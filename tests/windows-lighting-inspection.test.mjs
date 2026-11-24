import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {LightingInspection} from '../server/lighting-inspection.mjs';
import {deriveConnectionDisplay} from '../shared/connection-display.mjs';
import {lightingUnavailableMessage} from '../shared/device-status.mjs';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';

const result=()=>({modelId:'air75-v3',firmwareVersion:'1.0.23.6',lightingProfile:1,ledCount:104,
  state:[2,60,0,0,0,0,0,0,0,2,50,0,0,0,0,0,0,0,0,0,0,94],renderedColors:Array(104).fill('#123456'),readOnly:true,noMutation:true,restorationReady:false});
function hardware(){
  const h=new EventEmitter();h.transportEpoch=0;
  h.state={connected:true,identified:true,readOnly:true,modelId:'air75-v3',firmwareVersion:'1.0.23.6',lightingProfile:1,connectionSessionId:'test:1'};
  h.request=async op=>{assert.equal(op,'lightingSnapshot');return result();};return h;
}
test('lighting observation remains immutable and never becomes a recovery backup',async()=>{
  const h=hardware(),inspection=new LightingInspection(h,{now:()=>123});
  const sample=await inspection.read();assert.equal(sample.capturedAt,123);assert.equal(sample.restorationReady,false);
  sample.renderedColors[0]='#ffffff';assert.equal(inspection.snapshot().renderedColors[0],'#123456');
  for(const field of ['lightingProfile','firmwareVersion','connectionSessionId']){
    const before=h.state[field];h.state[field]=field==='lightingProfile'?0:'changed';assert.equal(inspection.snapshot(),null);
    h.state[field]=before;assert.equal(inspection.snapshot(),null);await inspection.read();
  }
  h.emit('disconnected');assert.equal(inspection.snapshot(),null);
});
test('unverified firmware does not reach the lighting reader',async()=>{
  const h=hardware();h.state.firmwareVersion='2.0.0.8';h.request=async()=>assert.fail('must not send a lighting read');
  await assert.rejects(new LightingInspection(h).read(),{code:'LIGHTING_SCHEMA_UNVERIFIED'});
});
test('in-flight profile changes and unsafe returned metadata discard the observation',async()=>{
  const h=hardware(),inspection=new LightingInspection(h);
  h.request=async()=>{h.state.lightingProfile=0;return result();};
  await assert.rejects(inspection.read(),{code:'SNAPSHOT_SESSION_CHANGED'});assert.equal(inspection.snapshot(),null);
  h.state.lightingProfile=1;h.request=async()=>({...result(),restorationReady:true});
  await assert.rejects(inspection.read(),{code:'BRIDGE_PROTOCOL_ERROR'});assert.equal(inspection.snapshot(),null);
});
test('healthy Windows preview has its own neutral connection state and cannot claim restored lighting',()=>{
  const state={desktop:{host:'tauri',capabilities:{lighting:false}},device:{...hardware().state,errorCode:'WINDOWS_PROBE_ONLY',connection:{status:'attention'}},playback:{mode:'idle'}};
  const display=deriveConnectionDisplay({state});assert.equal(display.stateId,'usbPreview');assert.equal(display.tone,'neutral');assert.equal(display.primaryAction,null);
  assert.doesNotMatch(display.deviceBody.zh,/检查连接|重新连接/);assert.match(lightingUnavailableMessage(state),/当前键盘暂不能播放/);
  assert.equal(deriveConnectionDisplay({state,serviceError:'offline'}).stateId,'serviceUnknown');
  state.device.errorCode='ROUTE_MISMATCH';assert.equal(deriveConnectionDisplay({state}).stateId,'attention');
});
test('real isolated service exposes a session-bound read-only observation and clears it on disconnect',{timeout:15000},async t=>{
  const f=await previewServiceFixture(t,{connected:true}),service=await f.start();
  assert.equal((await service.command({op:'connect'})).ok,true);
  const inspected=await service.command({op:'inspectLighting'});assert.equal(inspected.ok,true);
  assert.equal(inspected.result.restorationReady,false);assert.equal(inspected.result.renderedColors.length,104);
  assert.equal((await service.state()).device.lightingSnapshot.lightingProfile,1);
  await service.command({op:'disconnect'});assert.equal((await service.state()).device.lightingSnapshot,null);
  await service.close();assert(!(await f.operations()).some(row=>['arm','paint','nativeLighting','side'].includes(row.op)));
});
test('real isolated service rejects an unregistered firmware before a lighting request',{timeout:15000},async t=>{
  const f=await previewServiceFixture(t,{connected:true,firmwareVersion:'2.0.0.8',lightingProfile:0}),service=await f.start();
  await service.command({op:'connect'});const inspected=await service.command({op:'inspectLighting'});
  assert.equal(inspected.ok,false);assert.match(inspected.error,/尚未核对/);
  assert.equal((await service.state()).device.lightingProfile,0);await service.close();
  assert(!(await f.operations()).some(row=>row.op==='lightingSnapshot'));
});
test('Air75 V3 2.0.0.7 can be inspected without enabling playback or restoration',async()=>{
  const h=hardware();h.state.firmwareVersion='2.0.0.7';h.request=async()=>({...result(),firmwareVersion:'2.0.0.7'});
  const value=await new LightingInspection(h).read();assert.equal(value.state.length,22);assert.equal(value.restorationReady,false);
  h.request=async()=>({...result(),firmwareVersion:'2.0.0.7',state:Array(17).fill(0)});
  await assert.rejects(new LightingInspection(h).read(),{code:'BRIDGE_PROTOCOL_ERROR'});
});
