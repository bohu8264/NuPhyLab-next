import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {once} from 'node:events';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Hardware} from '../server/hardware.mjs';

// Exercise the real Hardware queue, JSONL transport and state commits against
// a standalone Node process. This double neither loads the native executable
// nor imports IOKit, enumerates USB, reads real journals or sends OS keys.
async function fixture(t, initial={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'nuphylab-sleep-hardware-'));
  const binary=path.join(directory,'fake-sleep-helper.mjs');
  const control=path.join(directory,'control.json'),log=path.join(directory,'operations.jsonl');
  let configuration={capability:true,...initial};
  await writeFile(control,JSON.stringify(configuration));await writeFile(log,'');
  await writeFile(binary,`#!${process.execPath}
import {createInterface} from 'node:readline';
import {readFileSync,appendFileSync} from 'node:fs';
const control=process.argv[process.argv.indexOf('--backup')+1],log=control.replace(/control\\.json$/,'operations.jsonl');
const config=()=>JSON.parse(readFileSync(control,'utf8'));
let connected=false,armed=Boolean(config().armed),rgbPending=Boolean(config().rgbPending),sleepPending=Boolean(config().sleepPending),sleepActive=false,removedOnce=false;
const lease=()=>({supported:config().capability===true,active:sleepActive,pending:sleepPending,ownsChanges:sleepActive});
const state=()=>{const c=config();if(typeof c.forceSleepPending==='boolean')sleepPending=c.forceSleepPending;return {
 connected,armed,identified:connected,transport:'USB',vendorId:0x19f5,productId:c.kick?0x1026:0x1028,modelId:c.kick?'kick75':'air75-v3',keyLedCount:c.kick?80:84,ledCount:c.kick?85:104,
 readOnly:c.readOnly===true,protocolReady:c.readOnly!==true,firmware:c.kick?[18,0,4,170,6,0,0,0]:[23,0,1,170,6,0,0,0],
 recoveryPending:rgbPending,needsRestore:rgbPending,unsafeWritesNeeded:false,error:null,errorCode:null,
 capabilities:{perKey:true,readProbeVerified:true,connectionWake:!c.kick,...(Object.hasOwn(c,'capability')?{boardSleepLease:c.capability}:{})},boardSleepLease:lease()
};};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const remove=()=>{connected=false;armed=false;send({event:'disconnected',needsRestore:rgbPending});};
const answer=(request,result)=>{let output=JSON.stringify({id:request.id,ok:true,result})+'\\n';if(config().sameChunkRemovalOp===request.op&&!removedOnce){removedOnce=true;connected=false;armed=false;output+=JSON.stringify({event:'disconnected',needsRestore:rgbPending})+'\\n';}process.stdout.write(output);};
const reject=(request,code,message)=>send({id:request.id,ok:false,error:{code,message}});
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line),c=config();appendFileSync(log,JSON.stringify({op:request.op,...(request.op==='paint'?{count:request.colors?.length}:{})})+'\\n');
 switch(request.op){
 case 'connect':connected=true;answer(request,state());break;
 case 'status':answer(request,state());break;
 case 'acquireBoardSleepLease':
  if(c.acquireError){reject(request,c.acquireError,'simulated native sleep acquisition failed');break;}
  if(!c.alreadyDisabled){sleepPending=true;sleepActive=true;}
  answer(request,{sleepInfo:[0,6,30,0],boardSleepLease:lease(),changed:!c.alreadyDisabled,verified:c.acquireVerified!==false});break;
 case 'readBoardSleep':answer(request,{sleepInfo:[sleepPending?0:1,6,30,0],boardSleepLease:lease(),verified:true});break;
 case 'releaseBoardSleepLease':sleepPending=false;sleepActive=false;answer(request,{sleepInfo:[1,6,30,0],boardSleepLease:lease(),restored:true,verified:true});break;
 case 'arm':case 'armConnectionWake':
  if(c.capability===true&&!sleepActive&&!c.alreadyDisabled){reject(request,'TEST_ORDER','sleep was not acquired before arm');break;}
  if(c.armError){sleepPending=false;sleepActive=false;armed=false;reject(request,c.armError,'simulated RGB arm failed after native sleep cleanup');break;}
  armed=true;rgbPending=true;answer(request,{armed:true,verified:true,recoveryPending:true,needsRestore:true});break;
 case 'paint':answer(request,{painted:84});break;
 case 'restore':
  if(c.restoreError){reject(request,c.restoreError,'simulated pending original restoration failed');break;}
  armed=false;rgbPending=false;sleepPending=false;sleepActive=false;answer(request,{...state(),restored:true,verified:true});break;
 case 'disconnect':
  connected=false;armed=false;rgbPending=false;sleepActive=false;sleepPending=c.disconnectSleepPending===true;
  answer(request,{...state(),functionKeyRecoveryPending:false,unsafeWritesNeeded:false});break;
 case 'barrier':setTimeout(()=>answer(request,{}),60);break;
 case 'restoreKeys':answer(request,{restored:true});break;
 case 'quit':answer(request,{quitting:true});setTimeout(()=>process.exit(0),15);break;
 default:reject(request,'TEST_UNEXPECTED','unexpected test operation');
 }
});
`);
  await chmod(binary,0o700);
  const hardware=new Hardware(binary,control);
  t.after(async()=>{
    if(hardware.child){const child=hardware.child,closed=once(child,'close');child.kill('SIGKILL');await closed;}
    await rm(directory,{recursive:true,force:true});
  });
  return {hardware,operations:async()=> (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).map(row=>row.op),
    configure:async patch=>{configuration={...configuration,...patch};await writeFile(control,JSON.stringify(configuration));}};
}

test('ordinary playback restores pending RGB first, acquires sleep, then arms and paints',async t=>{
  const f=await fixture(t,{rgbPending:true});await f.hardware.connect();await f.hardware.arm();await f.hardware.paint(Array(84).fill('#ffffff'));
  assert.deepEqual(await f.operations(),['connect','restore','status','status','acquireBoardSleepLease','arm','paint']);
  assert.equal(f.hardware.state.armed,true);assert.deepEqual(f.hardware.state.boardSleepLease,{supported:true,active:true,pending:true,ownsChanges:true});
  await f.hardware.restore();assert.equal(f.hardware.state.boardSleepLease.pending,false);assert.equal(f.hardware.state.armed,false);
});

test('wake acquires sleep before native preparation while retaining the pending original',async t=>{
  const f=await fixture(t,{rgbPending:true});await f.hardware.connect({connectionWake:true});await f.hardware.arm({connectionWake:true});
  assert.deepEqual(await f.operations(),['connect','acquireBoardSleepLease','armConnectionWake']);
  assert.equal(f.hardware.state.recoveryPending,true);assert.equal(f.hardware.state.boardSleepLease.pending,true);
});

test('an already armed device still checks sleep without repeating native arm',async t=>{
  const f=await fixture(t);await f.hardware.connect();await f.hardware.arm();await f.hardware.arm();
  assert.deepEqual(await f.operations(),['connect','status','acquireBoardSleepLease','arm','acquireBoardSleepLease']);
  assert.equal(f.hardware.state.armed,true);assert.equal(f.hardware.state.boardSleepLease.active,true);
});

test('qualified Kick playback acquires its advertised sleep lease and restores it on stop',async t=>{
  const f=await fixture(t,{kick:true,capability:true});await f.hardware.connect();await f.hardware.arm();
  assert.equal(f.hardware.state.modelId,'kick75');
  assert.deepEqual(await f.operations(),['connect','status','acquireBoardSleepLease','arm']);
  assert.equal(f.hardware.state.boardSleepLease.active,true);
  await f.hardware.restore();
  assert.equal(f.hardware.state.boardSleepLease.pending,false);
  assert.equal(f.hardware.state.armed,false);
});

test('an already disabled board can pass verified acquisition without claiming a mutation',async t=>{
  const f=await fixture(t,{alreadyDisabled:true});await f.hardware.connect();await f.hardware.arm();
  assert.equal(f.hardware.state.armed,true);assert.deepEqual(f.hardware.state.boardSleepLease,{supported:true,active:false,pending:false,ownsChanges:false});
  assert.deepEqual(await f.operations(),['connect','status','acquireBoardSleepLease','arm']);
});

for(const capability of [undefined,false,'true',1])test(`sleep acquisition requires explicit capability true (${String(capability)})`,async()=>{
  const hardware=new Hardware('/unused/not-a-real-native-helper','/unused/not-a-real-backup');
  hardware.state.capabilities=capability===undefined?{}:{boardSleepLease:capability};
  assert.equal(await hardware.acquireBoardSleepLease(),undefined);assert.equal(hardware.child,null);assert.equal(hardware.serial,0);
});

for(const kick of [false,true])test(`${kick?'Kick':'older helper'} playback remains available without the sleep capability`,async t=>{
  const f=await fixture(t,{capability:false,kick});await f.hardware.connect();await f.hardware.arm();
  assert.deepEqual(await f.operations(),['connect','status','arm']);assert.equal(f.hardware.state.armed,true);
});

for(const wake of [false,true])test(`${wake?'wake':'ordinary'} preparation never arms on an unverified sleep result`,async t=>{
  const f=await fixture(t,{acquireVerified:false});await f.hardware.connect({connectionWake:wake});
  await assert.rejects(f.hardware.arm({connectionWake:wake}),error=>error.code==='SLEEP_VERIFY_FAILED');
  assert.equal(f.hardware.state.armed,false);assert.equal((await f.operations()).filter(op=>['arm','armConnectionWake','paint'].includes(op)).length,0);
  assert.equal(f.hardware.state.boardSleepLease.pending,false,'unverified reply cannot publish successful ownership metadata');
});

for(const wake of [false,true])test(`${wake?'wake':'ordinary'} acquisition failure preserves the native error and prevents RGB writes`,async t=>{
  const f=await fixture(t,{acquireError:'SLEEP_BACKUP_DEVICE_MISMATCH'});await f.hardware.connect({connectionWake:wake});
  await assert.rejects(f.hardware.arm({connectionWake:wake}),error=>error.code==='SLEEP_BACKUP_DEVICE_MISMATCH'&&/native sleep acquisition failed/.test(error.protocolDetail));
  assert.equal(f.hardware.state.armed,false);const ops=await f.operations();assert.equal(ops.filter(op=>op==='acquireBoardSleepLease').length,1);
  assert.equal(ops.some(op=>['arm','armConnectionWake','paint'].includes(op)),false);
});

test('failed pending RGB restoration prevents sleep acquisition as well as native arm',async t=>{
  const f=await fixture(t,{rgbPending:true,restoreError:'STATE_VERIFY_FAILED'});
  await assert.rejects(f.hardware.connect());await assert.rejects(f.hardware.arm());
  assert.equal((await f.operations()).some(op=>['acquireBoardSleepLease','arm'].includes(op)),false);
});

test('RGB arm failure is not replayed and a later status adopts native sleep rollback',async t=>{
  const f=await fixture(t,{armError:'STATE_VERIFY_FAILED'});await f.hardware.connect();
  await assert.rejects(f.hardware.arm(),error=>error.code==='STATE_VERIFY_FAILED');await f.hardware.status();
  assert.equal(f.hardware.state.armed,false);assert.equal(f.hardware.state.boardSleepLease.pending,false);
  assert.deepEqual(await f.operations(),['connect','status','acquireBoardSleepLease','arm','status']);
});

for(const op of ['readBoardSleep','acquireBoardSleepLease','releaseBoardSleepLease'])test(`${op} discards a success followed by removal in the same stdout chunk`,async t=>{
  const f=await fixture(t,{sameChunkRemovalOp:op});await f.hardware.connect();
  const before=f.hardware.state.connectionSessionId;
  await assert.rejects(op==='acquireBoardSleepLease'?f.hardware.acquireBoardSleepLease():f.hardware.request(op),error=>error.code==='SESSION_CHANGED');
  assert.equal(f.hardware.state.connected,false);assert.equal(f.hardware.state.armed,false);assert.equal(f.hardware.state.identified,false);
  assert.equal(f.hardware.state.boardSleepLease.active,false,'a discarded lease result must not revive ownership in the removed session');
  assert.equal((await f.operations()).filter(name=>name===op).length,1);assert.ok(before);
});

for(const op of ['readBoardSleep','acquireBoardSleepLease','releaseBoardSleepLease'])test(`${op} queued before disconnect is rejected before reaching the helper`,async t=>{
  const f=await fixture(t);await f.hardware.connect();
  const barrier=f.hardware.request('barrier');const pending=f.hardware.request(op);const disconnect=f.hardware.disconnect();
  const results=await Promise.allSettled([barrier,pending,disconnect]);
  assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'SESSION_CHANGED');
  assert.equal((await f.operations()).includes(op),false);assert.equal(f.hardware.state.connected,false);
});

test('sleep-only pending restore bypasses both read-only and disconnected early exits',async t=>{
  const f=await fixture(t,{sleepPending:true});await f.hardware.connect();
  Object.assign(f.hardware.state,{connected:false,readOnly:true,recoveryPending:false,needsRestore:false,unsafeWritesNeeded:false});
  const result=await f.hardware.restore();assert.equal(result.verified,true);assert.equal(f.hardware.state.boardSleepLease.pending,false);
  assert.deepEqual(await f.operations(),['connect','restore']);
});

test('sleep-only recovery errors survive status until native confirms no pending lease',async t=>{
  const f=await fixture(t,{sleepPending:true});await f.hardware.connect();
  f.hardware.state.error='Original sleep flag is still pending';f.hardware.state.errorCode='SLEEP_RESTORE_REQUIRED';
  await f.hardware.status();assert.equal(f.hardware.state.errorCode,'SLEEP_RESTORE_REQUIRED');assert.equal(f.hardware.state.error,'Original sleep flag is still pending');
  await f.configure({forceSleepPending:false});await f.hardware.status();assert.equal(f.hardware.state.errorCode,null);assert.equal(f.hardware.state.error,null);
});

test('disconnect retains sleep-only pending as deferred recovery even with no current mutation',async t=>{
  const f=await fixture(t,{disconnectSleepPending:true});await f.hardware.connect();
  const state=await f.hardware.disconnect();assert.equal(state.connected,false);assert.equal(state.boardSleepLease.pending,true);
  assert.equal(state.recoveryPending,false);assert.equal(state.unsafeWritesNeeded,false);assert.equal(state.errorCode,'RESTORE_DEFERRED');assert.ok(state.error);
});

test('a clean disconnect clears sleep metadata and prior restore errors',async t=>{
  const f=await fixture(t);await f.hardware.connect();f.hardware.restoreFailure='old failure';f.hardware.keyRestoreFailure='old key failure';
  const state=await f.hardware.disconnect();assert.equal(state.boardSleepLease.pending,false);assert.equal(state.errorCode,null);assert.equal(state.error,null);
  assert.equal(f.hardware.restoreFailure,null);assert.equal(f.hardware.keyRestoreFailure,null);
});

test('close restores a sleep-only lease before quitting the helper',async t=>{
  const f=await fixture(t,{sleepPending:true});await f.hardware.connect();await f.hardware.close();
  assert.deepEqual(await f.operations(),['connect','restoreKeys','restore','quit']);assert.equal(f.hardware.child,null);
});
