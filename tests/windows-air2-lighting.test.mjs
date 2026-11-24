import test from 'node:test';
import assert from 'node:assert/strict';
import {windowsLightingPolicy,windowsBoardSleepSupported} from '../shared/windows-lighting-firmware.mjs';
import {getKeyboardProfile} from '../shared/keyboard-models.mjs';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';
const identityQualification={status:'qualified',source:'embeddedUsbSerial',reasonCode:null};
test('Windows Air 2 selects its own recovery policy independently of official Mac defaults and other models',()=>{
  assert.equal(windowsLightingPolicy('air75-v3','2.0.0.7'),'air75-v3-2.0.0.7');
  assert.equal(windowsLightingPolicy('air75-v3','1.0.23.6'),'air75-v3-1.0.23.6');
  for(const [id,version] of [['air75-v3','2.0.0.8'],['kick75','2.0.0.7'],['invented','2.0.0.7']])assert.equal(windowsLightingPolicy(id,version),null);
  assert.equal(getKeyboardProfile('air75-v3').qualifiedFirmware,'2.0.0.7');assert.equal(getKeyboardProfile('air75-v3').windowsQualifiedFirmware,'1.0.23.6');
  assert.equal(windowsBoardSleepSupported('air75-v3','2.0.0.7'),false);assert.equal(windowsBoardSleepSupported('air75-v3','1.0.23.6'),true);
});
test('the Windows Air 2 service admits lighting and verifies exit while physical AI and keymap writes remain closed',async t=>{
  const f=await previewServiceFixture(t,{connected:true,firmwareVersion:'2.0.0.7',identityQualification}),s=await f.start();
  assert.equal((await s.command({op:'connect'})).ok,true);let state=await s.state();assert.equal(state.desktop.capabilities.lighting,true);assert.equal(state.connectionWake.active,true);
  assert.equal((await s.command({op:'preview',colors:Array(84).fill('#254677')})).ok,true);
  state=await s.state();assert.equal(state.device.readOnly,false);assert.equal(state.device.capabilities.functionKeyAdaptation,false);assert.equal(state.desktop.capabilities.agentControl,false);
  assert.equal((await s.command({op:'codexKey',code:'F1'})).ok,false);assert.equal((await s.command({op:'nativeLighting',mode:3,brightness:60,speed:2})).ok,false);
  await s.command({op:'stop'});assert.equal((await s.command({op:'inspectFunctionKeys'})).ok,true);
  const checked=await s.command({op:'checkWindowsRecovery'});assert.equal(checked.ok,true);assert.equal(checked.result.canRestore,true);
  await s.close();assert.equal(s.hostMessages.at(-1).success,true);assert.equal(s.hostMessages.at(-1).keyboardVerified,true);
  const rows=await f.operations();assert(rows.some(r=>r.event==='lightingClosed'&&r.restored));assert(!rows.some(r=>['prepareFunctionKey','adaptKeys','shortcut'].includes(r.op)));
});
