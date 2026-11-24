import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowsResumePlanner,discoverWindowsClaudeCLI,validateResumeSelection} from '../server/platform/windows-resume.mjs';
import {validatePreviewCommand} from '../server/platform/preview-policy.mjs';
const id='12345678-1234-1234-1234-123456789abc',requestId='c'.repeat(64),cwd="D:\\项目 0's $() ; `",exe='C:\\Users\\fixture\\bin\\codex.exe';
function fixture(options={}){
  const task={id,status:'completed',...options.task},queries=[],evidence=[];
  const codex={codexHome:'C:\\Codex home',snapshot:()=>({tasks:options.missing?[]:[{...task}]}),discoverDatabase:async()=>options.noDatabase?null:'C:\\Codex home\\state_1.sqlite',
    sql:async(database,sql)=>{queries.push(sql);return sql.startsWith('PRAGMA')?(options.noCwd?['id']:['id','cwd','archived']).map(name=>({name})):options.rows??[{id,cwd}];}};
  const claude={snapshot:()=>({tasks:[{id,status:'ended',live:false,pid:42,cwd,...options.task}]})};
  const probe={writers:async(home,ids)=>{evidence.push({home,ids});await options.onProbe?.(task);return options.writers===undefined?new Map():options.writers;},
    starts:async pids=>{evidence.push({pids});return options.processes===undefined?new Map():options.processes;}};
  const planner=new WindowsResumePlanner({codex,claude,probe,now:()=>123456789,
    inspect:async path=>({isDirectory:()=>path===cwd&&!options.directoryMissing,isFile:()=>path===exe}),
    discoverCodex:async()=>options.cli===undefined?exe:options.cli,discoverClaude:async()=>exe});
  return {planner,task,queries,evidence,prepare:(source='codex')=>planner.prepare({source,id,requestId})};
}
test('resume preparation resolves the selected project and native executable without a prompt or shell command',async()=>{
  const f=fixture(),result=await f.prepare();
  assert.deepEqual(result,{version:1,source:'codex',id,requestId,executable:exe,cwd,preparedAt:123456789});
  assert(!('args'in result));assert(!('prompt'in result));assert.equal(f.queries.filter(sql=>sql.startsWith('SELECT')).length,2);
  assert.deepEqual(f.evidence,[{home:'C:\\Codex home',ids:[id]}]);
});
test('resume rejects unknown or active writers missing project metadata and foreign rows',async()=>{
  for(const options of [{writers:null},{writers:new Map([[id,{startedAt:1}]])},{noDatabase:true},{noCwd:true},{rows:[]},{rows:[{id:'foreign',cwd}]},
    {rows:[{id,cwd},{id,cwd}]},{rows:[{id,cwd:'\\\\server\\share'}]},{directoryMissing:true},{cli:null},{cli:'C:\\bin\\codex.cmd'},{missing:true},{task:{status:'running'}}]){
    await assert.rejects(fixture(options).prepare());
  }
});
test('a task state or directory change during preparation cannot become a launch plan',async()=>{
  const f=fixture({onProbe:task=>{task.status='running';}});await assert.rejects(f.prepare(),/状态已变化/);
  const moved=fixture();let reads=0;const sql=moved.planner.codex.sql;
  moved.planner.codex.sql=async(...args)=>{const rows=await sql(...args);return args[1].startsWith('SELECT')&&++reads===2?[{id,cwd:'E:\\moved'}]:rows;};
  await assert.rejects(moved.prepare(),/目录已变化/);
});
test('Claude recovery requires an explicit ended session and confirmed absent process',async()=>{
  const f=fixture();const plan=await f.prepare('claude');assert.equal(plan.source,'claude');assert.deepEqual(f.evidence,[{pids:[42]}]);
  for(const options of [{task:{status:'running'}},{task:{live:true}},{task:{pid:null}},{task:{pid:0x100000000}},{processes:null},{processes:new Map([[42,123]])}])
    await assert.rejects(fixture(options).prepare('claude'));
});
test('native Claude discovery accepts exe candidates only and never invokes a shell',async()=>{
  const inspected=[];const expected='D:\\本机工具\\claude.exe';
  assert.equal(await discoverWindowsClaudeCLI({home:'C:\\User',env:{CLAUDE_CLI:'D:\\bad.cmd',Path:'relative;\\\\server\\share;D:\\本机工具'},
    inspect:async path=>{inspected.push(path);return {isFile:()=>path===expected};}}),expected);
  assert(inspected.every(path=>!path.startsWith('\\\\')&&!path.endsWith('.cmd')));
});
test('only typed source session and request identities reach the preparation boundary',()=>{
  for(const value of ['--dangerously-skip-permissions','../session','last',id+'\n'])assert.throws(()=>validateResumeSelection('codex',value));
  assert.throws(()=>validateResumeSelection('shell',id));
  const request={op:'windowsPrepareResume',source:'codex',id,requestId};
  assert.doesNotThrow(()=>validatePreviewCommand(request,{agentStatus:true}));
  for(const extra of [{executable:exe},{cwd},{args:['--yolo']},{prompt:'do work'}])assert.throws(()=>validatePreviewCommand({...request,...extra},{agentStatus:true}));
  const focus={op:'windowsAgentAction',source:'codex',action:'focusTerminal',id};
  assert.doesNotThrow(()=>validatePreviewCommand(focus,{agentStatus:true}));
  for(const extra of [{pid:42},{hwnd:101},{ownerPid:43},{program:exe},{keys:['Enter']}])assert.throws(()=>validatePreviewCommand({...focus,...extra},{agentStatus:true}));
  assert.throws(()=>validatePreviewCommand(request,{agentStatus:false}));
});
