import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeService} from './helpers/fake-service.mjs';
const recovery={status:'confirmationRequired',pending:true,blocking:true,errorCode:'KEY_LEASE_DEVICE',error:'请确认仍为原键盘。'};
const fixture={modelId:'kick75',firmwareVersion:'4.0.18.6',keyRecovery:recovery};
test('a pending F4 journal is distinct from protocol compatibility and preview is read-only',async t=>{
 const service=await fakeService(t,fixture);const before=await service.state();
 assert.equal(before.device.connected,true);assert.equal(before.device.capabilities.perKey,true);
 assert.equal(before.device.keyRecovery.status,'confirmationRequired');
 const start=(await service.operations()).length;
 const preview=await service.command({op:'previewFunctionKeyRecovery'});
 assert.equal(preview.ok,true);assert.equal(preview.result.canConfirm,true);
 assert(!(await service.operations()).slice(start).some(o=>['prepareFunctionKey','confirmFunctionKeyRecovery','paint','arm','disconnect'].includes(o.op)));
 assert.deepEqual((await service.state()).settings,before.settings);
});
test('recovery confirmation requires explicit same-keyboard approval and a current preview token',async t=>{
 const service=await fakeService(t,fixture);const original=await service.state();
 const a=(await service.command({op:'previewFunctionKeyRecovery'})).result;
 const b=(await service.command({op:'previewFunctionKeyRecovery'})).result;
 const start=(await service.operations()).length;
 assert.equal((await service.command({op:'confirmFunctionKeyRecovery',token:b.token})).ok,false);
 assert(!(await service.operations()).slice(start).some(o=>o.op==='confirmFunctionKeyRecovery'));
 assert.equal((await service.command({op:'confirmFunctionKeyRecovery',token:a.token,confirmSameKeyboard:true})).ok,false);
 const result=await service.command({op:'confirmFunctionKeyRecovery',token:b.token,confirmSameKeyboard:true});
 assert.equal(result.ok,true);assert.equal(result.result.archived,true);
 const current=await service.state();assert.equal(current.device.keyRecovery.status,'none');
 assert.deepEqual(current.settings,original.settings);assert.deepEqual(current.scenes,original.scenes);
 assert.equal((await service.command({op:'confirmFunctionKeyRecovery',token:b.token,confirmSameKeyboard:true})).ok,false);
});
test('an incompatible recovery preview cannot authorize writes or a safe firmware handoff',async t=>{
 const service=await fakeService(t,{...fixture,recoveryCanConfirm:false});
 const preview=(await service.command({op:'previewFunctionKeyRecovery'})).result;assert.equal(preview.canConfirm,false);
 assert.equal((await service.command({op:'confirmFunctionKeyRecovery',token:preview.token,confirmSameKeyboard:true})).ok,false);
 const result=await service.command({op:'prepareFirmwareUpdate'});assert.equal(result.ok,false);
 assert.equal(result.result?.url,undefined);assert.equal((await service.state()).device.functionKeyRecoveryPending,true);
});

test('unowned historical records remain retained while a clean USB handoff succeeds without confirming or rewriting them',async t=>{
 const service=await fakeService(t,{...fixture,keyRecovery:{...recovery,ownsCurrentHandle:false,unownedHistory:true},unownedFunctionKeyHistory:true});
 const start=(await service.operations()).length;
 const result=await service.command({op:'prepareFirmwareUpdate'});assert.equal(result.ok,true);
 const state=await service.state();assert.equal(state.device.connected,false);assert.equal(state.device.functionKeyRecoveryPending,true);assert.equal(state.device.error,null);
 assert.equal(state.device.unownedFunctionKeyHistory,true);
 assert(!(await service.operations()).slice(start).some(o=>['prepareFunctionKey','confirmFunctionKeyRecovery','restoreFunctionKey'].includes(o.op)));
});
test('unowned history never masks an owned mutation or lost original journal during handoff',async t=>{
 for(const unsafe of [{unsafeWritesNeeded:true},{historicalRecoveryLost:true}]){
  const service=await fakeService(t,{...fixture,keyRecovery:{...recovery,ownsCurrentHandle:false},unownedFunctionKeyHistory:true,...unsafe});
  const result=await service.command({op:'prepareFirmwareUpdate'});assert.equal(result.ok,false);assert.equal(result.result?.url,undefined);
  assert.equal((await service.state()).device.connected,false,'failed preparation must still release USB');
 }
});
