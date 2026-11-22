import test from 'node:test';
import assert from 'node:assert/strict';
import {appDraftFixture,scene,deferred} from './helpers/app-draft-fixture.mjs';
import {createVMEnvironment,plain} from './helpers/source-ui-vm.mjs';

const key='air-studio-draft-v1',copy=value=>JSON.parse(JSON.stringify(value));
const baseAnimation={effect:'static',direction:'right',speed:4,loop:true};
const source=Array(84).fill('#ff0000');
const legacy={code:'KeyB',count:2,intervalMs:800};
const cross={code:'Space',count:3,intervalMs:600,effect:'cross',color:'#ffffff',speed:4};
const selected={...baseAnimation,colorOverride:'#80c040',brightness:50,hueShift:90};
const crossScene=()=>scene('一石二鸟',{colors:Array(84).fill('#000000'),animation:selected,trigger:cross});
const page=f=>f.nodes().find(node=>node.props.className==='app-shell lab-v5')?.props['data-page'];
async function library(f){await f.click('作品库');return f.child('Library');}
const scenarios=[
  ['static',()=>scene('Saved 静态',{id:'static-source',colors:source,animation:selected}),
    {op:'preview',colors:Array(84).fill('#406020'),animation:selected}],
  ['animation',()=>scene('Saved 动画',{id:'animation-source',colors:source,
    animation:{...selected,effect:'frames',speed:7,loop:false,frames:[{colors:source,duration:400},{colors:Array(84).fill('#0044ff'),duration:700}]}}),null],
  ['legacy trigger',()=>scene('Saved 旧闪烁',{id:'trigger-source',colors:source,animation:selected,trigger:legacy}),
    {op:'triggerArm',colors:Array(84).fill('#406020'),trigger:legacy}],
  ['typing cross',crossScene,
    {op:'triggerArm',colors:Array(84).fill('#000000'),trigger:{...cross,color:'#406020'}}],
];

for(const [name,make,expected] of scenarios)test(`actual App direct ${name} playback keeps Library, dirty canvas and browser draft unchanged`,async()=>{
  const f=await appDraftFixture();
  await f.edit({name:'My unsaved canvas',animation:{...baseAnimation,brightness:37}});
  const before=copy(f.draft()),stored=f.storage.get(key),writes=f.writes.length,session=f.child('Studio').key;
  const lib=await library(f),target=make(),original=copy(target);
  lib.props.onPlay(target);await f.flush();
  assert.equal(page(f),'library');
  assert.ok(f.child('Library'));
  assert.equal(f.child('Studio'),undefined);
  assert.equal(f.modal(),undefined,'direct playback must never ask to discard the editing canvas');
  assert.deepEqual(copy(f.draft()),before);
  assert.equal(f.storage.get(key),stored);
  assert.equal(f.writes.length,writes);
  assert.deepEqual(target,original,'playback cannot bake appearance or trigger parameters into its source');
  assert.deepEqual(f.commands,[copy(expected??{op:'play',colors:target.colors,animation:target.animation})]);
  assert.ok(!f.commands.some(command=>['stop','saveScene','settings'].includes(command.op)));
  await f.click('灯光创作');
  assert.equal(f.child('Studio').key,session);
  assert.deepEqual(copy(f.child('Studio').props.draft),before);
  f.unmount();
});

for(const [name,make,expected] of scenarios)test(`approved editor open applies the ${name} output without a firmware restore`,async()=>{
  const f=await appDraftFixture(),target=make();
  (await library(f)).props.onLoad(target);await f.flush();
  assert.deepEqual(f.commands,[]);
  await f.click('放弃修改并打开');
  assert.equal(page(f),'studio');
  const {editorId,connectionSessionId,...output}=f.commands[0];
  assert.equal(typeof editorId,'string');assert.equal(connectionSessionId,'fixture-session');
  assert.deepEqual(output,copy(expected??{op:'play',colors:target.colors,animation:target.animation}));
  assert.equal(f.commands.length,1);
  assert.deepEqual(copy(f.draft()),copy(target));
  await library(f);
  assert.deepEqual(f.commands[1],{op:'endEditorLighting',editorId});
  f.unmount();
});

test('an offline or read-only keyboard still opens artwork for editing without a hardware command',async()=>{
  for(const device of [{connected:false},{connected:true,readOnly:true},{connected:true,capabilities:{perKey:false}}]){
    const f=await appDraftFixture({state:{device}}),target=scene('Offline work');
    (await library(f)).props.onLoad(target);await f.flush();await f.click('放弃修改并打开');
    assert.equal(f.draft().name,target.name);assert.deepEqual(f.commands,[]);f.unmount();
  }
});

test('direct playback failure stays in Library, preserves dirty work and releases the retry lock',async()=>{
  let attempts=0;
  const f=await appDraftFixture({onCommand:async()=>{if(++attempts===1)throw Error('Fixture playback failed');return{};}});
  const before=copy(f.draft()),stored=f.storage.get(key),lib=await library(f);
  lib.props.onPlay(scene('Output'));await f.flush();
  assert.equal(page(f),'library');assert.equal(f.modal(),undefined);
  assert.deepEqual(copy(f.draft()),before);assert.equal(f.storage.get(key),stored);
  assert.equal(f.child('FeedbackToast')?.props.message,'Fixture playback failed');
  assert.equal(f.child('Library').props.transitionBusy,false);
  f.child('Library').props.onPlay(scene('Retry output'));await f.flush();
  assert.equal(f.commands.length,2);
  assert.ok(f.commands.every(command=>command.op==='preview'));
  assert.deepEqual(copy(f.draft()),before);f.unmount();
});

test('direct playback dispatches once while pending and never opens a concurrent edit request',async()=>{
  const pending=deferred(),f=await appDraftFixture({onCommand:()=>pending.promise});
  const before=copy(f.draft()),lib=await library(f),target=crossScene();
  lib.props.onPlay(target);lib.props.onPlay(target);lib.props.onLoad(scene('Concurrent editor target'));
  await f.flush();
  assert.equal(f.commands.length,1);assert.equal(f.commands[0].op,'triggerArm');
  assert.equal(f.child('Library').props.transitionBusy,true);
  assert.equal(page(f),'library');assert.equal(f.modal(),undefined);
  assert.deepEqual(copy(f.draft()),before);
  pending.resolve({});await f.flush();
  assert.equal(f.child('Library').props.transitionBusy,false);
  assert.equal(page(f),'library');assert.deepEqual(copy(f.draft()),before);f.unmount();
});

test('late direct-play completion cannot navigate or unlock a newer USB session request',async()=>{
  const first=deferred(),second=deferred();
  const f=await appDraftFixture({onCommand:(_body,{commands})=>commands.length===1?first.promise:second.promise});
  const before=copy(f.draft());(await library(f)).props.onPlay(scene('First output'));await f.flush();
  f.state.device.connectionSessionId='replacement-session';f.render();await f.flush();
  f.child('Library').props.onPlay(scene('Second output'));await f.flush();
  assert.equal(f.commands.length,2);assert.equal(f.child('Library').props.transitionBusy,true);
  first.resolve({});await f.flush();
  assert.equal(f.child('Library').props.transitionBusy,true,'a stale completion must leave the current request locked');
  assert.equal(page(f),'library');assert.deepEqual(copy(f.draft()),before);
  second.resolve({});await f.flush();
  assert.equal(f.child('Library').props.transitionBusy,false);
  assert.equal(page(f),'library');assert.deepEqual(copy(f.draft()),before);f.unmount();
});

for(const [name,changes] of [
  ['disconnected',{device:{connected:false,capabilities:{perKey:true}}}],
  ['read-only',{device:{connected:true,readOnly:true,capabilities:{perKey:true}}}],
  ['unsupported',{device:{connected:true,capabilities:{perKey:false}}}],
  ['firmware',{firmware:{compatible:false}}],
])test(`direct library playback remains blocked for ${name} without changing the editor`,async()=>{
  const f=await appDraftFixture({state:changes}),before=copy(f.draft());
  (await library(f)).props.onPlay(scene('Blocked output'));await f.flush();
  assert.equal(f.commands.length,0);assert.equal(f.modal(),undefined);
  assert.equal(page(f),'library');assert.deepEqual(copy(f.draft()),before);f.unmount();
});

test('direct playback preserves an unreadable browser draft and never invokes its discard guard',async()=>{
  const damaged='{broken',f=await appDraftFixture({storage:{[key]:damaged}}),before=copy(f.draft());
  (await library(f)).props.onPlay(scene('Independent output'));await f.flush();
  assert.equal(f.commands.length,1);assert.equal(f.commands[0].op,'preview');
  assert.equal(page(f),'library');assert.equal(f.modal(),undefined);
  assert.equal(f.storage.get(key),damaged);assert.equal(f.writes.length,0);
  assert.deepEqual(copy(f.draft()),before);f.unmount();
});

for(const [name,patch] of [
  ['cross colour',{...cross,color:'#00ff00'}],
  ['cross speed',{...cross,speed:7}],
  ['trigger effect',{code:cross.code,count:cross.count,intervalMs:cross.intervalMs}],
])test(`opening for edit still protects a saved draft with changed ${name}`,async()=>{
  const saved=scene('Saved trigger',{id:'saved-trigger',trigger:cross});
  const f=await appDraftFixture({draft:saved,state:{scenes:[copy(saved)]}});
  await f.edit({trigger:patch});const before=copy(f.draft());
  (await library(f)).props.onLoad(scene('Open another work'));await f.flush();
  assert.equal(f.modal()?.props.title,'当前草稿有未保存修改');
  assert.equal(f.commands.length,0);assert.deepEqual(copy(f.draft()),before);f.unmount();
});

test('UI preset scenes retain the complete trigger configuration without aliasing its editable object',async()=>{
  const preset={...crossScene(),id:'typingCross',category:'pattern',description:'Fixture cross'};
  const env=createVMEnvironment({'../../shared/presets.mjs':{
    createPresets:()=>[preset],heartColors:()=>[],DEFAULT_COLOR:'#ffffff',
  }});
  const loaded=await env.load(new URL('../ui/src/presets.ts',import.meta.url));
  const mapped=loaded.exports.presets([]);
  assert.deepEqual(plain(mapped[0].trigger),cross);
  mapped[0].trigger.color='#00ff00';
  assert.equal(preset.trigger.color,'#ffffff');
});
