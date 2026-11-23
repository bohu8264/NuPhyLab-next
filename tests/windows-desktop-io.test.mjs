import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {WindowsDesktopIO} from '../server/windows-desktop-io.mjs';
import {deviceModels} from '../scripts/windows/prepare.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,configuration={}){
  const dir=await mkdtemp(path.join(tmpdir(),'NuPhy Windows IO 0 '));
  const helper=path.join(dir,'fake io.mjs'),log=path.join(dir,'events.jsonl');
  await writeFile(helper,`
import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
const config=${JSON.stringify(configuration)},log=${JSON.stringify(log)};let sessionId,sequence=0,monitor,audioSession;
const event=v=>{sequence+=config.gap&&v.event==='key'?2:1;console.log(JSON.stringify({...v,sessionId,eventSequence:sequence}));};
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line),{id,op}=q;appendFileSync(log,JSON.stringify(q)+'\\n');let result;
 if(op==='hello'){sessionId=q.sessionId;result={protocolVersion:config.oldHello?1:2,implementation:'windows-desktop-io',platform:'win32',sessionId,capabilities:{audio:true,globalKeys:true,sensitiveKeys:false,orderedKeyEvents:!config.oldHello}};}
 else if(op==='inventory')result={systemSupported:true,microphonePermission:false,devices:[{id:'mic-fixture',name:'测试 麦克风'}]};
 else if(op==='monitorKeys'){
  result={monitoring:true,suppressing:false,sensitiveKeys:false};const old=monitor;monitor=q.monitorId;
  if(config.suspendMonitor)event({event:'systemSuspend'});
  if(config.firstBatch)for(const phase of ['up','down','down','up'])event({event:'key',modelId:q.modelId,source:'windowsRawInput',code:'KeyA',phase,monitorId:monitor,sensitiveKeys:false});
  if(config.delayedMonitor){event({event:'key',modelId:q.modelId,source:'windowsRawInput',code:'KeyA',phase:'down',monitorId:monitor,sensitiveKeys:false});setTimeout(()=>console.log(JSON.stringify({id,ok:true,result})),600);return;}
  if(config.firstBatch){console.log(JSON.stringify({id,ok:true,result}));return;}
  if(config.currentReset){setTimeout(()=>{event({event:'key',modelId:q.modelId,source:'windowsRawInput',code:'KeyA',phase:'down',monitorId:monitor,sensitiveKeys:false});event({event:'keysReset',modelId:q.modelId,monitorId:monitor,reasonCode:'INPUT_EVENT_OVERFLOW'});event({event:'key',modelId:q.modelId,source:'windowsRawInput',code:'KeyA',phase:'down',monitorId:monitor,sensitiveKeys:false});},20);console.log(JSON.stringify({id,ok:true,result}));return;}
  setTimeout(()=>{if(old){event({event:'key',modelId:q.modelId,source:'windowsRawInput',code:'KeyA',phase:'down',monitorId:old,sensitiveKeys:false});if(config.oldReset)event({event:'keysReset',modelId:q.modelId,monitorId:old,reasonCode:'INPUT_SOURCE_CHANGED'});}event({event:'key',modelId:q.modelId,source:'windowsRawInput',code:'KeyA',phase:'down',monitorId:monitor,sensitiveKeys:false});},20);
 }
 else if(op==='startAudio'){
  const old=audioSession;audioSession=q.session;
  const failed=()=>{event({event:'audioFeature',session:q.session,status:'error',error:'systemCapture',reasonCode:'AUDIO_DEVICE_CHANGED'});event({event:'audioFeature',session:q.session,status:'listening',rms:0.7,bands:Array(8).fill(0.6)});event({event:'audioFeature',session:q.session,status:'error',error:'systemCapture',reasonCode:'AUDIO_WORKER_FAILED'});};
  if(config.audioFailure==='beforeAck')failed();
  if(config.audioFailure==='afterAck')setTimeout(failed,20);
  if(config.staleAudio&&old){event({event:'audioFeature',session:old,status:'error',error:'systemCapture',reasonCode:'AUDIO_DEVICE_CHANGED'});event({event:'audioFeature',session:old,status:'listening',rms:0.8,bands:Array(8).fill(0.8)});}
  if(config.suspend)setTimeout(()=>event({event:'systemSuspend'}),40);
  setTimeout(()=>event({event:'audioFeature',session:q.session,status:'listening',rms:config.badFeature?2:0.2,bands:Array(8).fill(0.1)}),20);
  result={started:true,session:config.badAudioStart?'unrelated-session':q.session};
 }
 else if(op==='quit'){
  console.log(JSON.stringify({id,ok:true,result:{quitting:true}}));
  if(!config.missingReceipt)event({event:'shutdownComplete',audioStopped:true,keysStopped:true});process.exit(0);return;
 }else {if(op==='stopAudio'&&config.suspendOnAudioStop)event({event:'systemSuspend'});result={alive:true,stopped:!(op==='stopAudio'&&config.badAudioStop)};}
 if(config.holdInventory&&op==='inventory')return;
 console.log(JSON.stringify({id,ok:true,result}));
});
`);
  const io=new WindowsDesktopIO({command:process.execPath,args:[helper]});
  t.after(async()=>{await io.close().catch(()=>{});await rm(dir,{recursive:true,force:true});});
  return {io,log:async()=>JSON.parse('['+(await readFile(log,'utf8')).trim().split('\n').join(',')+']')};
}
test('desktop IO handshakes without starting capture and requires verified shutdown',async t=>{
  const f=await fixture(t);assert.equal((await f.io.start()).capabilities.sensitiveKeys,false);
  const inventory=await f.io.request('inventory');assert.equal(inventory.devices[0].name,'测试 麦克风');
  assert(!(await f.log()).some(r=>r.op==='startAudio'||r.op==='monitorKeys'));
  await f.io.close();assert.equal(f.io.phase,'closed');assert.equal(f.io.shutdown,true);
});
test('audio exports only bounded features and stops on changed desired state',async t=>{
  const f=await fixture(t),received=[];f.io.on('audio',v=>received.push(v));
  const session='12345678-1234-1234-1234-123456789abc';
  await f.io.syncAudio({enabled:true,session,source:'system',deviceId:''});await delay(80);
  assert(received.length>0);assert.deepEqual(Object.keys(received[0]).sort(),['bands','rms','session','status']);
  await f.io.syncAudio({enabled:false});await f.io.close();
  const rows=await f.log();assert.equal(rows.filter(r=>r.op==='startAudio').length,1);assert.equal(rows.filter(r=>r.op==='stopAudio').length,1);
});
for(const timing of ['beforeAck','afterAck'])test(`capture failure ${timing} retires the session and cannot replay queued samples`,async t=>{
  const f=await fixture(t,{audioFailure:timing}),received=[],failed=once(f.io,'audio');f.io.on('audio',v=>received.push(v));
  await f.io.syncAudio({enabled:true,session:'12345678-1234-1234-1234-123456789abc',source:'system',deviceId:''});
  await failed;await delay(60);
  assert.deepEqual(received.map(v=>v.status),['error']);assert.equal(f.io.audioDesired,null);assert.equal(f.io.phase,'ready');
  await f.io.syncAudio({enabled:false});await f.io.close();
  const rows=await f.log();assert.equal(rows.filter(q=>q.op==='startAudio').length,1);assert.equal(rows.filter(q=>q.op==='stopAudio').length,1);
});
test('switching audio sessions ignores old failures without cancelling the new capture',async t=>{
  const f=await fixture(t,{staleAudio:true}),received=[];f.io.on('audio',v=>received.push(v));
  const first='12345678-1234-1234-1234-123456789abc',next='12345678-1234-1234-1234-123456789def';
  await f.io.syncAudio({enabled:true,session:first,source:'system',deviceId:''});
  received.length=0;
  await f.io.syncAudio({enabled:true,session:next,source:'microphone',deviceId:'mic-fixture'});await delay(60);
  assert.equal(f.io.audioDesired.session,next);assert(received.length>0);assert(received.every(v=>v.session===next&&v.status==='listening'));
  await f.io.close();const rows=(await f.log()).filter(q=>['startAudio','stopAudio'].includes(q.op));
  assert.deepEqual(rows.map(q=>q.op),['startAudio','stopAudio','startAudio']);assert.equal(rows[2].deviceId,'mic-fixture');
});
test('an unrelated audio start acknowledgement fails capture without accepting samples',async t=>{
  const f=await fixture(t,{badAudioStart:true});
  await assert.rejects(f.io.syncAudio({enabled:true,session:'12345678-1234-1234-1234-123456789abc',source:'system',deviceId:''}),{code:'IO_PROTOCOL_ERROR'});
  assert.equal(f.io.phase,'failed');assert.equal(f.io.shutdown,null);
});
test('unconfirmed audio stop cannot start a replacement capture',async t=>{
  const f=await fixture(t,{badAudioStop:true});
  await f.io.syncAudio({enabled:true,session:'12345678-1234-1234-1234-123456789abc',source:'system',deviceId:''});
  await assert.rejects(f.io.syncAudio({enabled:true,session:'12345678-1234-1234-1234-123456789def',source:'microphone',deviceId:'mic-fixture'}),{code:'IO_PROTOCOL_ERROR'});
  assert.equal(f.io.phase,'failed');assert.equal((await f.log()).filter(q=>q.op==='startAudio').length,1);
});
test('suspend during audio switching cancels the replacement before starting it',async t=>{
  const f=await fixture(t,{suspendOnAudioStop:true});
  await f.io.syncAudio({enabled:true,session:'12345678-1234-1234-1234-123456789abc',source:'system',deviceId:''});
  await f.io.syncAudio({enabled:true,session:'12345678-1234-1234-1234-123456789def',source:'microphone',deviceId:'mic-fixture'});
  assert.equal(f.io.audioDesired,null);assert.equal(f.io.audioSignature,'null');
  assert.equal((await f.log()).filter(q=>q.op==='startAudio').length,1);await f.io.close();
});
test('old monitor generations cannot trigger keys after rebinding',async t=>{
  const f=await fixture(t,{oldReset:true}),received=[],resets=[];f.io.on('key',v=>received.push(v));f.io.on('keysReset',()=>resets.push(true));
  await f.io.monitorKeys('air75-v3',['KeyA']);await delay(80);assert.equal(received.length,1);
  await f.io.monitorKeys('air75-v3',['KeyA']);await delay(80);assert.equal(received.length,2);
  assert(received.every(v=>v.source==='windowsRawInput'));assert(received.every(v=>!('nativeKeySignature'in v)));
  assert.equal(resets.length,0);assert.equal(f.io.keysModel,'air75-v3');
});
test('malformed audio fails the isolated helper without affecting a keyboard owner',async t=>{
  const f=await fixture(t,{badFeature:true}),failed=once(f.io,'failure');
  await f.io.syncAudio({enabled:true,session:'12345678-1234-1234-1234-123456789abc',source:'system',deviceId:''});
  await failed;assert.equal(f.io.phase,'failed');assert.equal(f.io.shutdown,null);
});
test('rapid monitor replacement cannot let an older acknowledgement overwrite the selected keys',async t=>{
  const f=await fixture(t);const pending=await Promise.allSettled([f.io.monitorKeys('air75-v3',['KeyA']),f.io.monitorKeys('air75-v3',['KeyB'])]);
  assert.equal(pending[0].status,'rejected');assert.equal(pending[0].reason.code,'IO_SOURCE_CHANGED');assert.equal(pending[1].status,'fulfilled');
  assert.deepEqual([...f.io.keysCodes],['KeyB']);await f.io.close();
});
test('suspend during monitor startup invalidates its late acknowledgement',async t=>{
  const f=await fixture(t,{suspendMonitor:true});await assert.rejects(f.io.monitorKeys('air75-v3',['KeyA']),{code:'IO_SOURCE_CHANGED'});
  assert.equal(f.io.keysModel,null);assert.equal(f.io.keysMonitor,null);await f.io.close();
});
test('zero exit without capture shutdown receipt is a failed close',async t=>{
  const f=await fixture(t,{missingReceipt:true});await f.io.start();
  await assert.rejects(f.io.close(),{code:'IO_EXIT_FAILED'});
});
test('suspend retires the capture session and ignores late pre-suspend features',async t=>{
  const f=await fixture(t,{suspend:true}),suspended=once(f.io,'suspend');
  await f.io.syncAudio({enabled:true,session:'12345678-1234-1234-1234-123456789abc',source:'system',deviceId:''});
  await suspended;assert.equal(f.io.audioDesired,null);assert.equal(f.io.audioSignature,'null');await f.io.syncAudio({enabled:false});await f.io.close();
});
test('an isolated failed capture process restarts with a fresh session and no automatic capture or key replay',async t=>{
  const f=await fixture(t);await f.io.start();const first=f.io.sessionId,closed=once(f.io,'closed');
  f.io.abort(Object.assign(Error('isolated sleep failure'),{code:'TEST_SLEEP'}));await closed;await f.io.restart();
  assert.notEqual(f.io.sessionId,first);assert.equal(f.io.status().available,true);assert.equal(f.io.audioDesired,null);assert.equal(f.io.keysModel,null);
  assert.equal((await f.log()).filter(q=>q.op==='hello').length,2);assert(!(await f.log()).some(q=>q.op==='startAudio'||q.op==='monitorKeys'));await f.io.close();
});
test('a crashed capture child can retire after real exit without inventing a graceful receipt',async t=>{
  const f=await fixture(t);await f.io.start();const closed=once(f.io,'closed');f.io.abort(Object.assign(Error('isolated crash'),{code:'TEST_CRASH'}));
  await f.io.close();await closed;assert.equal(f.io.phase,'closed');assert.equal(f.io.captureTerminated,true);assert.equal(f.io.shutdown,null);
});
test('shutdown during restart prevents a replacement child from starting',async t=>{
  const f=await fixture(t);await f.io.start();const closed=once(f.io,'closed');f.io.abort(Object.assign(Error('isolated crash'),{code:'TEST_CRASH'}));await closed;
  const restarting=f.io.restart(),closing=f.io.close();await assert.rejects(restarting,{code:'IO_CLOSED'});await closing;
  assert.equal((await f.log()).filter(q=>q.op==='hello').length,1);assert.equal(f.io.phase,'closed');
});
test('queued desktop IO requests are bounded before sending',async t=>{
  const f=await fixture(t,{holdInventory:true});await f.io.start();
  const results=Array.from({length:16},()=>f.io.request('inventory'));const settled=Promise.allSettled(results);
  await assert.rejects(f.io.request('inventory'),{code:'IO_QUEUE_FULL'});
  f.io.abort(Object.assign(new Error('fixture cancelled'),{code:'FIXTURE_STOP'}));
  assert((await settled).every(r=>r.status==='rejected'));
});
test('v2 refuses a v1 capture helper before any key monitor is requested',async t=>{
  const f=await fixture(t,{oldHello:true});await assert.rejects(f.io.start(),{code:'IO_PROTOCOL_ERROR'});
  assert(!(await f.log()).some(q=>q.op==='monitorKeys'));assert.equal(f.io.keysModel,null);
});
test('startup key batches wait for acknowledgement and suppress repeats and orphan releases',async t=>{
  const f=await fixture(t,{firstBatch:true}),received=[];f.io.on('key',v=>received.push(v));
  await f.io.monitorKeys('air75-v3',['KeyA']);assert.deepEqual(received.map(v=>v.phase),['down','up']);
  assert(received.every(v=>v.source==='windowsRawInput'&&!Object.hasOwn(v,'nativeKeySignature')));assert.equal(f.io.heldKeys.size,0);await f.io.close();
});
test('expired startup keys are discarded without replaying a press after a delayed acknowledgement',async t=>{
  const f=await fixture(t,{delayedMonitor:true}),received=[];f.io.on('key',v=>received.push(v));
  await assert.rejects(f.io.monitorKeys('air75-v3',['KeyA']),{code:'IO_PROTOCOL_ERROR'});assert.deepEqual(received,[]);assert.equal(f.io.heldKeys.size,0);assert.equal(f.io.phase,'failed');
});
test('a missing event sequence retires capture rather than accepting a later key',async t=>{
  const f=await fixture(t,{gap:true}),received=[],failed=once(f.io,'failure');f.io.on('key',v=>received.push(v));
  await f.io.monitorKeys('air75-v3',['KeyA']);await failed;assert.deepEqual(received,[]);assert.equal(f.io.phase,'failed');assert.equal(f.io.keysMonitor,null);
});
test('a current overflow reset clears held keys and excludes queued events from the retired monitor',async t=>{
  const f=await fixture(t,{currentReset:true}),received=[],reset=once(f.io,'keysReset');f.io.on('key',v=>received.push(v));
  await f.io.monitorKeys('air75-v3',['KeyA']);await reset;await delay(20);
  assert.deepEqual(received.map(v=>v.phase),['down']);assert.equal(f.io.heldKeys.size,0);assert.equal(f.io.keysMonitor,null);assert.equal(f.io.phase,'ready');await f.io.close();
});
test('real native desktop IO handshake and quit never open devices or create user files',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'NuPhy native IO fixture ')),models=path.join(dir,'models.json');
  await writeFile(models,JSON.stringify(deviceModels()));
  const command=fileURLToPath(new URL(`../target/debug/nuphylab-desktop-io${process.platform==='win32'?'.exe':''}`,import.meta.url));
  const io=new WindowsDesktopIO({command,args:['--models',models]});
  t.after(async()=>{await io.close().catch(()=>{});await rm(dir,{recursive:true,force:true});});
  await io.start();assert.equal(io.capabilities.sensitiveKeys,false);await io.close();assert.equal(io.shutdown,true);
  assert.deepEqual(await readdir(dir),['models.json']);
});
