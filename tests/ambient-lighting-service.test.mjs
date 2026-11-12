import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fakeService,until} from './helpers/fake-service.mjs';
import {firmwarePrompt} from '../shared/firmware-onboarding.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('ambient samples fade static artwork over the ordinary RAM renderer, preserve art, learn manual dimmer and keep manual Off',async t=>{
  const s=await fakeService(t,{storedSettings:{autoConnect:false,brightness:70,lightDurationMs:0,lightIdleMs:0}});
  const art=Array(84).fill('#ffffff');
  await s.command({op:'preview',colors:art});
  assert.equal((await s.command({op:'settings',settings:{ambientLighting:{enabled:true}}})).ok,true);
  let sequence=0;
  const sample=async lux=>s.command({op:'ambientLightSample',sample:{sequence:++sequence,sampledAt:Date.now(),status:'ready',lux}});
  for(let i=0;i<3;i++)await sample(1000);
  await until(s.state,v=>v.colors[0]==='#000000','static frame did not fade in daylight',4500);
  assert.equal((await s.state()).settings.brightness,70,'sensor never writes the manual setting');
  for(let i=0;i<18;i++){await sample(80);await wait(80);}
  await until(s.state,v=>v.ambientLighting.status==='active'&&v.colors[0]!=='#000000','dark room did not brighten static frame');
  await s.command({op:'settings',settings:{brightness:35}});
  let state=await s.state();assert.equal(state.settings.ambientLighting.profiles['air75-v3'].length,1);
  const saved=JSON.parse(await readFile(s.dataDir+'/library.json','utf8'));assert.equal(saved.settings.brightness,35);
  await s.command({op:'settings',settings:{brightness:0}});for(let i=0;i<3;i++)await sample(0);
  state=await s.state();assert.ok(state.colors.every(c=>c==='#000000'));assert.equal(state.ambientLighting.status,'manualOff');
  const writes=(await s.operations());assert.ok(writes.some(x=>x.op==='paint'));
  assert.equal(writes.some(x=>x.op==='nativeLighting'),false,'automatic fades must not save firmware effects');
  assert.equal(writes.some(x=>x.op==='side'&&x.brightness>0),false,'samples do not acquire side-light settings');
  await s.command({op:'restore'});const before=(await s.operations()).filter(x=>x.op==='arm').length;
  for(let i=0;i<3;i++)await sample(0);await wait(150);
  assert.equal((await s.operations()).filter(x=>x.op==='arm').length,before,'a sample must not rearm a manually restored keyboard');
});
test('old Kick firmware keeps its update guide while per-key controls remain unavailable',async t=>{
  const s=await fakeService(t,{modelId:'kick75',firmwareVersion:'4.0.12.6',readOnly:true,storedSettings:{autoConnect:false}});
  await s.command({op:'connect'});const state=await s.state();
  const prompt=firmwarePrompt(state);assert.equal(prompt.target,'4.0.18.6');assert.equal(prompt.required,true);
  assert.equal(state.firmware.compatible,false);
  assert.equal((await s.operations()).some(x=>['arm','paint','nativeLighting'].includes(x.op)),false);
});
test('a paused game fades without advancing play, and sensor reports do not extend the sleep deadline',async t=>{
  const s=await fakeService(t,{freshLibrary:true,storedSettings:{brightness:70,lightDurationMs:0,lightIdleMs:0}});
  await s.command({op:'gameStart',gameType:'snake',speed:10});await s.command({op:'gamePause',paused:true});
  const before=(await s.state()).game;
  await s.command({op:'settings',settings:{ambientLighting:{enabled:true}}});
  let sequence=0;
  const sample=()=>s.command({op:'ambientLightSample',sample:{sequence:++sequence,sampledAt:Date.now(),status:'ready',lux:1000}});
  for(let i=0;i<3;i++)await sample();
  await until(s.state,v=>v.colors.every(c=>c==='#000000'),'paused game did not fade',4500);
  assert.deepEqual((await s.state()).game,before);
  await s.command({op:'settings',settings:{lightDurationMs:1000}});
  for(let i=0;i<7;i++){await sample();await wait(200);}
  const ended=await s.state();assert.equal(ended.lightPower.sleeping,true);assert.equal(ended.lightPower.reason,'duration');
});
