// Development example only: a real Rust process with the shared simulated
// board, never an HID handle or the application's read-only native entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeLightingClient} from '../../server/native-lighting-client.mjs';
const binary=fileURLToPath(new URL(`../../target/debug/examples/lighting-simulator${process.platform==='win32'?'.exe':''}`,import.meta.url));
async function fixture(t,{fault,backend='simulated',modelId='air75-v3',lightingProfile=1,simulatorModel,firmwareVersion}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'NuPhy 灯光 0 '));
  const client=new NativeLightingClient({command:binary,args:['--directory',directory,...(simulatorModel?['--model',simulatorModel]:[]),...(fault?['--fault',fault]:[]),...(firmwareVersion?['--firmware',firmwareVersion]:[])],backend,modelId,lightingProfile,firmwareVersion});
  t.after(async()=>{await client.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  return {client,directory};
}
async function audits(directory){return Promise.all((await readdir(directory)).filter(name=>name.startsWith('simulator-audit-')).map(async name=>JSON.parse(await readFile(path.join(directory,name),'utf8'))));}
const colors=()=>Array(84).fill('#254677');
test('Air 2.0.0.7 paints and restores RGB while leaving unqualified global sleep unchanged',async t=>{
  const {client,directory}=await fixture(t,{firmwareVersion:'2.0.0.7'});const armed=await client.arm();
  assert.equal(armed.device.firmwareVersion,'2.0.0.7');assert.deepEqual(armed.boardSleepLease,{supported:false,active:false,pending:false});
  await client.paint(colors(),{verify:true});await client.side('#123456',35);await client.close();
  (await audits(directory)).forEach(a=>{restored(a);assert(!a.commands.some(c=>[0xf3,0xf5].includes(c)));});
});
test('a killed Air 2.0.0.7 worker retains RGB and a fresh worker restores it without sleep writes',async t=>{
  const {client,directory}=await fixture(t,{firmwareVersion:'2.0.0.7'});await client.arm();await client.paint(colors());
  const ended=new Promise(resolve=>client.child.once('close',resolve));client.child.kill();await ended;
  const names=await readdir(directory);assert(names.includes('profile-1.json'));assert(!names.includes('board-sleep.json'));
  const recovered=new NativeLightingClient({command:binary,args:['--directory',directory,'--firmware','2.0.0.7'],backend:'simulated',modelId:'air75-v3',lightingProfile:1,firmwareVersion:'2.0.0.7'});
  t.after(()=>recovered.close().catch(()=>{}));const checked=await recovered.recoveryStatus();assert.equal(checked.firmwareVersion,'2.0.0.7');assert.equal(checked.canRestore,true);
  assert.deepEqual(checked.pending,{lightingProfiles:[1],boardSleep:false,keymapProfiles:[]});assert.equal((await recovered.recoverExisting()).complete,true);await recovered.close();
  const report=(await audits(directory)).at(-1);restored(report);
});
function restored(a){assert.equal(a.simulated,true);assert.deepEqual(a.state,a.originalState);assert.deepEqual(a.rgb,a.originalRgb);assert.deepEqual(a.sleep,a.originalSleep);}
test('real Node/Rust lighting peer restores RGB and sleep across explicit restore, rearm and quit',async t=>{
  const {client,directory}=await fixture(t);const first=await client.arm();assert.equal(first.boardSleepLease.active,true);
  await client.paint(colors(),{verify:true});await client.side('#abcdef',70);await client.restore();await client.arm();assert.equal(client.status().leaseId,2);await client.paint(colors());
  const result=await client.close();assert.equal(result.restoration.verified,true);const reports=await audits(directory);assert.equal(reports.length,2);reports.forEach(restored);
  const names=await readdir(directory);assert.equal(names.includes('profile-1.json'),false);assert.equal(names.includes('board-sleep.json'),false);
});
for(const [label,options,code] of [
 ['backend',{backend:'windows-hid'},'LIGHTING_PROTOCOL_MISMATCH'],
 ['model',{modelId:'kick75'},'CONTROLLER_DEVICE_MISMATCH'],
 ['physical profile',{lightingProfile:0},'SESSION_CHANGED'],
])test(`real Rust/Node rejects mismatched ${label} before mutation`,async t=>{
  const {client,directory}=await fixture(t,options);await assert.rejects(client.arm(),{code});await assert.rejects(client.close());
  (await audits(directory)).forEach(restored);const names=await readdir(directory);assert.equal(names.some(n=>/^(?:profile-|board-sleep)/.test(n)),false);
});
test('a real paint failure is not replayed or hidden by EOF even when rollback succeeds',async t=>{
  const {client,directory}=await fixture(t,{fault:'paint'});await client.arm();await assert.rejects(client.paint(colors()));await assert.rejects(client.close());
  assert.equal(client.status().restoration.reportedRestored,true);assert.equal(client.status().phase,'failed');const reports=await audits(directory);assert.equal(reports.length,1);reports.forEach(restored);
});
test('real failed RGB restoration preserves its baseline while independently restoring sleep',async t=>{
  const {client,directory}=await fixture(t,{fault:'restore'});await client.arm();await client.paint(colors());await assert.rejects(client.close());
  assert.equal(client.status().restoration.pending,true);const [a]=await audits(directory);assert.deepEqual(a.sleep,a.originalSleep);assert.notDeepEqual(a.rgb,a.originalRgb);
  const names=await readdir(directory);assert.equal(names.includes('profile-1.json'),true);assert.equal(names.includes('board-sleep.json'),false);
});
test('real native stock worker applies and exits using settings only with the original palette intact',async t=>{
  const {client,directory}=await fixture(t,{modelId:'kick75',simulatorModel:'kick75'});
  await client.armNative();
  assert.equal(client.status().leasePurpose,'native');
  const original=await client.nativeSnapshot();
  const config={mode:4,brightness:37,speed:1,color:'#123456'};
  const applied=await client.nativeLighting(config);assert.equal(applied.changed,true);
  assert.deepEqual(applied.state.slice(9),original.state.slice(9));
  assert.equal((await client.nativeLighting(config)).changed,false);
  await client.close();const [audit]=await audits(directory);restored(audit);
  assert.equal(audit.commands.some(c=>[0xd8,0xf3,0xf5].includes(c)),false);
});
test('a terminated native stock worker recovers from its durable original without a palette record',async t=>{
  const {client,directory}=await fixture(t,{modelId:'kick75',simulatorModel:'kick75'});
  await client.armNative();await client.nativeLighting({mode:4,brightness:37,speed:1});
  const ended=new Promise(resolve=>client.child.once('close',resolve));client.child.kill();await ended;
  assert.equal((await readdir(directory)).includes('profile-1.palette.json'),false);
  const recovered=new NativeLightingClient({command:binary,args:['--directory',directory,'--model','kick75'],backend:'simulated',modelId:'kick75',lightingProfile:1});
  t.after(()=>recovered.close().catch(()=>{}));
  assert.deepEqual((await recovered.recoveryStatus()).pending,{lightingProfiles:[1],boardSleep:false,keymapProfiles:[]});
  assert.equal((await recovered.recoverExisting()).complete,true);await recovered.close();
  const reports=await audits(directory);assert.equal(reports.length,2);
  // The status-only open observes the changed settings, then the separate
  // explicit recovery open restores them; a status read is not a receipt.
  assert.notDeepEqual(reports[0].state,reports[0].originalState);restored(reports[1]);
  for(const audit of reports)assert.equal(audit.commands.includes(0xd8),false);
});
test('real wake worker confirms all main slots black before admitting animation and restores on priority exit',async t=>{
  const {client,directory}=await fixture(t);const result=await client.armConnectionWake();
  assert.equal(result.connectionWake.mainBlackVerified,true);assert.equal(result.connectionWake.sideMuted,true);
  assert.equal(result.connectionWake.paletteExposureRequired,true);
  assert.deepEqual(await client.paint(Array(84).fill('#000000')),{painted:84,skipped:true,readback:false});
  await client.paint(colors());await client.close();const [audit]=await audits(directory);restored(audit);
  const commands=audit.commands.filter(c=>[0xd6,0xd8].includes(c));assert.equal(commands[0],0xd6);
});

test('the v5 peer reports pending key originals without treating them as clean or overwriting them by arming RGB',async t=>{
  const {client,directory}=await fixture(t,{firmwareVersion:'2.0.0.7'});
  const file=path.join(directory,'keymap-1.intent.json'),original='isolated future key intent; no device write';
  // Real originals live in a store whose persistent lock already exists.
  await writeFile(path.join(directory,'session.lock'),'');
  await writeFile(file,original);
  const checked=await client.recoveryStatus();assert.deepEqual(checked.pending.keymapProfiles,[1]);assert.equal(checked.noMutation,true);
  assert.equal(client.status().restoration.pending,true);
  await assert.rejects(client.close());
  assert.equal(client.shutdownEvidence().verified,false);
  assert.equal(await readFile(file,'utf8'),original);
  const other=new NativeLightingClient({command:binary,args:['--directory',directory,'--firmware','2.0.0.7'],backend:'simulated',modelId:'air75-v3',lightingProfile:1,firmwareVersion:'2.0.0.7'});
  t.after(()=>other.close().catch(()=>{}));
  await assert.rejects(other.arm(),{code:'FUNCTION_KEYS_RECOVERY_REQUIRED'});await assert.rejects(other.close());
  assert.equal(await readFile(file,'utf8'),original);(await audits(directory)).forEach(restored);
});
