import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeService,until} from './helpers/fake-service.mjs';
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

const modeRecoveryFixture=()=>{
 const standard=Array(92).fill(0);for(let i=1;i<=12;i++)standard[i]=57+i;
 return {...fixture,permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true},
  tasks:[{id:'recovery-task',title:'Synthetic recovery task',status:'running'}],
  codexKeybindings:[{command:'globalDictationHold',key:'Ctrl+Shift+D'},{command:'globalDictationSingleTap',key:null}],
  keyRecovery:{...recovery,ownsCurrentHandle:false,unownedHistory:true},unownedFunctionKeyHistory:true,
  keymap:{modelId:'kick75',protocol:'kick75-s4-keymap',readOnly:true,geometryVerified:true,matrixKeyCount:90,keymapKeyCount:92,
   firmwareVersion:'4.0.18.6',mode:0,locationId:1,active:standard,defaults:[standard,standard],functionKeyLeaseSupported:false}};
};

test('active Codex or Claude mode refuses an old recovery token before releasing held input or sending HID confirmation',async t=>{
 for(const source of ['codex','claude']){
  const service=await fakeService(t,modeRecoveryFixture());
  const ok=async body=>{const r=await service.command(body);assert.equal(r.ok,true,JSON.stringify(r));return r.result;};
  const old=await ok({op:'previewFunctionKeyRecovery'});
  await ok({op:'agentMode',source,enabled:true});
  if(source==='codex')await ok({op:'codexKey',code:'F9',phase:'down'});
  const before=await service.state(),start=(await service.operations()).length;
  if(source==='codex')assert.equal(before.codex.keys.held.source,'F9');
  const refused=await service.command({op:'confirmFunctionKeyRecovery',token:old.token,confirmSameKeyboard:true});
  assert.equal(refused.ok,false);assert.match(refused.error,source==='claude'?/关闭 Claude Code 模式/:/关闭 Codex 模式/);
  const after=await service.state();assert.deepEqual(after.codex.keys.held,before.codex.keys.held);assert.deepEqual(after.device.keyRecovery,before.device.keyRecovery);
  assert.deepEqual((await service.operations()).slice(start).filter(o=>['confirmFunctionKeyRecovery','restoreFunctionKey','prepareFunctionKey','shortcut'].includes(o.op)),[]);
  if(source==='codex')await ok({op:'codexKey',code:'F9',phase:'up'});
  await ok({op:'agentMode',source,enabled:false});
  const fresh=await ok({op:'previewFunctionKeyRecovery'});assert.notEqual(fresh.token,old.token);
  const recovered=await ok({op:'confirmFunctionKeyRecovery',token:fresh.token,confirmSameKeyboard:true});
  assert.equal(recovered.verified,true);assert.equal((await service.state()).device.keyRecovery.pending,false);
 }
});

test('a confirmation received behind a queued mode On is checked at execution, before any recovery write',async t=>{
 const service=await fakeService(t,{...modeRecoveryFixture(),paintDelayMs:180});
 const ok=async body=>{const r=await service.command(body);assert.equal(r.ok,true,JSON.stringify(r));return r.result;};
 const old=await ok({op:'previewFunctionKeyRecovery'}),start=(await service.operations()).length;
 const painting=service.command({op:'preview',colors:Array(84).fill('#123456')});
 await until(service.operations,ops=>ops.slice(start).some(op=>op.op==='paint'),'Delayed ordinary paint did not start');
 const enabling=service.command({op:'agentMode',source:'codex',enabled:true});
 await new Promise(resolve=>setTimeout(resolve,10));
 const confirming=service.command({op:'confirmFunctionKeyRecovery',token:old.token,confirmSameKeyboard:true});
 assert.equal((await service.state()).settings.codexEnabled,false,'Both commands are waiting behind the ordinary paint');
 assert.equal((await painting).ok,true);assert.equal((await enabling).ok,true);
 const refused=await confirming;assert.equal(refused.ok,false);assert.match(refused.error,/关闭 Codex 模式/);
 assert.deepEqual((await service.operations()).slice(start).filter(op=>op.op==='confirmFunctionKeyRecovery'),[]);
 assert.equal((await service.state()).device.keyRecovery.pending,true);
});
