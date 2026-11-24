import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,plain,walkAll,textOf} from './helpers/source-ui-vm.mjs';
import {airLayout,blank} from '../shared/layout.mjs';
import * as appearance from '../shared/render-animation.mjs';
import * as triggers from '../shared/trigger.mjs';
import * as typing from '../shared/typing-cross.mjs';

const animation={effect:'static',direction:'right',speed:4,loop:true,frames:[],brightness:50};
const cross={code:'Space',count:3,intervalMs:600,effect:'cross',color:'#ffffff',speed:4};
const scene=()=>({name:'My editable cross',colors:blank(),animation:{...animation},trigger:{...cross}});

test('Windows input reset warnings preserve normal typing and do not offer macOS permission settings',async()=>{
  const f=await fixture();f.state.trigger.warning='按键事件未能完整接收，已停止灯效，请重新启用触发。';f.state.desktop={platform:'win32'};f.render();
  assert.match(textOf(f.panel.tree),/按键事件未能完整接收/);assert.match(textOf(f.panel.tree),/按键仍会正常输入/);assert.equal(f.button('管理权限'),undefined);
  delete f.state.desktop;f.render();assert(f.button('管理权限'));f.unmount();
});

async function fixture(draft=scene()){
  let now=1000,nextFrame=1,draftWrites=0,prevented=0;
  const frames=new Map(),commands=[],notices=[];
  const env=createVMEnvironment({
    './i18n':{t:value=>value},
    'lucide-react':new Proxy({},{get:(_object,key)=>'Icon:'+String(key)}),
    './rangeStyle':{rangeStyle:()=>({})},
    './ColorWheel':{ColorWheel:'FixtureColorWheel'},
    './TriggerKeyRecorder':{TriggerKeyRecorder:'FixtureKeyRecorder'},
    './Keyboard':{Keyboard:'FixtureKeyboard',lightingPeak:()=>255},
    './GamePanel':{GamePanel:'FixtureGamePanel'},
    './presets':{DEFAULT_COLOR:'#dc847b',heartColors:()=>blank()},
    './types':{blankColors:blank},
    './primitives':{Button:'Button',Switch:'Switch',run:promise=>env.track(promise)},
    './useWorkspaceLayout':{useWorkspaceLayout:()=>({mode:'flow',style:{},headerRef:{},gridRef:{},stageRef:{},keyboardRef:{},auxiliaryRef:{},returnToKeyboard(){}})},
    './connection-copy-v7':{canvasCaption:()=>'',connectionCopy:value=>value?.zh??'',keyboardActionHint:()=>''},
    '../../shared/device-status.mjs':{lightingUnavailableMessage:()=>''},
    '../../shared/render-animation.mjs':appearance,
    '../../shared/trigger.mjs':triggers,
    '../../shared/typing-cross.mjs':typing,
  });
  env.window.performance={now:()=>now};
  env.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  env.window.requestAnimationFrame=callback=>{const id=nextFrame++;frames.set(id,callback);return id;};
  env.window.cancelAnimationFrame=id=>frames.delete(id);
  const triggerModule=(await env.load(new URL('../ui/src/TriggerPanel.tsx',import.meta.url))).exports;
  env.modules['./TriggerPanel']=triggerModule;
  const Studio=(await env.load(new URL('../ui/src/Studio.tsx',import.meta.url))).exports.Studio;
  const state={settings:{brightness:27},device:{connected:true,armed:false,modelId:'air75-v3',connectionSessionId:'cross-ui',capabilities:{perKey:true}},
    firmware:{compatible:true},playback:{mode:'idle',playing:false},game:{status:'idle'},colors:blank(),scenes:[],
    trigger:{armed:false,flashing:false,completed:0,config:{...cross},monitor:'off'}};
  const props={mode:'trigger',layout:airLayout,state,draft:structuredClone(draft),
    setDraft:next=>{props.draft=next;draftWrites++;},command:async body=>{
      commands.push(structuredClone(body));
      if(body.op==='triggerArm'){
        state.device.armed=true;state.playback={mode:'trigger',playing:false};state.colors=blank();
        state.trigger={...state.trigger,armed:true,flashing:false,config:structuredClone(body.trigger),monitor:'global'};
      }else if(body.op==='triggerStop'){
        state.device.armed=false;state.playback={mode:'idle',playing:false};state.trigger.armed=false;state.trigger.monitor='off';
      }
      return{};
    },notify:message=>notices.push(message),onSave(){},onBrowsePresets(){},onEditCodexColors(){}};
  const studio=env.mount(Studio,props);let panel;
  function render(){
    studio.update(props);
    const child=walkAll(studio.tree,node=>node.type===triggerModule.TriggerPanel)[0];
    assert.ok(child,'cross/legacy trigger panel should remain in the Studio property column');
    if(panel)panel.update(child.props);else panel=env.mount(child.type,child.props);
    studio.render();
  }
  const nodes=()=>[...walkAll(studio.tree,()=>true),...walkAll(panel.tree,()=>true)];
  const button=label=>nodes().find(node=>node.props?.onClick&&textOf(node)===label);
  const textarea=()=>walkAll(panel.tree,node=>node.type==='textarea')[0];
  const colors=()=>plain(walkAll(studio.tree,node=>node.type==='FixtureKeyboard')[0].props.colors);
  const frame=at=>{now=at;const work=[...frames.values()];frames.clear();for(const callback of work)callback(at);render();};
  const key=(code,{at=now,repeat=false}={})=>{now=at;textarea().props.onKeyDown({code,repeat,target:{value:'typed secret'},preventDefault(){prevented++;}});render();};
  const click=async label=>{const control=button(label);assert.ok(control,label);assert.ok(!control.props.disabled,label+' disabled');control.props.onClick();await env.settle(panel);render();await env.settle(studio);render();};
  render();
  return{env,triggerModule,props,state,studio,get panel(){return panel;},nodes,button,textarea,colors,frame,key,click,render,frames,commands,notices,
    writes:()=>draftWrites,prevented:()=>prevented,unmount(){panel.unmount();studio.unmount();}};
}

test('cross editor exposes colour/speed and removes legacy pattern controls while preserving appearance',async()=>{
  const draft=scene();draft.animation.colorOverride='#0080ff';
  const f=await fixture(draft),wheel=f.nodes().find(node=>node.type==='FixtureColorWheel');
  assert.ok(wheel);assert.equal(wheel.props.color,'#ffffff');
  assert.equal(f.nodes().some(node=>node.type==='FixtureKeyRecorder'),false);
  assert.equal(f.button('编辑图案'),undefined);assert.equal(f.button('清空画板'),undefined);
  assert.equal(f.button('试闪一次'),undefined);assert.ok(f.button('试放一次'));
  wheel.props.onChange('#FF0000');f.render();
  const speed=f.nodes().find(node=>node.props['aria-label']==='扩散速度');
  assert.equal(speed.props.min,'1');assert.equal(speed.props.max,'10');
  speed.props.onChange({target:{value:'7'}});f.render();
  assert.equal(f.props.draft.trigger.color,'#ff0000');assert.equal(f.props.draft.trigger.speed,7);
  assert.equal(Object.hasOwn(f.props.draft.animation,'colorOverride'),false);
  assert.equal(f.props.draft.animation.brightness,50);
  assert.deepEqual(f.props.draft.colors,blank());
  assert.deepEqual(f.colors(),typing.typingCrossThumbnail(airLayout,'#800000'));
  assert.deepEqual(f.commands,[]);f.unmount();
});

test('typing preview layers actual key waves without saving text or automatically arming the keyboard',async()=>{
  const draft=scene();draft.trigger.color='#ff0000';
  const f=await fixture(draft),before=structuredClone(f.props.draft),writes=f.writes();
  assert.equal(f.frames.size,0,'opening the editor cannot start a loop');
  assert.equal(f.textarea().props.value,undefined);assert.equal(f.textarea().props.onChange,undefined);
  const reference=new typing.TypingCross(airLayout);
  f.key('KeyA',{at:1000});reference.fire('KeyA',1000);f.frame(1050);
  assert.deepEqual(f.colors(),reference.render(1050,{color:'#800000',speed:4}));
  f.key('KeyL',{at:1100});reference.fire('KeyL',1100);f.key('KeyL',{at:1110,repeat:true});f.frame(1160);
  assert.deepEqual(f.colors(),reference.render(1160,{color:'#800000',speed:4}));
  const onlyLast=new typing.TypingCross(airLayout);onlyLast.fire('KeyL',1100);
  assert.notDeepEqual(f.colors(),onlyLast.render(1160,{color:'#800000',speed:4}));
  assert.equal(f.prevented(),0);assert.equal(f.writes(),writes);assert.deepEqual(f.props.draft,before);
  assert.deepEqual(f.commands,[]);assert.equal(f.state.trigger.armed,false);
  f.frame(2000);assert.ok(f.colors().every(color=>color==='#000000'));assert.equal(f.frames.size,0);
  await f.click('试放一次');assert.equal(f.frames.size,1);assert.deepEqual(f.commands,[]);
  f.unmount();assert.equal(f.frames.size,0);
});

test('cross arms a blank source with appearance once, shows truthful hardware output, applies settings and stays armed after a wave',async()=>{
  const draft=scene();draft.trigger.color='#ff0000';
  const f=await fixture(draft);
  assert.equal(f.button('启用按键触发').props.disabled,false,'generated trajectories do not need a source pattern');
  await f.click('启用按键触发');
  assert.deepEqual(f.commands[0],{op:'triggerArm',colors:blank(),trigger:{...cross,color:'#800000'}});
  assert.equal(f.props.draft.trigger.color,'#ff0000','submitted brightness cannot be baked into saved source colour');
  f.state.colors=Array(84).fill('#123456');f.state.trigger.flashing=true;f.render();
  const wheel=f.nodes().find(node=>node.type==='FixtureColorWheel');wheel.props.onChange('#00ff00');f.render();
  assert.deepEqual(f.colors(),Array(84).fill('#123456'),'armed editor must show actual output while the next colour is only a draft');
  assert.equal(f.commands.length,1);
  assert.ok(textOf(f.panel.tree).includes('颜色和速度已修改，点击应用设置更新键盘。'));
  f.key('KeyA',{at:1000});assert.equal(f.frames.size,0,'armed output cannot be replaced by a local page preview');
  await f.click('应用设置');
  assert.equal(f.commands[1].op,'triggerArm');assert.equal(f.commands[1].trigger.color,'#008000');
  assert.equal(f.props.draft.trigger.color,'#00ff00');
  await f.click('试放一次');assert.deepEqual(f.commands[2],{op:'triggerFire',code:'Space'});
  f.state.colors=blank();f.state.trigger.flashing=false;f.render();
  assert.equal(f.state.trigger.armed,true);assert.ok(f.button('关闭按键触发'));
  assert.ok(textOf(f.studio.tree).includes('等待按键 · 每次按键产生独立光波'));
  await f.click('关闭按键触发');assert.equal(f.commands.at(-1).op,'triggerStop');f.unmount();
});

test('legacy trigger controls and configured-key fallback remain unchanged',async()=>{
  const draft=scene();draft.trigger={code:'KeyB',count:2,intervalMs:800};draft.colors=Array(84).fill('#ff0000');
  const f=await fixture(draft);
  assert.ok(f.nodes().find(node=>node.type==='FixtureKeyRecorder'));
  assert.equal(f.nodes().some(node=>node.type==='FixtureColorWheel'),false);
  assert.equal(f.textarea(),undefined);assert.ok(f.button('编辑图案'));
  assert.equal(f.button('试闪一次').props.disabled,true);
  await f.click('启用按键触发');
  assert.deepEqual(f.commands[0],{op:'triggerArm',colors:Array(84).fill('#800000'),trigger:draft.trigger});
  await f.click('试闪一次');assert.deepEqual(f.commands[1],{op:'triggerFire'});f.unmount();
});

test('window cross fallback forwards supported typing/modifier keys once without blocking their normal action',async()=>{
  const f=await fixture(),state=f.state;state.playback.mode='trigger';state.trigger={...state.trigger,armed:true,monitor:'window',config:{...cross}};
  const hook=f.env.mount(()=>{f.triggerModule.useTriggerKeys(state,f.props.command);return null;});
  let prevented=0;
  const dispatch=(code,patch={})=>f.env.window.dispatchEvent({type:'keydown',code,repeat:false,defaultPrevented:false,
    metaKey:false,ctrlKey:false,altKey:false,shiftKey:false,target:{isContentEditable:true},preventDefault(){prevented++;},...patch});
  dispatch('KeyA');dispatch('ShiftLeft',{shiftKey:true});dispatch('F13');dispatch('KeyA',{repeat:true});dispatch('MediaPlayPause');
  dispatch('KeyL',{defaultPrevented:true});await f.env.settle(hook);
  assert.deepEqual(f.commands,[{op:'triggerKey',code:'KeyA'},{op:'triggerKey',code:'ShiftLeft'},{op:'triggerKey',code:'PrintScreen'}]);
  assert.equal(prevented,0);
  state.trigger.config={code:'Space',count:3,intervalMs:600};
  dispatch('KeyA');dispatch('Space',{shiftKey:true});dispatch('Space');await f.env.settle(hook);
  assert.deepEqual(f.commands.at(-1),{op:'triggerKey',code:'Space'});assert.equal(f.commands.length,4);
  hook.unmount();dispatch('Space');assert.equal(f.commands.length,4);f.unmount();
});
