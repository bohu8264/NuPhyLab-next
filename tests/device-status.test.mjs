import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLightingOnly,lightingUnavailableMessage} from '../shared/device-status.mjs';
test('a failed latest-firmware probe never masquerades as a legacy Kick firmware',()=>{
  for(const modelId of ['air75-v3','kick75']){
    const state={device:{connected:true,modelId,readOnly:true,capabilities:{perKey:false,stockEffects:false}},firmware:{upgradeRecommended:false}};
    assert.equal(nativeLightingOnly(state),false);
    assert.match(lightingUnavailableMessage(state),/重新连接/);
    assert.doesNotMatch(lightingUnavailableMessage(state),/固件|4\.0\.18/);
  }
});
test('only verified stock-effect support selects the legacy Kick page',()=>{
  const device={connected:true,modelId:'kick75',readOnly:false,capabilities:{perKey:false,stockEffects:true}};
  assert.equal(nativeLightingOnly({device}),true);
  assert.match(lightingUnavailableMessage({device}),/NuPhyIO/);
  assert.equal(nativeLightingOnly({device:{...device,modelId:'air75-v3'}}),false);
  assert.equal(nativeLightingOnly({device:{...device,connected:false}}),false);
  assert.equal(nativeLightingOnly({device:{...device,readOnly:true}}),false);
});
