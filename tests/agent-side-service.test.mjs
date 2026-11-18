import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeService,until} from './helpers/fake-service.mjs';
const aggregate={status:'running',complete:true,fresh:true,count:9,succeeded:0};
async function fixture(t,config={}){const s=await fakeService(t,{sideWholeZone:true,aggregate,permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true},...config});s.ok=async req=>{const r=await s.command(req);assert.equal(r.ok,true,JSON.stringify(r));return r.result;};await s.ok({op:'settings',settings:{codexLightZone:'side',brightness:100,lightDurationMs:0,lightIdleMs:0}});return s;}
const mode=(s,enabled)=>s.ok({op:'agentMode',source:'codex',enabled});
test('completion stays green, idle is white, and unknown never masquerades as idle',async t=>{
 const s=await fixture(t);await mode(s,true);
 await s.configure({aggregate:{...aggregate,status:'completed',succeeded:9}});
 await until(s.state,v=>v.device.sideColor==='#6f9e85','completion not green');
 await s.configure({aggregate:{status:'idle',complete:true,fresh:true,count:0}});
 await until(s.state,v=>v.device.sideColor==='#ffffff'&&v.codex.lighting.side.ownsOutput,'idle not white');
 await s.configure({aggregate:{status:'idle',complete:false,fresh:true,count:0}});
 await until(s.state,v=>!v.codex.lighting.side.ownsOutput,'incomplete idle retained white');
 await mode(s,false);assert.equal((await s.state()).settings.codexEnabled,false);
});
test('side mode only owns command keys; disabling them releases all keys and task dispatch is rejected',async t=>{const s=await fixture(t);await mode(s,true);let v=await s.state();assert.deepEqual(v.codex.keys.bindings.map(k=>k.index),[6,7,8,9,10,11]);assert.equal(v.codex.keys.bindingScope,'commands');assert.equal(v.codex.lighting.ownsOutput,false);assert.equal(v.codex.lighting.side.ownsOutput,true);const r=await s.command({op:'codexKey',index:0});assert.equal(r.ok,false);await s.ok({op:'settings',settings:{codexCommandKeysEnabled:false}});v=await s.state();assert.equal(v.codex.keys.enabled,false);assert.equal(v.codex.keys.bindings.length,0);await s.ok({op:'settings',settings:{codexLightZone:'backlight'}});v=await s.state();assert.deepEqual(v.codex.keys.bindings.map(k=>k.index),[0,1,2,3,4,5]);});
test('side status preserves ordinary artwork and restores side state on Off',async t=>{const s=await fixture(t);const colors=Array(84).fill('#123456');await s.ok({op:'preview',colors});const start=(await s.operations()).length;await mode(s,true);let v=await s.state();assert.deepEqual(v.colors,colors);assert.equal(v.playback.mode,'static');assert.equal(v.device.sideColor,'#3976da');await mode(s,false);v=await s.state();assert.deepEqual(v.colors,colors);assert.equal(v.codex.lighting.side.ownsOutput,false);const ops=(await s.operations()).slice(start);assert.ok(ops.some(o=>o.op==='side'&&o.restore));assert.ok(!ops.some(o=>o.op==='restore'));});
test('incomplete or stale collection releases a prior green output',async t=>{for(const patch of [{complete:false},{fresh:false}]){const s=await fixture(t);await mode(s,true);await s.configure({aggregate:{...aggregate,status:'completed',...patch}});await until(s.operations,ops=>ops.some(o=>o.op==='side'&&o.restore),'stale aggregate retained hardware output');assert.ok((await s.operations()).some(o=>o.op==='side'&&o.restore));}});
test('removing AI assistant releases side output and shortcuts; adding it leaves mode Off',async t=>{const s=await fixture(t);await mode(s,true);const before=await s.state();await s.ok({op:'settings',settings:{sidebarFeatures:before.settings.sidebarFeatures.filter(x=>x!=='codex')}});let v=await s.state();assert.equal(v.codex.keys.enabled,false);assert.equal(v.codex.lighting.side.ownsOutput,false);assert.ok((await s.operations()).some(o=>o.op==='side'&&o.restore));await s.ok({op:'settings',settings:{sidebarFeatures:before.settings.sidebarFeatures}});v=await s.state();assert.equal(v.settings.codexEnabled,false);assert.equal(v.codex.lighting.side.ownsOutput,false);});
test('unsupported side capability does not write; other models retain prior backlight and task keys',async t=>{
 const missing=await fixture(t,{sideWholeZone:false});const start=(await missing.operations()).length;await mode(missing,true);assert.ok(!(await missing.operations()).slice(start).some(o=>o.op==='side'));
 const kick=await fixture(t,{modelId:'kick75'});await mode(kick,true);const v=await kick.state();assert.equal(v.codex.lighting.zone,'backlight');assert.equal(v.codex.keys.bindings.length,12);assert.equal(v.codex.lighting.side.ownsOutput,false);assert.equal(v.settings.codexLightZone,'side');
});

test('switching to side mode releases the F4 board lease and maps only F7–F12',async t=>{
 const {FACTORY_MAC_ROW}=await import('../shared/keycap-functions.mjs');const standard=Array(98).fill(0),mac=Array(98).fill(0);
 for(let i=1;i<=12;i++){standard[i]=57+i;mac[i]=FACTORY_MAC_ROW[i-1];}
 const s=await fixture(t,{firmwareVersion:'1.0.23.6',keymap:{modelId:'air75-v3',protocol:'air75-s4-keymap',matrixKeyCount:96,keymapKeyCount:98,readOnly:true,geometryVerified:true,mode:0,locationId:1,active:mac,defaults:[mac,standard],functionKeyLeaseSupported:true,firmwareVersion:'1.0.23.6'}});
 await s.ok({op:'settings',settings:{codexLightZone:'backlight'}});await mode(s,true);
 assert.ok((await s.operations()).some(o=>o.op==='prepareFunctionKey'));const start=(await s.operations()).length;
 await s.ok({op:'settings',settings:{codexLightZone:'side'}});const ops=(await s.operations()).slice(start);
 assert.ok(ops.some(o=>o.op==='restoreFunctionKey'));assert.ok(!ops.some(o=>o.op==='prepareFunctionKey'));
 const state=await s.state();assert.deepEqual(state.codex.adaptation.ready,['F7','F8','F9','F10','F11','F12']);
 assert.deepEqual(state.codex.adaptation.boardAdapted,[]);
});

test('an idle side mode retires quota green and displays white',async t=>{const s=await fixture(t,{aggregate:{status:'idle',complete:true,fresh:true,count:0}});await s.ok({op:'settings',settings:{quotaSideEnabled:true}});await until(s.state,v=>v.device.sideColor==='#6f9e85','quota was not set');const start=(await s.operations()).length;await mode(s,true);const v=await s.state();assert.equal(v.device.sideColor,'#ffffff');assert.equal(v.codex.lighting.side.ownsOutput,true);assert.ok((await s.operations()).slice(start).some(o=>o.op==='side'&&o.restore));});
test('failed same-color brightness writes withdraw ownership even if native rollback is unconfirmed',async t=>{const s=await fixture(t,{sideRollback:false});await s.ok({op:'preview',colors:Array(84).fill('#123456')});await mode(s,true);assert.equal((await s.state()).codex.lighting.side.ownsOutput,true);await s.configure({failSide:true});const r=await s.command({op:'settings',settings:{codexBrightness:42}});assert.equal(r.ok,false);assert.equal((await s.state()).codex.lighting.side.ownsOutput,false);await s.configure({failSide:false});await until(s.state,v=>v.codex.lighting.side.ownsOutput===true,'side ownership did not recover after verified write');});

test('Off remains persisted and keys stay released when side restoration fails',async t=>{const s=await fixture(t);await mode(s,true);await s.configure({failSide:true,sideRollback:false});const result=await s.command({op:'agentMode',source:'codex',enabled:false});assert.equal(result.ok,false);let v=await s.state();assert.equal(v.settings.codexEnabled,false);assert.equal(v.codex.keys.enabled,false);assert.equal(v.codex.lighting.side.ownsOutput,false);await s.configure({failSide:false});await until(s.operations,ops=>ops.some(o=>o.op==='side'&&o.restore),'off restoration not retried');v=await s.state();assert.equal(v.settings.codexEnabled,false);});
test('USB reconnect cannot consume a green observation from the prior connection',async t=>{const s=await fixture(t);await s.ok({op:'settings',settings:{autoConnect:false}});await mode(s,true);await s.configure({disconnect:1});await until(s.state,v=>!v.device.connected,'disconnect absent');const pre=Date.now()-10;await s.configure({aggregate:{...aggregate,status:'completed',succeeded:9,observedAt:pre}});const start=(await s.operations()).length;await s.ok({op:'connect'});assert.equal((await s.state()).codex.lighting.side.ownsOutput,false);assert.ok(!(await s.operations()).slice(start).some(o=>o.op==='side'&&o.color==='#6f9e85'));await s.configure({aggregate:{...aggregate}});await until(s.state,v=>v.codex.lighting.side.ownsOutput,'fresh post-connect observation did not resume');});
test('manual disconnect and official-driver handoff both retire the old cohort',async t=>{for(const op of ['disconnect','prepareFirmwareUpdate']){const s=await fixture(t);await mode(s,true);const observedAt=Date.now()-10;await s.ok({op});await s.configure({aggregate:{...aggregate,status:'completed',observedAt}});const start=(await s.operations()).length;await s.ok({op:'connect'});assert.equal((await s.state()).codex.lighting.side.ownsOutput,false);assert.ok(!(await s.operations()).slice(start).some(o=>o.op==='side'&&o.color==='#6f9e85'));}});
test('profile changes invalidate side receipts and use the new profile only after fresh observation',async t=>{const s=await fixture(t);await mode(s,true);const before=await s.state();const observedAt=Date.now()-10;await s.configure({lightingProfile:1,aggregate:{...aggregate,observedAt}});await until(s.state,v=>v.device.lightingProfile===1,'profile not observed',6500);let v=await s.state();assert.equal(v.codex.lighting.side.ownsOutput,false);assert.equal(v.device.connectionSessionId,before.device.connectionSessionId);await s.configure({aggregate:{...aggregate}});await until(s.state,v=>v.codex.lighting.side.ownsOutput,'fresh new-profile receipt not produced');});

test('Off persists even if a held dictation command cannot release',async t=>{
 const s=await fixture(t,{freshLibrary:true});await mode(s,true);const held=await s.nativeKey({op:'codexKey',code:'F11'});assert.equal(held.ok,true,JSON.stringify(held));
 await s.configure({codexControlError:{code:'CONTROL_CAPTURE_STOP_UNCONFIRMED',message:'synthetic held release failed'}});
 const off=await s.command({op:'agentMode',source:'codex',enabled:false});assert.equal(off.ok,false);
 const v=await s.state();assert.equal(v.settings.codexEnabled,false);assert.equal(v.codex.keys.enabled,false);assert.equal(v.codex.lighting.side.ownsOutput,false);
 await s.configure({codexControlError:null});assert.equal((await s.nativeKey({op:'codexKey',code:'F7'})).ok,false);
});
test('a signed late key-down cannot acquire a new binding or block a fresh press',async t=>{
 const s=await fixture(t);await s.ok({op:'settings',settings:{codexLightZone:'backlight'}});await mode(s,true);const old=(await s.state()).codex.keys.bindingEpoch;
 await s.ok({op:'settings',settings:{codexLightZone:'side',codexTaskKeys:['F1','F2','F3','F7','F5','F6'],codexCommandKeys:['F4','F8','F9','F10','F11','F12'],codexCommandIds:['settings','newTask','dictation','voice','toggleTerminal','newWindow']}});
 const start=(await s.operations()).length;assert.equal((await s.nativeKey({op:'codexKey',code:'F4',gestureId:'old:1',nativeKeyBindingEpoch:old})).ok,false);assert.ok(!(await s.operations()).slice(start).some(o=>o.op==='shortcut'));
 assert.equal((await s.nativeKey({op:'codexKey',code:'F4',gestureId:'new:1'})).ok,true);assert.ok((await s.operations()).slice(start).some(o=>o.op==='shortcut'));
});
test('returning to a dormant side profile restores its journal even with idle tasks',async t=>{
 const s=await fixture(t);await mode(s,true);await s.configure({lightingProfile:1,aggregate:{status:'idle',complete:true,fresh:true,count:0}});
 await until(s.state,v=>v.device.lightingProfile===1,'Win profile missing',6500);const start=(await s.operations()).length;
 await s.configure({lightingProfile:0});await until(s.state,v=>v.device.lightingProfile===0 && v.device.sideRecoveryPending===false,'returned Mac side lease not recovered',6500);
 assert.ok((await s.operations()).slice(start).some(o=>o.op==='side'&&o.restore));
 await until(s.state,v=>v.codex.lighting.side.ownsOutput&&v.device.sideColor==='#ffffff','fresh idle did not resume white after recovery');
 await s.configure({aggregate});await until(s.state,v=>v.codex.lighting.side.ownsOutput&&v.device.sideColor==='#3976da','new post-recovery task did not start');
});

for (const lightMode of ['whole','keys']) for (const fault of ['none','heldRelease',...(lightMode==='whole'?['sideRestore']:[])]) {
 test(`Off returns ordinary artwork and original side state from ${lightMode} with ${fault}`,async t=>{
  const s=await fakeService(t,{freshLibrary:true,sideWholeZone:true,tasks:[{id:'off-a',title:'Generated task',status:'running'}],permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}});
  const ok=async req=>{const r=await s.command(req);assert.equal(r.ok,true,JSON.stringify(r));return r;};
  const art=Array(84).fill('#123456');
  await ok({op:'settings',settings:{codexLightMode:lightMode,codexWholeTaskId:'off-a',codexSelectedPulse:false,codexAmbient:false,brightness:100,quotaSideEnabled:false,lightDurationMs:0,lightIdleMs:0}});
  await ok({op:'preview',colors:art});const originalSide=(await s.state()).device.state.slice(9,17);
  await ok({op:'agentMode',source:'codex',enabled:true});
  if(fault==='heldRelease') {
   assert.equal((await s.nativeKey({op:'codexKey',code:'F11'})).ok,true);
   await s.configure({codexControlError:{code:'CONTROL_CAPTURE_STOP_UNCONFIRMED',message:'generated stop failure'}});
  } else if(fault==='sideRestore') await s.configure({failSide:true,sideRollback:false});
  const off=await s.command({op:'agentMode',source:'codex',enabled:false});assert.equal(off.ok,fault==='none');
  let v=await s.state();assert.equal(v.settings.codexEnabled,false);assert.equal(v.codex.keys.enabled,false);
  assert.equal(v.playback.mode,'static');assert.equal(v.device.armed,true);assert.deepEqual(v.colors,art);
  await s.configure({failSide:false,codexControlError:null});
  await until(s.state,v=>JSON.stringify(v.device.state.slice(9,17))===JSON.stringify(originalSide),'original side did not recover after Off');
  v=await s.state();assert.equal(v.device.armed,true);assert.equal(v.playback.mode,'static');assert.deepEqual(v.colors,art);
 });
}

test('side-output errors leave a playing ordinary animation running',async t=>{
 const s=await fixture(t,{sideRollback:false});const art=Array(84).fill('#123456');
 await s.ok({op:'play',colors:art,animation:{effect:'frames',speed:4,loop:true,frames:[{colors:art,duration:800},{colors:Array(84).fill('#aabbcc'),duration:800}]}});
 await mode(s,true);await s.configure({failSide:true,aggregate:{...aggregate,status:'waiting'}});
 await until(s.state,v=>v.playback.lastError!==null,'side failure not observed');
 let v=await s.state();assert.equal(v.device.armed,true);assert.equal(v.playback.playing,true);assert.equal(v.playback.mode,'animation');assert.equal(v.codex.lighting.side.ownsOutput,false);
 const frames=v.playback.framesSent;await s.configure({failSide:false});
 await until(s.state,v=>v.codex.lighting.side.ownsOutput && v.playback.framesSent>frames,'animation and side receipt did not both recover');
});

for(const eventSource of ['carbon','local'])test(`an unsigned ${eventSource} packet still honors its recorded binding epoch`,async t=>{
 const s=await fixture(t);await s.ok({op:'settings',settings:{codexLightZone:'backlight'}});await mode(s,true);const old=(await s.state()).codex.keys.bindingEpoch;
 await s.ok({op:'settings',settings:{codexLightZone:'side',codexTaskKeys:['F1','F2','F3','F7','F5','F6'],codexCommandKeys:['F4','F8','F9','F10','F11','F12'],codexCommandIds:['settings','newTask','dictation','voice','toggleTerminal','newWindow']}});
 const start=(await s.operations()).length;
 assert.equal((await s.command({op:'codexKey',code:'F4',phase:'down',eventSource,gestureId:'old:'+eventSource,nativeKeyBindingEpoch:old})).ok,false);
 assert.ok(!(await s.operations()).slice(start).some(o=>o.op==='shortcut'));
 const current=(await s.state()).codex.keys.bindingEpoch;
 assert.equal((await s.command({op:'codexKey',code:'F4',phase:'down',eventSource,gestureId:'new:'+eventSource,nativeKeyBindingEpoch:current})).ok,true);
});

for(const removeFeature of [false,true])test(`exclusive AI restore retries after failure; feature removal=${removeFeature}`,async t=>{
 const s=await fakeService(t,{freshLibrary:true,sideWholeZone:true,tasks:[{id:'restore-a',status:'running'}],permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}});
 const ok=async req=>{const r=await s.command(req);assert.equal(r.ok,true,JSON.stringify(r));return r;};
 await ok({op:'settings',settings:{codexLightMode:'whole',codexWholeTaskId:'restore-a',quotaSideEnabled:false}});await ok({op:'agentMode',source:'codex',enabled:true});
 await s.configure({failWholeRestore:true});const offset=(await s.operations()).length;
 const request=removeFeature?{op:'settings',settings:{sidebarFeatures:(await s.state()).settings.sidebarFeatures.filter(x=>x!=='codex')}}:{op:'agentMode',source:'codex',enabled:false};
 assert.equal((await s.command(request)).ok,false);assert.equal((await s.state()).settings.codexEnabled,false);
 await s.configure({failWholeRestore:false});await until(s.state,v=>!v.device.recoveryPending&&!v.device.armed&&v.device.state[10]===65,'exclusive restore not retried');
 assert.ok((await s.operations()).slice(offset).filter(x=>x.op==='restore').length>=2);
});
test('feature removal retains cleanup after a side error and repaints the ordinary work',async t=>{
 const s=await fakeService(t,{freshLibrary:true,sideWholeZone:true,tasks:[{id:'remove-a',status:'running'}],permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}});
 const ok=async req=>{const r=await s.command(req);assert.equal(r.ok,true,JSON.stringify(r));return r;};const art=Array(84).fill('#123456');
 await ok({op:'settings',settings:{codexLightMode:'whole',codexWholeTaskId:'remove-a',brightness:100,quotaSideEnabled:false,lightDurationMs:0,lightIdleMs:0}});
 await ok({op:'preview',colors:art});await ok({op:'agentMode',source:'codex',enabled:true});await s.configure({failSide:true,sideRollback:false});
 assert.equal((await s.command({op:'settings',settings:{sidebarFeatures:(await s.state()).settings.sidebarFeatures.filter(x=>x!=='codex')}})).ok,false);
 assert.deepEqual((await s.state()).colors,art);await s.configure({failSide:false});
 await until(s.state,v=>v.device.state[10]===65,'feature removal did not retry side restoration');const v=await s.state();assert.equal(v.device.armed,true);assert.deepEqual(v.colors,art);assert.equal(v.codex.keys.enabled,false);
});
test('a new ordinary work supersedes a failed exclusive AI restore ticket',async t=>{
 const s=await fakeService(t,{freshLibrary:true,sideWholeZone:true,tasks:[{id:'new-work',status:'running'}],permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}});
 const ok=async req=>{const r=await s.command(req);assert.equal(r.ok,true,JSON.stringify(r));return r;};
 await ok({op:'settings',settings:{brightness:100}});await ok({op:'agentMode',source:'codex',enabled:true});await s.configure({failWholeRestore:true});assert.equal((await s.command({op:'agentMode',source:'codex',enabled:false})).ok,false);
 const art=Array(84).fill('#123456');await ok({op:'preview',colors:art});const offset=(await s.operations()).length;await s.configure({failWholeRestore:false});
 await new Promise(r=>setTimeout(r,200));const v=await s.state();assert.equal(v.device.armed,true);assert.equal(v.playback.mode,'static');assert.deepEqual(v.colors,art);assert.ok(!(await s.operations()).slice(offset).some(x=>x.op==='restore'));
});

test('the first side write is fenced to the profile of its task observation',async t=>{
 const s=await fixture(t,{aggregate:{status:'unknown',complete:false,fresh:true,count:0}});await mode(s,true);
 assert.ok(!(await s.operations()).some(o=>o.op==='side'));const observedAt=Date.now();await new Promise(r=>setTimeout(r,10));
 await s.configure({lightingProfile:1,aggregate:{...aggregate,status:'completed',succeeded:9,observedAt}});
 await until(s.state,v=>v.device.lightingProfile===1,'first profile change was not refreshed');
 let v=await s.state();assert.equal(v.codex.lighting.side.ownsOutput,false);
 const writes=(await s.operations()).filter(o=>o.op==='side'&&!o.restore);
 assert.ok(writes.length>=1);assert.ok(writes.every(o=>o.expectedProfile===0));assert.notDeepEqual(v.device.state.slice(14,17),[111,158,133]);
 await s.configure({aggregate});await until(s.state,v=>v.codex.lighting.side.ownsOutput,'fresh profile observation did not resume');
 assert.equal((await s.operations()).filter(o=>o.op==='side'&&!o.restore).at(-1).expectedProfile,1);
});

async function exclusiveCleanupFixture(t) {
 const s=await fakeService(t,{freshLibrary:true,sideWholeZone:true,recordVisibleWrites:true,aggregate,tasks:[{id:'scoped-cleanup',status:'running'}],permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}});
 s.ok=async req=>{const r=await s.command(req);assert.equal(r.ok,true,JSON.stringify(r));return r.result;};
 await s.ok({op:'settings',settings:{codexLightZone:'backlight',codexLightMode:'whole',codexWholeTaskId:'scoped-cleanup',codexSelectedPulse:false,codexBrightness:100,quotaSideEnabled:false,lightDurationMs:0,lightIdleMs:0,autoConnect:false}});
 await mode(s,true);await s.configure({failWholeRestore:true});return s;
}
for (const direct of [false,true]) test(`side takeover finishes prior exclusive main recovery; direct transition=${direct}`,async t=>{
 const s=await exclusiveCleanupFixture(t);let r;
 if(!direct) {assert.equal((await s.command({op:'agentMode',source:'codex',enabled:false})).ok,false);r=await s.command({op:'settings',settings:{codexLightZone:'side',codexEnabled:true}});}
 else r=await s.command({op:'settings',settings:{codexLightZone:'side'}});
 assert.equal(r.ok,false);assert.equal((await s.state()).settings.codexLightZone,'side');assert.equal((await s.state()).codex.lighting.side.ownsOutput,false);
 const mark=(await s.operations()).length;await s.configure({failWholeRestore:false});
 await until(s.state,v=>v.playback.mode==='idle'&&!v.device.armed&&v.codex.lighting.side.ownsOutput,'side output did not wait for and follow main recovery',6500);
 const ops=(await s.operations()).slice(mark), restored=ops.findIndex(o=>o.event==='simulatedRestore'), side=ops.findIndex(o=>o.op==='side'&&!o.restore);
 assert.ok(restored>=0 && side>restored);assert.ok(ops.filter(o=>o.op==='restore').every(o=>o.expectedProfile===0));
 const visible=ops.filter(o=>o.event==='simulatedVisibleWrite').at(-1);assert.ok(visible.colors.slice(0,84).every(c=>c==='#000000'));
});
test('failed whole Off survives a same-USB Mac/Win return and restores only its original profile',async t=>{
 const s=await exclusiveCleanupFixture(t);assert.equal((await s.command({op:'agentMode',source:'codex',enabled:false})).ok,false);
 const session=(await s.state()).device.connectionSessionId;await s.configure({lightingProfile:1});
 await until(s.state,v=>v.device.lightingProfile===1,'Win missing',6500);const mark=(await s.operations()).length;
 await s.configure({failWholeRestore:false});await new Promise(r=>setTimeout(r,100));assert.ok(!(await s.operations()).slice(mark).some(o=>o.op==='restore'));
 await s.configure({lightingProfile:0});await until(s.state,v=>v.device.lightingProfile===0&&!v.device.recoveryPending,'Mac cleanup lost on round trip',6500);
 assert.equal((await s.state()).device.connectionSessionId,session);const restored=(await s.operations()).slice(mark).filter(o=>o.op==='restore');assert.ok(restored.length>0);assert.ok(restored.every(o=>o.expectedProfile===0));
});
test('a stale worker profile cannot restore the other profile before status catches up',async t=>{
 const s=await exclusiveCleanupFixture(t);const mark=(await s.operations()).length;
 await s.configure({lightingProfile:1,failWholeRestore:false});assert.equal((await s.command({op:'agentMode',source:'codex',enabled:false})).ok,false);
 const ops=(await s.operations()).slice(mark);assert.ok(ops.some(o=>o.op==='restore'&&o.expectedProfile===0));assert.ok(!ops.some(o=>o.event==='simulatedRestore'&&o.lightingProfile===1));
 await until(s.state,v=>v.device.lightingProfile===1,'new profile missing',6500);await s.configure({lightingProfile:0});
 await until(s.state,v=>v.device.lightingProfile===0&&!v.device.recoveryPending,'original profile not recovered',6500);
});

test('ordinary work is repainted when switching whole overlay to side even if its first release fails',async t=>{
 const s=await exclusiveCleanupFixture(t);await s.configure({failWholeRestore:false});const art=Array(84).fill('#123456');
 await s.ok({op:'settings',settings:{brightness:100}});await s.ok({op:'preview',colors:art});
 assert.notDeepEqual((await s.state()).colors,art);await s.configure({failSide:true,sideRollback:false});
 assert.equal((await s.command({op:'settings',settings:{codexLightZone:'side'}})).ok,false);
 await until(s.state,v=>JSON.stringify(v.colors)===JSON.stringify(art),'ordinary main overlay was not retired');
 assert.equal((await s.state()).device.armed,true);await s.configure({failSide:false});
 await until(s.state,v=>v.codex.lighting.side.ownsOutput,'ordinary main plus side not recovered');
 const v=await s.state();assert.equal(v.playback.mode,'static');assert.equal(v.device.armed,true);assert.deepEqual(v.colors,art);
});

for(const replacement of ['audio','game','trigger'])test(`failed prior AI cleanup yields both zones to a newer ${replacement}`,async t=>{
 const s=await exclusiveCleanupFixture(t);assert.equal((await s.command({op:'agentMode',source:'codex',enabled:false})).ok,false);
 if(replacement==='game')await s.ok({op:'settings',settings:{sidebarFeatures:[...(await s.state()).settings.sidebarFeatures,'game']}});
 if(replacement==='audio')await s.ok({op:'audioInventory',systemSupported:true,devices:[],microphonePermission:true});
 const mark=(await s.operations()).length;
 if(replacement==='audio')await s.ok({op:'audioStart'});
 else if(replacement==='game')await s.ok({op:'gameStart',gameType:'snake',speed:1});
 else await s.ok({op:'triggerArm',colors:Array(84).fill('#123456'),trigger:{count:3,intervalMs:200}});
 await new Promise(r=>setTimeout(r,240));const v=await s.state();assert.equal(v.playback.mode,replacement);assert.equal(v.device.armed,true);assert.equal(v.device.state[10],0);
 assert.ok(!(await s.operations()).slice(mark).some(o=>o.op==='restore'||o.op==='side'&&o.restore));
 await s.configure({failWholeRestore:false});
});
