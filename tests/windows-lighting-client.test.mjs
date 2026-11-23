import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import path from 'node:path';
import {windowsBoardSleepSupported} from '../shared/windows-lighting-firmware.mjs';
import {NativeLightingClient} from '../server/native-lighting-client.mjs';
import {NATIVE_LIGHTING as C,encodeLightingRequest,validateLightingMessage,validateLightingResult} from '../server/native-lighting-contract.mjs';
import {getKeyboardProfile} from '../shared/keyboard-models.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
class Clock {
  value=0;serial=0;timers=new Map();
  now=()=>this.value;
  setTimeout=(fn,ms)=>{const id=++this.serial;this.timers.set(id,{fn,at:this.value+ms});return id;};
  clearTimeout=id=>this.timers.delete(id);
  async advance(ms){const end=this.value+ms;for(;;){const next=[...this.timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;this.value=next[1].at;this.timers.delete(next[0]);next[1].fn();await flush();}this.value=end;await flush();}
}
class Peer extends EventEmitter {
  stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();requests=[];lease=0;killCount=0;
  constructor(options={}){super();this.options=options;let pending='';this.stdin.on('data',b=>{pending+=b;while(pending.includes('\n')){const i=pending.indexOf('\n'),r=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);this.requests.push(r);queueMicrotask(()=>this.handle(r));}});}
  kill(){this.killCount++;}
  reply(r,result){this.stdout.write(JSON.stringify({id:r.id,ok:true,result})+'\n');}
  shutdown(overrides={}){this.stdout.write(JSON.stringify({event:'shutdownComplete',sessionId:this.sessionId,eventSequence:1,lightingRestored:true,recoveryPending:false,noMutation:!this.lease,reasonCode:null,...overrides})+'\n');}
  exit(code=0){this.stdout.end();this.emit('close',code,null);}
  handle(r){
    if(r.op==='hello'){this.sessionId=r.sessionId;this.reply(r,{profile:C.profile,protocolVersion:C.protocolVersion,implementation:C.implementation,implementationVersion:'1.2.40',sessionId:r.sessionId,backend:'simulated',readOnly:false,maxLineBytes:C.maxLineBytes,capabilities:C.capabilities,...this.options.hello});}
    if(['arm','armNative','armConnectionWake'].includes(r.op)){
      const p=getKeyboardProfile(r.modelId);this.lease++;
      this.reply(r,{armed:true,leaseId:this.lease,device:{modelId:r.modelId,firmwareVersion:(p.windowsQualifiedFirmware??p.qualifiedFirmware),lightingProfile:r.lightingProfile,vendorId:p.vendorId,productId:p.productIds[0],keyLedCount:p.keyCount,ledCount:p.keyCount+p.sideCount,canvasCount:p.canvasCount,connectionToken:'simulated-connection',...this.options.device},boardSleepLease:{supported:windowsBoardSleepSupported(r.modelId,this.options.device?.firmwareVersion??(p.windowsQualifiedFirmware??p.qualifiedFirmware)),active:windowsBoardSleepSupported(r.modelId,this.options.device?.firmwareVersion??(p.windowsQualifiedFirmware??p.qualifiedFirmware)),pending:windowsBoardSleepSupported(r.modelId,this.options.device?.firmwareVersion??(p.windowsQualifiedFirmware??p.qualifiedFirmware))},
        ...(r.op==='armConnectionWake'?{connectionWake:{mainBlackVerified:true,sideMuted:true,sideIndicatorObserved:false,allLightsBlack:true,paletteExposureRequired:true,...this.options.wake}}:{})});
      if(this.options.shutdownAfterArm)this.shutdown();
    }
    if(r.op==='paint'&&!this.options.holdPaint)this.paintReply(r);
    if(r.op==='side')this.reply(r,{updated:true});
    if(['nativeLighting','nativeSnapshot'].includes(r.op)&&!this.options.holdNative){
      this.nativeState??=[2,60,2,0,1,3,31,47,63,2,45,1,0,0,12,34,56];
      if(r.op==='nativeLighting'){
        this.nativeState[0]=r.mode;this.nativeState[1]=r.brightness;this.nativeState[2]=r.speed;
        if(r.color){this.nativeState[4]=0;this.nativeState.splice(6,3,...r.color);}
      }
      const p=getKeyboardProfile('kick75');this.reply(r,{verified:true,changed:r.op==='nativeLighting',state:[...this.nativeState],colors:Array((p.keyCount+p.sideCount)*3).fill(12)});
    }
    if(r.op==='restore')this.reply(r,{verified:true,noMutation:false,archived:true});
    if(r.op==='heartbeat'&&!this.options.holdHeartbeat)this.reply(r,{alive:true});
    if(r.op==='quit'){
      if(this.options.holdQuit)return;
      this.reply(r,{quitting:true,lightingRestored:true,noMutation:!this.lease});
      if(!this.options.omitShutdown)this.shutdown();this.exit(this.options.exitCode||0);
    }
  }
  paintReply(r){this.reply(r,{painted:84,skipped:false,readback:r.verify});}
}
function fixture(t,options={}){
  const peer=new Peer(options),clock=new Clock();let spawns=0;
  const client=new NativeLightingClient({command:path.resolve('unused-lighting-controller'),backend:'simulated',modelId:options.modelId??'air75-v3',lightingProfile:1,firmwareVersion:options.clientFirmwareVersion},{spawnProcess:()=>{spawns++;return peer;},scheduler:clock});
  t.after(()=>{if(!client.ended)peer.exit(1);});
  return {client,peer,clock,spawns:()=>spawns};
}
const colors=()=>Array(84).fill('#112233');
test('a separately selected Air 2 controller binds the reply to the discovered firmware',async t=>{
  const {client}=fixture(t,{clientFirmwareVersion:'2.0.0.7',device:{firmwareVersion:'2.0.0.7'}});
  await client.arm();assert.equal(client.status().device.firmwareVersion,'2.0.0.7');await client.close();
});
const rejectsCode=(promise,code)=>assert.rejects(promise,{code});
test('lighting client negotiates, binds metadata, paints, restores and requires cleanup before close',async t=>{
  const {client,peer}=fixture(t);await client.arm();assert.equal(client.status().device.firmwareVersion,'1.0.23.6');
  await client.paint(colors(),{verify:true});await client.side('#abcdef',75);await client.restore();
  assert.equal(client.status().restoration.verified,true);await client.arm();assert.equal(client.status().leaseId,2);
  const result=await client.close();assert.equal(result.restoration.verified,true);assert.equal(client.status().phase,'closed');assert.equal(peer.killCount,0);
});
test('heartbeats continue independently while painting is held and an unanswered heartbeat stops output',async t=>{
  const {client,peer,clock}=fixture(t,{holdPaint:true});await client.arm();const paint=client.paint(colors());const rejected=rejectsCode(paint,'LIGHTING_HEARTBEAT_TIMEOUT');
  await clock.advance(3000);assert.equal(client.status().heartbeat.acknowledged,3);assert.equal(peer.requests.filter(r=>r.op==='paint').length,1);
  peer.options.holdHeartbeat=true;await clock.advance(4000);await rejected;assert.equal(peer.stdin.writableEnded,true);assert.equal(peer.killCount,0);
});
test('bounded queue reserves heartbeat capacity and discards expired unsent colors',async t=>{
  const {client,peer,clock}=fixture(t,{holdPaint:true});await client.arm();const first=client.paint(colors());
  const waiting=Array.from({length:6},()=>client.side('#abcdef'));const expired=waiting.map(p=>rejectsCode(p,'FRAME_EXPIRED'));
  await rejectsCode(client.side('#ffffff'),'LIGHTING_QUEUE_FULL');await clock.advance(600);peer.paintReply(peer.requests.find(r=>r.op==='paint'));await first;await Promise.all(expired);
  assert.equal(peer.requests.some(r=>r.op==='side'),false);await client.close();
});
test('quit bypasses a blocked paint, cancels queued frames and never kills or restarts the peer',async t=>{
  const {client,peer,spawns}=fixture(t,{holdPaint:true});await client.arm();const paint=client.paint(colors()),queued=client.side('#ffffff');
  const checks=[rejectsCode(paint,'LIGHTING_CLIENT_CLOSED'),rejectsCode(queued,'LIGHTING_CLIENT_CLOSED')];await client.close();await Promise.all(checks);
  assert.equal(peer.requests.some(r=>r.op==='side'),false);assert.equal(peer.killCount,0);assert.equal(spawns(),1);await rejectsCode(client.arm(),'LIGHTING_CLIENT_CLOSED');
});
for(const [name,options,code] of [
 ['backend mismatch',{hello:{backend:'windows-hid'}},'LIGHTING_PROTOCOL_MISMATCH'],
 ['wrong physical profile',{device:{lightingProfile:0}},'LIGHTING_PROTOCOL_ERROR'],
 ['unexpected firmware',{device:{firmwareVersion:'2.0.0.7'}},'LIGHTING_PROTOCOL_ERROR'],
 ['foreign device',{device:{modelId:'kick75'}},'LIGHTING_PROTOCOL_ERROR'],
])test(`lighting client rejects ${name} without sending colors`,async t=>{
  const {client,peer}=fixture(t,options);await rejectsCode(client.arm(),code);assert.equal(peer.requests.some(r=>r.op==='paint'),false);assert.equal(peer.stdin.writableEnded,true);assert.equal(peer.killCount,0);
});
test('same-chunk arm and shutdown invalidate the lease before the caller can use it',async t=>{
  const {client}=fixture(t,{shutdownAfterArm:true});await rejectsCode(client.arm(),'SESSION_CHANGED');assert.equal(client.status().leaseId,null);
});
for(const [options,code] of [[{omitShutdown:true},'LIGHTING_CLEANUP_UNCONFIRMED'],[{exitCode:1},'LIGHTING_EXIT_FAILED']])
 test(`lighting close refuses incomplete evidence: ${code}`,async t=>{const {client}=fixture(t,options);await client.arm();await rejectsCode(client.close(),code);assert.equal(client.status().phase,'failed');});
test('invalid reply IDs reject pending paint and preserve uncertain restoration',async t=>{
  const {client,peer}=fixture(t,{holdPaint:true});await client.arm();const paint=client.paint(colors());const rejection=rejectsCode(paint,'LIGHTING_PROTOCOL_ERROR');
  peer.stdout.write(JSON.stringify({id:999,ok:true,result:{painted:84,skipped:false,readback:false}})+'\n');await rejection;
  assert.equal(client.status().restoration.pending,true);assert.equal(client.status().restoration.verified,false);
});
test('invalid color requests stay local and protocol rejects extra fields and contradictory cleanup',async t=>{
  const {client,peer}=fixture(t);await client.arm();await rejectsCode(client.paint(['#ffffff']),'INVALID_COLORS');await rejectsCode(client.side('#ffffff',101),'INVALID_SIDE');
  assert.equal(peer.requests.filter(r=>['paint','side'].includes(r.op)).length,0);
  assert.throws(()=>encodeLightingRequest(1,client.sessionId,'arm',{modelId:'air75-v3',lightingProfile:1,directory:'untrusted'}),{code:'LIGHTING_REQUEST_INVALID'});
  assert.throws(()=>validateLightingMessage({event:'shutdownComplete',sessionId:client.sessionId,eventSequence:1,lightingRestored:true,recoveryPending:true,noMutation:false,reasonCode:null}),{code:'LIGHTING_PROTOCOL_ERROR'});await client.close();
});
test('native lease validates parameters locally, binds its purpose and cannot issue RGB or side writes',async t=>{
  const {client,peer}=fixture(t,{modelId:'kick75'});
  await client.armNative();assert.equal(client.status().leasePurpose,'native');
  await rejectsCode(client.paint(Array(80).fill('#ffffff')),'NOT_ARMED');await rejectsCode(client.side('#ffffff'),'NOT_ARMED');
  for(const config of [{mode:21,brightness:50,speed:2},{mode:3,brightness:101,speed:2},{mode:3,brightness:50,speed:5},{mode:3,brightness:50,speed:2,path:'x'}])await assert.rejects(client.nativeLighting(config));
  assert.equal(peer.requests.some(r=>r.op==='nativeLighting'),false);
  const result=await client.nativeLighting({mode:3,brightness:50,speed:2,color:'#112233'});
  assert.deepEqual(result.state.slice(6,9),[17,34,51]);assert.equal((await client.nativeSnapshot()).changed,false);
  await client.restore();assert.equal(client.status().leasePurpose,null);
  await client.arm();await rejectsCode(client.nativeSnapshot(),'NOT_ARMED');await client.close();
});
test('unsupported native models stay local and older lighting controllers cannot negotiate v4',async t=>{
  const f=fixture(t);await rejectsCode(f.client.armNative(),'NATIVE_LIGHTING_UNSUPPORTED');assert.equal(f.spawns(),0);
  for(const version of [2,3,4]){const old=fixture(t,{hello:{profile:`windows-lighting-v${version}`,protocolVersion:version}});await rejectsCode(old.client.start(),'LIGHTING_PROTOCOL_MISMATCH');}
});
test('connection wake binds blackout proof to the armed lease and clears it after restore',async t=>{
  const {client,peer}=fixture(t);await client.armConnectionWake();
  assert.equal(client.status().leasePurpose,'perKey');assert.equal(client.status().connectionWakePreparation.mainBlackVerified,true);
  await client.paint(colors());await client.restore();assert.equal(client.status().connectionWakePreparation,null);
  await client.arm();assert.equal(client.status().connectionWakePreparation,null);await client.close();assert.equal(peer.killCount,0);
});
for(const wake of [{mainBlackVerified:false},{sideMuted:false},{allLightsBlack:false,sideIndicatorObserved:false},{path:'external'}])
test(`invalid wake proof is rejected before any animation frame: ${JSON.stringify(wake)}`,async t=>{
  const {client,peer}=fixture(t,{wake});await rejectsCode(client.armConnectionWake(),'LIGHTING_PROTOCOL_ERROR');
  assert.equal(peer.requests.some(r=>r.op==='paint'),false);assert.equal(peer.killCount,0);
});
test('native queued mutations expire and priority quit cancels pending native snapshots without killing',async t=>{
  const {client,peer,clock}=fixture(t,{modelId:'kick75',holdNative:true});await client.armNative();
  const first=client.nativeLighting({mode:3,brightness:50,speed:2});
  const firstCheck=rejectsCode(first,'FRAME_EXPIRED');
  const queued=client.nativeLighting({mode:4,brightness:60,speed:1});const expired=rejectsCode(queued,'FRAME_EXPIRED');
  await clock.advance(600);
  const request=peer.requests.find(r=>r.op==='nativeLighting');
  peer.stdout.write(JSON.stringify({id:request.id,ok:false,error:{code:'FRAME_EXPIRED',message:'expired'}})+'\n');
  // The current frame's own rejection is independent of the queued age check.
  await firstCheck;await expired;
  const snapshot=client.nativeSnapshot();const cancelled=rejectsCode(snapshot,'LIGHTING_CLIENT_CLOSED');await client.close();await cancelled;
  assert.equal(peer.requests.filter(r=>r.op==='nativeLighting').length,1);assert.equal(peer.killCount,0);
});

test('the current lighting protocol rejects candidate key writes and cannot flatten pending key originals to clean',()=>{
  assert.equal(C.capabilities.keymapWrite,false);
  for(const op of ['prepareFunctionKeys','restoreFunctionKeys','recoverFunctionKeys']) {
    assert.throws(()=>encodeLightingRequest(2,'00000000-0000-4000-8000-000000000001',op,{keys:[1,4]}));
  }
  const result={modelId:'air75-v3',firmwareVersion:'2.0.0.7',lightingProfile:1,
    pending:{lightingProfiles:[],boardSleep:false,keymapProfiles:[1]},canRestore:true,noMutation:true};
  assert.deepEqual(validateLightingResult('recoveryStatus',result,{modelId:'air75-v3',lightingProfile:1}).pending.keymapProfiles,[1]);
  delete result.pending.keymapProfiles;
  assert.throws(()=>validateLightingResult('recoveryStatus',result,{modelId:'air75-v3',lightingProfile:1}),{code:'LIGHTING_PROTOCOL_ERROR'});
});

test('v5 requires an independent complete key receipt and rejects inconsistent all-clear reports',()=>{
  const expected={modelId:'air75-v3',lightingProfile:1},empty=()=>({lightingProfiles:[],boardSleep:false,keymapProfiles:[]});
  const report={modelId:'air75-v3',lightingProfile:1,lighting:{status:'notNeeded'},boardSleep:{status:'notNeeded'},
    functionKeys:{status:'restored',completion:{verified:true,noMutation:false,archived:true,restoredKeys:2,externalChangesPreserved:true}},
    deferredProfiles:[],remaining:empty(),complete:true,completedCleanup:empty()};
  assert.equal(validateLightingResult('recoverExisting',report,expected).complete,true);
  for(const change of [
    r=>delete r.functionKeys,
    r=>r.functionKeys={status:'failed',error:{code:'UNQUALIFIED',message:'record retained'}},
    r=>r.functionKeys.completion.restoredKeys=13,
    r=>r.functionKeys.completion.noMutation=true,
    r=>r.functionKeys.completion.verified=false,
    r=>r.remaining.keymapProfiles=[1],
    r=>delete r.remaining.keymapProfiles,
  ]){const invalid=structuredClone(report);change(invalid);assert.throws(()=>validateLightingResult('recoverExisting',invalid,expected),{code:'LIGHTING_PROTOCOL_ERROR'});}
});
