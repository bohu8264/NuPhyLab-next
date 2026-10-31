import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {fakeService,until} from './helpers/fake-service.mjs';

const tasks=Array.from('abcdef',id=>({id,title:'Private fixture title '+id,status:'running'}));
const gesture=(id,phase='down',eventSource='eventTap')=>({op:'codexKey',code:'F2',gestureId:id,phase,eventSource,eventTime:123.456});
const action=(threadId='b',extra={})=>({op:'codexAction',action:'task',threadId,...extra});
const ok=async(service,body)=>{const r=await service.command(body);assert.equal(r.ok,true,JSON.stringify(r));return r.result;};
const rows=async service=>(await service.state()).codex.keys.taskOpenTrace;
const opens=async service=>(await service.operations()).filter(x=>x.op==='shortcut'&&x.action==='task');
async function fixture(t,extra={}) {
  const service=await fakeService(t,{tasks,skipInitialConnect:true,taskOpenDiagnostics:true,...extra});
  await ok(service,{op:'settings',settings:{autoConnect:false,codexEnabled:true,codexSelectedPulse:false}});
  return service;
}

// Deterministic real HTTP receipt order while another fake helper request holds
// the service queue. This does not reimplement production context resolution.
async function pipeline(service,bodies) {
  const url=new URL(service.url);
  const raw=await new Promise((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port:Number(url.port)});let text='';
    socket.setTimeout(10000,()=>socket.destroy(new Error('fake HTTP pipeline timeout')));
    socket.on('error',reject);socket.on('data',bytes=>{text+=bytes.toString();});socket.on('end',()=>resolve(text));
    socket.on('connect',()=>{for(const [i,body] of bodies.entries()){
      const json=JSON.stringify(body);
      socket.write(`POST /api/command HTTP/1.1\r\nHost: ${url.host}\r\nX-Air-Token: ${service.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: ${i===bodies.length-1?'close':'keep-alive'}\r\n\r\n${json}`);
    }});
  });
  return raw.split(/(?=HTTP\/1\.1 \d{3} )/).filter(Boolean).map(response=>{
    const split=response.indexOf('\r\n\r\n'),headers=response.slice(0,split);let body=response.slice(split+4);
    if(/transfer-encoding: chunked/i.test(headers)){
      let rest=Buffer.from(body),chunks=[];while(rest.length){const end=rest.indexOf('\r\n'),length=parseInt(rest.subarray(0,end).toString(),16);assert.ok(Number.isInteger(length));if(!length)break;chunks.push(rest.subarray(end+2,end+2+length));rest=rest.subarray(end+2+length+2);}body=Buffer.concat(chunks).toString();
    }
    return JSON.parse(body);
  });
}

test('task delivery diagnostic correlates one F2 open and preserves distinct fast presses',async t=>{
  const service=await fixture(t);
  const baseline=(await service.operations()).length;
  const first=await ok(service,gesture('probe:F2:one'));
  assert.deepEqual(first,{opened:true,threadId:'b'});
  await ok(service,gesture('probe:F2:one'));
  await ok(service,gesture('probe:F2:one','up'));
  await ok(service,gesture('probe:F2:one','down','local'));
  assert.equal((await opens(service)).length,1);
  let trace=await rows(service);assert.equal(trace.length,1);
  assert.equal(trace[0].origin,'physical-key');assert.equal(trace[0].gestureId,'probe:F2:one');
  assert.equal(trace[0].code,'F2');assert.equal(trace[0].index,1);assert.equal(trace[0].source,'codex');
  assert.equal(trace[0].eventSource,'eventTap');assert.equal(trace[0].eventTime,123.456);assert.ok(Number.isInteger(trace[0].epoch));
  assert.equal(trace[0].targetId,'b');assert.equal(trace[0].expectedURI,'codex://threads/b');assert.equal(trace[0].finalURI,'codex://threads/b');
  assert.equal(trace[0].osAccepted,true);assert.equal(trace[0].transport,'resolved');
  assert.deepEqual(trace[0].handlerSnapshot,{available:true,bundleId:'com.openai.codex',version:'26.1021.31345',build:'21828'});
  assert.equal((await opens(service))[0].diagnosticId,trace[0].diagnosticId);
  await ok(service,gesture('probe:F2:two'));await ok(service,gesture('probe:F2:two','up'));
  trace=await rows(service);assert.equal(trace.length,2);assert.notEqual(trace[0].diagnosticId,trace[1].diagnosticId);
  assert.equal((await opens(service)).length,2);
  const ops=(await service.operations()).slice(baseline);
  assert.equal(ops.some(x=>['connect','arm','paint','nativeLighting','adaptKeys','keyMonitor','triggerMonitor'].includes(x.op)),false);
  for(const request of ops.filter(x=>x.op==='shortcut'))assert.deepEqual(Object.keys(request).sort(),['action','diagnosticId','id','op','threadId']);
});

test('unknown, stale, wrong-target, and duplicate events cannot replace a pending task result',async t=>{
  const service=await fixture(t);await ok(service,gesture('probe:old'));await ok(service,gesture('probe:old','up'));
  const original=(await rows(service))[0];
  const event={event:'taskOpenResult',diagnosticId:original.diagnosticId,threadId:'b',uri:'codex://threads/b',at:1,
    handler:{available:true,bundleId:'old.handler',version:'1',build:'1'},osAccepted:false};
  await service.configure({taskOpenExtraEvents:[event,{...event,diagnosticId:'unknown'},
    {...event,diagnosticId:'$current',threadId:'evil',uri:'codex://threads/evil'},
    {...event,diagnosticId:'$current',uri:'codex://threads/b?prompt=DO_NOT_RECORD'},
    {...event,diagnosticId:'$current',at:'DO_NOT_RECORD'},
    {...event,diagnosticId:'$current',osAccepted:'DO_NOT_RECORD'},
    {...event,diagnosticId:'$current',osAccepted:true,handler:{available:true,bundleId:'first.handler',version:'2',build:'2'}},
    {...event,diagnosticId:'$current',osAccepted:false}]});
  await ok(service,gesture('probe:fresh'));await ok(service,gesture('probe:fresh','up'));
  const trace=await rows(service);assert.equal(trace.length,2);assert.deepEqual(trace[0],original);
  assert.equal(trace[1].osAccepted,true);assert.equal(trace[1].handlerSnapshot.bundleId,'first.handler');
  assert.equal(trace[1].finalURI,'codex://threads/b');assert.equal(JSON.stringify(trace).includes('DO_NOT_RECORD'),false);
});

test('only internal physical context and whitelisted handler metadata enter the bounded ring',async t=>{
  const service=await fixture(t,{taskOpenEventOverrides:{handler:{available:true,bundleId:'com.openai.codex',version:'DO NOT RECORD',build:'x'.repeat(81),prompt:'DO_NOT_RECORD'},cwd:'DO_NOT_RECORD',prompt:'DO_NOT_RECORD'}});
  for(let i=0;i<35;i++)await ok(service,action('b',{diagnosticId:'forged',taskOpenContext:{gestureId:'DO_NOT_RECORD',source:'claude'},prompt:'DO_NOT_RECORD',cwd:'DO_NOT_RECORD'}));
  const trace=await rows(service);assert.equal(trace.length,32);assert.equal(new Set(trace.map(x=>x.diagnosticId)).size,32);
  const fields=new Set(['diagnosticId','at','targetId','expectedURI','origin','transport','osAccepted','handlerSnapshot','finalURI','helperAt','finishedAt']);
  for(const row of trace){
    assert.equal(row.origin,'task-action');assert.equal(row.gestureId,undefined);assert.notEqual(row.diagnosticId,'forged');
    assert.ok(Object.keys(row).every(k=>fields.has(k)));assert.equal(row.handlerSnapshot.version,null);assert.equal(row.handlerSnapshot.build,null);
  }
  assert.equal(JSON.stringify(trace).includes('DO_NOT_RECORD'),false);assert.equal(JSON.stringify(trace).includes('Private fixture title'),false);
  assert.equal((await opens(service)).length,35);
});

test('OS rejection remains a failed task with one metadata result and no retry',async t=>{
  const service=await fixture(t,{taskOpenFail:true});
  const result=await service.command(gesture('probe:failure'));assert.equal(result.ok,false);
  assert.equal(result.error,'macOS could not open the Codex task URL.');
  await ok(service,gesture('probe:failure','up'));
  const trace=await rows(service);assert.equal(trace.length,1);assert.equal(trace[0].transport,'failed');
  assert.equal(trace[0].failureCode,'TASK_OPEN_FAILED');assert.equal(trace[0].osAccepted,false);assert.equal(trace[0].finalURI,'codex://threads/b');
  assert.equal((await opens(service)).length,1);
  assert.equal((await service.state()).codex.keys.gestureTrace.filter(x=>x.stage==='failed').length,1);
});

test('missing native diagnostic or unavailable handler never invents an arrival ACK or blocks open',async t=>{
  const service=await fixture(t,{taskOpenReport:false});
  await ok(service,action());let trace=await rows(service);assert.equal(trace[0].transport,'resolved');assert.equal(trace[0].osAccepted,null);
  assert.equal(trace[0].finalURI,undefined);assert.equal(trace[0].handlerSnapshot,null);
  await service.configure({taskOpenReport:true,taskOpenEventOverrides:{handler:{available:false,bundleId:null,version:null,build:null}}});
  await ok(service,action());trace=await rows(service);assert.equal(trace[1].osAccepted,true);assert.equal(trace[1].handlerSnapshot.available,false);
  await service.configure({taskOpenReport:false,taskOpenFail:true,taskOpenFailureCode:'BACKPRESSURE'});
  assert.equal((await service.command(action())).ok,false);trace=await rows(service);
  assert.equal(trace[2].osAccepted,null);assert.equal(trace[2].transport,'failed');assert.equal(trace[2].failureCode,'BACKPRESSURE');
  assert.equal((await opens(service)).length,3);
});

test('queued source or binding changes reject captured F2 without starting a delivery diagnostic',async t=>{
  for(const settings of [{agentSource:'claude',codexEnabled:false,claudeEnabled:true},{codexTaskKeys:['F2','F1','F3','F4','F5','F6']}]){
    const service=await fixture(t,{taskOpenDelayMs:350});
    const blocker=service.command(action('a'));await until(service.operations,ops=>ops.some(x=>x.op==='shortcut'&&x.threadId==='a'),'fake task did not hold worker');
    const results=await pipeline(service,[{op:'settings',settings},gesture('probe:queued')]);
    assert.equal((await blocker).ok,true);assert.equal(results[0].ok,true);assert.equal(results[1].ok,false);
    assert.match(results[1].error,/按键绑定已更新/);assert.equal((await opens(service)).length,1);
    const trace=await rows(service);assert.equal(trace.length,1);assert.equal(trace[0].origin,'task-action');assert.equal(trace[0].targetId,'a');
    if(settings.codexTaskKeys){
      await ok(service,gesture('probe:queued','up'));await service.configure({taskOpenDelayMs:0});
      await ok(service,gesture('probe:new-binding'));await ok(service,gesture('probe:new-binding','up'));
      const fresh=(await rows(service))[1];assert.equal(fresh.origin,'physical-key');assert.equal(fresh.index,0);
      assert.equal(fresh.targetId,'a');assert.equal(fresh.source,'codex');assert.ok(fresh.epoch>0);
    }
  }
});
