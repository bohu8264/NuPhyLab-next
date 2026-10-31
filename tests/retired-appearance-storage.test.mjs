import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store,defaultSettings,validateSettings,validateScene} from '../server/storage.mjs';
import {GAME_TYPES} from '../shared/games.mjs';
import {fakeService} from './helpers/fake-service.mjs';

const retired=['appearanceStyle','glassStrength'];
const colors=Array(84).fill('#ba6f68');
const settings={brightness:37,airTopRightModule:'keycap',language:'en',slotIds:['kept-task'],codexTaskSource:'custom',
  outputColorProfile:{version:1,enabled:true,binding:{modelId:'kick75',productId:0x1026,firmwareVersion:'4.0.18.6',deviceKey:'native-device-v1:'+'a'.repeat(64)},transfer:'srgb',gains:{r:1,g:.6,b:.6}}};
const scene=validateScene({id:'kept-art',name:'Keep frame colors',modelId:'air75-v3',colors,animation:{effect:'frames',speed:3,loop:true,hueShift:19,brightness:42,frames:[{colors,duration:400}]},createdAt:'2026-10-01T00:00:00.000Z'},'2026-10-02T00:00:00.000Z');
const library=extra=>({version:1,scenes:[scene],settings:{...settings,...extra},bestScore:37,gameBestScores:Object.fromEntries(GAME_TYPES.map(type=>[type,type==='snake'?37:12]))});
async function fixture(t,extra={}){
  const dir=await mkdtemp(path.join(tmpdir(),'nuphy-retired-settings-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'library.json'),bytes=JSON.stringify(library(extra),null,2);await writeFile(file,bytes);
  return {dir,file,bytes,store:await new Store(dir).load()};
}

test('load ignores only the two retired UI keys without rewriting old libraries or changing artwork/settings',async t=>{
  for(const extra of [{appearanceStyle:'glass',glassStrength:55},{appearanceStyle:'opaque',glassStrength:0},{appearanceStyle:{old:true},glassStrength:'historical-invalid'}]){
    const {store,file,bytes}=await fixture(t,extra);
    assert.equal(store.warning,null);assert.notEqual(store.readOnly,true);assert.equal(await readFile(file,'utf8'),bytes,'load is read-only');
    for(const key of retired){assert.equal(Object.hasOwn(store.data.settings,key),false);assert.equal(Object.hasOwn(defaultSettings,key),false);}
    assert.deepEqual(store.data.settings,validateSettings(settings));assert.deepEqual(store.data.scenes,[scene]);
    assert.equal(store.data.bestScore,37);assert.deepEqual(store.data.gameBestScores,library().gameBestScores);
  }
});

test('ordinary scene and settings saves after legacy load drop retired keys while preserving kept data',async t=>{
  const {store,file}=await fixture(t,{appearanceStyle:'glass',glassStrength:82});
  const original=structuredClone(store.data);await store.saveScene({name:'New artwork',colors,animation:{effect:'pulse',brightness:61,hueShift:-20}});
  let saved=JSON.parse(await readFile(file,'utf8'));for(const key of retired)assert.equal(Object.hasOwn(saved.settings,key),false);
  assert.deepEqual(saved.settings,original.settings);assert.deepEqual(saved.scenes.find(s=>s.id===scene.id),scene);
  await store.settings({brightness:48});const reopened=await new Store(store.dir).load();saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(reopened.warning,null);assert.equal(reopened.data.settings.brightness,48);assert.deepEqual(reopened.data.settings.outputColorProfile,original.settings.outputColorProfile);
  assert.deepEqual(reopened.data.scenes,store.data.scenes);assert.deepEqual(reopened.data.gameBestScores,original.gameBestScores);
  for(const key of retired)assert.equal(Object.hasOwn(saved.settings,key),false);
});

test('other unknown or invalid stored settings still preserve the file and fail closed',async t=>{
  for(const invalid of [{unrecognizedLegacyKey:true},{brightness:101},{airTopRightModule:'invalid'}]){
    const {store,file,bytes}=await fixture(t,{appearanceStyle:'glass',glassStrength:50,...invalid});
    assert.ok(store.warning);assert.equal(store.readOnly,true);assert.equal(await readFile(file,'utf8'),bytes);
    await assert.rejects(store.settings({brightness:50}));assert.equal(await readFile(file,'utf8'),bytes);
  }
});

test('new retired-key requests are rejected atomically instead of using load-only compatibility',async t=>{
  const {store,file}=await fixture(t,{appearanceStyle:'opaque',glassStrength:0}),before=structuredClone(store.data),bytes=await readFile(file,'utf8');
  for(const patch of [{appearanceStyle:'glass'},{appearanceStyle:'opaque'},{glassStrength:55},{glassStrength:null},{appearanceStyle:'opaque',brightness:60},{glassStrength:0,airTopRightModule:'rotary'}]){
    assert.throws(()=>validateSettings(patch),/不支持的设置项/);await assert.rejects(store.settings(patch),/不支持的设置项/);
    assert.deepEqual(store.data,before);assert.equal(await readFile(file,'utf8'),bytes);
  }
});

test('retired-key API batches reject before releasing held input or changing hardware, file or playback',async t=>{
  const service=await fakeService(t,{tasks:[{id:'running',title:'Fixture',status:'running'}],codexKeybindings:[{command:'globalDictationHold',key:'Ctrl+Shift+D'},{command:'globalDictationSingleTap',key:null}]});
  const ok=async body=>{const r=await service.command(body);assert.equal(r.ok,true,JSON.stringify(r));return r.result;};
  await ok({op:'settings',settings:{codexEnabled:true,codexSelectedPulse:false,codexAmbient:false,quotaSideEnabled:false}});
  await ok({op:'codexKey',code:'F9',phase:'down'});await new Promise(resolve=>setTimeout(resolve,80));
  const before=await service.state(),file=path.join(service.dataDir,'library.json'),bytes=await readFile(file,'utf8'),start=(await service.operations()).length;
  assert.equal(before.codex.keys.held.source,'F9');
  for(const settings of [{appearanceStyle:'opaque'},{glassStrength:50},{appearanceStyle:'glass',brightness:50},{glassStrength:0,airTopRightModule:'keycap'}]){
    const result=await service.command({op:'settings',settings});assert.equal(result.ok,false);assert.match(result.error,/不支持的设置项/);
  }
  const after=await service.state();assert.deepEqual(after.settings,before.settings);assert.deepEqual(after.playback,before.playback);assert.deepEqual(after.colors,before.colors);
  assert.deepEqual(after.codex.keys.held,before.codex.keys.held);assert.deepEqual(after.scenes,before.scenes);assert.deepEqual(after.device.outputColorProfile,before.device.outputColorProfile);
  assert.equal(await readFile(file,'utf8'),bytes);const mutating=new Set(['arm','paint','side','restore','restoreKeys','restoreFunctionKey','prepareFunctionKey','adaptKeys','nativeLighting','triggerMonitor','shortcut','disconnect']);
  assert.deepEqual((await service.operations()).slice(start).filter(x=>mutating.has(x.op)),[]);
  await ok({op:'codexKey',code:'F9',phase:'up'});assert.equal((await service.state()).codex.keys.held,null);
});
