// Real Rust processes and a file-backed simulated board. No HID device.
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeLightingClient} from '../server/native-lighting-client.mjs';
const binary=fileURLToPath(new URL(`../target/debug/examples/lighting-simulator${process.platform==='win32'?'.exe':''}`,import.meta.url));
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'NuPhy 重开恢复 0 ')),clients=[];
  const client=(fault='')=>{const c=new NativeLightingClient({command:binary,args:['--directory',directory,...(fault?['--fault',fault]:[])],backend:'simulated',modelId:'air75-v3',lightingProfile:1});clients.push(c);return c;};
  const active=async()=>{const values={};for(const n of (await readdir(directory)).filter(n=>/^(?:profile-[01](?:\.palette|\.intent|\.rgb-intent|\.completed)?|board-sleep(?:\.intent|\.completed)?)\.json$/.test(n)))values[n]=await readFile(path.join(directory,n),'utf8');return values;};
  const disk=async()=>JSON.parse(await readFile(path.join(directory,'simulator-hardware.json'),'utf8'));
  const crash=async()=>{const c=client();await c.arm();await c.paint(Array(84).fill('#254677'));const ended=once(c.child,'close');assert.equal(c.child.kill(),true);await ended;await assert.rejects(c.close());return c;};
  t.after(async()=>{for(const c of clients)await c.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  return {directory,client,active,disk,crash};
}
test('cold recovery checks byte-identical originals then restores a board left by a terminated process',async t=>{
  const f=await fixture(t);await f.crash();const before=await f.active(),c=f.client();
  const checked=await c.recoveryStatus();assert.deepEqual(checked.pending,{lightingProfiles:[1],boardSleep:true,keymapProfiles:[]});assert.equal(checked.noMutation,true);assert.equal(checked.canRestore,true);
  assert.deepEqual(await f.active(),before);
  const auditName=(await readdir(f.directory)).find(n=>n.startsWith('simulator-audit-'+c.child.pid+'-'));
  const audit=JSON.parse(await readFile(path.join(f.directory,auditName),'utf8'));assert(audit.commands.every(op=>[0xa1,0xa0,0xd1].includes(op)));
  const result=await c.recoverExisting();assert.equal(result.complete,true);assert.equal(result.lighting.status,'restored');assert.equal(result.boardSleep.status,'restored');
  assert.deepEqual(await f.active(),{});const disk=await f.disk();assert.deepEqual(disk.state,disk.originalState);assert.deepEqual(disk.sleep,disk.originalSleep);
  const archived=(await readdir(f.directory)).find(n=>/^profile-1\.history-[a-f0-9]+\.json$/.test(n));assert(archived);assert.equal(await readFile(path.join(f.directory,archived),'utf8'),before['profile-1.json']);
  await c.close();assert.equal(c.shutdownEvidence().verified,true);
});
test('changed or deleted originals after checking stop recovery before any setter',async t=>{
  for(const change of ['changed','deleted']){
    const f=await fixture(t);await f.crash();const c=f.client();await c.recoveryStatus();
    const file=path.join(f.directory,'profile-1.json');
    if(change==='changed')await writeFile(file,(await readFile(file,'utf8'))+' ');else await rm(file);
    const before=await f.active();await assert.rejects(c.recoverExisting(),{code:'RECOVERY_STATUS_CHANGED'});await assert.rejects(c.close());assert.deepEqual(await f.active(),before);
    for(const name of (await readdir(f.directory)).filter(n=>n.startsWith('simulator-audit-'+c.child.pid+'-'))){const audit=JSON.parse(await readFile(path.join(f.directory,name),'utf8'));assert(audit.commands.every(op=>[0xa1,0xa0,0xd1].includes(op)));}
  }
});
test('RGB and sleep recover independently and a later explicit attempt only repairs the retained sleep record',async t=>{
  const f=await fixture(t);await f.crash();const c=f.client('cold-sleep');await c.recoveryStatus();
  const first=await c.recoverExisting();assert.equal(first.complete,false);assert.equal(first.lighting.status,'restored');assert.equal(first.boardSleep.status,'failed');
  assert.deepEqual(first.remaining,{lightingProfiles:[],boardSleep:true,keymapProfiles:[]});await assert.rejects(c.close());
  const next=f.client();assert.deepEqual((await next.recoveryStatus()).pending,{lightingProfiles:[],boardSleep:true,keymapProfiles:[]});
  const second=await next.recoverExisting();assert.equal(second.complete,true);assert.equal(second.lighting.status,'notNeeded');assert.equal(second.boardSleep.status,'restored');await next.close();
  const disk=await f.disk();assert.deepEqual(disk.state,disk.originalState);assert.deepEqual(disk.sleep,disk.originalSleep);assert.deepEqual(await f.active(),{});
});
test('another physical profile stays deferred and cannot be called complete',async t=>{
  const f=await fixture(t);await f.crash();await writeFile(path.join(f.directory,'profile-0.json'),'{}');const c=f.client();
  assert.deepEqual((await c.recoveryStatus()).pending.lightingProfiles,[0,1]);
  const result=await c.recoverExisting();assert.equal(result.complete,false);assert.deepEqual(result.deferredProfiles,[0]);assert.deepEqual(result.remaining.lightingProfiles,[0]);
  assert.equal(await readFile(path.join(f.directory,'profile-0.json'),'utf8'),'{}');await assert.rejects(c.close());
});
test('recovery requires a check in this native process and never creates a baseline when bypassed',async t=>{
  const f=await fixture(t),c=f.client();await assert.rejects(c.recoverExisting(),{code:'RECOVERY_CHECK_REQUIRED'});await assert.rejects(c.close());
  assert.deepEqual(await readdir(f.directory),[]);assert.deepEqual(c.shutdownEvidence(),{verified:true,recoveryPending:false,noMutation:true});
});
test('a damaged RGB completion marker cannot skip independent sleep recovery',async t=>{
  const f=await fixture(t);await f.crash();const marker=path.join(f.directory,'profile-1.completed.json');await writeFile(marker,'damaged completion');
  const original=await readFile(path.join(f.directory,'profile-1.json'),'utf8'),c=f.client();await c.recoveryStatus();
  const result=await c.recoverExisting();assert.equal(result.complete,false);assert.equal(result.lighting.status,'failed');assert.equal(result.lighting.error.code,'BACKUP_CLEANUP_REQUIRED');assert.equal(result.boardSleep.status,'restored');
  assert.equal(result.remaining.boardSleep,false);assert.equal(await readFile(marker,'utf8'),'damaged completion');assert.equal(await readFile(path.join(f.directory,'profile-1.json'),'utf8'),original);await assert.rejects(c.close());
});
test('a different hardware identity firmware or physical switch after checking cannot receive old settings',async t=>{
  for(const [change,code] of [['identity','RECOVERY_STATUS_CHANGED'],['profile','SESSION_CHANGED'],['firmware','RECOVERY_STATUS_CHANGED'],['unknownFirmware','RECOVERY_POLICY_UNVERIFIED']]){
    const f=await fixture(t);await f.crash();const c=f.client();await c.recoveryStatus();const disk=await f.disk();
    if(change==='identity')disk.serial='another-simulated-keyboard';else if(change==='profile')disk.profile=0;else disk.firmware=[0,0,2,170,change==='unknownFirmware'?8:7,0,0,0];
    await writeFile(path.join(f.directory,'simulator-hardware.json'),JSON.stringify(disk));const before=await f.active();
    await assert.rejects(c.recoverExisting(),{code});await assert.rejects(c.close());assert.deepEqual(await f.active(),before);
    for(const name of (await readdir(f.directory)).filter(n=>n.startsWith('simulator-audit-'+c.child.pid+'-'))){const audit=JSON.parse(await readFile(path.join(f.directory,name),'utf8'));assert(audit.commands.every(op=>[0xa1,0xa0,0xd1].includes(op)));}
  }
});
