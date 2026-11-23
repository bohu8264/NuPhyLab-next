import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {once} from 'node:events';
import {NATIVE_READONLY,encodeNativeRequest,validateHello,readNativeLines,validateReadonlyResult} from '../server/native-contract.mjs';
import {nativeContractFixture} from './helpers/native-contract-fixture.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('native identity status is bounded separate evidence and never accepts raw serials or contradictory sources',()=>{
  const status={readOnly:true,connected:true,identified:true,armed:false};
  const qualified={status:'qualified',source:'embeddedUsbSerial',reasonCode:null};
  assert.doesNotThrow(()=>validateReadonlyResult('connect',{...status,identityQualification:qualified}));
  assert.doesNotThrow(()=>validateReadonlyResult('status',status));
  for(const identityQualification of [{...qualified,serial:'private'},{...qualified,source:'containerId'},
    {...qualified,status:'candidate'},{...qualified,reasonCode:'not qualified'},'qualified'])
    assert.throws(()=>validateReadonlyResult('connect',{...status,identityQualification}),{code:'BRIDGE_PROTOCOL_ERROR'});
});
test('native contract rejects header overrides, writes, wrong versions and oversized UTF-8 requests',()=>{
  const session='12345678-1234-1234-1234-123456789abc';
  assert.equal(JSON.parse(encodeNativeRequest(1,'status')).op,'status');
  for(const [id,op,args] of [[0,'status',{}],[1,'paint',{}],[1,'status',{op:'arm'}],[1,'status',{id:2}],[1,'status',{colors:[]}],[1,'hello',{padding:'你'.repeat(32768)}]])
    assert.throws(()=>encodeNativeRequest(id,op,args));
  const hello={...NATIVE_READONLY,sessionId:session,readOnly:true,implementationVersion:'1.2.40'};
  assert.equal(validateHello(hello,session).readOnly,true);
  assert.throws(()=>validateHello({...hello,protocolVersion:2},session),{code:'BRIDGE_PROTOCOL_MISMATCH'});
  assert.throws(()=>validateHello({...hello,capabilities:{...hello.capabilities,lightingWrite:true}},session),{code:'BRIDGE_PROTOCOL_MISMATCH'});
});
test('bounded native reader preserves split Unicode and multiple complete lines',()=>{
  const input=new PassThrough(),values=[],errors=[];
  const dispose=readNativeLines(input,value=>values.push(value),error=>errors.push(error));
  const bytes=Buffer.from(JSON.stringify({id:1,ok:false,error:{code:'TEST',message:'测试 0'}})+'\n'+JSON.stringify({id:2,ok:true,result:{}})+'\n');
  for(const byte of bytes)input.write(Buffer.from([byte]));
  assert.equal(values.length,2);assert.equal(values[0].error.message,'测试 0');assert.deepEqual(errors,[]);dispose();input.destroy();
});
test('bounded native reader rejects truncated, malformed, invalid UTF-8 and oversized output once',async()=>{
  for(const bytes of [Buffer.from('{}\n'),Buffer.from('null\n'),Buffer.from('[]\n'),Buffer.from('{"id":1'),Buffer.from([0xff,10]),Buffer.alloc(32769,65)]){
    const input=new PassThrough(),errors=[],values=[];
    const dispose=readNativeLines(input,value=>values.push(value),error=>errors.push(error));
    input.end(bytes);await once(input,'end');
    assert.equal(errors.length,1);assert.equal(errors[0].code,'BRIDGE_PROTOCOL_ERROR');assert.deepEqual(values,[]);dispose();input.destroy();
  }
});
test('read-only native client handshakes once and refuses writes before starting a child',async t=>{
  const f=await nativeContractFixture(t),h=f.hardware;
  for(const op of ['arm','paint','shortcut','hello'])await assert.rejects(h.request(op));
  assert.equal(h.child,null);
  await Promise.all([h.request('permissions'),h.request('status')]);
  assert.equal(h.bridgeStatus().available,true);assert.equal(h.bridgeStatus().capabilities.lightingWrite,false);
  assert.deepEqual((await f.operations()).map(row=>row.op),['hello','permissions','status']);
  await h.close();assert.equal(h.bridgeStatus().status,'closed');assert.equal(h.shutdownResult.noMutation,true);
});
test('mismatched native handshakes never reach a device command',{timeout:15000},async t=>{
  for(const hello of [{protocolVersion:2},{platform:'darwin'},{implementation:'unknown'},{sessionId:'old'},
    {capabilities:{...NATIVE_READONLY.capabilities,lightingWrite:true}}]){
    const f=await nativeContractFixture(t,{hello});
    await assert.rejects(f.hardware.request('connect'),{code:'BRIDGE_PROTOCOL_MISMATCH'});
    assert.equal(f.hardware.bridgeStatus().available,false);
    assert.deepEqual((await f.operations()).filter(row=>row.op).map(row=>row.op),['hello']);
  }
});
test('native queue is bounded before commands are scheduled and drains in order',async t=>{
  const f=await nativeContractFixture(t,{delayMs:5}),h=f.hardware;
  const pending=Array.from({length:NATIVE_READONLY.maxPending},()=>h.request('status'));
  await assert.rejects(h.request('permissions'),{code:'BRIDGE_QUEUE_FULL'});
  await Promise.all(pending);assert.equal(h.pendingCount,0);
  const ops=(await f.operations()).map(row=>row.op);assert.equal(ops[0],'hello');assert.equal(ops.filter(op=>op==='status').length,32);
  await h.close();
});
test('native process loss rejects old queued work and a replacement must handshake again',{timeout:15000},async t=>{
  const f=await nativeContractFixture(t,{delayMs:1000}),h=f.hardware;
  await h.request('permissions');const previous=h.bridgeStatus().sessionId;
  const first=h.request('status'),second=h.request('permissions'),results=Promise.allSettled([first,second]);
  while(!(await f.operations()).some(row=>row.op==='status'))await wait(5);
  const child=h.child,closed=once(child,'close');child.kill();await closed;
  assert((await results).every(result=>result.status==='rejected'));
  await f.configure({delayMs:0});await h.request('permissions');
  assert.notEqual(h.bridgeStatus().sessionId,previous);
  assert.equal((await f.operations()).filter(row=>row.op==='hello').length,2);
  assert.equal((await f.operations()).filter(row=>row.op==='permissions').length,2,'the old queued permission request must not reach the replacement');
  await h.close();
});
test('stale events, changed capabilities and damaged replies invalidate the native session',async t=>{
  for(const configuration of [{badEvent:'session'},{badEvent:'sequence'},{badEvent:'replay'},
    {result:{readOnly:false,armed:true}},{result:{capabilities:{perKey:true}}},{invalidReply:'not-json\n'}]){
    const f=await nativeContractFixture(t,configuration),h=f.hardware;
    await assert.rejects(h.request('status'));assert.equal(h.bridgeStatus().available,false);assert.equal(h.state.armed,false);
  }
});
test('old reply IDs cannot revive a previous native result',async t=>{
  const f=await nativeContractFixture(t,{oldReply:true});
  const result=await f.hardware.request('status');assert.equal(result.connected,false);assert.equal(result.readOnly,true);
  await f.hardware.close();
});
test('native exit code zero without cleanup acknowledgement is not a clean close',async t=>{
  const f=await nativeContractFixture(t,{missingShutdown:true});
  await f.hardware.request('permissions');await assert.rejects(f.hardware.close(),/未确认清理/);
  assert.equal(f.hardware.bridgeStatus().status,'failed');
});
test('missing native handshake times out before any keyboard operation',{timeout:6000},async t=>{
  const f=await nativeContractFixture(t,{noHello:true});
  await assert.rejects(f.hardware.request('connect'),{code:'BRIDGE_TIMEOUT'});
  assert.deepEqual((await f.operations()).filter(row=>row.op).map(row=>row.op),['hello']);
});
test('legacy Mac launch descriptors keep their existing handshake-free wire format',async t=>{
  const f=await nativeContractFixture(t,{legacy:true});
  await f.hardware.request('permissions');assert.equal((await f.operations())[0].op,'permissions');
  assert.equal(f.hardware.bridgeStatus().status,'legacy');await f.hardware.close();
});
