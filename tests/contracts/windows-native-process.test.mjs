// Real Rust executable and Node client. These cases never call an accepted
// connect/enumerate operation, so no HID device is opened on either platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Hardware} from '../../server/hardware.mjs';
import {NativeLightingClient} from '../../server/native-lighting-client.mjs';
import {deviceModels} from '../../scripts/windows/prepare.mjs';

const binary=fileURLToPath(new URL(`../../target/debug/nuphylab-hid${process.platform==='win32'?'.exe':''}`,import.meta.url));
const sessionId='12345678-1234-1234-1234-123456789abc';
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'nuphy-rust-contract-')),models=path.join(directory,'models.json');
  await writeFile(models,JSON.stringify(deviceModels()));t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,args:['--models',models]};
}
async function raw(args,requests){
  const child=spawn(binary,args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>65536)child.kill();});child.stderr.on('data',bytes=>{stderr+=bytes;});
  child.stdin.on('error',()=>{});
  const result=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,stderr,values:stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}));});
  const timeout=setTimeout(()=>child.kill(),8000);
  child.stdin.end(typeof requests==='string'?requests:requests.map(value=>JSON.stringify(value)+'\n').join(''));
  try{return await result;}finally{clearTimeout(timeout);}
}
test('real Node client negotiates the Rust helper and verifies read-only cleanup',async t=>{
  const f=await fixture(t),h=new Hardware({command:binary,args:f.args,protocol:'windows-readonly-v1'},path.join(f.directory,'unused.json'));
  t.after(async()=>{if(h.child)await h.close();});
  const permissions=await h.request('permissions');assert.equal(permissions.platform,'win32');assert.equal(permissions.canPostEvents,false);
  assert.equal((await h.request('status')).readOnly,true);assert.equal(h.bridgeStatus().capabilities.lightingWrite,false);
  await h.close();assert.equal(h.shutdownResult.noMutation,true);assert.equal(h.bridgeStatus().status,'closed');
});
test('real Rust refuses pre-handshake reads and writes after a valid handshake',async t=>{
  const f=await fixture(t),result=await raw(f.args,[{id:1,op:'connect'},
    {id:2,op:'hello',protocolVersion:1,sessionId},{id:3,op:'status'},{id:4,op:'arm'},{id:5,op:'quit'}]);
  assert.equal(result.code,0,result.stderr);
  assert.equal(result.values[0].error.code,'BRIDGE_HANDSHAKE_REQUIRED');
  assert.equal(result.values[1].result.sessionId,sessionId);assert.equal(result.values[2].result.connected,false);
  assert.equal(result.values[3].error.code,'WINDOWS_PROBE_ONLY');assert.equal(result.values.at(-1).eventSequence,1);
  assert.equal(result.values.at(-1).noMutation,true);
});
test('real Rust rejects version mismatches, replayed IDs and extra command parameters',async t=>{
  const f=await fixture(t),result=await raw(f.args,[{id:1,op:'hello',protocolVersion:2,sessionId},
    {id:2,op:'hello',protocolVersion:1,sessionId},{id:2,op:'status'},{id:3,op:'status',colors:[]},{id:4,op:'quit'}]);
  assert.equal(result.code,0,result.stderr);assert.equal(result.values[0].error.code,'BRIDGE_PROTOCOL_MISMATCH');
  assert.equal(result.values[2].error.code,'BRIDGE_REQUEST_INVALID');assert.equal(result.values[3].error.code,'BRIDGE_REQUEST_INVALID');
  const sleep=await raw(f.args,[{id:1,op:'hello',protocolVersion:1,sessionId},
    {id:2,op:'sleepSnapshot',command:245},{id:3,op:'quit'}]);
  assert.equal(sleep.code,0);assert.equal(sleep.values[1].error.code,'BRIDGE_REQUEST_INVALID');
});
test('real Rust handles EOF and bounds malformed stdin while emitting cleanup markers',async t=>{
  const f=await fixture(t);
  const eof=await raw(f.args,[{id:1,op:'hello',protocolVersion:1,sessionId}]);
  assert.equal(eof.code,0,eof.stderr);assert.equal(eof.values.at(-1).sessionId,sessionId);assert.equal(eof.values.at(-1).noMutation,true);
  for(const input of ['x'.repeat(32769),'{}']){
    const result=await raw(f.args,input);assert.equal(result.code,1);assert.match(result.stderr,/INVALID_REQUEST/);
    assert.equal(result.values.at(-1).event,'shutdownComplete');assert.equal(result.values.at(-1).noMutation,true);
  }
});
test('the explicit native lighting entry handshakes and quits without opening a device or store',async t=>{
  const f=await fixture(t),client=new NativeLightingClient({command:binary,args:[...f.args,'--lighting'],backend:'windows-hid',modelId:'air75-v3',lightingProfile:1});
  t.after(()=>client.close().catch(()=>{}));
  const hello=await client.start();assert.equal(hello.backend,'windows-hid');
  assert.equal(hello.profile,'windows-lighting-v5');
  const result=await client.close();assert.equal(result.restoration.verified,true);assert.equal(result.restoration.noMutation,true);
  assert.deepEqual(await readdir(f.directory),['models.json']);
});
test('the explicit lighting entry rejects commands before its own handshake',async t=>{
  const f=await fixture(t),result=await raw([...f.args,'--lighting'],[{id:1,op:'arm',sessionId,modelId:'air75-v3',lightingProfile:1}]);
  assert.equal(result.code,1);assert.match(result.stderr,/CONTROLLER_HANDSHAKE_REQUIRED/);
  assert.equal(result.values.every(value=>value.ok===false),true);
});

test('the v5 native entry refuses all earlier lighting handshakes before opening a device',async t=>{
  const f=await fixture(t);
  for(const version of [2,3,4]){
    const result=await raw([...f.args,'--lighting'],[{id:1,op:'hello',protocolVersion:version,sessionId}]);
    assert.equal(result.code,1);assert.match(result.stderr,/CONTROLLER_PROTOCOL_MISMATCH/);
    assert.equal(result.values.some(v=>v.ok===true),false);
  }
  assert.deepEqual(await readdir(f.directory),['models.json']);
});
test('the explicit lighting entry refuses path identity timeout and conflicting mode overrides',async t=>{
  const f=await fixture(t);
  for(const extra of [['--directory',f.directory],['--serial','invented'],['--timeout','1'],['--enumerate'],['--lighting'],['--models',f.args[1]]]){
    const result=await raw([...f.args,'--lighting',...extra],'');
    assert.equal(result.code,1);assert.match(result.stderr,/INVALID_ARGUMENT/);assert.deepEqual(result.values,[]);
  }
  assert.deepEqual(await readdir(f.directory),['models.json']);
});
