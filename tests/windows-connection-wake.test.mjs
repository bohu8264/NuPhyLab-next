import test from 'node:test';
import assert from 'node:assert/strict';
import {AirConnectionWake,supportsAirConnectionWake} from '../server/connection-wake.mjs';
const device=()=>({modelId:'air75-v3',connected:true,identified:true,readOnly:false,transport:'USB',vendorId:0x19f5,productId:0x1028,
  firmwareVersion:'1.0.23.6',lightingProfile:1,ledCount:104,keyLedCount:84,connectionSessionId:'probe-1:1',protocolReady:false,
  identityQualification:{status:'qualified',source:'embeddedUsbSerial'},capabilities:{perKey:true,connectionWake:true,readProbeVerified:false},
  windowsLighting:{available:true,connectionWakeReady:true}});
test('Windows wake uses native-owner qualification without claiming a Mac read probe',()=>{
  const d=device();assert.equal(supportsAirConnectionWake(d),true);
  for(const patch of [{firmwareVersion:'2.0.0.8'},{lightingProfile:2},{identityQualification:null},{identityQualification:{status:'candidate',source:'embeddedUsbSerial'}},
    {identityQualification:{status:'qualified',source:'hidPath'}},{transport:'Bluetooth'},{ledCount:103},{keyLedCount:83},
    {windowsLighting:{available:true}},{windowsLighting:{available:false,connectionWakeReady:true}},{historicalRecoveryLost:true}])
    assert.equal(supportsAirConnectionWake({...d,...patch,protocolReady:true,capabilities:{...d.capabilities,readProbeVerified:true}}),false);
});
test('rejected preparation consumes the attachment opportunity and process restarts cannot replay it',()=>{
  const wake=new AirConnectionWake(),d=device();const first=wake.begin(d,1);assert(first);
  wake.cancel('outputFailed');assert.equal(wake.begin({...d,connectionSessionId:'new-process'},2),null);
  wake.absent();assert(wake.begin({...d,connectionSessionId:'reinserted'},3));
});
test('Windows preparation holds the starting clock, rejects stale attachments and finishes with a black frame',()=>{
  let now=0;const wake=new AirConnectionWake({now:()=>now}),d={...device(),armed:true};
  const first=wake.begin(d,1,{automatic:true});now=2000;assert.equal(wake.elapsed(),0);assert(wake.frame(d,1).every(c=>c==='#000000'));
  assert.equal(wake.start(first,d,1),true);now+=50;assert(wake.frame(d,1).some(c=>c!=='#000000'));
  now+=4350;assert(wake.frame(d,1).every(c=>c==='#000000'));assert.deepEqual(wake.handoff(),{automatic:true});wake.complete();assert.equal(wake.snapshot().status,'completed');
  wake.absent();wake.begin(d,2);assert.equal(wake.frame({...d,connectionSessionId:'changed'},2),null);assert.equal(wake.snapshot().reason,'sessionChanged');
});
