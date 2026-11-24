// Real application service and process pipes with an explicitly isolated
// protocol peer. No physical device or user library is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';
const identityQualification={status:'qualified',source:'embeddedUsbSerial',reasonCode:null};
const colors=()=>Array(84).fill('#254677');
async function ready(t,options={}) {
  const f=await previewServiceFixture(t,{connected:true,identityQualification,...options}),s=await f.start();
  assert.equal((await s.command({op:'connect'})).ok,!options.recoveryPending);return {f,s};
}
function receipt(s) {const v=s.hostMessages.at(-1);assert.equal(v.event,'hostShutdownComplete');assert.equal(v.protocolVersion,2);return v;}
test('the application admits qualified basic playback and closes both native owners with a bound receipt',async t=>{
  const {f,s}=await ready(t);assert.equal((await s.state()).desktop.capabilities.lighting,true);
  assert.equal((await s.command({op:'preview',colors:colors()})).ok,true);
  assert.equal((await s.command({op:'stop'})).ok,true);
  assert.equal((await s.command({op:'preview',colors:colors()})).ok,true);
  await s.close();const end=receipt(s);assert.equal(end.shutdownId,s.shutdownId);assert.equal(end.success,true);assert.equal(end.keyboardVerified,true);assert.equal(end.recoveryPending,false);assert.equal(end.noMutation,false);
  const rows=await f.operations();const native=rows.find(r=>r.event==='lightingClosed');assert(native?.restored);
  assert.equal(rows.filter(r=>r.op==='arm').length,2);assert.equal(rows.filter(r=>r.op==='quit').length,2);
  assert.equal(rows.filter(r=>r.event==='started').length,2);
});
test('host shutdown bypasses an in-flight application paint and never waits for its ordinary queue',async t=>{
  const {f,s}=await ready(t,{holdLightingPaint:true});
  const paint=s.command({op:'preview',colors:colors()}).catch(error=>({error}));
  const deadline=Date.now()+5000;
  while(!(await f.operations()).some(r=>r.op==='paint'&&r.held===true)){if(Date.now()>deadline)assert.fail('paint was not started');await new Promise(resolve=>setTimeout(resolve,10));}
  await s.close();await paint;const end=receipt(s);assert.equal(end.success,true);assert.equal(end.keyboardVerified,true);
  const rows=await f.operations();assert.equal(rows.filter(r=>r.op==='paint'&&r.held===true).length,1);assert.equal(rows.filter(r=>r.event==='lightingClosed').length,1);
});
test('failed native restoration still closes the probe and emits a failed recovery receipt',async t=>{
  const {f,s}=await ready(t,{failLightingRestore:true});assert.equal((await s.command({op:'preview',colors:colors()})).ok,true);
  await s.close(false,{expectedExit:1});const end=receipt(s);assert.equal(end.shutdownId,s.shutdownId);assert.equal(end.success,false);assert.equal(end.keyboardVerified,false);assert.equal(end.recoveryPending,true);
  const rows=await f.operations();assert.equal(rows.filter(r=>r.op==='quit').length,2);assert.equal(rows.filter(r=>r.event==='lightingClosed').length,1);
});
test('a rejected application paint remains failed but verified rollback still permits normal host shutdown',async t=>{
  const {s}=await ready(t,{failLightingPaint:true});assert.equal((await s.command({op:'preview',colors:colors()})).ok,false);
  await s.close();const end=receipt(s);assert.equal(end.success,true);assert.equal(end.keyboardVerified,true);assert.equal(end.recoveryPending,false);assert.equal(end.noMutation,false);
});
test('lost host input restores an active session and emits no invented shutdown identity',async t=>{
  const {s}=await ready(t);assert.equal((await s.command({op:'preview',colors:colors()})).ok,true);
  await s.close(true);const end=receipt(s);assert.equal(end.shutdownId,null);assert.equal(end.keyboardVerified,true);assert.equal(end.recoveryPending,false);
});
test('verified identity does not enable the observed unqualified firmware or privileged commands',async t=>{
  const {f,s}=await ready(t,{firmwareVersion:'2.0.0.8'});assert.equal((await s.state()).desktop.capabilities.lighting,false);
  for(const body of [{op:'preview',colors:colors()},{op:'play',colors:colors(),animation:{}},{op:'codexKey',code:'F1'}])assert.equal((await s.command(body)).ok,false);
  await s.close();assert.equal(receipt(s).noMutation,true);assert.equal((await f.operations()).some(r=>r.op==='arm'),false);
});
test('the real application refuses unregistered Air reads and cannot offer restoration',async t=>{
  const {s}=await ready(t,{firmwareVersion:'2.0.0.8'});
  assert.equal((await s.command({op:'inspectLighting'})).ok,false);
  const checked=await s.command({op:'checkWindowsRecovery'});assert.equal(checked.ok,true);assert.equal(checked.result.canRestore,false);
  assert.equal((await s.command({op:'recoverWindowsLighting'})).ok,false);
  assert.equal((await s.command({op:'checkWindowsRecovery',path:'external'})).ok,false);
  await s.close();assert.equal(receipt(s).noMutation,true);
});
test('the real application blocks playback for old records then explicitly recovers before normal exit',async t=>{
  const {s}=await ready(t,{recoveryPending:true});
  assert.equal((await s.command({op:'recoverWindowsLighting'})).ok,false);
  const checked=await s.command({op:'checkWindowsRecovery'});assert.equal(checked.ok,true);assert.equal(checked.result.pending.boardSleep,true);
  assert.equal((await s.command({op:'preview',colors:colors()})).ok,false);
  const restored=await s.command({op:'recoverWindowsLighting'});assert.equal(restored.ok,true);assert.equal(restored.result.complete,true);
  assert.equal((await s.state()).device.windowsRecovery.status,'complete');
  await s.close();assert.equal(receipt(s).success,true);
});
test('partial cold recovery remains visible and cannot become a successful host exit',async t=>{
  const {s}=await ready(t,{recoveryPending:true,failColdSleep:true});
  await s.command({op:'checkWindowsRecovery'});const restored=await s.command({op:'recoverWindowsLighting'});
  assert.equal(restored.ok,true);assert.equal(restored.result.complete,false);assert.equal(restored.result.lighting.status,'restored');assert.equal(restored.result.boardSleep.status,'failed');
  const state=await s.state();assert.equal(state.device.windowsRecovery.status,'failed');assert.equal(state.desktop.capabilities.lighting,false);
  assert.equal((await s.command({op:'restore'})).ok,false,'ordinary stop/restore cannot claim that pending cold records were restored');
  await s.close(false,{expectedExit:1});assert.equal(receipt(s).success,false);assert.equal(receipt(s).recoveryPending,true);
});

test('pending key records block playback and a failed key barrier keeps the host exit unverified',async t=>{
  const f=await previewServiceFixture(t,{connected:true,identityQualification,keyRecoveryPending:true,failColdKeys:true}),s=await f.start();
  assert.equal((await s.command({op:'connect'})).ok,false);
  const check=await s.command({op:'checkWindowsRecovery'});assert.equal(check.ok,true);
  assert.deepEqual(check.result.pending.keymapProfiles,[1]);
  assert.equal((await s.command({op:'preview',colors:colors()})).ok,false);
  const restore=await s.command({op:'recoverWindowsLighting'});assert.equal(restore.ok,true);
  assert.equal(restore.result.functionKeys.status,'failed');assert.equal(restore.result.complete,false);
  const state=await s.state();assert.equal(state.device.windowsRecovery.status,'failed');
  assert.deepEqual(state.device.windowsRecovery.pending.keymapProfiles,[1]);assert.equal(state.desktop.capabilities.lighting,false);
  await s.close(false,{expectedExit:1});assert.equal(receipt(s).keyboardVerified,false);assert.equal(receipt(s).recoveryPending,true);
});

test('key records disappearing without their restoration receipt cannot clear a remembered obligation',async t=>{
  const f=await previewServiceFixture(t,{connected:true,identityQualification,keyRecoveryPending:true,omitKeyReceipt:true}),s=await f.start();
  await s.command({op:'connect'});assert.equal((await s.command({op:'checkWindowsRecovery'})).ok,true);
  const result=await s.command({op:'recoverWindowsLighting'});assert.equal(result.ok,false);assert.match(result.error,/缺少恢复证明/);
  assert.equal((await s.command({op:'checkWindowsRecovery'})).ok,false);
  await s.close(false,{expectedExit:1});assert.equal(receipt(s).success,false);assert.equal(receipt(s).recoveryPending,true);
});

test('a separate verified key receipt releases the obligation before normal host shutdown',async t=>{
  const f=await previewServiceFixture(t,{connected:true,identityQualification,keyRecoveryPending:true}),s=await f.start();
  await s.command({op:'connect'});await s.command({op:'checkWindowsRecovery'});
  const result=await s.command({op:'recoverWindowsLighting'});assert.equal(result.ok,true);assert.equal(result.result.complete,true);
  assert.equal(result.result.functionKeys.completion.restoredKeys,2);
  await s.close();assert.equal(receipt(s).success,true);
});
