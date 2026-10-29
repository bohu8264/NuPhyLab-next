import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionRecovery} from '../server/connection-recovery.mjs';
import {fakeService,until} from './helpers/fake-service.mjs';

test('reconnect backoff is bounded, deduplicates work, and respects explicit handoff',()=>{
  let now=0;const recovery=new ConnectionRecovery({now:()=>now});
  const bad={connected:true,readOnly:true,errorCode:'UNSUPPORTED_PROTOCOL'};
  assert(recovery.due(bad,true));recovery.begin();assert(!recovery.due(bad,true));recovery.finish(bad);
  assert(!recovery.due(bad,true));now=1000;assert(recovery.due(bad,true));
  for(let i=0;i<12;i++){recovery.begin();recovery.finish(bad);assert(recovery.nextAttempt-now<=15000);now=recovery.nextAttempt;}
  assert.equal(recovery.snapshot(bad,true).status,'attention');assert(!recovery.due(bad,false));
  assert(!recovery.due({...bad,errorCode:'UNSUPPORTED_FIRMWARE'},true));
  recovery.finish({connected:true,readOnly:false});assert.equal(recovery.attempts,0);
});
for(const modelId of ['air75-v3','kick75']) {
  test(`${modelId}: a transient protocol failure clears without unplugging or clicking reconnect`,async t=>{
    const s=await fakeService(t,{modelId,firmwareVersion:modelId==='kick75'?'4.0.18.6':'1.0.23.6',readOnly:true});
    await s.command({op:'settings',settings:{codexEnabled:false,autoConnect:true}});
    await until(s.state,v=>v.device.readOnly===true,'read-only first probe');
    const start=(await s.operations()).length;
    await s.configure({readOnly:false});
    const result=await until(s.state,v=>v.device.connected&&!v.device.readOnly,'automatic recovery',8000);
    assert.equal(result.device.error,null);assert.equal(result.device.connection.status,'ready');
    assert((await s.operations()).slice(start).some(v=>v.op==='connect'));
    assert.equal((await s.command({op:'play',colors:Array(84).fill('#102030'),animation:{effect:'static'}})).ok,true);
  });
  test(`${modelId}: repeated unplug/replug restores usability and explicit disconnect stays disconnected`,async t=>{
    const s=await fakeService(t,{modelId,firmwareVersion:modelId==='kick75'?'4.0.18.6':'1.0.23.6'});
    await s.command({op:'settings',settings:{codexEnabled:false,autoConnect:true}});
    await s.command({op:'connect'});
    for(let n=1;n<=3;n++){
      assert.equal((await s.command({op:'play',colors:Array(84).fill('#102030'),animation:{effect:'static'}})).ok,true);
      await s.configure({disconnect:n,present:false});await until(s.state,v=>!v.device.connected,'unplug');
      await s.configure({present:true});
      const next=await until(s.state,v=>v.device.connected&&!v.device.readOnly&&v.device.armed,'replug',8000);
      assert.equal(next.device.modelId,modelId);assert.equal(next.device.error,null);
    }
    await s.command({op:'disconnect'});const before=(await s.operations()).filter(v=>v.op==='connect').length;
    await new Promise(resolve=>setTimeout(resolve,2200));
    assert.equal((await s.state()).device.connected,false);
    assert.equal((await s.operations()).filter(v=>v.op==='connect').length,before);
  });
}
test('application update preparation stops hardware and never auto-reconnects during installation',async t=>{
  const s=await fakeService(t);await s.command({op:'settings',settings:{codexEnabled:false,autoConnect:true}});
  await s.command({op:'connect'});
  await s.command({op:'play',colors:Array(84).fill('#102030'),animation:{effect:'static'}});
  assert.equal((await s.command({op:'prepareAppUpdate'})).ok,true);
  const after=await s.state();assert.equal(after.device.connected,false);assert.equal(after.playback.playing,false);
  const before=(await s.operations()).filter(v=>v.op==='connect').length;
  await new Promise(resolve=>setTimeout(resolve,2200));
  assert.equal((await s.operations()).filter(v=>v.op==='connect').length,before);
});
