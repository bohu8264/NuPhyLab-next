import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WindowsProcessProbe} from '../server/platform/windows-processes.mjs';
import {WindowsClaudeHookInstaller} from '../server/platform/windows-claude-hooks.mjs';
import {WindowsAgentActions,WindowsCodexAdapter,windowsResumeCommand} from '../server/platform/windows-agents.mjs';
import {ClaudeCodeAdapter} from '../server/claude-code.mjs';
import {validatePreviewCommand} from '../server/platform/preview-policy.mjs';
import {normalizeEvent,reduceSession} from '../server/claude-events.mjs';
test('PowerShell resume commands preserve quotes dollars backticks and Unicode as literal path data',()=>{
  assert.equal(windowsResumeCommand('codex','thread-0',"D:\\项目 0's $() `"),"& { Set-Location -LiteralPath 'D:\\项目 0''s $() `' -ErrorAction Stop; codex resume 'thread-0' }");
  assert.equal(windowsResumeCommand('claude','session-0'),"claude --resume 'session-0'");
  assert.throws(()=>windowsResumeCommand('shell','x'));assert.throws(()=>windowsResumeCommand('claude',"x'; bad"));
});
test('Windows actions only open an existing local directory or copy prepared text without shell interpolation',async()=>{
  const calls=[],copied=[];const runner=new WindowsAgentActions({env:{SystemRoot:'C:\\Windows'},run:async(...args)=>calls.push(args),inspect:async()=>({isDirectory:()=>true}),clipboard:async text=>copied.push(text)});
  await runner.execute({available:true,type:'revealProject',path:'D:\\项目 $() 0'});
  assert.deepEqual(calls[0].slice(0,2),['C:\\Windows\\explorer.exe',['D:\\项目 $() 0']]);
  const text=windowsResumeCommand('claude','abc-0',"D:\\A's project");await runner.execute({available:true,type:'copyResume',text});assert.deepEqual(copied,[text]);
  for(const value of [{type:'shortcut',keys:['Enter']},{type:'revealProject',path:'\\\\server\\share'},{type:'copyResume',text:'\0'}])await assert.rejects(runner.execute({available:true,...value}));
});
test('Windows process evidence preserves unknown state and rejects foreign or duplicated identities',async()=>{
  const calls=[];const probe=new WindowsProcessProbe('unused',{run:async(q,env)=>{calls.push([q,env]);return q.op==='processStarts'?{processes:[{pid:42,startedAt:1234,executable:'claude.exe'}]}:{writers:[{id:'task-0',startedAt:1234}]};}});
  assert.deepEqual(await probe.starts([42,42,-1]),new Map([[42,1234]]));assert.deepEqual(await probe.writers('C:\\Codex home',['task-0']),new Map([['task-0',{startedAt:1234}]]));
  assert.equal(calls[1][1].CODEX_HOME,'C:\\Codex home');assert.equal(await probe.writers('C:\\Codex',['../bad']),null);
  for(const result of [{processes:[{pid:99,startedAt:1,executable:'codex.exe'}]},{processes:[{pid:42,startedAt:1,executable:'x'},{pid:42,startedAt:1,executable:'x'}]}]){
    const bad=new WindowsProcessProbe('unused',{run:async()=>result});assert.equal(await bad.starts([42,43]),null);
  }
  const denied=new WindowsProcessProbe('unused',{run:async()=>{throw Error('access denied');}});assert.equal(await denied.starts([42]),null);assert.equal(await denied.writers('C:\\Codex',['task-0']),null);
});
test('Windows Codex database uses the bundled read-only safe CLI and never invents Mac shortcuts',async()=>{
  let invocation;
  const adapter=new WindowsCodexAdapter({home:'C:\\Users\\fixture',env:{},sqlitePath:'C:\\App\\nuphylab-sqlite.exe',probe:{writers:async()=>null},enableQuota:false,
    databaseExec:async(...args)=>{invocation=args;return {stdout:'[{"id":"task-0"}]'};}});
  assert.deepEqual(await adapter.sql('C:\\Codex\\state_1.sqlite','SELECT id FROM threads;'),[{id:'task-0'}]);
  assert.deepEqual(invocation[1].slice(0,6),['-readonly','-json','-batch','-init','NUL','-safe']);
  assert(adapter.snapshot().shortcuts.every(s=>s.available===false&&s.keys.length===0));
  assert.equal(adapter.action('approve').available,false);assert.equal(adapter.action('dictation').available,false);
});
test('Windows status and hook commands cannot supply program paths key proofs or runtime overrides',()=>{
  for(const op of ['refreshCodex','refreshClaude','claudeHookStatus','claudeHookInstall']){
    assert.doesNotThrow(()=>validatePreviewCommand({op},{agentStatus:true}));
    assert.throws(()=>validatePreviewCommand({op,path:'C:\\other'},{agentStatus:true}));
  }
  assert.doesNotThrow(()=>validatePreviewCommand({op:'settings',settings:{codexEnabled:true,codexKeyAdaptation:false}},{agentStatus:true}));
  assert.throws(()=>validatePreviewCommand({op:'settings',settings:{codexKeyAdaptation:true}},{agentStatus:true}));
  assert.throws(()=>validatePreviewCommand({op:'codexKey',nativeKeySignature:'invented'},{agentStatus:true}));
});
test('Windows exec-form hook installs only owned entries and writes portable minimal records',{timeout:30000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"NuPhy hook $() % ' 0 "));t.after(()=>rm(root,{recursive:true,force:true}));
  const dataDir=path.join(root,'app data'),claudeDir=path.join(root,'claude home');await mkdir(claudeDir);
  const other={type:'command',command:'existing-user-hook.exe',args:['literal $()']};
  await writeFile(path.join(claudeDir,'settings.json'),JSON.stringify({theme:'keep',hooks:{SessionStart:[{hooks:[other]}]}}));
  const installer=new WindowsClaudeHookInstaller({dataDir,claudeDir});const result=await installer.install();assert.equal(result.installed,true);
  const settings=JSON.parse(await readFile(path.join(claudeDir,'settings.json'),'utf8'));
  assert.equal(settings.theme,'keep');assert.deepEqual(settings.hooks.SessionStart[0].hooks,[other]);
  const entry=settings.hooks.SessionStart.at(-1).hooks[0];assert.deepEqual(entry.args,[path.join(installer.hookDir,'nuphylab-claude-hook.mjs'),installer.spoolDir,'--portable']);assert.equal(entry.onFailure,'continue');
  const child=spawn(entry.command,entry.args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NUPHYLAB_HOOK_PID:'42'}});const exited=once(child,'close');
  let stdout='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',()=>{});
  child.stdin.end(JSON.stringify({hook_event_name:'SessionStart',session_id:'CON:0',cwd:'D:\\项目 0',user_prompt:'SECRET_PROMPT',tool_input:{token:'SECRET_TOKEN'}}));
  assert.equal((await exited)[0],0);assert.equal(stdout,'{}');
  const files=await readdir(installer.spoolDir);assert.equal(files.length,1);assert.match(files[0],/^session~[A-Za-z0-9_-]+\.jsonl$/);
  const raw=await readFile(path.join(installer.spoolDir,files[0]),'utf8');assert(!raw.includes('SECRET_'));
  const adapter=new ClaudeCodeAdapter({dataDir,claudeDir,installer});assert((await adapter.readSpool()).has('CON:0'));
  await installer.remove({purgeSpool:false});const after=JSON.parse(await readFile(path.join(claudeDir,'settings.json'),'utf8'));
  assert.equal(after.theme,'keep');assert.deepEqual(after.hooks.SessionStart[0].hooks,[other]);assert.deepEqual(await readdir(installer.spoolDir),files);
});
test('upgraded Claude spool merges legacy and portable files without dropping events or literal Windows paths',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'NuPhy spool merge '));t.after(()=>rm(root,{recursive:true,force:true}));
  const spoolDir=path.join(root,'spool');await mkdir(spoolDir);const session='session-0',cwd="D:\\项目 0's $()";
  const first={e:'SessionStart',s:session,at:1000,c:cwd,p:42},last={e:'UserPromptSubmit',s:session,at:2000,c:cwd,p:42};
  await writeFile(path.join(spoolDir,session+'.jsonl'),JSON.stringify(first)+'\n');
  const portable=path.join(spoolDir,'session~'+Buffer.from(session).toString('base64url')+'.jsonl');
  await writeFile(portable,[first,last].map(v=>JSON.stringify(v)).join('\n')+'\n');
  const adapter=new ClaudeCodeAdapter({dataDir:root,installer:{spoolDir}});
  for(let attempt=0;attempt<2;attempt++){
    const grouped=await adapter.readSpool(),value=reduceSession(grouped.get(session),{now:2500});
    assert.equal(value.cwd,cwd);assert.equal(value.status,'running');assert.equal(value.events,2);
  }
  const end={e:'SessionEnd',s:session,at:3000,r:'exit'};await writeFile(portable,JSON.stringify(end)+'\n');
  assert.equal(reduceSession((await adapter.readSpool()).get(session),{now:3500}).status,'ended');
  assert.equal(normalizeEvent({...first,c:'\\\\server\\share'}).cwd,null);assert.equal(normalizeEvent({...first,c:'D:\\bad\npath'}).cwd,null);
});
