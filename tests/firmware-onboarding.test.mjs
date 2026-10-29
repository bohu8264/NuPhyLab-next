import test from 'node:test';import assert from 'node:assert/strict';
import {firmwarePrompt,currentFirmwareReady,firmwareUpdateSatisfied} from '../shared/firmware-onboarding.mjs';
const old=()=>({device:{connected:true,modelId:'kick75',connectionSessionId:'first'},firmware:{current:'4.0.15.6',latest:'4.0.18.6',minimumRequired:'4.0.18.6',latestConfirmed:true,upgradeRecommended:true,status:'updateAvailable'}});
test('old firmware reminder is stable across USB reconnects and separated by model and version',()=>{
 const first=old(),again=structuredClone(first);again.device.connectionSessionId='second';
 assert.equal(firmwarePrompt(first).key,firmwarePrompt(again).key);
 again.firmware.current='4.0.16.6';assert.notEqual(firmwarePrompt(first).key,firmwarePrompt(again).key);
 const air={device:{connected:true,modelId:'air75-v3'},firmware:{current:'1.0.16.6',latest:'1.0.23.6',minimumRequired:'1.0.16.6',latestConfirmed:true,status:'updateAvailable'}};
 assert.equal(firmwarePrompt(air).target,'1.0.23.6');assert.notEqual(firmwarePrompt(air).key,firmwarePrompt(first).key);
});
test('latest, newer, offline compatible and unknown keyboards never request an unnecessary downgrade or browser handoff',()=>{
 for(const patch of [{current:'4.0.18.6',status:'current'},{current:'4.0.19.6',status:'newer'},{current:'unknown'},{current:'4.0.18.6',latestConfirmed:false,status:'unavailable',upgradeRecommended:false}]){
  const s=old();Object.assign(s.firmware,patch);assert.equal(firmwarePrompt(s),null);
 }
 const absent=old();absent.device.connected=false;assert.equal(firmwarePrompt(absent),null);
 const unknown=old();unknown.device.modelId='other';assert.equal(firmwarePrompt(unknown),null);
 const offline=old();offline.firmware.latestConfirmed=false;offline.firmware.status='unavailable';assert.equal(firmwarePrompt(offline).target,'4.0.18.6');
});
test('updated firmware clears the old reminder even offline; an old or different board does not',()=>{
 const previous=firmwarePrompt(old()),state=old();assert.equal(firmwareUpdateSatisfied(state,previous),false);
 Object.assign(state.firmware,{current:'4.0.18.6',status:'current',upgradeRecommended:false,compatible:true});assert.equal(currentFirmwareReady(state),true);assert.equal(firmwareUpdateSatisfied(state,previous),true);
 Object.assign(state.firmware,{latestConfirmed:false,status:'unavailable'});assert.equal(currentFirmwareReady(state),false);assert.equal(firmwareUpdateSatisfied(state,previous),true);
 state.device.modelId='air75-v3';assert.equal(firmwareUpdateSatisfied(state,previous),false);
 state.device.modelId='kick75';state.firmware.compatible=false;assert.equal(firmwareUpdateSatisfied(state,previous),false);
});
