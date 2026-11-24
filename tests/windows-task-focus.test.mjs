import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowsTaskFocusPlanner} from '../server/platform/windows-task-focus.mjs';
import {WindowsProcessProbe} from '../server/platform/windows-processes.mjs';
import {validatePreviewCommand} from '../server/platform/preview-policy.mjs';
const id='12345678-1234-1234-1234-123456789abc',requestId='a'.repeat(64);
const executable='C:\\原生工具\\codex.exe',createdTicks='01dc000000000001';
const startedAt=Number((BigInt('0x'+createdTicks)-116444736000000000n)/10000n);
const identity=()=>({id,pid:42,createdTicks,startedAt,executable});
function fixture(options={}){
  let present=true;const calls=[];
  const codex={codexHome:'C:\\Codex home',snapshot:()=>({tasks:present?[{id,status:'running'}]:[]})};
  const planner=new WindowsTaskFocusPlanner({codex,now:()=>1000,
    probe:{codexTarget:async(home,selected)=>{calls.push({home,id:selected});return options.targets?options.targets[calls.length-1]:identity();}},
    discoverCLI:async()=>{if(options.removeTask)present=false;return options.executable===undefined?executable:options.executable;},
    inspect:async()=>({isFile:()=>!options.missingFile})});
  return {planner,calls,prepare:(extra={})=>planner.prepare({source:'codex',id,requestId,...extra})};
}
test('external task focus uses two fresh unique writer identities and emits no window or input command',async()=>{
  const f=fixture(),plan=await f.prepare();
  assert.deepEqual(plan,{version:1,source:'codex',id,requestId,pid:42,createdTicks,executable,preparedAt:1000});
  assert.deepEqual(f.calls,[{home:'C:\\Codex home',id},{home:'C:\\Codex home',id}]);
  assert(!('hwnd'in plan));assert(!('args'in plan));assert(!('prompt'in plan));
});
test('task focus rejects unknown owners replaced processes changed programs and removed tasks',async()=>{
  for(const options of [{targets:[null]},{targets:[identity(),null]},
    {targets:[identity(),{...identity(),pid:43}]},{targets:[identity(),{...identity(),createdTicks:'01dc000000000002'}]},
    {targets:[identity(),{...identity(),executable:'D:\\elsewhere\\codex.exe'}]},
    {executable:null},{executable:'C:\\other\\codex.exe'},{missingFile:true},{removeTask:true}])
    await assert.rejects(fixture(options).prepare());
  assert.equal((await fixture({executable:'c:/原生工具/CODEX.EXE'}).prepare()).executable,executable);
});
test('unsupported sources incomplete ids and unknown request tokens cannot select an external process',async()=>{
  for(const extra of [{source:'claude'},{source:'shell'},{id:'task-0'},{id:'../x'},{requestId:'foreign'}]){
    const f=fixture();await assert.rejects(f.prepare(extra));assert.deepEqual(f.calls,[]);
  }
});
test('native target lookup keeps full FILETIME as text and rejects ambiguous or inconsistent identities',async()=>{
  const calls=[];const probe=new WindowsProcessProbe('unused',{run:async(q,env)=>{calls.push([q,env]);return {writers:[identity()]};}});
  assert.deepEqual(await probe.codexTarget('C:\\Codex home',id),identity());
  assert.deepEqual(calls,[[{op:'writerTargets',ids:[id]},{CODEX_HOME:'C:\\Codex home'}]]);
  for(const writers of [[],[identity(),identity()],[{...identity(),id:'foreign'}],
    [{...identity(),pid:0}],[{...identity(),pid:0xffffffff}],[{...identity(),createdTicks:Number(BigInt('0x'+createdTicks))}],
    [{...identity(),createdTicks:'01DC000000000001'}],[{...identity(),startedAt:startedAt+1}]]){
    const bad=new WindowsProcessProbe('unused',{run:async()=>({writers})});assert.equal(await bad.codexTarget('C:\\Codex home',id),null);
  }
});
test('older native probes fail closed for target lookup while ordinary status still works',async()=>{
  const probe=new WindowsProcessProbe('unused',{run:async q=>{
    if(q.op==='writerTargets')throw Error('Unknown operation');
    return {writers:[{id,startedAt}]};
  }});
  assert.equal(await probe.codexTarget('C:\\Codex home',id),null);
  assert.deepEqual(await probe.writers('C:\\Codex home',[id]),new Map([[id,{startedAt}]]));
});
test('public focus requests and private preparation cannot accept caller selected process identities',()=>{
  for(const body of [{op:'windowsAgentAction',source:'codex',action:'focusTask',id},
    {op:'windowsPrepareTaskFocus',source:'codex',id,requestId}]){
    assert.doesNotThrow(()=>validatePreviewCommand(body,{agentStatus:true}));
    for(const extra of [{pid:42},{createdTicks},{executable},{hwnd:101},{keys:['Enter']},{prompt:'approve'}])
      assert.throws(()=>validatePreviewCommand({...body,...extra},{agentStatus:true}));
    assert.throws(()=>validatePreviewCommand(body,{agentStatus:false}));
  }
});
