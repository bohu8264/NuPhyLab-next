import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {watchHostControl} from '../server/host-control.mjs';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';
import {shutdownReceipt,writeShutdownReceipt,WINDOWS_HOST} from '../server/host-shutdown.mjs';
import {NATIVE_LIGHTING} from '../server/native-lighting-contract.mjs';

const secret='a'.repeat(64),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t,options={}){
  const input=new PassThrough();let shutdown=0,lost=0,hello=0;
  const dispose=watchHostControl({input,secret,onShutdown:()=>shutdown++,onLost:()=>lost++,onHello:()=>hello++,...options});
  t.after(()=>{dispose();input.destroy();});
  return {input,counts:()=>({shutdown,lost,hello}),send:op=>input.write(JSON.stringify({op,secret})+'\n')};
}
test('host control accepts chunked authenticated messages and shuts down once',async t=>{
  const f=fixture(t);const message=JSON.stringify({op:'hello',secret})+'\n';
  f.input.write(message.slice(0,20));assert.equal(f.counts().hello,0);f.input.write(message.slice(20));
  f.send('ping');f.send('shutdown');f.input.end();await wait(5);
  assert.deepEqual(f.counts(),{hello:1,shutdown:1,lost:0});
});
test('EOF, invalid secrets, oversized input and missing heartbeats fail closed',async t=>{
  for(const value of ['{}\n','null\n','[]\n',JSON.stringify({op:'ping',secret:'你'.repeat(64)})+'\n','x'.repeat(4097)]){
    const f=fixture(t);f.input.write(value);f.send('shutdown');assert.equal(f.counts().lost,1);assert.equal(f.counts().shutdown,0);
  }
  const eof=fixture(t);eof.input.end();await wait(5);assert.equal(eof.counts().lost,1);
  const expired=fixture(t,{timeoutMs:20});await wait(65);assert.equal(expired.counts().lost,1);
});
test('the real isolated service closes the pipe helper after native-host stdin closes',{timeout:15000},async t=>{
  const fixture=await previewServiceFixture(t),service=await fixture.start();
  assert.equal((await service.state()).desktop.stage,'probe');
  assert.equal((await service.command({op:'refreshPermissions'})).ok,true);
  service.child.stdin.end();
  const [code]=await service.exited;
  assert.equal(code,0);assert((await fixture.operations()).some(row=>row.op==='quit'));
});
test('authenticated shutdown carries a bounded identity and rejects malformed identities',()=>{
  let received;const input=new PassThrough();let lost=0;
  const dispose=watchHostControl({input,secret,onShutdown:value=>received=value.shutdownId,onLost:()=>lost++});
  input.write(JSON.stringify({op:'shutdown',secret,shutdownId:'b'.repeat(64)})+'\n');
  assert.equal(received,'b'.repeat(64));assert.equal(lost,0);dispose();
  const bad=new PassThrough();const end=watchHostControl({input:bad,secret,onShutdown:()=>assert.fail('invalid shutdown accepted'),onLost:()=>lost++});
  bad.write(JSON.stringify({op:'shutdown',secret,shutdownId:'foreign'})+'\n');assert.equal(lost,1);end();
});
test('shutdown receipts bind this request and cannot promote missing or failed restoration',async()=>{
  const id='c'.repeat(64),clean={verified:true,recoveryPending:false,noMutation:true};
  const receipt=shutdownReceipt(id,0,clean);assert.equal(receipt.success,true);assert.equal(receipt.shutdownId,id);
  for(const [code,evidence] of [[0,undefined],[1,clean],[0,{...clean,verified:false}],[0,{...clean,recoveryPending:true}]])
    assert.equal(shutdownReceipt(id,code,evidence).success,false);
  assert.throws(()=>shutdownReceipt('old',0,clean));
  const stream=new PassThrough();let bytes='';stream.on('data',data=>bytes+=data);
  await writeShutdownReceipt(stream,receipt);assert.deepEqual(JSON.parse(bytes),receipt);
  assert(WINDOWS_HOST.shutdownTimeoutMs>=NATIVE_LIGHTING.requestTimeoutMs+WINDOWS_HOST.heartbeatTimeoutMs);
});
