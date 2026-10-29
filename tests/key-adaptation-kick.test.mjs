import test from 'node:test';
import assert from 'node:assert/strict';
import {KeyAdaptation,planKeyAdaptation,planKeycapFunctions} from '../server/key-adaptation.mjs';
import {FACTORY_MAC_ROW,extendedKeycapMappings} from '../shared/keycap-functions.mjs';
import {fakeService,until} from './helpers/fake-service.mjs';

const keys=Array.from({length:12},(_,i)=>`F${i+1}`);
function kickMap({extended=false,standard=false}={}) {
  const win=Array(92).fill(0),mac=Array(92).fill(0);
  keys.forEach((_,i)=>{win[i+1]=58+i;mac[i+1]=FACTORY_MAC_ROW[i];});
  const active=[...(standard?win:mac)];
  if(extended)keys.forEach((_,i)=>{active[i+1]=104+i;});
  return {modelId:'kick75',protocol:'kick75-s4-keymap',matrixKeyCount:90,keymapKeyCount:92,
    geometryVerified:true,readOnly:true,functionKeyLeaseSupported:true,functionKeyLease:false,
    firmwareVersion:'4.0.18.6',mode:0,locationId:17825792,active,defaults:[mac,win]};
}

test('Kick maps its verified 92-entry layer and all uniquely identifiable factory F sources',()=>{
  const map=kickMap(),plan=planKeyAdaptation(map,keys);
  assert.equal(plan.mappings.length,11);
  assert.deepEqual(plan.unsupported,['F4'],'a generated Command+Space is never treated as an ordinary remappable usage');
  assert.deepEqual(plan.ready,keys.filter(key=>key!=='F4'));
  assert.deepEqual(plan.mappings.map(row=>row.HIDKeyboardModifierMappingSrc),[
    0x700000069,0x70000006a,0xc0000029f,0xc000000cf,0x10000009b,
    0xc000000b6,0xc000000cd,0xc000000b5,0xc000000e2,0xc000000ea,0xc000000e9,
  ]);
  assert.deepEqual(plan.mappings.map(row=>row.HIDKeyboardModifierMappingDst),
    keys.filter(key=>key!=='F4').map(key=>0x700000039+Number(key.slice(1))));
  assert.equal(planKeyAdaptation(kickMap({standard:true}),keys).mappings.length,0);
});

test('Kick rejects mismatched model, geometry, dimensions and encoder F aliases',()=>{
  const map=kickMap();
  for(const patch of [{modelId:'air75-v3'},{protocol:'air75-s4-keymap'},{matrixKeyCount:96},
    {keymapKeyCount:98},{matrixKeyCount:undefined},{keymapKeyCount:undefined},{geometryVerified:false},
    {readOnly:false},{active:Array(98).fill(0)},{defaults:[map.defaults[0],Array(98).fill(0)]}])
    assert.throws(()=>planKeyAdaptation({...map,...patch},keys));
  const encoderAlias=kickMap();encoderAlias.defaults[1][12]=0;encoderAlias.defaults[1][90]=69;
  assert.throws(()=>planKeyAdaptation(encoderAlias,keys),/功能键的位置/);
  const legacyOverride={...map,firmwareVersion:'1.0.16.6',protocol:'unverified'};
  assert.throws(()=>planKeyAdaptation(legacyOverride,keys));
});

test('the legacy AIR contract remains compatible while explicit conflicting declarations are rejected',()=>{
  const active=Array(98).fill(0),win=Array(98).fill(0);
  keys.forEach((_,i)=>{active[i+1]=FACTORY_MAC_ROW[i];win[i+1]=58+i;});
  const map={firmwareVersion:'1.0.16.6',mode:0,locationId:1,active,defaults:[active,win]};
  assert.equal(planKeyAdaptation(map,keys).mappings.length,11);
  for(const patch of [{protocol:'unverified'},{modelId:'kick75'},{matrixKeyCount:90},
    {keymapKeyCount:92},{geometryVerified:false},{readOnly:false},{geometryVerified:null},{readOnly:'yes'}])
    assert.throws(()=>planKeyAdaptation({...map,...patch},keys));
});

function mockHardware(initialMap=kickMap()) {
  let map=initialMap,leased=false;const calls=[];
  const hardware={child:{},state:{},async request(op,args){
    calls.push({op,args});
    if(op==='permissions')return {inputMonitoring:true,accessibility:true,canPostEvents:true};
    if(op==='readKeymap'){
      const copy=structuredClone(map);
      if(leased){copy.active[4]=61;copy.functionKeyLease=true;}
      return copy;
    }
    if(op==='prepareFunctionKey'){leased=true;return {verified:true,leased:true};}
    if(op==='restoreFunctionKey'){leased=false;return {restored:true,verified:true};}
    return {verified:true};
  }};
  return {hardware,calls,setMap(value){map=value;},isLeased:()=>leased};
}

test('Kick requires an explicit verified lease capability and validates before any key write',async()=>{
  for(const patch of [{matrixKeyCount:96},{keymapKeyCount:undefined},{defaults:[]}]){
    const mock=mockHardware({...kickMap(),...patch}),adaptation=new KeyAdaptation(mock.hardware);
    assert.equal((await adaptation.sync({enabled:true,active:true,connected:true,bindings:keys})).status,'error');
    assert(!mock.calls.some(call=>['prepareFunctionKey','adaptKeys'].includes(call.op)));
  }
  for(const flag of [undefined,false]){
    const mock=mockHardware({...kickMap(),functionKeyLeaseSupported:flag}),adaptation=new KeyAdaptation(mock.hardware);
    const result=await adaptation.sync({enabled:true,active:true,connected:true,bindings:keys});
    assert.equal(result.status,'partial');assert.deepEqual(result.unsupported,['F4']);
    assert(!mock.calls.some(call=>call.op==='prepareFunctionKey'));
  }
});

test('a pending journal on a new USB handle drops only old JS ownership and keeps the other eleven keys usable',async()=>{
 const mock=mockHardware(),a=new KeyAdaptation(mock.hardware);
 const config={enabled:true,active:true,connected:true,bindings:keys};
 await a.sync(config);assert.equal(a.boardOwned,true);
 const originalRequest=mock.hardware.request.bind(mock.hardware);
 mock.hardware.request=async(op,args)=>{
  if(op==='readKeymap'){
   mock.calls.push({op,args});
   return {...kickMap(),locationId:34603008,functionKeyLease:false,functionKeyLeaseSupported:false,
    keyRecovery:{status:'confirmationRequired',pending:true,blocking:true,ownsCurrentHandle:false}};
  }
  return originalRequest(op,args);
 };
 mock.calls.length=0;
 const result=await a.sync(config,true);
 assert.equal(result.status,'partial');assert.deepEqual(result.unsupported,['F4']);
 assert.equal(result.ready.length,11);assert.equal(a.boardOwned,false);
 assert(mock.calls.some(call=>call.op==='restoreKeys'));
 assert(!mock.calls.some(call=>['restoreFunctionKey','prepareFunctionKey'].includes(call.op)));
});

test('Kick leases only F4 while using device-scoped OS mappings for the other eleven, then fully releases',async()=>{
  const mock=mockHardware(),a=new KeyAdaptation(mock.hardware);
  const config={enabled:true,active:true,connected:true,bindings:keys};
  const result=await a.sync(config);
  assert.equal(result.status,'ready');assert.deepEqual(result.ready,keys);assert.equal(result.mapped,12);
  assert.deepEqual(result.boardAdapted,['F4']);assert.equal(mock.isLeased(),true);
  const applied=mock.calls.find(call=>call.op==='adaptKeys');
  assert.equal(applied.args.locationId,17825792);assert.equal(applied.args.mappings.length,11);
  const before=mock.calls.length;
  const off=await a.sync({...config,active:false});
  assert.equal(off.status,'paused');assert.equal(off.mapped,0);assert.deepEqual(off.ready,[]);
  assert.equal(mock.isLeased(),false);assert.equal(a.owned,false);assert.equal(a.boardOwned,false);
  assert.deepEqual(mock.calls.slice(before).map(call=>call.op),['restoreKeys','restoreFunctionKey']);
  await a.sync(config);
  const unplug=await a.sync({...config,connected:false});
  assert.equal(unplug.status,'waitingDevice');assert.deepEqual(unplug.ready,[]);assert.equal(unplug.mapped,0);
  assert.equal(mock.isLeased(),false);
});

test('Kick inactive fallback follows only its verified full extended F row and preserves ordinary factory functions',async()=>{
  assert.deepEqual(planKeycapFunctions(kickMap()).mappings,[]);
  assert.deepEqual(planKeycapFunctions(kickMap({extended:true})).mappings,extendedKeycapMappings());
  const altered=kickMap({extended:true});altered.defaults[0][4]=4;
  assert.throws(()=>planKeycapFunctions(altered),/原厂功能配置/);
  const mock=mockHardware(kickMap({extended:true})),a=new KeyAdaptation(mock.hardware);
  const result=await a.sync({enabled:true,active:false,connected:true,keycapFallback:true,bindings:keys});
  assert.equal(result.status,'keycaps');assert.equal(result.keycapsMapped,true);
  const applied=mock.calls.find(call=>call.op==='adaptKeys');
  assert.equal(applied.args.profile,'keycaps');assert.equal(applied.args.mappings.length,12);
  assert(!mock.calls.some(call=>call.op==='prepareFunctionKey'));
});

test('real service enables Kick Codex keys, restores original behavior when off and after a reconnect',async t=>{
  const service=await fakeService(t,{modelId:'kick75',firmwareVersion:'4.0.18.6',functionKeyAdaptation:true,
    keymap:kickMap(),permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}});
  const original=await service.state();
  assert.equal((await service.command({op:'codexAdapt'})).ok,true);
  let state=await service.state();
  assert.equal(state.device.modelId,'kick75');assert.equal(state.codex.adaptation.status,'ready');
  assert.equal(state.codex.adaptation.mapped,12);assert.deepEqual(state.codex.adaptation.boardAdapted,['F4']);
  await service.command({op:'settings',settings:{codexEnabled:false,codexKeycapFallback:false}});
  state=await service.state();assert.equal(state.codex.adaptation.status,'paused');
  assert.equal(state.codex.adaptation.mapped,0);assert.deepEqual(state.codex.adaptation.ready,[]);
  assert((await service.operations()).some(call=>call.op==='restoreFunctionKey'));
  await service.command({op:'settings',settings:{codexEnabled:true}});
  await service.command({op:'disconnect'});
  await until(service.state,state=>state.codex.adaptation.status==='waitingDevice','Kick disconnect releases key conversion');
  await service.command({op:'connect'});
  await until(service.state,state=>state.codex.adaptation.status==='ready','Kick reconnect reapplies the verified conversion');
  state=await service.state();
  assert.deepEqual(state.settings.codexTaskKeys,original.settings.codexTaskKeys);
  assert.deepEqual(state.settings.codexCommandKeys,original.settings.codexCommandKeys);
  assert.deepEqual(state.scenes,original.scenes);
});

test('an existing standard F4 stays usable with all other keys while an unowned old record remains untouched',async t=>{
 const map=kickMap();map.active[map.defaults[1].indexOf(61)]=61;
 const recovery={status:'confirmationRequired',pending:true,blocking:true,ownsCurrentHandle:false,unownedHistory:true};
 const service=await fakeService(t,{modelId:'kick75',firmwareVersion:'4.0.18.6',keymap:map,keyRecovery:recovery,unownedFunctionKeyHistory:true,permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}});
 await service.command({op:'codexAdapt'});const state=await until(service.state,s=>s.codex.adaptation.status==='ready','function keys did not become ready');
 assert.deepEqual(state.codex.adaptation.ready,keys);assert.equal(state.device.functionKeyRecoveryPending,true);
 assert(!(await service.operations()).some(o=>['prepareFunctionKey','confirmFunctionKeyRecovery','restoreFunctionKey'].includes(o.op)));
});
