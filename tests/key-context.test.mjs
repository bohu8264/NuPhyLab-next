import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fakeService,until} from './helpers/fake-service.mjs';

const tasks=[{id:'codex-a',title:'Isolated A',status:'running'},{id:'codex-b',title:'Isolated B',status:'running'}];
const gesture=(code,id,phase='down')=>({op:'codexKey',code,phase,gestureId:id,eventSource:'eventTap',eventTime:23.456});
const mode=source=>({agentSource:source,codexEnabled:source==='codex',claudeEnabled:source==='claude'});
const ok=async(service,body)=>{const result=await service.command(body);assert.equal(result.ok,true,JSON.stringify(result));return result.result;};
const shortcuts=async service=>(await service.operations()).filter(x=>['shortcut','claudeExternalAction'].includes(x.op));

async function fixture(t,source,extra={}) {
  const service=await fakeService(t,{tasks,codexKeybindings:[{command:'globalDictationHold',key:'Ctrl+Shift+D'}],...extra});
  await mkdir(service.claudeDir,{recursive:true});
  await writeFile(path.join(service.claudeDir,'settings.json'),'{}');
  await ok(service,{op:'claudeHookInstall'});
  for(const [i,id] of ['claude-a','claude-b'].entries())await writeFile(path.join(service.claudeSpool,id+'.jsonl'),JSON.stringify({e:'UserPromptSubmit',s:id,at:Date.now()+i,c:'/isolated/'+id})+'\n');
  await ok(service,{op:'refreshClaude'});
  await until(service.state,s=>s.claude.tasks.length===2,'isolated Claude sessions missing');
  await ok(service,{op:'settings',settings:{...mode(source),codexSelectedPulse:false,claudeSelectedPulse:false,codexAmbient:false,quotaSideEnabled:false,lightIdleMs:0,
    claudeTaskAction:'selectOnly',claudeTaskSource:'custom',claudeSlotIds:['claude-a','claude-b','','','',''],
    claudeCommandIds:['toggleLightMode','refresh','none','none','none','none']}});
  return service;
}

// One TCP connection sends requests in wire order while a separate fake paint
// holds the serialized worker. This tests real HTTP receipt, not a copied queue.
async function pipeline(service,bodies) {
  const url=new URL(service.url);
  const raw=await new Promise((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port:Number(url.port)});let text='';
    socket.setTimeout(10000,()=>socket.destroy(new Error('isolated HTTP pipeline timeout')));
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

async function queued(service,bodies) {
  const paints=(await service.operations()).filter(x=>x.op==='paint').length;
  await service.configure({paintDelayMs:650});
  const blocker=service.command({op:'preview',colors:Array(84).fill('#123456')});
  await until(service.operations,ops=>ops.filter(x=>x.op==='paint').length>paints,'fake paint did not hold worker');
  const results=await pipeline(service,bodies);
  assert.equal((await blocker).ok,true);await service.configure({paintDelayMs:0});
  assert.equal(results.length,bodies.length);return results;
}

for(const source of ['codex','claude'])for(const [kind,code] of [['task','F2'],['command','F7']]) {
  test(`queued source switch ${source} to ${source==='codex'?'claude':'codex'} rejects received ${kind} key`,async t=>{
    const service=await fixture(t,source),other=source==='codex'?'claude':'codex',before=await shortcuts(service);
    const results=await queued(service,[{op:'settings',settings:mode(other)},gesture(code,`queue:${source}:${kind}`)]);
    assert.equal(results[0].ok,true);assert.equal(results[1].ok,false,'old-context key must not dispatch in new integration');
    assert.match(results[1].error,/按键绑定已更新/);assert.equal((await service.state()).settings.agentSource,other);
    assert.equal((await shortcuts(service)).length,before.length,'no external action in either integration');
    assert.equal((await service.state()).claude.lighting.selectedId,null,'old task must not select a different integration task');
    assert.equal((await service.state()).settings.claudeLightMode,'keys','old command must not toggle the new integration');
  });
}

for(const source of ['codex','claude'])for(const kind of ['task','command']) {
  test(`queued ${source} ${kind} binding-index change rejects the old key`,async t=>{
    const service=await fixture(t,source),prefix=source==='codex'?'codex':'claude';
    const patch=kind==='task'?{[prefix+'TaskKeys']:['F2','F1','F3','F4','F5','F6']}:{[prefix+'CommandKeys']:['F8','F7','F9','F10','F11','F12']};
    const before=await shortcuts(service),code=kind==='task'?'F2':'F7';
    const results=await queued(service,[{op:'settings',settings:patch},gesture(code,`index:${source}:${kind}`)]);
    assert.equal(results[0].ok,true);assert.equal(results[1].ok,false);assert.match(results[1].error,/按键绑定已更新/);
    assert.equal((await shortcuts(service)).length,before.length);assert.equal((await service.state()).claude.lighting.selectedId,null);
    await ok(service,gesture(code,`index:${source}:${kind}`,'up'));
    await ok(service,gesture(code,`index:${source}:${kind}:fresh`));
    await ok(service,gesture(code,`index:${source}:${kind}:fresh`,'up'));
    if(kind==='task'){
      if(source==='claude')assert.equal((await service.state()).claude.lighting.selectedId,'claude-a');
      else assert.equal((await shortcuts(service)).at(-1).threadId,'codex-a');
    }
  });
}

for(const source of ['codex','claude']) {
  test(`queued ${source} command-ID change and source round-trip each invalidate the receipt epoch`,async t=>{
    const service=await fixture(t,source),prefix=source==='codex'?'codex':'claude';
    const commands=[...(await service.state()).settings[prefix+'CommandIds']];commands[0]=source==='codex'?'settings':'refresh';
    let results=await queued(service,[{op:'settings',settings:{[prefix+'CommandIds']:commands}},gesture('F7',`command-id:${source}`)]);
    assert.equal(results[1].ok,false);assert.match(results[1].error,/按键绑定已更新/);
    const before=await shortcuts(service),other=source==='codex'?'claude':'codex';
    results=await queued(service,[{op:'settings',settings:mode(other)},{op:'settings',settings:mode(source)},gesture('F2',`round-trip:${source}`)]);
    assert.equal(results[0].ok,true);assert.equal(results[1].ok,true);assert.equal(results[2].ok,false,'source equality after a round-trip must not resurrect a stale key');
    assert.match(results[2].error,/按键绑定已更新/);assert.equal((await shortcuts(service)).length,before.length);
  });

  test(`duplicate ${source} gesture retains its first context across integration changes`,async t=>{
    const service=await fixture(t,source),id=`duplicate:${source}`,other=source==='codex'?'claude':'codex';
    await ok(service,gesture('F2',id));await ok(service,gesture('F2',id,'up'));
    const before=await shortcuts(service);
    await ok(service,{op:'settings',settings:mode(other)});
    const duplicate=await ok(service,{...gesture('F2',id),eventSource:'local'});
    assert.equal(duplicate.reason,'duplicate-press');assert.equal((await shortcuts(service)).length,before.length);
    const received=(await service.state()).codex.keys.gestureTrace.filter(x=>x.stage==='received'&&x.gestureId===id);
    assert.equal(received.at(-1).targetId,source==='codex'?'codex-b':'claude-b');
    await ok(service,gesture('F2',id+':new'));await ok(service,gesture('F2',id+':new','up'));
    const state=await service.state();if(other==='claude')assert.equal(state.claude.lighting.selectedId,'claude-b');
    else assert.equal((await shortcuts(service)).at(-1).threadId,'codex-b');
  });
}

test('an old-source up cannot release the new-source hold, while its matching up still releases once',async t=>{
  const service=await fixture(t,'claude');
  await ok(service,gesture('F9','source:claude:old'));await ok(service,{op:'settings',settings:mode('codex')});
  await ok(service,gesture('F9','source:codex:new'));assert.equal((await service.state()).codex.keys.held.source,'F9');
  const before=await shortcuts(service),old=await ok(service,gesture('F9','source:claude:old','up'));
  assert.equal(old.reason,'stale-release');assert.equal((await shortcuts(service)).length,before.length);assert.equal((await service.state()).codex.keys.held.source,'F9');
  await ok(service,gesture('F9','source:codex:new','up'));assert.equal((await service.state()).codex.keys.held,null);
  assert.equal((await shortcuts(service)).length,before.length+1);assert.equal((await shortcuts(service)).at(-1).phase,'up');
});
