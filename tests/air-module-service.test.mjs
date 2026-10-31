import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fakeService } from "./helpers/fake-service.mjs";
import { heart } from "../shared/layout.mjs";

const lightingSnapshot = state => ({
  armed: state.device.armed,
  colors: state.colors,
  playback: state.playback,
  hardwareState: state.device.state,
  adaptation: { mapped: 0, boardAdapted: [], keycapsMapped: false, ...state.codex.adaptation },
});
const mutations=new Set(['arm','paint','side','restore','restoreKeys','restoreFunctionKey','prepareFunctionKey','adaptKeys','nativeLighting','triggerMonitor','shortcut','disconnect']);
const writes=operations=>operations.filter(operation=>mutations.has(operation.op));
const withoutModule=settings=>Object.fromEntries(Object.entries(settings).filter(([key])=>key!=='airTopRightModule'));
const colors=Array(84).fill('#d07d74');
const ok=async(service,body)=>{const result=await service.command(body);assert.equal(result.ok,true,JSON.stringify(result));return result.result;};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function calibratedService(t,extra={}) {
  const service=await fakeService(t,{modelId:'kick75',firmwareVersion:'4.0.18.6',
    outputIdentity:{productId:0x1026,backupPath:'/isolated/devices/kick75-1026-74657374/original-lighting-mac.json'},
    tasks:[{id:'running',title:'Isolated running task',status:'running'}],...extra});
  await ok(service,{op:'settings',settings:{brightness:100,codexSelectedPulse:false,codexAmbient:false,quotaSideEnabled:false,lightDurationMs:60000,lightIdleMs:0}});
  const binding=(await service.state()).device.outputColorProfile.binding;assert.ok(binding);
  await ok(service,{op:'settings',settings:{outputColorProfile:{version:1,enabled:true,binding,transfer:'srgb',gains:{r:1,g:.6,b:.6}}}});
  return service;
}

test("Air module API saves a local preference without touching active lighting or key mappings", async t => {
  const service = await fakeService(t);
  assert.equal((await service.state()).settings.airTopRightModule, "rotary");
  assert.equal((await service.command({ op: "preview", colors: heart() })).ok, true);
  const before = lightingSnapshot(await service.state());
  const start = (await service.operations()).length;
  for (const module of ["keycap", "rotary", "keycap"]) {
    const response = await service.command({ op: "settings", settings: { airTopRightModule: module } });
    assert.equal(response.ok, true);
    assert.equal(response.result.airTopRightModule, module);
    const state = await service.state();
    assert.equal(state.settings.airTopRightModule, module);
    assert.deepEqual(lightingSnapshot(state), before);
  }
  const saved = JSON.parse(await readFile(path.join(service.dataDir, "library.json"), "utf8"));
  assert.equal(saved.settings.airTopRightModule, "keycap");
  const operations = (await service.operations()).slice(start);
  assert(operations.every(({ op }) => ["status", "bluetoothDevices", "systemIdle"].includes(op)), JSON.stringify(operations));
});

test("Air module API rejects invalid values before changing the preference or hardware", async t => {
  const service = await fakeService(t);
  await service.command({ op: "disconnect" });
  const before = await service.state();
  const start = (await service.operations()).length;
  for (const value of [null, "", "knob", "Del", true, 0, [], {}]) {
    const response = await service.command({ op: "settings", settings: { airTopRightModule: value } });
    assert.equal(response.status, 400);
    assert.equal(response.ok, false);
    assert.match(response.error, /Air/);
  }
  const after = await service.state();
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(lightingSnapshot(after), lightingSnapshot(before));
  const operations = (await service.operations()).slice(start);
  assert(operations.every(({ op }) => ["status", "bluetoothDevices"].includes(op)), JSON.stringify(operations));
});

test('Air module-only changes preserve static, paused, agent and paused-game output, artwork and calibration',async t=>{
  const service=await calibratedService(t);
  await ok(service,{op:'saveScene',scene:{name:'Keep source artwork',colors,animation:{effect:'frames',hueShift:22,brightness:41,speed:4,loop:true,frames:[{colors,duration:400}]}}});
  const setups=[
    ['static',async()=>{await ok(service,{op:'settings',settings:{codexEnabled:false}});await ok(service,{op:'preview',colors});}],
    ['paused',async()=>{await ok(service,{op:'play',colors,animation:{effect:'frames',speed:4,loop:true,frames:[{colors,duration:400}]}});await ok(service,{op:'pause'});}],
    ['agent',async()=>{await ok(service,{op:'agentMode',source:'codex',enabled:true});await ok(service,{op:'stop'});}],
    ['game',async()=>{await ok(service,{op:'gameStart',gameType:'snake',speed:1});await ok(service,{op:'gamePause',paused:true});}],
  ];
  for(const [mode,setup] of setups){
    await setup();await delay(80);const before=await service.state(),start=(await service.operations()).length;assert.equal(before.playback.mode,mode);
    for(const airTopRightModule of ['keycap','rotary','keycap'])await ok(service,{op:'settings',settings:{airTopRightModule}});
    await delay(100);const after=await service.state();
    assert.deepEqual(lightingSnapshot(after),lightingSnapshot(before),mode+' lighting and mappings');
    assert.equal(after.device.connected,before.device.connected);assert.deepEqual(after.device.outputColorProfile,before.device.outputColorProfile);
    assert.deepEqual(after.scenes,before.scenes);assert.deepEqual(withoutModule(after.settings),withoutModule(before.settings));
    assert.ok(after.lightPower.remainingMs<=before.lightPower.remainingMs,mode+' must not restart duration');assert.equal(after.lightPower.sleeping,before.lightPower.sleeping);
    if(mode==='game')assert.deepEqual(after.game,before.game,'paused game state');
    assert.deepEqual(writes((await service.operations()).slice(start)),[],mode+' no hardware/key side effects');
  }
});

test('Air module-only changes preserve held dictation and physical repeat suppression',async t=>{
  const service=await calibratedService(t,{codexKeybindings:[{command:'globalDictationHold',key:'Ctrl+Shift+D'},{command:'globalDictationSingleTap',key:null}]});
  await ok(service,{op:'settings',settings:{codexEnabled:true}});await ok(service,{op:'codexKey',code:'F9',phase:'down'});
  const before=await service.state(),start=(await service.operations()).length;assert.equal(before.codex.keys.held.source,'F9');
  await ok(service,{op:'settings',settings:{airTopRightModule:'keycap'}});await ok(service,{op:'settings',settings:{airTopRightModule:'rotary'}});
  assert.deepEqual((await service.state()).codex.keys.held,before.codex.keys.held);assert.deepEqual(writes((await service.operations()).slice(start)),[]);
  await ok(service,{op:'codexKey',code:'F9',phase:'up'});assert.equal((await service.state()).codex.keys.held,null);
  await ok(service,{op:'codexKey',code:'F11',phase:'down'});const taps=(await service.operations()).filter(x=>x.op==='shortcut').length;
  await ok(service,{op:'settings',settings:{airTopRightModule:'keycap'}});
  const repeat=await ok(service,{op:'codexKey',code:'F11',phase:'down'});assert.equal(repeat.ignored,true);assert.equal((await service.operations()).filter(x=>x.op==='shortcut').length,taps);
  await ok(service,{op:'codexKey',code:'F11',phase:'up'});
});

test('invalid Air module and brightness batches reject before held-key or output changes',async t=>{
  const service=await calibratedService(t,{codexKeybindings:[{command:'globalDictationHold',key:'Ctrl+Shift+D'},{command:'globalDictationSingleTap',key:null}]});
  await ok(service,{op:'settings',settings:{codexEnabled:true}});await ok(service,{op:'codexKey',code:'F9',phase:'down'});
  const before=await service.state(),bytes=await readFile(path.join(service.dataDir,'library.json'),'utf8'),start=(await service.operations()).length;
  for(const airTopRightModule of ['invalid',null])assert.equal((await service.command({op:'settings',settings:{airTopRightModule,brightness:50}})).ok,false);
  const after=await service.state();assert.deepEqual(after.settings,before.settings);assert.deepEqual(lightingSnapshot(after),lightingSnapshot(before));
  assert.deepEqual(after.codex.keys.held,before.codex.keys.held);assert.equal(await readFile(path.join(service.dataDir,'library.json'),'utf8'),bytes);
  assert.deepEqual(writes((await service.operations()).slice(start)),[]);await ok(service,{op:'codexKey',code:'F9',phase:'up'});
});

test('Air module plus brightness retains the normal calibrated hardware settings path',async t=>{
  const service=await calibratedService(t);await ok(service,{op:'preview',colors});const before=await service.state(),paints=(await service.operations()).filter(x=>x.op==='paint').length;
  await ok(service,{op:'settings',settings:{airTopRightModule:'keycap',brightness:50}});const after=await service.state();
  assert.equal(after.settings.airTopRightModule,'keycap');assert.equal(after.settings.brightness,50);assert.equal(after.colors[0],'#683f3a');
  assert.equal((await service.operations()).filter(x=>x.op==='paint').length,paints+1);assert.deepEqual(after.device.outputColorProfile,before.device.outputColorProfile);
  assert.deepEqual(after.scenes,before.scenes);assert.equal(after.playback.mode,'static');
  // The calibrated full-intensity sample is #a11f1b. Global 50% now dims
  // those linear device bytes, while the logical preview remains #683f3a.
  assert.ok((await service.operations()).filter(x=>x.op==='paint').at(-1).colors.every(color=>color==='#51100e'));
  const verification=await ok(service,{op:'verifyColors'});assert.equal(verification.matches,true);assert.equal(verification.checked,80);assert.ok(verification.expected.every(color=>color==='#51100e'));
});
