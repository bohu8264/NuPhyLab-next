import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLightingOnly,lightingUnavailableMessage,sidebarDeviceIdentity} from '../shared/device-status.mjs';
test('a failed latest-firmware probe never masquerades as a legacy Kick firmware',()=>{
  for(const modelId of ['air75-v3','kick75']){
    const state={device:{connected:true,modelId,readOnly:true,capabilities:{perKey:false,stockEffects:false}},firmware:{upgradeRecommended:false}};
    assert.equal(nativeLightingOnly(state),false);
    assert.match(lightingUnavailableMessage(state),/重新连接/);
    assert.doesNotMatch(lightingUnavailableMessage(state),/固件|4\.0\.18/);
  }
});

test('the sidebar names only a connected USB keyboard, never an idle or retained identity',()=>{
  for(const state of [null,{}, {device:{connected:false,autoConnecting:true}},
    {device:{connected:false,identified:true,modelId:'kick75',model:'Kick75 ANSI',readOnly:true}},
    {device:{connected:false,identified:true,modelId:'air75-v3',model:'AIR75 V3 ANSI',connection:{status:'reconnecting'}}}]) {
    assert.deepEqual(sidebarDeviceIdentity(state),{modelName:null,transport:null});
  }
  assert.deepEqual(sidebarDeviceIdentity({device:{connected:true,modelId:'air75-v3',model:'Air75 V3 ANSI'}}),{modelName:'Air75 V3',transport:'usb'});
  assert.deepEqual(sidebarDeviceIdentity({device:{connected:true,modelId:'kick75',model:'Kick75 ANSI',readOnly:true}}),{modelName:'Kick75',transport:'usb'});
});

test('USB removal and AIR/Kick switching cannot leave the prior model in the sidebar',()=>{
  const state={device:{connected:true,identified:true,modelId:'air75-v3',model:'Air75 V3 ANSI'}};
  assert.equal(sidebarDeviceIdentity(state).modelName,'Air75 V3');
  state.device.connected=false;assert.equal(sidebarDeviceIdentity(state).modelName,null);
  Object.assign(state.device,{connected:true,modelId:'kick75',model:'Kick75 ANSI'});
  assert.equal(sidebarDeviceIdentity(state).modelName,'Kick75');
  state.device.connected=false;assert.equal(sidebarDeviceIdentity(state).modelName,null);
  // A layout can change before the display-name field is replaced; model ID wins.
  Object.assign(state.device,{connected:true,modelId:'air75-v3'});
  assert.equal(sidebarDeviceIdentity(state).modelName,'Air75 V3');
});

test('connected AIR Bluetooth remains visible even with an old disconnected Kick identity',()=>{
  const state={device:{connected:false,identified:true,modelId:'kick75',model:'Kick75 ANSI',readOnly:true},bluetooth:{connected:true}};
  assert.deepEqual(sidebarDeviceIdentity(state),{modelName:'Air75 V3',transport:'bluetooth'});
  state.device.connected=true;assert.deepEqual(sidebarDeviceIdentity(state),{modelName:'Kick75',transport:'usb'});
  state.device.connected=false;state.bluetooth.connected=false;
  assert.deepEqual(sidebarDeviceIdentity(state),{modelName:null,transport:null});
});
test('only verified stock-effect support selects the legacy Kick page',()=>{
  const device={connected:true,modelId:'kick75',readOnly:false,capabilities:{perKey:false,stockEffects:true}};
  assert.equal(nativeLightingOnly({device}),true);
  assert.match(lightingUnavailableMessage({device}),/NuPhyIO/);
  assert.equal(nativeLightingOnly({device:{...device,modelId:'air75-v3'}}),false);
  assert.equal(nativeLightingOnly({device:{...device,connected:false}}),false);
  assert.equal(nativeLightingOnly({device:{...device,readOnly:true}}),false);
});
