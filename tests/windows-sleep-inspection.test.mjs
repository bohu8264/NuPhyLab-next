import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {SleepInspection} from '../server/lighting-inspection.mjs';
import {validateReadonlyResult,NATIVE_READONLY,validateHello} from '../server/native-contract.mjs';
import {getSleepReadLength} from '../shared/keyboard-models.mjs';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';

const snapshot=()=>({modelId:'air75-v3',firmwareVersion:'2.0.0.7',lightingProfile:1,enabled:true,
  state:[1,10,30,213],readOnly:true,noMutation:true,restorationReady:false});
function hardware(){
  const h=new EventEmitter();h.transportEpoch=0;
  h.state={connected:true,identified:true,readOnly:true,armed:false,modelId:'air75-v3',firmwareVersion:'2.0.0.7',lightingProfile:1,connectionSessionId:'test:1'};
  h.request=async op=>{assert.equal(op,'sleepSnapshot');return snapshot();};return h;
}
test('sleep observations preserve bytes privately in memory and expire on connection firmware profile or epoch changes',async()=>{
  const h=hardware(),reader=new SleepInspection(h,{now:()=>123});
  const value=await reader.read();assert.equal(value.capturedAt,123);value.state[3]=0;
  assert.equal(reader.snapshot().state[3],213);assert.equal(reader.snapshot().restorationReady,false);
  for(const field of ['lightingProfile','firmwareVersion','connectionSessionId']){
    const before=h.state[field];h.state[field]=field==='lightingProfile'?0:'changed';
    assert.equal(reader.snapshot(),null);h.state[field]=before;assert.equal(reader.snapshot(),null);await reader.read();
  }
  h.transportEpoch++;assert.equal(reader.snapshot(),null);await reader.read();
  h.emit('disconnected');assert.equal(reader.snapshot(),null);
});
test('sleep reads require their own exact schema and never borrow lighting or restoration eligibility',async()=>{
  assert.equal(getSleepReadLength('air75-v3','1.0.23.6'),4);
  for(const [model,version] of [['air75-v3','2.0.0.8'],['kick75','4.0.18.6'],['air65-v3','1.0.5.6']]){
    const h=hardware();h.state.modelId=model;h.state.firmwareVersion=version;
    h.request=async()=>assert.fail('unsupported sleep reader must not reach a helper');
    await assert.rejects(new SleepInspection(h).read(),{code:'SLEEP_SCHEMA_UNVERIFIED'});
  }
  const h=hardware();h.request=async()=>{h.state.lightingProfile=0;return snapshot();};
  const reader=new SleepInspection(h);await assert.rejects(reader.read(),{code:'SNAPSHOT_SESSION_CHANGED'});assert.equal(reader.snapshot(),null);
});
test('sleep contract rejects altered flags unknown fields invalid bytes and peers missing the read capability',()=>{
  assert.doesNotThrow(()=>validateReadonlyResult('sleepSnapshot',snapshot()));
  for(const patch of [{enabled:false},{state:[2,10,30,0]},{state:[1,10,30]},{state:[1,256,30,0]},
    {state:[1,1.5,30,0]},{serial:'private'},{restorationReady:true},{readOnly:false},{noMutation:false},{firmwareVersion:'2.0.0.8'}])
    assert.throws(()=>validateReadonlyResult('sleepSnapshot',{...snapshot(),...patch}),{code:'BRIDGE_PROTOCOL_ERROR'});
  const session='12345678-1234-1234-1234-123456789abc',capabilities={...NATIVE_READONLY.capabilities};
  delete capabilities.sleepSnapshot;
  assert.throws(()=>validateHello({...NATIVE_READONLY,sessionId:session,implementationVersion:'1.2.40',readOnly:true,capabilities},session),{code:'BRIDGE_PROTOCOL_MISMATCH'});
});
test('isolated Windows service reads board sleep without a lighting owner and clears it on disconnect',{timeout:15000},async t=>{
  const f=await previewServiceFixture(t,{connected:true,firmwareVersion:'2.0.0.7'}),service=await f.start();
  await service.command({op:'connect'});
  assert.equal((await service.state()).device.sleepSnapshot,null);
  const read=await service.command({op:'inspectSleep'});assert.equal(read.ok,true);assert.equal(read.result.enabled,true);
  assert.deepEqual((await service.state()).device.sleepSnapshot.state,[1,10,30,213]);
  for(const key of ['serial','path','lightingProfile','enabled'])assert.equal((await service.command({op:'inspectSleep',[key]:0})).ok,false);
  assert.equal((await service.command({op:'preview',colors:Array(84).fill('#000000')})).ok,false);
  await service.command({op:'disconnect'});assert.equal((await service.state()).device.sleepSnapshot,null);
  await service.close();assert(!(await f.operations()).some(r=>['arm','paint','nativeLighting','side'].includes(r.op)));
});
test('isolated Windows service refuses unregistered sleep firmware before native observation',{timeout:15000},async t=>{
  const f=await previewServiceFixture(t,{connected:true,firmwareVersion:'2.0.0.8'}),service=await f.start();
  await service.command({op:'connect'});assert.equal((await service.command({op:'inspectSleep'})).ok,false);
  await service.close();assert(!(await f.operations()).some(r=>r.op==='sleepSnapshot'));
});
