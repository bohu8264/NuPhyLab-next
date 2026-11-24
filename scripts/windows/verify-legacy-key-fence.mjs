// Development verification only: both peers must identify as simulated.
// Usage: node verify-legacy-key-fence.mjs <v4 lighting-simulator> <current lighting-simulator> <current core test executable>
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';

const [legacy,current,seed]=process.argv.slice(2);
if(process.argv.length!==5||![legacy,current].every(p=>/^lighting-simulator(?:\.exe)?$/.test(path.basename(p)))||
  !seed||!/^nuphylab_core-[\da-f]+(?:\.exe)?$/.test(path.basename(seed)))throw Error('Supply only the v4/current development simulators and current core test executable');
const childTest='function_keys::tests::function_keys_crash_child';
assert.match(execFileSync(seed,['--list'],{encoding:'utf8',timeout:5000}),new RegExp(childTest+': test'));
const directory=await mkdtemp(path.join(tmpdir(),'NuPhy legacy guard ')),store=path.join(directory,'store');
// The ignored entry exclusively uses an in-memory keyboard and this temp path.
await (await import('node:fs/promises')).mkdir(store);
const child=spawn(seed,['--exact',childTest,'--ignored'],{env:{...process.env,NUPHY_FUNCTION_KEYS_CRASH_DIR:store},stdio:'ignore',windowsHide:true});
const seedClosed=new Promise(resolve=>child.once('close',resolve));let seeded=false;
try{
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){try{await readFile(path.join(directory,'synthetic-keyboard-state.json'));seeded=true;break;}catch{await pause(20);}}
}finally{child.kill();await seedClosed;}
if(!seeded)throw Error('Isolated key owner did not persist its original and compatibility guard');

async function active(){const data={};for(const n of await readdir(store))if(/^(?:keymap-[01](?:\.intent|\.completed)?|profile-0)\.json$/.test(n))data[n]=(await readFile(path.join(store,n))).toString('base64');return data;}
const original=await active();assert(original['profile-0.json']);
const fence=JSON.parse(Buffer.from(original['profile-0.json'],'base64'));
assert.equal(fence.data.feature,'function-key-legacy-fence-v1');
assert.equal(fence.data.originalDigest,createHash('sha256').update(Buffer.from(original['keymap-1.json'],'base64')).digest('hex'));

async function peer(binary,version,actions){
  const p=spawn(binary,['--directory',store,'--firmware','2.0.0.7'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const pending=new Map(),sessionId=randomUUID(),events=[];let id=0,stderr='',simulated=false;
  p.stdin.on('error',()=>{});p.stderr.on('data',b=>{stderr=(stderr+b).slice(-4096);});
  createInterface({input:p.stdout}).on('line',line=>{const v=JSON.parse(line);if(v.event){events.push(v);return;}const q=pending.get(v.id);if(q){pending.delete(v.id);q.resolve(v);}});
  const closed=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',code=>{for(const q of pending.values())q.reject(Error('Mock exited before replying: '+stderr));pending.clear();resolve(code);});});
  const request=(op,args={})=>new Promise((resolve,reject)=>{const number=++id;pending.set(number,{resolve,reject});p.stdin.write(JSON.stringify({id:number,op,sessionId,...args})+'\n');});
  // Force termination is restricted to verified simulated peers, after their
  // ordinary quit/EOF path fails. No production HID process is selected.
  const watchdog=setTimeout(()=>{if(simulated)p.kill();else p.stdin.end();},20000);
  try{
    const hello=await request('hello',{protocolVersion:version});assert.equal(hello.ok,true);
    assert.equal(hello.result.backend,'simulated');assert.equal(hello.result.profile,`windows-lighting-v${version}`);
    assert.equal(hello.result.protocolVersion,version);assert.equal(hello.result.sessionId,sessionId);simulated=true;
    await actions(request);
    if(p.exitCode===null){await request('quit').catch(()=>{});p.stdin.end();}
    const code=await closed;assert.equal(code,1,'pending originals must prevent an all-clear exit');
    assert.equal(events.length,1,'missing or duplicate shutdown event');
    const end=events[0];assert.equal(end.event,'shutdownComplete');assert.equal(end.sessionId,sessionId);
    assert.equal(end.eventSequence,1);assert.equal(end.lightingRestored,false);assert.equal(end.recoveryPending,true);
  }finally{clearTimeout(watchdog);p.stdin.end();if(p.exitCode===null&&simulated){p.kill();await closed;}}
  assert.deepEqual(await active(),original,'a protocol peer altered pending key originals or the guard');
}

try{
  const selection={modelId:'air75-v3',lightingProfile:1};
  await peer(legacy,4,async request=>{
    const checked=await request('recoveryStatus',selection);assert.equal(checked.ok,true);assert.deepEqual(checked.result.pending.lightingProfiles,[0]);
    const recovered=await request('recoverExisting',selection);assert.equal(recovered.ok,true);assert.equal(recovered.result.complete,false);assert.deepEqual(recovered.result.remaining.lightingProfiles,[0]);
  });
  await peer(legacy,4,async request=>{const armed=await request('arm',selection);assert.equal(armed.ok,false);});
  await peer(current,5,async request=>{
    const checked=await request('recoveryStatus',selection);assert.equal(checked.ok,true);
    assert.deepEqual(checked.result.pending,{lightingProfiles:[],boardSleep:false,keymapProfiles:[1]});
    const armed=await request('arm',selection);assert.equal(armed.ok,false);assert.equal(armed.error.code,'FUNCTION_KEYS_RECOVERY_REQUIRED');
  });
  // A legacy user switching to the reserved guard's profile still cannot
  // decode it as an RGB original or remove it through explicit recovery.
  const diskFile=path.join(store,'simulator-hardware.json'),disk=JSON.parse(await readFile(diskFile,'utf8'));disk.profile=0;await writeFile(diskFile,JSON.stringify(disk));
  await peer(legacy,4,async request=>{
    const selected={...selection,lightingProfile:0};assert.equal((await request('recoveryStatus',selected)).ok,true);
    const recovered=await request('recoverExisting',selected);assert.equal(recovered.ok,true);assert.equal(recovered.result.complete,false);assert.equal(recovered.result.lighting.status,'failed');
  });
  let audits=0;
  for(const n of await readdir(store))if(n.startsWith('simulator-audit-')){
    const a=JSON.parse(await readFile(path.join(store,n),'utf8'));assert.equal(a.simulated,true);assert(a.commands.every(c=>[0xa0,0xa1,0xd1,0xd2,0xd5,0xf3].includes(c)),JSON.stringify(a.commands));audits++;
  }
  assert(audits>=4);console.log(JSON.stringify({legacyProtocol:4,currentProtocol:5,cases:4,originalsPreserved:true,deviceSetters:0,simulated:true}));
}finally{await rm(directory,{recursive:true,force:true});}
