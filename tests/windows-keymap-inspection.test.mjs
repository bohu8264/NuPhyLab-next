import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {getKeyboardProfile} from '../shared/keyboard-models.mjs';
import {FACTORY_MAC_ROW} from '../shared/keycap-functions.mjs';
import {validKeymapSnapshot,summarizeFunctionKeys} from '../shared/function-keymap.mjs';
import {inspectWindowsFunctionKeyPreparation} from '../shared/windows-function-key-preparation.mjs';
import {KeymapInspection} from '../server/lighting-inspection.mjs';
import {validateReadonlyResult} from '../server/native-contract.mjs';
import {validatePreviewCommand} from '../server/platform/preview-policy.mjs';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';
export function sample(modelId='air75-v3',firmwareVersion=(getKeyboardProfile(modelId).windowsQualifiedFirmware??getKeyboardProfile(modelId).qualifiedFirmware)){
  const p=getKeyboardProfile(modelId),n=p.rows*p.columns+p.extraKeys,defaults=[Array(n).fill(4),Array(n).fill(4)];
  for(let i=0;i<12;i++){defaults[0][i+1]=FACTORY_MAC_ROW[i];defaults[1][i+1]=58+i;}
  defaults[0][30]=39;defaults[1][30]=39;
  return {modelId,firmwareVersion,lightingProfile:1,matrixKeyCount:p.rows*p.columns,keymapKeyCount:n,active:[...defaults[1]],defaults,readOnly:true,noMutation:true,restorationReady:false};
}
test('summaries distinguish all F-key modes and never include raw keymap or device identity',()=>{
  const raw=sample(),before=structuredClone(raw);assert.equal(summarizeFunctionKeys(raw).status,'standard');assert.equal(summarizeFunctionKeys(raw).standardCount,12);
  assert.deepEqual(raw,before);assert.equal(raw.active[30],39);
  for(const [kind,change] of [
    ['needsAdaptation',s=>s.active=[...s.defaults[0]]],
    ['needsAdaptation',s=>{for(let i=0;i<12;i++)s.active[i+1]=104+i;}],
    ['custom',s=>s.active[4]=12345],['shared',s=>s.active[25]=61],
    ['unknown',s=>s.defaults[1][25]=61],['unknown',s=>s.defaults[1][4]=0],
  ]){const v=sample();change(v);const summary=summarizeFunctionKeys(v);assert.equal(summary.status,kind);assert.equal(summary.restorationReady,false);assert(!Object.hasOwn(summary,'active'));assert(!Object.hasOwn(summary,'defaults'));}
  assert.equal(summarizeFunctionKeys(sample('air65-v3')).status,'noFunctionRow');
});
test('unsafe malformed and unknown native observations fail validation before planning',()=>{
  assert(validKeymapSnapshot(sample('air75-v3','2.0.0.7')));
  for(const mutate of [v=>v.firmwareVersion='2.0.0.8',v=>v.restorationReady=true,v=>v.readOnly=false,v=>v.noMutation=false,
    v=>v.active.pop(),v=>v.active[0]=65536,v=>v.active[0]=-1,v=>v.active[0]=1.5,v=>v.defaults.push([]),v=>v.lightingProfile=2,v=>v.matrixKeyCount++,v=>v.serial='invented']){
    const v=sample();mutate(v);assert.equal(validKeymapSnapshot(v),false);assert.throws(()=>validateReadonlyResult('keymapSnapshot',v),{code:'BRIDGE_PROTOCOL_ERROR'});
  }
  assert.throws(()=>validatePreviewCommand({op:'inspectFunctionKeys',modelId:'air75-v3'}),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
  assert.doesNotThrow(()=>validatePreviewCommand({op:'inspectFunctionKeys'}));
});
function hardware(){
  const h=new EventEmitter();h.transportEpoch=0;h.state={connected:true,identified:true,armed:false,readOnly:false,modelId:'air75-v3',firmwareVersion:'1.0.23.6',lightingProfile:1,connectionSessionId:'pipe:1'};
  h.request=async op=>{assert.equal(op,'keymapSnapshot');return sample();};return h;
}
test('observations stay bound to the idle connection and are cleared by ownership changes',async()=>{
  const h=hardware(),read=new KeymapInspection(h,{now:()=>123});const v=await read.read();assert.equal(v.capturedAt,123);assert.equal(v.status,'standard');
  v.functions[0].status='custom';assert.equal(read.snapshot().functions[0].status,'standard');
  h.lighting={status:()=>({phase:'armed'})};assert.equal(read.snapshot(),null);await assert.rejects(read.read());h.lighting=null;
  await read.read();h.transportEpoch++;assert.equal(read.snapshot(),null);
  await read.read();h.inspectionEpoch=2;assert.equal(read.snapshot(),null,'a complete ownership cycle between polls also invalidates the observation');
  await read.read();h.state.lightingProfile=0;assert.equal(read.snapshot(),null);
  h.state.lightingProfile=1;await read.read();h.emit('disconnected');assert.equal(read.snapshot(),null);
});
test('profile changes during reads and unknown firmware never publish stale function keys',async()=>{
  const h=hardware(),read=new KeymapInspection(h);h.request=async()=>{h.state.connectionSessionId='pipe:2';return sample();};
  await assert.rejects(read.read(),{code:'SNAPSHOT_SESSION_CHANGED'});assert.equal(read.snapshot(),null);
  h.request=async()=>{h.inspectionEpoch=(h.inspectionEpoch??0)+2;return sample();};
  await assert.rejects(read.read(),{code:'SNAPSHOT_SESSION_CHANGED'});assert.equal(read.snapshot(),null);
  h.state.firmwareVersion='2.0.0.8';h.request=async()=>assert.fail('must not reach reader');await assert.rejects(read.read(),{code:'KEYMAP_SCHEMA_UNVERIFIED'});
});
test('isolated Windows service reads function keys on Air 2 without acquiring a writer',async t=>{
  const f=await previewServiceFixture(t,{connected:true,firmwareVersion:'2.0.0.7',extendedFunctionKeys:true}),s=await f.start();await s.command({op:'connect'});
  const v=await s.command({op:'inspectFunctionKeys'});assert.equal(v.ok,true);assert.equal(v.result.status,'needsAdaptation');assert.equal(v.result.standardCount,0);
  assert(v.result.functions.every(f=>f.status==='extended'&&!f.shared));
  assert.equal(v.result.preparation.canPrepare,false);assert.deepEqual(v.result.preparation.candidateKeys,[]);
  assert.equal(v.result.preparation.preservedExtendedKeys.length,12);
  assert(v.result.preparation.checks.some(c=>c.id==='mapping'&&c.reason==='existingExtended'));
  const state=await s.state();assert.equal(state.device.keymapSnapshot.status,'needsAdaptation');assert.equal(state.device.capabilities.functionKeyAdaptation,false);assert.equal(state.desktop.capabilities.agentControl,false);
  assert.equal((await s.command({op:'prepareFunctionKey',keys:['F4']})).ok,false);
  await s.command({op:'disconnect'});assert.equal((await s.state()).device.keymapSnapshot,null);await s.close();
  assert(!(await f.operations()).some(r=>['arm','armConnectionWake','paint','prepareFunctionKey','adaptKeys'].includes(r.op)));
});
test('preparation checks describe candidate ranges without granting writes or adopting existing extended keys',()=>{
  const raw=sample('air75-v3','2.0.0.7'),before=structuredClone(raw);
  const inspect=()=>inspectWindowsFunctionKeyPreparation(raw,{identityQualified:true,recoveryStatus:'clear'});
  let result=inspect();assert.equal(result.readOnly,true);assert.equal(result.canPrepare,false);
  assert.equal(result.candidateKeys.length,12);assert.deepEqual(result.preservedExtendedKeys,[]);
  assert.deepEqual(result.checks.filter(c=>c.status==='blocked').map(c=>c.id),['completion','input']);
  assert.deepEqual(raw,before);assert(!/active|defaults|serial|deviceKey|position/.test(JSON.stringify(result)));
  for(let i=0;i<12;i++)raw.active[i+1]=104+i;
  result=inspect();assert.deepEqual(result.candidateKeys,[]);assert.equal(result.preservedExtendedKeys.length,12);
  assert.equal(result.checks.find(c=>c.id==='mapping').reason,'existingExtended');assert.equal(result.canPrepare,false);
  raw.active[2]=59;result=inspect();assert.deepEqual(result.candidateKeys,['F2']);assert.equal(result.preservedExtendedKeys.length,11);
});
test('preparation blocks occupied targets, custom or shared keys, wrong modes and unsupported scopes',()=>{
  for(const [mutate,reason] of [
    [v=>v.active[30]=104,'targetInUse'],[v=>v.active[v.matrixKeyCount]=104,'targetInUse'],
    [v=>v.active[30]=58,'sharedFunction'],[v=>v.active[1]=12345,'unsupportedMapping'],
    [v=>v.defaults[1][30]=58,'unknownPosition'],[v=>v.lightingProfile=0,'unsupportedMapping'],
  ]){
    const raw=sample('air75-v3','2.0.0.7');mutate(raw);const result=inspectWindowsFunctionKeyPreparation(raw);
    assert.equal(result.canPrepare,false);assert(!result.candidateKeys.includes('F1'));assert.equal(result.checks.find(c=>c.id==='mapping').reason,reason);
  }
  for(const raw of [sample(),sample('kick75'),sample('air65-v3')]){
    const result=inspectWindowsFunctionKeyPreparation(raw);assert.deepEqual(result.candidateKeys,[]);assert.equal(result.checks.find(c=>c.id==='device').status,'blocked');
  }
  const raw=sample('air75-v3','2.0.0.8');assert.throws(()=>inspectWindowsFunctionKeyPreparation(raw),TypeError);
  const result=inspectWindowsFunctionKeyPreparation(sample('air75-v3','2.0.0.7'),{identityQualified:'yes',recoveryStatus:'complete'});
  assert.equal(result.checks.find(c=>c.id==='identity').status,'blocked');assert.equal(result.checks.find(c=>c.id==='recovery').status,'unchecked');
});
test('preparation requires current native identity and a connection-bound recovery check, and expires with either',async()=>{
  const h=hardware();h.state.firmwareVersion='2.0.0.7';h.request=async()=>sample('air75-v3','2.0.0.7');
  const read=new KeymapInspection(h),check=(value,id)=>value.preparation.checks.find(c=>c.id===id);
  let result=await read.read();assert.equal(check(result,'identity').status,'blocked');assert.equal(check(result,'recovery').status,'unchecked');
  h.state.identityQualification={status:'qualified',source:'embeddedUsbSerial',reasonCode:null};assert.equal(read.snapshot(),null);
  result=await read.read();assert.equal(check(result,'identity').status,'confirmed');
  h.recoveryView={status:'clear'};h.recoveryKey='prior';h.recoveryContext=()=> 'current';assert.equal(read.snapshot(),null);
  result=await read.read();assert.equal(check(result,'recovery').status,'unchecked');
  h.recoveryKey='current';assert.equal(read.snapshot(),null);result=await read.read();assert.equal(check(result,'recovery').status,'confirmed');
  h.recoveryNeedsAttention=true;assert.equal(read.snapshot(),null);result=await read.read();assert.equal(check(result,'recovery').reason,'recoveryPending');
  h.recoveryNeedsAttention=false;h.recoveryView={status:'complete'};result=await read.read();assert.equal(check(result,'recovery').status,'unchecked');
  h.request=async()=>{h.state.identityQualification=null;return sample('air75-v3','2.0.0.7');};
  await assert.rejects(read.read(),{code:'SNAPSHOT_SESSION_CHANGED'});assert.equal(read.snapshot(),null);
});
