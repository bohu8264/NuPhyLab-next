import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fakeService,until} from './helpers/fake-service.mjs';
import {HOOK_MARKER} from '../server/claude-hooks.mjs';
import {resolveAgentLightingView} from '../shared/agent-lighting-view.mjs';

const tasks=[{id:'a',title:'Running control',status:'running'},{id:'b',title:'Finished task',status:'completed'}];
const commands=state=>['F7','F8','F9','F10','F11','F12'].map(code=>state.colors[state.layout.find(key=>key.code===code).index]);
const isBlack=colors=>colors.every(color=>color==='#000000');
const ok=async(s,body)=>{const value=await s.command(body);assert.equal(value.ok,true,JSON.stringify(value));return value;};
async function moved(s,first) {return until(s.state,value=>JSON.stringify(commands(value))!==JSON.stringify(first),'command-key output did not move',2500);}
const hook=(service,payload)=>new Promise((resolve,reject)=>{
  const child=spawn(path.join(service.claudeHookDir,HOOK_MARKER),[service.claudeSpool],{stdio:['pipe','ignore','ignore']});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`hook exit ${code}`)));child.stdin.end(JSON.stringify(payload));
});

test('real Codex service changes keys/whole output, retains explicit follow and animates selected command keys',async t=>{
  const s=await fakeService(t,{tasks});
  await ok(s,{op:'settings',settings:{codexEnabled:true,codexLightMode:'whole',codexBrightness:100,brightness:100,codexSelectedPulse:false,codexAmbient:false,lightIdleMs:0}});
  let state=await s.state();assert.equal(state.playback.mode,'agent');assert.equal(state.device.armed,true);assert.equal(state.codex.lighting.wholeTaskId,null);assert.ok(isBlack(state.colors));
  await ok(s,{op:'settings',settings:{codexWholeTaskId:'b'}});state=await until(s.state,value=>value.colors[0]==='#00ff4c','whole-mode explicit task not rendered');
  assert.equal(new Set(state.layout.map(key=>state.colors[key.index])).size,1);
  await ok(s,{op:'settings',settings:{codexLightMode:'keys'}});state=await until(s.state,value=>value.colors[0]==='#000000'&&value.colors[1]==='#304ffe','keys mode not rendered');
  assert.equal(state.colors[2],'#00ff4c');assert.equal(state.settings.codexWholeTaskId,'b');assert.ok(isBlack(commands(state)));
  await ok(s,{op:'settings',settings:{codexAmbient:true}});state=await s.state();assert.ok(isBlack(commands(state)),'unselected ambient is deliberately dark');
  await ok(s,{op:'codexSelect',threadId:'a'});state=await until(s.state,value=>!isBlack(commands(value)),'selected ambient never lit');const first=commands(state);await moved(s,first);
  await ok(s,{op:'settings',settings:{codexAmbient:false}});await until(s.state,value=>isBlack(commands(value)),'ambient off left command lights on');
  await ok(s,{op:'settings',settings:{codexAmbient:true,codexTaskSource:'custom',slotIds:['b','','','','','']}});state=await until(s.state,value=>value.codex.slots[0]?.id==='b'&&isBlack(commands(value)),'unbound control task unexpectedly moved');
  assert.equal(state.codex.lighting.selectedId,'a');assert.equal(resolveAgentLightingView('codex',state).ambientTask,null);
  const saved=JSON.parse(await readFile(path.join(s.dataDir,'library.json'),'utf8'));assert.equal(saved.settings.codexLightMode,'keys');assert.equal(saved.settings.codexAmbient,true);assert.equal(saved.settings.codexWholeTaskId,'b');
  assert.equal((await s.operations()).filter(op=>op.op==='shortcut').length,0,'selecting control must not invoke external AI shortcuts');
});

test('sole-task automatic whole mode works, and a missing explicit task never silently changes target',async t=>{
  const s=await fakeService(t,{tasks:[tasks[0]]});
  await ok(s,{op:'settings',settings:{codexEnabled:true,codexLightMode:'whole',codexSelectedPulse:false,codexBrightness:100,brightness:100,lightIdleMs:0}});
  let state=await until(s.state,value=>value.colors[0]==='#304ffe','sole task was not followed');assert.equal(state.codex.lighting.wholeTaskId,'a');
  await ok(s,{op:'settings',settings:{codexWholeTaskId:'missing'}});state=await until(s.state,value=>isBlack(value.colors),'missing task did not stay dark');assert.equal(state.settings.codexWholeTaskId,'missing');
  await s.configure({tasks});await until(s.state,value=>value.codex.tasks.length===2,'second task not visible');assert.ok(isBlack((await s.state()).colors));
  await ok(s,{op:'settings',settings:{codexWholeTaskId:'a'}});await until(s.state,value=>value.colors[0]==='#304ffe','explicit existing task not restored');
});

test('restored, inactive static, game, zero-brightness and disconnected output retains truthful AI ownership',async t=>{
  const s=await fakeService(t,{tasks});
  await ok(s,{op:'settings',settings:{brightness:100,codexSelectedPulse:false,codexBrightness:100,lightIdleMs:0}});
  await ok(s,{op:'preview',colors:Array(84).fill('#112233')});
  await ok(s,{op:'settings',settings:{codexLightMode:'whole',codexAmbient:true}});let state=await s.state();assert.equal(state.playback.mode,'static');assert.ok(state.colors.every(color=>color==='#112233'));assert.equal(resolveAgentLightingView('codex',state).ownsOutput,false);
  await ok(s,{op:'settings',settings:{codexEnabled:true,codexWholeTaskId:'a'}});await until(s.state,value=>value.playback.mode==='static'&&value.colors[0]==='#304ffe'&&value.codex.lighting.ownsOutput,'AI overlay did not start');
  await ok(s,{op:'gameStart',gameType:'snake'});await ok(s,{op:'gamePause',paused:true});const game=await s.state();
  await ok(s,{op:'settings',settings:{codexLightMode:'keys',codexAmbient:false}});state=await s.state();assert.equal(state.playback.mode,'game');assert.deepEqual(state.colors,game.colors);assert.equal(resolveAgentLightingView('codex',state).ownsOutput,false);
  await ok(s,{op:'restore'});const before=(await s.operations()).filter(op=>['arm','paint'].includes(op.op)).length;
  await ok(s,{op:'settings',settings:{codexAmbient:true,codexLightMode:'whole'}});state=await s.state();assert.equal(state.device.armed,false);assert.equal(resolveAgentLightingView('codex',state).ownsOutput,false);assert.equal((await s.operations()).filter(op=>['arm','paint'].includes(op.op)).length,before);
  await ok(s,{op:'settings',settings:{codexEnabled:true,codexWholeTaskId:'a',brightness:0}});state=await until(s.state,value=>value.device.armed&&isBlack(value.colors),'zero brightness did not remain dark');assert.equal(state.playback.mode,'agent');
  await ok(s,{op:'settings',settings:{autoConnect:false}});await ok(s,{op:'disconnect'});const off=(await s.operations()).filter(op=>op.op==='paint').length;
  await ok(s,{op:'settings',settings:{codexLightMode:'keys',codexAmbient:false}});state=await s.state();assert.equal(state.device.connected,false);assert.equal(state.device.armed,false);assert.equal((await s.operations()).filter(op=>op.op==='paint').length,off);
});

test('unsupported firmware preserves preferences without arming or sending per-key lights',async t=>{
  const s=await fakeService(t,{modelId:'kick75',firmwareVersion:'4.0.15.6',compatible:false,mainWholeZone:true,functionKeyAdaptation:false,tasks});
  const before=(await s.operations()).filter(op=>['arm','paint'].includes(op.op)).length;
  await ok(s,{op:'settings',settings:{codexEnabled:true,codexLightMode:'whole',codexAmbient:true}});const state=await s.state();assert.equal(state.device.capabilities.perKey,false);assert.equal(state.device.armed,false);assert.equal(resolveAgentLightingView('codex',state).blockedReason,'unsupported');assert.equal((await s.operations()).filter(op=>['arm','paint'].includes(op.op)).length,before);
});

test('real Claude hook service and source selection use the same whole/ambient rules without external actions',async t=>{
  const s=await fakeService(t,{tasks});await mkdir(s.claudeDir,{recursive:true});await writeFile(path.join(s.claudeDir,'settings.json'),'{"model":"keep"}');await ok(s,{op:'claudeHookInstall'});
  await hook(s,{hook_event_name:'UserPromptSubmit',session_id:'c-a',cwd:'/isolated/a'});await hook(s,{hook_event_name:'Stop',session_id:'c-b',cwd:'/isolated/b'});
  await until(s.state,value=>value.claude.tasks.length===2,'Claude sessions not visible');
  await ok(s,{op:'settings',settings:{agentSource:'claude',claudeEnabled:true,claudeLightMode:'whole',claudeBrightness:100,brightness:100,claudeSelectedPulse:false,lightIdleMs:0}});
  let state=await s.state();assert.ok(isBlack(state.colors),'two unselected Claude sessions must not auto-follow');assert.equal(resolveAgentLightingView('codex',state).ownsOutput,false);assert.equal(resolveAgentLightingView('claude',state).ownsOutput,true);
  await ok(s,{op:'settings',settings:{claudeWholeTaskId:'c-a'}});await until(s.state,value=>value.colors[0]==='#304ffe','Claude whole target not rendered');
  await ok(s,{op:'settings',settings:{claudeLightMode:'keys',claudeAmbient:true,claudeTaskSource:'custom',claudeSlotIds:['c-a','c-b','','','','']}});
  await ok(s,{op:'claudeSelect',sessionId:'c-a'});state=await until(s.state,value=>!isBlack(commands(value)),'Claude selected ambient not lit');await moved(s,commands(state));
  await ok(s,{op:'settings',settings:{claudeAmbient:false}});await until(s.state,value=>isBlack(commands(value)),'Claude ambient off failed');
  const saved=JSON.parse(await readFile(path.join(s.dataDir,'library.json'),'utf8'));assert.equal(saved.settings.claudeLightMode,'keys');assert.equal(saved.settings.claudeWholeTaskId,'c-a');assert.equal(saved.settings.claudeAmbient,false);
  assert.equal((await s.operations()).filter(op=>op.op==='claudeExternalAction'||op.op==='shortcut').length,0);
});
