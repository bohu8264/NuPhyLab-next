import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeService} from './helpers/fake-service.mjs';

test('fixture transport preserves network failures and service diagnostics without retrying requests',async t=>{
 const service=await fakeService(t),original=globalThis.fetch;
 const failure=Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('fixture socket closed'),{code:'UND_ERR_SOCKET'})});
 let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;throw failure;};
  for(const [resource,read] of [['/api/state',()=>service.state()],['/api/command',()=>service.command({op:'connect'})]]){
   await assert.rejects(read(),error=>{
    assert.equal(error.cause,failure);assert.match(error.message,/UND_ERR_SOCKET/);
    assert(error.message.includes(resource));assert.match(error.message,/running/);return true;
   });
  }
  assert.equal(calls,2,'each request must be attempted exactly once');
 }finally{globalThis.fetch=original;}
 assert.equal((await service.state()).device.connected,true);
});
