import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeService,until} from './helpers/fake-service.mjs';
import {FACTORY_MAC_ROW} from '../shared/keycap-functions.mjs';

const tasks=[{id:'one',title:'First',status:'idle'},{id:'two',title:'Second',status:'running'}];
test('a Kick with the old 218 LED reply retains identity and reaches the firmware handoff without writes',async t=>{
  const service=await fakeService(t,{modelId:'kick75',firmwareVersion:'4.0.15.6',readOnly:true});
  await until(service.state,s=>s.device.connected && s.firmware.upgradeRecommended && s.firmware.latest==='4.0.18.6','old firmware was not offered an upgrade');
  const before=await service.state();
  assert.equal(before.device.identified,true);
  assert.equal(before.device.firmware,'4.0.15.6');
  assert.equal(before.device.capabilities.perKey,false);
  assert.equal(before.device.errorCode,'WRONG_LED_COUNT');
  assert.match(before.device.error,/218/);
  assert.equal(before.firmware.latest,'4.0.18.6');
  assert.equal(before.firmware.updateRequired,true);
  const handoff=await service.command({op:'prepareFirmwareUpdate'});
  assert.equal(handoff.ok,true);
  assert.equal(handoff.result.url,'https://drive.nuphy.io/?lang=zh-CN');
  const after=await service.state();
  assert.equal(after.device.connected,false);
  assert.equal(after.device.identified,false);
  assert.equal(after.codex.keys.enabled,false);
  const writes=(await service.operations()).filter(o=>['arm','paint','side','nativeLighting','prepareFunctionKey','adaptKeys'].includes(o.op));
  assert.deepEqual(writes,[]);
});

test('firmware handoff restores lighting and temporary function keys before releasing USB',async t=>{
  const win=Array(98).fill(0),mac=Array(98).fill(0);
  for(let i=0;i<12;i++){win[i+1]=58+i;mac[i+1]=FACTORY_MAC_ROW[i];}
  const keymap={mode:0,locationId:1,firmwareVersion:'1.0.16.6',active:mac,defaults:[mac,win]};
  const service=await fakeService(t,{tasks,keymap,permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}});
  await service.command({op:'codexAdapt'});
  await until(service.state,s=>s.codex.adaptation.status==='ready','key setup did not finish');
  const start=(await service.operations()).length;
  assert.equal((await service.command({op:'prepareFirmwareUpdate'})).ok,true);
  const ops=(await service.operations()).slice(start).map(o=>o.op);
  assert(ops.includes('restoreKeys'));
  assert(ops.includes('restoreFunctionKey'));
  assert(ops.indexOf('restoreKeys')<ops.indexOf('disconnect'));
  assert(ops.indexOf('restoreFunctionKey')<ops.indexOf('disconnect'));
  assert.equal((await service.state()).device.driverHandoff,true);
});

test('empty custom slots choose recent tasks on enable while real saved assignments remain intact',async t=>{
  const service=await fakeService(t,{tasks});
  await service.command({op:'settings',settings:{codexTaskSource:'custom',slotIds:[]}});
  await service.command({op:'codexAdapt'});
  let state=await service.state();
  assert.equal(state.settings.codexTaskSource,'recent');
  assert.equal(state.codex.slots[0].id,'one');
  assert.equal((await service.command({op:'codexSlot',index:0})).ok,true);
  await service.command({op:'settings',settings:{codexTaskSource:'custom',slotIds:['two']}});
  await service.command({op:'codexAdapt'});
  state=await service.state();
  assert.equal(state.settings.codexTaskSource,'custom');
  assert.equal(state.codex.slots[0].id,'two');
  const missing=await service.command({op:'codexSlot',index:1});
  assert.equal(missing.ok,false);
  assert.match(missing.error,/最近任务/);
});

test('host and helper permissions are both required and host updates never grant or open settings',async t=>{
  const service=await fakeService(t,{permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}});
  const start=(await service.operations()).length;
  const denied={inputMonitoring:false,accessibility:false,canPostEvents:false};
  assert.equal((await service.command({op:'nativePermissions',permissions:denied})).ok,true);
  let state=await service.state();
  assert.equal(state.native.inputMonitoring,false);
  assert.equal(state.native.helper.inputMonitoring,true);
  assert.equal(state.native.host.inputMonitoring,false);
  assert.equal((await service.command({op:'nativePermissions',permissions:{inputMonitoring:true}})).ok,false);
  assert.equal((await service.command({op:'nativePermissions',permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true}})).ok,true);
  state=await service.state();
  assert.equal(state.native.inputMonitoring,true);
  assert.equal(state.native.accessibility,true);
  assert(!(await service.operations()).slice(start).some(o=>o.op==='openPermissionSettings'));
});

test('an unsupported USB Kick does not disable a subsequently selected AIR Bluetooth keyboard',async t=>{
  const permissions={inputMonitoring:true,accessibility:true,canPostEvents:true};
  const service=await fakeService(t,{modelId:'kick75',firmwareVersion:'4.0.15.6',readOnly:true,permissions});
  await service.command({op:'disconnect'});
  await service.configure({present:false,bluetoothDevices:[{id:'1234',model:'Air75 V3',transport:'bluetooth'}]});
  await service.command({op:'codexAdapt'});
  const state=await service.state();
  assert.equal(state.bluetooth.connected,true);
  assert.equal(state.codex.adaptation.status,'ready');
  assert.equal(state.codex.adaptation.transport,'bluetooth');
});

test('a failed USB release never returns an updater URL or re-enables keyboard control',async t=>{
  const service=await fakeService(t,{modelId:'kick75',firmwareVersion:'4.0.15.6',readOnly:true,failDisconnect:true});
  const result=await service.command({op:'prepareFirmwareUpdate'});
  assert.equal(result.ok,false);
  assert.match(result.error,/重新插拔/);
  assert.equal(result.result?.url,undefined);
  assert.equal((await service.state()).codex.keys.enabled,false);
  assert.equal((await service.state()).device.driverHandoff,true);
});
