import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexKeyGestures} from '../server/codex-shortcuts.mjs';
import {describeAction} from '../server/codex.mjs';

const action=describeAction('dictation');
const shortcut={keyCode:2,code:'KeyD',modifiers:['control','shift'],accelerator:'Ctrl+Shift+D',delivery:'globalTap'};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('dictation inspection clears invalid accelerator and recovers without sending keys',async()=>{
  let error=null;const sent=[];
  const gestures=new CodexKeyGestures({resolve:async()=>{if(error)throw error;return shortcut;},send:async request=>sent.push(request)});
  assert.deepEqual(await gestures.inspectDictation(action),{mode:'toggle',accelerator:shortcut.accelerator});
  error=new Error('shortcut conflict');
  assert.deepEqual(await gestures.inspectDictation(action),{mode:'toggle',error:'shortcut conflict'});
  error=null;
  assert.deepEqual(await gestures.inspectDictation(action),{mode:'toggle',accelerator:shortcut.accelerator});
  assert.equal(sent.length,0);
});

test('an older failed inspection cannot overwrite a newer successful inspection',async()=>{
  const old=deferred();let calls=0;
  const gestures=new CodexKeyGestures({resolve:()=>++calls===1?old.promise:Promise.resolve(shortcut),send:async()=>{throw Error('unexpected output');}});
  const pending=gestures.inspectDictation(action);
  await gestures.inspectDictation(action);old.reject(new Error('obsolete conflict'));await pending;
  assert.deepEqual(gestures.dictation,{mode:'toggle',accelerator:shortcut.accelerator});
});

test('an older successful inspection cannot erase a newer failed inspection',async()=>{
  const old=deferred();let calls=0;
  const gestures=new CodexKeyGestures({resolve:()=>++calls===1?old.promise:Promise.reject(new Error('current conflict')),send:async()=>{}});
  const pending=gestures.inspectDictation(action);
  await gestures.inspectDictation(action);old.resolve(shortcut);await pending;
  assert.deepEqual(gestures.dictation,{mode:'hold',error:'current conflict'});
});

test('successful dictation execution invalidates older background inspections',async()=>{
  const old=deferred(),sent=[];let calls=0;
  const gestures=new CodexKeyGestures({resolve:()=>++calls===1?old.promise:Promise.resolve(shortcut),send:async request=>sent.push(request)});
  const pending=gestures.inspectDictation(action);
  await gestures.execute(action,{phase:'down',source:'button'});
  old.reject(new Error('old keymap'));await pending;
  assert.deepEqual(gestures.dictation,{mode:'toggle',accelerator:shortcut.accelerator});
  assert.deepEqual(sent.map(request=>request.phase),['tap']);
});

test('failed execution updates shortcut state immediately; output failure remains an operation error',async()=>{
  let resolveError=true,sendError=false;
  const gestures=new CodexKeyGestures({resolve:async()=>{if(resolveError)throw new Error('disabled binding');return shortcut;},send:async()=>{if(sendError)throw new Error('permission revoked');}});
  await assert.rejects(gestures.execute(action,{phase:'down'}),/disabled binding/);
  assert.equal(gestures.dictation.error,'disabled binding');
  resolveError=false;await gestures.inspectDictation(action);sendError=true;
  await assert.rejects(gestures.execute(action,{phase:'down'}),/permission revoked/);
  assert.deepEqual(gestures.dictation,{mode:'toggle',accelerator:shortcut.accelerator});
});

test('a held dictation release never resolves a changed or broken shortcut again',async()=>{
  let broken=false,resolutions=0;const sent=[];
  const gestures=new CodexKeyGestures({resolve:async()=>{resolutions++;if(broken)throw new Error('changed binding');return {...shortcut,delivery:'globalHold'};},send:async request=>sent.push(request)});
  await gestures.execute(action,{phase:'down',source:'F9'});
  broken=true;await gestures.inspectDictation(action);assert.equal(gestures.dictation.error,'changed binding');
  await gestures.execute(action,{phase:'up',source:'F8'});assert.ok(gestures.held);
  await gestures.execute(action,{phase:'up',source:'F9'});
  assert.equal(gestures.held,null);assert.equal(resolutions,2);
  assert.deepEqual(sent.map(request=>request.phase),['down','up']);
});
