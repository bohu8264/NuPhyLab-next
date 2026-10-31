import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fakeService,until} from './helpers/fake-service.mjs';
import {FACTORY_MAC_ROW} from '../shared/keycap-functions.mjs';

const tasks=[{id:'mode-a',title:'Synthetic A',status:'running'},{id:'mode-b',title:'Synthetic B',status:'completed'}];
const art=Array(84).fill('#123456');
const permissions={inputMonitoring:true,accessibility:true,canPostEvents:true};
const settings={brightness:100,codexSelectedPulse:false,codexAmbient:false,claudeSelectedPulse:false,claudeAmbient:false,
  lightDurationMs:0,lightIdleMs:0};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const black=colors=>colors.every(color=>color==='#000000');
function keymap(model='air75-v3',{factory=false,lease=true}={}){
  const kick=model==='kick75',size=kick?92:98,standard=Array(size).fill(0),mac=Array(size).fill(0);
  for(let i=1;i<=12;i++){standard[i]=57+i;mac[i]=factory?FACTORY_MAC_ROW[i-1]:57+i;}
  return {modelId:model,protocol:kick?'kick75-s4-keymap':'air75-s4-keymap',matrixKeyCount:size-2,keymapKeyCount:size,
    readOnly:true,geometryVerified:true,mode:0,locationId:1,active:mac,defaults:[mac,standard],functionKeyLeaseSupported:lease,
    firmwareVersion:kick?'4.0.18.6':'1.0.23.6'};
}
async function fixture(t,control={}){
  const s=await fakeService(t,{tasks,permissions,...control});
  const ok=async body=>{const result=await s.command(body);assert.equal(result.ok,true,JSON.stringify(result));return result.result;};
  await ok({op:'settings',settings});
  return {...s,ok};
}
const mode=(s,enabled=true,source='codex')=>s.ok({op:'agentMode',source,enabled});

test('one mode command atomically selects an integration and couples its function-key adaptation',async t=>{
  const s=await fixture(t);
  await s.ok({op:'saveScene',scene:{name:'Kept artwork',colors:art,animation:{effect:'static'}}});
  const original=(await s.state()).scenes;
  const enabled=await mode(s);assert.equal(enabled.source,'codex');assert.equal(enabled.enabled,true);
  let state=await s.state();
  assert.equal(state.settings.codexEnabled,true);assert.equal(state.settings.claudeEnabled,false);assert.equal(state.settings.codexKeyAdaptation,true);
  assert.equal(state.codex.keys.enabled,true);assert.equal(state.codex.lighting.ownsOutput,true);assert.equal(state.codex.lighting.sleeping,false);
  assert.equal(state.codex.lighting.outputOwner.source,'codex');
  assert.equal(state.codex.lighting.outputOwner.connectionSessionId,state.device.connectionSessionId);
  await mode(s,true,'claude');state=await s.state();
  assert.equal(state.settings.agentSource,'claude');assert.equal(state.settings.claudeEnabled,true);assert.equal(state.settings.codexEnabled,false);
  assert.equal(state.codex.lighting.ownsOutput,false);assert.equal(state.claude.lighting.ownsOutput,true);assert.equal(state.codex.keys.source,'claude');
  await mode(s,false,'claude');state=await s.state();
  assert.equal(state.settings.codexEnabled,false);assert.equal(state.settings.claudeEnabled,false);assert.equal(state.settings.codexKeyAdaptation,false);
  assert.equal(state.codex.keys.enabled,false);assert.equal(state.claude.lighting.ownsOutput,false);assert.deepEqual(state.scenes,original);
});

test('invalid mode requests fail before changing settings, stored artwork or native operations',async t=>{
  const s=await fixture(t),file=path.join(s.dataDir,'library.json'),bytes=await readFile(file,'utf8');
  const before=await s.state(),start=(await s.operations()).length;
  for(const request of [{enabled:true},{source:'invalid',enabled:true},{source:'codex'},{source:'codex',enabled:'true'},{source:'claude',enabled:null}]){
    const result=await s.command({op:'agentMode',...request});assert.equal(result.ok,false);assert.match(result.error,/模式设置无效/);
  }
  assert.deepEqual((await s.state()).settings,before.settings);assert.equal(await readFile(file,'utf8'),bytes);
  assert.deepEqual((await s.operations()).slice(start).filter(op=>['arm','paint','side','restore','adaptKeys','restoreKeys','prepareFunctionKey','restoreFunctionKey','shortcut'].includes(op.op)),[]);
});

test('committed screen colours retain the selected palette while only device output is globally dimmed',async t=>{
  const s=await fixture(t);await s.ok({op:'settings',settings:{brightness:27}});await mode(s);
  let state=await s.state();assert.equal(state.previewColors[1],'#304ffe');assert.equal(state.colors[1],'#0d1545');
  assert.deepEqual((await s.operations()).filter(r=>r.op==='paint').at(-1).colors,state.colors,'preview must not brighten the USB payload');
  await s.ok({op:'preview',colors:art});state=await s.state();
  assert.equal(state.previewColors[20],'#123456');assert.equal(state.previewColors[1],'#304ffe');assert.equal(state.colors[20],'#050e17');
  await s.ok({op:'settings',settings:{brightness:0}});state=await s.state();assert.ok(state.previewColors.every(c=>c==='#000000'));assert.ok(state.colors.every(c=>c==='#000000'));
});

test('legacy adapt commands retain their result shape and mutual-exclusion behaviour',async t=>{
  const s=await fixture(t);
  const on=await s.ok({op:'codexAdapt',source:'claude'});assert.ok(typeof on.status==='string');
  let state=await s.state();assert.equal(state.settings.claudeEnabled,true);assert.equal(state.settings.codexEnabled,false);
  await s.ok({op:'codexAdapt'});state=await s.state();assert.equal(state.settings.codexEnabled,true);assert.equal(state.settings.claudeEnabled,false);
  const off=await s.ok({op:'codexAdaptRestore'});assert.ok(typeof off.status==='string');assert.equal((await s.state()).codex.keys.enabled,false);
});

test('the mode command preserves empty custom slots and the configured ordinary-key fallback',async t=>{
  const s=await fixture(t);await s.ok({op:'settings',settings:{codexTaskSource:'custom',slotIds:[],codexKeycapFallback:true}});
  await mode(s);let state=await s.state();
  assert.equal(state.settings.codexTaskSource,'custom');assert.deepEqual(state.settings.slotIds,[]);assert.equal(state.settings.codexKeycapFallback,true);
  await mode(s,false);state=await s.state();assert.equal(state.settings.codexTaskSource,'custom');assert.equal(state.settings.codexKeycapFallback,true);
  await s.ok({op:'codexAdapt'});assert.equal((await s.state()).settings.codexTaskSource,'recent','legacy Setup retains its explicit empty-custom repair');
});

test('persisted Codex mode starts its status lights on the first automatic Kick connection',async t=>{
  const s=await fakeService(t,{skipInitialConnect:true,modelId:'kick75',firmwareVersion:'4.0.18.6',tasks,permissions,keymap:keymap('kick75'),
    storedSettings:{...settings,agentSource:'codex',codexEnabled:true,claudeEnabled:false,codexKeyAdaptation:true,autoConnect:true}});
  const state=await until(s.state,v=>v.device.connected&&v.device.armed&&v.codex.lighting.ownsOutput,'Stored mode did not start on Kick',8000);
  assert.equal(state.device.modelId,'kick75');assert.equal(state.playback.mode,'agent');assert.equal(state.codex.keys.enabled,true);
  assert.equal(state.colors[1],'#304ffe');assert.equal(state.colors[2],'#00ff4c');
});

test('automatic Air/Kick handoffs preserve mode intent but discard the previous layout artwork',async t=>{
  const s=await fixture(t);await mode(s);await s.ok({op:'preview',colors:art});
  await s.configure({disconnect:1,present:false});await until(s.state,v=>!v.device.connected,'Air did not unplug');
  await s.configure({present:true,modelId:'kick75',firmwareVersion:'4.0.18.6',keymap:keymap('kick75')});
  const kick=await until(s.state,v=>v.device.modelId==='kick75'&&v.device.connected&&v.codex.lighting.ownsOutput,'Kick auto connection lost the mode',8000);
  assert.equal(kick.settings.codexEnabled,true);assert.equal(kick.codex.keys.enabled,true);assert.equal(kick.playback.mode,'agent');
  assert.equal(kick.colors[1],'#304ffe');assert.equal(kick.colors[20],'#000000');
  const session=kick.device.connectionSessionId;
  await s.configure({disconnect:2,present:false});await until(s.state,v=>!v.device.connected,'Kick did not unplug');
  await s.configure({present:true,modelId:'air75-v3',firmwareVersion:'1.0.23.6',keymap:keymap()});
  const air=await until(s.state,v=>v.device.modelId==='air75-v3'&&v.device.connected&&v.codex.lighting.ownsOutput,'Air auto connection lost the mode',8000);
  assert.notEqual(air.device.connectionSessionId,session);assert.equal(air.colors[1],'#304ffe');assert.equal(air.colors[20],'#000000');
  assert.equal(air.codex.lighting.outputOwner.connectionSessionId,air.device.connectionSessionId);
});

test('enabling and repeating On retain a playing ordinary animation and overlay its task keys',async t=>{
  const s=await fixture(t);
  await s.ok({op:'play',colors:art,animation:{effect:'frames',speed:4,loop:true,frames:[{colors:art,duration:800}]}});
  const before=await s.state();await mode(s);
  let state=await until(s.state,v=>v.colors[1]==='#304ffe','Mode did not overlay the playing work');
  assert.equal(state.playback.mode,'animation');assert.equal(state.playback.playing,true);assert.equal(state.colors[20],'#123456');
  assert.equal(state.colors[2],'#00ff4c');assert.equal(state.codex.lighting.ownsOutput,true);
  const opStart=(await s.operations()).length;await mode(s);state=await s.state();
  assert.equal(state.playback.mode,'animation');assert.equal(state.playback.playing,true);assert.equal(state.colors[20],before.colors[20]);
  assert.deepEqual((await s.operations()).slice(opStart).filter(op=>['restore','arm','nativeLighting'].includes(op.op)),[]);
});

test('static and paused works continue receiving task status updates without moving their background',async t=>{
  const s=await fixture(t);await mode(s);await s.ok({op:'preview',colors:art});
  await s.configure({tasks:[{...tasks[0],status:'completed'},{...tasks[1],status:'error'}]});
  let state=await until(s.state,v=>v.colors[1]==='#00ff4c'&&v.colors[2]==='#ff0033','Static work hid new task statuses');
  assert.equal(state.playback.mode,'static');assert.equal(state.colors[20],'#123456');
  await s.ok({op:'play',colors:art,animation:{effect:'frames',speed:4,loop:true,frames:[{colors:art,duration:800},{colors:Array(84).fill('#aabbcc'),duration:800}]}});
  await wait(90);await s.ok({op:'pause'});const paused=await s.state();
  await s.configure({tasks:[tasks[0],tasks[1]]});state=await until(s.state,v=>v.colors[1]==='#304ffe'&&v.colors[2]==='#00ff4c','Paused work hid new statuses');
  assert.equal(state.playback.mode,'paused');assert.equal(state.playback.playing,false);assert.equal(state.playback.elapsed,paused.playback.elapsed);
  assert.equal(state.colors[20],paused.colors[20]);
});

test('mode Off removes only the overlay from a paused work and keeps its position and pixels',async t=>{
  const s=await fixture(t);await mode(s);
  await s.ok({op:'play',colors:art,animation:{effect:'frames',speed:4,loop:true,frames:[{colors:art,duration:800},{colors:Array(84).fill('#aabbcc'),duration:800}]}});
  await wait(100);await s.ok({op:'pause'});const before=await s.state(),start=(await s.operations()).length;
  await mode(s,false);const after=await s.state();
  assert.equal(after.playback.mode,'paused');assert.equal(after.playback.playing,false);assert.equal(after.playback.elapsed,before.playback.elapsed);
  assert.deepEqual(after.colors,Array(84).fill(before.colors[20]));assert.equal(after.codex.keys.enabled,false);assert.equal(after.codex.lighting.ownsOutput,false);
  assert.deepEqual((await s.operations()).slice(start).filter(op=>op.op==='restore'),[]);
});

test('mode toggles preserve an active audio session; internal AudioStop returns to AI status lighting',async t=>{
  const s=await fixture(t);await s.ok({op:'audioInventory',systemSupported:true,devices:[{id:'mode-test-mic',name:'Synthetic mic'}],microphonePermission:true});
  await s.ok({op:'audioStart'});const before=await s.state();
  await mode(s);let state=await s.state();assert.equal(state.playback.mode,'audio');assert.equal(state.audio.session,before.audio.session);
  await mode(s);state=await s.state();assert.equal(state.audio.session,before.audio.session);assert.equal(state.playback.mode,'audio');
  await mode(s,false);state=await s.state();assert.equal(state.audio.session,before.audio.session);assert.equal(state.playback.mode,'audio');
  await mode(s);const start=(await s.operations()).length;await s.ok({op:'audioStop'});state=await s.state();
  assert.equal(state.settings.codexEnabled,true);assert.equal(state.playback.mode,'agent');assert.equal(state.colors[1],'#304ffe');assert.equal(state.codex.lighting.ownsOutput,true);
  assert.deepEqual((await s.operations()).slice(start).filter(op=>op.op==='restore'),[]);
});

test('an internal scene stop keeps the mode and clears only the ordinary artwork',async t=>{
  const s=await fixture(t);await mode(s);await s.ok({op:'preview',colors:art});const start=(await s.operations()).length;
  await s.ok({op:'stop'});const state=await s.state();
  assert.equal(state.settings.codexEnabled,true);assert.equal(state.playback.mode,'agent');assert.equal(state.colors[1],'#304ffe');assert.equal(state.colors[20],'#000000');
  assert.deepEqual((await s.operations()).slice(start).filter(op=>op.op==='restore'),[]);
});

test('Restore explicitly exits the mode and does not reclaim the original lighting on later ticks',async t=>{
  const s=await fixture(t);await mode(s);await s.ok({op:'preview',colors:art});
  await s.ok({op:'restore'});let state=await s.state();const count=(await s.operations()).filter(op=>op.op==='paint').length;
  assert.equal(state.settings.codexEnabled,false);assert.equal(state.settings.codexKeyAdaptation,false);assert.equal(state.codex.keys.enabled,false);
  assert.equal(state.playback.mode,'idle');assert.equal(state.device.armed,false);assert.equal(state.codex.lighting.ownsOutput,false);
  await wait(140);state=await s.state();assert.equal(state.playback.mode,'idle');assert.equal((await s.operations()).filter(op=>op.op==='paint').length,count);
});

test('game, trigger and key recording keep their safe temporary mode pause and truthful ownership',async t=>{
  const s=await fixture(t);await mode(s);
  await s.ok({op:'gameStart',gameType:'snake',speed:4});let state=await s.state();
  assert.equal(state.settings.codexEnabled,true);assert.equal(state.codex.keys.enabled,false);assert.equal(state.codex.lighting.ownsOutput,false);assert.equal(state.codex.lighting.pausedReason,'game');
  await s.ok({op:'gameStop'});state=await s.state();assert.equal(state.codex.lighting.ownsOutput,true);
  await s.ok({op:'triggerArm',colors:art,trigger:{code:'Space',count:1,intervalMs:200}});state=await s.state();
  assert.equal(state.codex.keys.enabled,false);assert.equal(state.codex.lighting.ownsOutput,false);assert.equal(state.codex.lighting.pausedReason,'trigger');
  await s.ok({op:'triggerStop'});state=await s.state();assert.equal(state.codex.lighting.ownsOutput,true);
  await s.ok({op:'codexCapture',session:'mode-recorder',active:true});state=await s.state();
  assert.equal(state.codex.keys.enabled,false);assert.equal(state.codex.lighting.ownsOutput,false);assert.equal(state.codex.lighting.pausedReason,'recording');
  await s.ok({op:'codexCapture',session:'mode-recorder',active:false});
  await until(s.state,v=>v.codex.lighting.ownsOutput,'Mode did not resume after recording');
});

for(const power of [{lightDurationMs:1000,lightIdleMs:0},{lightDurationMs:0,lightIdleMs:1000}])test(`AI overlay survives background ${power.lightDurationMs?'duration':'idle'} sleep and status changes`,async t=>{
  const s=await fixture(t);await mode(s);await s.ok({op:'settings',settings:power});await s.ok({op:'preview',colors:art});
  let state=await until(s.state,v=>v.lightPower.sleeping&&v.colors[20]==='#000000','Ordinary background did not sleep',4000);
  assert.equal(state.colors[1],'#304ffe');assert.equal(state.codex.lighting.sleeping,false);assert.equal(state.codex.lighting.backgroundSleeping,true);assert.equal(state.codex.lighting.ownsOutput,true);
  await s.configure({tasks:[{...tasks[0],status:'completed'},tasks[1]]});state=await until(s.state,v=>v.colors[1]==='#00ff4c','Sleeping background stopped AI status updates');
  assert.equal(state.lightPower.sleeping,true);assert.equal(state.colors[20],'#000000');
  assert.equal(state.settings.lightDurationMs,power.lightDurationMs);assert.equal(state.settings.lightIdleMs,power.lightIdleMs);
  await mode(s,false);state=await s.state();assert.equal(state.lightPower.sleeping,true);assert.equal(black(state.colors),true);
});

test('whole mode remains the explicit whole-keyboard priority and global zero stays dark',async t=>{
  const s=await fixture(t);await s.ok({op:'settings',settings:{codexLightMode:'whole',codexWholeTaskId:'mode-a'}});await mode(s);
  await s.ok({op:'preview',colors:art});let state=await s.state();
  assert.ok(state.layout.every(key=>state.colors[key.index]==='#304ffe'));assert.equal(state.codex.lighting.outputOwner.mode,'whole');
  await s.ok({op:'settings',settings:{brightness:0}});state=await s.state();assert.equal(black(state.colors),true);assert.equal(state.settings.codexEnabled,true);assert.equal(state.codex.lighting.ownsOutput,true);
});

test('unowned F4 history does not block status lights and mode Off never confirms or restores that lease',async t=>{
  const recovery={status:'confirmationRequired',pending:true,blocking:true,ownsCurrentHandle:false,unownedHistory:true};
  const s=await fixture(t,{modelId:'kick75',firmwareVersion:'4.0.18.6',keymap:keymap('kick75',{factory:true,lease:false}),keyRecovery:recovery,
    unownedFunctionKeyHistory:true});
  const start=(await s.operations()).length;await mode(s);let state=await s.state();
  assert.equal(state.device.armed,true);assert.equal(state.codex.lighting.ownsOutput,true);assert.equal(state.colors[1],'#304ffe');
  await mode(s,false);state=await s.state();assert.equal(state.device.keyRecovery.pending,true);assert.equal(state.device.keyRecovery.ownsCurrentHandle,false);
  assert.equal(state.settings.codexEnabled,false);assert.equal(state.codex.keys.enabled,false);
  assert.deepEqual((await s.operations()).slice(start).filter(op=>['confirmFunctionKeyRecovery','prepareFunctionKey','restoreFunctionKey'].includes(op.op)),[]);
});

test('mode Off restores only an owned F4 lease and its scoped OS mappings',async t=>{
  const s=await fixture(t,{keymap:keymap('air75-v3',{factory:true})});await mode(s);
  assert.ok((await s.operations()).some(op=>op.op==='prepareFunctionKey'));
  const start=(await s.operations()).length;await mode(s,false);const ops=(await s.operations()).slice(start),state=await s.state();
  assert.ok(ops.some(op=>op.op==='restoreKeys'));assert.ok(ops.some(op=>op.op==='restoreFunctionKey'));
  assert.equal(state.device.keyRecovery.pending,false);assert.equal(state.codex.keys.enabled,false);
});

test('equal wire colours reuse the old committed receipt without inventing a fresh RGB acknowledgement',async t=>{
  const s=await fixture(t);await mode(s);
  const before=await until(s.state,v=>v.codex.lighting.outputOwner?.reusedCommittedFrame,'Stable wire was not reused');
  const count=(await s.operations()).filter(op=>op.op==='paint').length,committed=before.codex.lighting.outputOwner.frameCommittedAt;
  await s.configure({tasks:[{...tasks[0],id:'mode-new'},tasks[1]]});
  const after=await until(s.state,v=>v.codex.slots[0]?.id==='mode-new','Same-colour task assignment was not published');
  assert.equal((await s.operations()).filter(op=>op.op==='paint').length,count);assert.equal(after.codex.lighting.outputOwner.frameCommittedAt,committed);
  assert.equal(after.codex.lighting.outputOwner.reusedCommittedFrame,true);
});

test('paint failure revokes ownership instead of claiming the requested new task colour',async t=>{
  const s=await fixture(t);await mode(s);await s.configure({failPaint:1,tasks:[{...tasks[0],status:'error'},tasks[1]]});
  const failed=await until(s.state,v=>!v.device.armed&&v.playback.lastError,'Output failure was not surfaced');
  assert.equal(failed.settings.codexEnabled,true);assert.equal(failed.codex.lighting.ownsOutput,false);assert.equal(failed.codex.lighting.outputOwner,null);
  await mode(s);await until(s.state,v=>v.device.armed&&v.codex.lighting.ownsOutput&&v.colors[1]==='#ff0033','Explicit mode retry did not recover output');
});

test('stock lighting is rejected while the mode owns task colours and works again after Off',async t=>{
  const s=await fixture(t,{modelId:'kick75',firmwareVersion:'4.0.18.6',mainWholeZone:true,keymap:keymap('kick75')});await mode(s);
  const start=(await s.operations()).length;
  const blocked=await s.command({op:'nativeLighting',mode:3,brightness:40,speed:2,color:'#400000'});
  assert.equal(blocked.ok,false);assert.match(blocked.error,/关闭 Codex 模式/);assert.equal((await s.state()).settings.codexEnabled,true);
  assert.deepEqual((await s.operations()).slice(start).filter(op=>op.op==='nativeLighting'),[]);
  await mode(s,false);await s.ok({op:'nativeLighting',mode:3,brightness:40,speed:2,color:'#400000'});
  const state=await s.state();assert.equal(state.playback.mode,'native');assert.equal(state.codex.lighting.ownsOutput,false);
});
