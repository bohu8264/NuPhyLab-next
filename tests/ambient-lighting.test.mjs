import test from 'node:test';
import assert from 'node:assert/strict';
import {AmbientLighting,DEFAULT_AMBIENT_LIGHTING,validateAmbientLighting,ambientTarget,learnAmbientPreference} from '../shared/ambient-lighting.mjs';
import {validateSettings,defaultSettings,Store} from '../server/storage.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const keyboard={connected:true,armed:true,modelId:'kick75',capabilities:{perKey:true}};
const enabled=()=>validateAmbientLighting({enabled:true});
function fixture(){
  let now=0,sequence=0;const controller=new AmbientLighting({now:()=>now,wallNow:()=>10000+now});
  const settings=enabled();
  const send=(lux,status='ready')=>controller.receive({sequence:++sequence,sampledAt:10000+now,status,lux});
  const step=(ms=100)=>{now+=ms;return controller.brightness(70,settings,keyboard);};
  const settle=lux=>{for(let i=0;i<100;i++){if(i%10===0)send(lux);step();}};
  return {controller,settings,send,step,settle,clock:v=>{now=v;}};
}
test('new and existing profiles default to manual; settings validation is bounded and merges partial changes',()=>{
  assert.equal(defaultSettings.ambientLighting.enabled,false);
  assert.equal(validateSettings({ambientLighting:{enabled:true}}).ambientLighting.learn,true);
  for(const v of [null,[],{enabled:1},{learn:'yes'},{brightRoom:'anything'},{unknown:true},{profiles:{other:[]}},{profiles:{kick75:[{lux:NaN,brightness:30}]}},{profiles:{kick75:Array(13).fill({lux:2,brightness:2})}}])
    assert.throws(()=>validateAmbientLighting(v));
  const next=validateAmbientLighting({learn:false},enabled());assert.equal(next.enabled,true);
  assert.equal(DEFAULT_AMBIENT_LIGHTING.enabled,false);
});
test('curve dims by environment with explicit daylight Off/Dim and bounded zero-lux behavior',()=>{
  const config=enabled(),values=[0,10,80,250,800,100000].map(lux=>ambientTarget(lux,70,config,'kick75'));
  assert.equal(values[0],70);assert.equal(values.at(-1),0);
  assert.ok(values.every((v,i)=>i===0||v<=values[i-1]));
  assert.equal(ambientTarget(2000,70,{...config,brightRoom:'dim'},'kick75'),8);
  assert.equal(ambientTarget(2000,3,{...config,brightRoom:'dim'},'kick75'),3);
});
test('startup waits for samples; zero is darkness; both directions fade with bounded steps',()=>{
  const f=fixture();assert.equal(f.step(),70);
  f.send(1000);f.step();assert.equal(f.controller.snapshot(70,f.settings,keyboard).status,'waiting');
  f.settle(1000);assert.equal(f.controller.brightness(70,f.settings,keyboard),0);
  let before=0;
  for(let i=0;i<120;i++){
    if(i%10===0)f.send(0);
    const value=f.step();assert.ok(value>=0&&value<=70);assert.ok(Math.abs(value-before)<=2.51);before=value;
  }
  assert.ok(before>65,'dark room must brighten the backlight');
});
test('a brief occlusion is rejected by median filtering and invalid/stale data falls back to manual',()=>{
  const f=fixture();f.settle(1000);f.send(0);f.step();f.send(1000);f.step();
  assert.equal(f.controller.brightness(70,f.settings,keyboard),0);
  f.send(undefined,'unavailable');for(let i=0;i<30;i++)f.step();
  assert.equal(f.controller.brightness(70,f.settings,keyboard),70);
  f.settle(1000);for(let i=0;i<100;i++)f.step();
  assert.equal(f.controller.snapshot(70,f.settings,keyboard).status,'unavailable');
  assert.equal(f.controller.brightness(70,f.settings,keyboard),70);
});
test('invalid, future, stale and reordered reports cannot overwrite recent readings',()=>{
  const f=fixture();f.send(80);
  assert.equal(f.controller.receive({status:'ready',lux:0,sequence:0,sampledAt:10000}),false);
  assert.ok(Math.abs(f.controller.lux-80)<1e-9);
  for(const p of [{lux:-1},{lux:Infinity},{lux:'0'},{lux:200001},{sequence:.2},{sampledAt:30000},{sampledAt:0},{status:'other'}])
    assert.throws(()=>f.controller.receive({status:'ready',lux:1,sequence:5,sampledAt:10000,...p}));
});
test('manual off always wins; disable, no USB, stock lighting and lid closure never acquire lighting ownership',()=>{
  const f=fixture();f.settle(0);
  assert.equal(f.controller.brightness(0,f.settings,keyboard),0);
  for(const [device,status] of [[{...keyboard,connected:false},'noKeyboard'],[{...keyboard,armed:false},'idle'],[{...keyboard,capabilities:{perKey:false}},'unsupportedKeyboard']])
    assert.equal(f.controller.snapshot(70,f.settings,device).status,status);
  f.send(undefined,'lidClosed');assert.equal(f.controller.snapshot(70,f.settings,keyboard).status,'lidClosed');
  f.settings.enabled=false;assert.equal(f.controller.brightness(70,f.settings,keyboard),70);
  assert.equal(f.controller.snapshot(70,f.settings,keyboard).status,'disabled');
});
test('learning is local per model, manual-only, bounded, respects daylight choice and survives reload',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'nuphy-ambient-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const f=fixture();f.settle(80);
  const learned=f.controller.preference(f.settings,keyboard,70,37);
  assert.ok(Math.abs(ambientTarget(80,70,learned,'kick75')-37)<.01);
  assert.equal(ambientTarget(80,70,learned,'air75-v3'),45.5);
  assert.equal(ambientTarget(1000,70,learned,'kick75'),0);
  assert.deepEqual(f.controller.preference({...f.settings,learn:false},keyboard,70,37).profiles,{});
  assert.deepEqual(f.controller.preference(f.settings,keyboard,70,0).profiles,{});
  let bounded=learned;for(let i=0;i<30;i++)bounded=learnAmbientPreference(bounded,'kick75',Math.exp(i/2),50);
  assert.ok(bounded.profiles.kick75.length<=12);
  const store=await new Store(folder).load();await store.settings({ambientLighting:learned});
  const reopened=await new Store(folder).load();assert.deepEqual(reopened.data.settings.ambientLighting,learned);
});
test('resuming after a long gap requires three new samples rather than using the covered lid reading',()=>{
  const f=fixture();f.settle(0);f.clock(50000);f.send(1000);
  assert.equal(f.controller.snapshot(70,f.settings,keyboard).status,'waiting');
  assert.ok(f.controller.lux>999);
});
