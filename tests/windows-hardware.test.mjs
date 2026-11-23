import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {WindowsHardware} from '../server/windows-hardware.mjs';
import {NativeLightingClient} from '../server/native-lighting-client.mjs';
import {getKeyboardProfile} from '../shared/keyboard-models.mjs';
const simulator=fileURLToPath(new URL(`../target/debug/examples/lighting-simulator${process.platform==='win32'?'.exe':''}`,import.meta.url));
const colors=()=>Array(84).fill('#254677');
test('inspection cannot open a second USB path while native ownership is busy or shutting down',async()=>{
  const h=new WindowsHardware({command:process.execPath,args:[],protocol:'windows-readonly-v1'},'unused');
  for(const phase of ['created','arming','armed','checkingRecovery','recoveringExisting','restoring','failed']){
    h.lighting={status:()=>({phase})};
    for(const op of ['lightingSnapshot','sleepSnapshot','keymapSnapshot'])await assert.rejects(h.request(op),{code:'INSPECTION_BUSY'});
    assert.equal(h.child,null);
  }
  h.lighting=null;h.shuttingDown=true;
  for(const op of ['lightingSnapshot','sleepSnapshot','keymapSnapshot'])await assert.rejects(h.request(op),{code:'INSPECTION_BUSY'});
});
const qualified=()=>({connected:true,identified:true,readOnly:true,armed:false,modelId:'air75-v3',firmwareVersion:'1.0.23.6',
  vendorId:0x19f5,productId:0x1028,lightingProfile:1,recoveryPending:false,needsRestore:false,
  transport:'USB',ledCount:104,keyLedCount:84,sideLedCount:20,
  identityQualification:{status:'qualified',source:'embeddedUsbSerial',reasonCode:null},capabilities:{perKey:false},errorCode:'WINDOWS_PROBE_ONLY'});
async function fixture(t,{fault,probe=qualified()}={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'NuPhy 应用 退出 0 '));let launches=0,statusReads=0;
  const h=new WindowsHardware({command:process.execPath,args:[],protocol:'windows-readonly-v1'},path.join(directory,'unused.json'),{
    createLightingClient:launch=>{launches++;assert.equal(launch.args.at(-1),'--lighting');assert.equal(launch.args.includes('--backup'),false);
      return new NativeLightingClient({command:simulator,args:['--directory',directory,'--model',probe.modelId,...(fault?['--fault',fault]:[])],backend:'simulated',modelId:launch.modelId,lightingProfile:launch.lightingProfile});},
  });
  h.updateState(probe);
  h.request=(op,args)=>{if(op==='status'){statusReads++;return Promise.resolve(structuredClone(probe));}return WindowsHardware.prototype.request.call(h,op,args);};
  t.after(async()=>{await h.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  const audits=async()=>Promise.all((await readdir(directory)).filter(n=>n.startsWith('simulator-audit-')).map(async n=>JSON.parse(await readFile(path.join(directory,n),'utf8'))));
  return {h,directory,audits,probe,launches:()=>launches,statusReads:()=>statusReads};
}
test('the Windows application driver owns a real simulated native session through paint restore rearm and exit',async t=>{
  const f=await fixture(t),h=f.h;assert.equal(h.lightingAvailable(),true);
  const idleEpoch=h.inspectionEpoch;await h.arm();assert(h.inspectionEpoch>idleEpoch);
  const armedEpoch=h.inspectionEpoch;await h.paint(colors(),{brightness:75});assert.equal(h.inspectionEpoch,armedEpoch);const count=f.statusReads();
  await h.status();assert.equal(f.statusReads(),count,'active USB checks stay on the owned native handle');
  await h.restore();assert(h.inspectionEpoch>armedEpoch);await h.arm();await h.paint(colors());await h.close();
  assert.equal(f.launches(),1);assert.deepEqual(h.shutdownEvidence(),{verified:true,recoveryPending:false,noMutation:false});
  const [audit]=await f.audits();assert.deepEqual(audit.state,audit.originalState);assert.deepEqual(audit.rgb,audit.originalRgb);assert.deepEqual(audit.sleep,audit.originalSleep);
});
test('unqualified firmware missing or candidate identity never starts the lighting process',async t=>{
  for(const kind of ['firmware','missing','candidate']){
    const probe=qualified();if(kind==='firmware')probe.firmwareVersion='2.0.0.8';
    else if(kind==='missing')delete probe.identityQualification;else probe.identityQualification={status:'candidate',source:'embeddedUsbSerial',reasonCode:'IDENTITY_FAMILY_UNVERIFIED'};
    const f=await fixture(t,{probe});await assert.rejects(f.h.arm(),{code:'WINDOWS_LIGHTING_UNAVAILABLE'});assert.equal(f.launches(),0);await f.h.close();
  }
});
test('Windows wake uses a verified black starting frame and keeps polling on its owner',async t=>{
  const f=await fixture(t),h=f.h;assert.equal(h.state.capabilities.connectionWake,true);
  await h.arm({connectionWake:true});assert.equal(h.state.windowsLighting.connectionWakePreparation.mainBlackVerified,true);
  assert.deepEqual(h.lastLightingWire,Array(84).fill('#000000'));
  const verifiedAt=h.lastPaintAcknowledgement.frameCommittedAt;
  assert.equal((await h.paint(Array(84).fill('#000000'))).reusedCommittedFrame,true);
  assert.equal(h.lastPaintAcknowledgement.frameCommittedAt,verifiedAt);
  await assert.rejects(h.arm({connectionWake:true}),{code:'CONNECTION_WAKE_ALREADY_ACTIVE'});
  const reads=f.statusReads();await h.status();assert.equal(f.statusReads(),reads);
  await h.close();const [audit]=await f.audits();assert.deepEqual(audit.state,audit.originalState);assert.deepEqual(audit.rgb,audit.originalRgb);
});
test('wake cannot start for unqualified firmware ambiguous identity invalid USB or geometry',async t=>{
  for(const patch of [{firmwareVersion:'2.0.0.8'},{identityQualification:null},{transport:'Bluetooth'},{ledCount:103},{keyLedCount:83}]){
    const f=await fixture(t,{probe:{...qualified(),...patch}});await assert.rejects(f.h.arm({connectionWake:true}));assert.equal(f.launches(),0);
  }
});
test('native stock effects share one owner, restore before changing purpose and never poll the discovery handle',async t=>{
  const p=getKeyboardProfile('kick75'),probe={...qualified(),modelId:'kick75',firmwareVersion:p.qualifiedFirmware,vendorId:p.vendorId,productId:p.productIds[0]};
  const f=await fixture(t,{probe}),h=f.h;
  assert.equal(h.state.capabilities.stockEffects,true);
  await h.request('nativeLighting',{mode:4,brightness:30,speed:1,color:'#123456'});
  assert.equal(h.state.armed,false);assert.equal(h.state.windowsLighting.purpose,'native');assert.equal(h.state.state[0],4);
  const count=f.statusReads();await h.status();const sample=await h.request('readColors');
  assert.equal(f.statusReads(),count);assert.equal(sample.colors.length,p.keyCount+p.sideCount);
  await assert.rejects(h.request('side',{color:'#ffffff'}));await assert.rejects(h.paint(Array(p.canvasCount).fill('#ffffff')));
  await h.arm();assert.equal(h.state.windowsLighting.purpose,'perKey');await h.paint(Array(p.canvasCount).fill('#254677'));
  await h.request('nativeLighting',{mode:3,brightness:40,speed:2});await h.close();
  const reports=await f.audits();assert.equal(reports.length,3);
  for(const audit of reports){assert.deepEqual(audit.state,audit.originalState);assert.deepEqual(audit.rgb,audit.originalRgb);assert.deepEqual(audit.sleep,audit.originalSleep);}
  for(const index of [0,2])assert.equal(reports[index].commands.some(c=>[0xd8,0xf3,0xf5].includes(c)),false);
});
test('native invalid requests cannot retire a per-key lease and Air 2.0.0.7 does not acquire native stock effects',async t=>{
  const f=await fixture(t);await f.h.arm();const lease=f.h.lighting.status().leaseId;
  await assert.rejects(f.h.request('nativeLighting',{mode:21,brightness:60,speed:2}),{code:'INVALID_NATIVE_LIGHTING'});
  assert.equal(f.h.lighting.status().leaseId,lease);
  await assert.rejects(f.h.request('nativeLighting',{mode:3,brightness:60,speed:2}),{code:'NATIVE_LIGHTING_UNSUPPORTED'});
  const probe=qualified();probe.firmwareVersion='2.0.0.7';const newer=await fixture(t,{probe});
  await assert.rejects(newer.h.request('nativeLighting',{mode:3,brightness:60,speed:2}),{code:'NATIVE_LIGHTING_UNSUPPORTED'});assert.equal(newer.launches(),0);
});
test('returning the original side lighting uses verified retirement and rearm without losing the main frame',async t=>{
  const f=await fixture(t),h=f.h;await h.arm();await h.paint(colors(),{brightness:70});
  const wire=[...h.lastLightingWire];await h.request('side',{color:'#000000',brightness:0});
  assert.equal((await h.request('side',{restore:true})).wholeSessionRearmed,true);
  assert.deepEqual(h.lastLightingWire,wire);assert.equal(h.lighting.status().leaseId,2);
  await h.close();const audits=await f.audits();assert.equal(audits.length,2);
  for(const audit of audits){assert.deepEqual(audit.state,audit.originalState);assert.deepEqual(audit.rgb,audit.originalRgb);assert.deepEqual(audit.sleep,audit.originalSleep);}
});
test('an older probe without identity evidence cannot retain a previous qualified connection',async t=>{
  const f=await fixture(t);assert.equal(f.h.lightingAvailable(),true);delete f.probe.identityQualification;
  await f.h.status();assert.equal(f.h.lightingAvailable(),false);assert.equal(f.h.state.identityQualification,null);
  await assert.rejects(f.h.arm());assert.equal(f.launches(),0);
});
test('shutdown is idempotent starts priority quit and forbids new output without killing the recovery owner',async t=>{
  const f=await fixture(t),h=f.h;await h.arm();await h.paint(colors());
  h.lighting.child.kill=()=>assert.fail('must never kill the recovery owner');
  const first=h.close();assert.equal(h.close(),first);await assert.rejects(h.paint(colors()),{code:'NOT_ARMED'});await first;
  assert.equal(h.shutdownEvidence().verified,true);assert.equal(f.launches(),1);assert.equal((await f.audits()).length,1);
});
test('an action remains failed but verified rollback permits application shutdown',async t=>{
  const f=await fixture(t,{fault:'paint'}),h=f.h;await h.arm();await assert.rejects(h.paint(colors()));
  await h.close();assert.equal(h.lighting.status().phase,'failed');assert.equal(h.shutdownEvidence().verified,true);
  const [audit]=await f.audits();assert.deepEqual(audit.rgb,audit.originalRgb);assert.deepEqual(audit.sleep,audit.originalSleep);
});
test('failed restoration remains pending across repeated closes and is never retried or hidden',async t=>{
  const f=await fixture(t,{fault:'restore'}),h=f.h;await h.arm();await h.paint(colors());
  const close=h.close();await assert.rejects(close,{code:'RESTORE_REQUIRED'});assert.equal(h.close(),close);await assert.rejects(h.close());
  assert.equal(h.shutdownEvidence().verified,false);assert.equal(h.shutdownEvidence().recoveryPending,true);
  const [audit]=await f.audits();assert.notDeepEqual(audit.rgb,audit.originalRgb);assert.deepEqual(audit.sleep,audit.originalSleep);
  assert.equal((await f.audits()).length,1);assert((await readdir(f.directory)).includes('profile-1.json'));
});
test('shutdown while probe selection is pending prevents a late arm from creating a native owner',async t=>{
  const f=await fixture(t);let release;f.h.request=()=>new Promise(resolve=>release=resolve);
  const arm=f.h.arm();const check=assert.rejects(arm,{code:'WINDOWS_LIGHTING_UNAVAILABLE'});
  await f.h.close();release(f.probe);await check;assert.equal(f.launches(),0);assert.equal(f.h.shutdownEvidence().verified,true);
});
test('the application recovers its terminated native owner only after checking saved originals',async t=>{
  const f=await fixture(t),h=f.h;await h.arm();await h.paint(colors());const ended=once(h.lighting.child,'close');h.lighting.child.kill();await ended;
  assert.equal((await h.checkRecovery()).pending.boardSleep,true);assert.equal(h.lightingAvailable(),false);
  const result=await h.recoverExisting();assert.equal(result.complete,true);assert.equal(h.state.windowsRecovery.status,'complete');assert.equal(h.lightingAvailable(),true);
  await h.arm();await h.paint(colors());await h.close();assert.equal(h.shutdownEvidence().verified,true);
});
test('missing previously observed records cannot become an application restoration proof',async t=>{
  const f=await fixture(t),h=f.h;await h.arm();await h.paint(colors());const ended=once(h.lighting.child,'close');h.lighting.child.kill();await ended;await h.checkRecovery();
  for(const name of (await readdir(f.directory)).filter(n=>/^(profile-|board-sleep)/.test(n)))await rm(path.join(f.directory,name));
  await assert.rejects(h.checkRecovery(),{code:'RECOVERY_EVIDENCE_MISSING'});assert.equal(h.lightingAvailable(),false);await assert.rejects(h.close());
});
test('completed and failed recovery views expire on connection profile firmware or identity changes without clearing obligations',async t=>{
  for(const status of ['clear','complete','failed'])for(const patch of [{connected:false,identified:false},{lightingProfile:0},{firmwareVersion:'2.0.0.7'},{identityQualification:null}]){
    const f=await fixture(t),h=f.h,key=h.recoveryContext();assert(key);
    h.recoveryViewKey=key;h.recoveryView={status};h.recoveryKey=status==='clear'?key:null;
    h.pendingKeyProfiles.add(1);h.recoveryNeedsAttention=true;h.decorate();assert.equal(h.state.windowsRecovery.status,status);
    h.updateState({...f.probe,...patch});assert.equal(h.state.windowsRecovery.status,'unchecked');assert.equal(h.recoveryKey,null);assert.equal(h.recoveryViewKey,null);
    assert.deepEqual([...h.pendingKeyProfiles],[1]);assert.equal(h.state.recoveryPending,true);
  }
});
test('a verified old-connection restore cannot publish its success as the new profile result',async t=>{
  const f=await fixture(t),h=f.h;await h.arm();await h.paint(colors());const ended=once(h.lighting.child,'close');h.lighting.child.kill();await ended;await h.checkRecovery();
  const recover=h.lighting.recoverExisting.bind(h.lighting);
  h.lighting.recoverExisting=async()=>{const result=await recover();f.probe.lightingProfile=0;h.updateState(f.probe);return result;};
  assert.equal((await h.recoverExisting()).complete,true);assert.equal(h.state.windowsRecovery.status,'unchecked');assert.equal(h.recoveryKey,null);
  await assert.rejects(h.recoverExisting(),{code:'RECOVERY_CHECK_REQUIRED'});await h.close();assert.equal(h.shutdownEvidence().verified,true);
});
test('an unconfirmed former owner cannot be cleared by an empty first inspection after external deletion',async t=>{
  const f=await fixture(t),h=f.h;await h.arm();await h.paint(colors());const ended=once(h.lighting.child,'close');h.lighting.child.kill();await ended;
  for(const name of (await readdir(f.directory)).filter(n=>/^(profile-|board-sleep)/.test(n)))await rm(path.join(f.directory,name));
  await assert.rejects(h.checkRecovery(),{code:'RECOVERY_EVIDENCE_MISSING'});assert.equal(h.state.recoveryPending,true);await assert.rejects(h.close());assert.equal(h.shutdownEvidence().recoveryPending,true);
});
