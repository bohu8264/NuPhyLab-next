import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CodexKeyGestures,resolveCodexShortcut,parseMacShortcut} from '../server/codex-shortcuts.mjs';
import {describeAction} from '../server/codex.mjs';

const action=describeAction('dictation');
const legacy=[{command:'composer.startDictation',key:'Ctrl+Shift+D'},{command:'composer.startDictation',key:'F11'}];
const hold={command:'globalDictationHold',key:'Ctrl+Shift+Alt+Command+F13'};
const tap={command:'globalDictationSingleTap',key:'Ctrl+Shift+Command+F17'};
async function keymap(t){
  const home=await mkdtemp(path.join(os.tmpdir(),'nuphy-extended-keymap-')),file=path.join(home,'keybindings.json');
  t.after(()=>rm(home,{recursive:true,force:true}));
  return {file,write:entries=>writeFile(file,JSON.stringify(entries)),resolve:options=>resolveCodexShortcut(action,{codexHome:home,...options})};
}

test('parser supports only SDK-defined F13-F20 without expanding the recorder catalogue',async()=>{
  // Public HIToolbox Events.h kVK_F13...kVK_F20; verified against the local SDK.
  const expected={F13:0x69,F14:0x6B,F15:0x71,F16:0x6A,F17:0x40,F18:0x4F,F19:0x50,F20:0x5A};
  for(const [code,keyCode] of Object.entries(expected))assert.deepEqual(parseMacShortcut('Control+'+code),{code,keyCode,modifiers:['control']});
  for(const code of ['F21','F22','F23','F24','toString','constructor'])assert.equal(parseMacShortcut('Control+'+code),null);
  const catalogue=JSON.parse(await readFile(new URL('../shared/trigger-keys.json',import.meta.url),'utf8'));
  assert.ok(Object.keys(expected).every(code=>!catalogue.some(entry=>entry.code===code)),'output parsing does not expand UI capture bindings');
});

test('actual resolver prioritizes global F13 hold and F17 tap; helper sends only to fakeSend',async t=>{
  const map=await keymap(t),sent=[];
  const gestures=new CodexKeyGestures({resolve:()=>map.resolve({blockedCodes:['F11','F13','F17']}),send:async request=>{sent.push(request);return {simulated:true};}});
  t.after(()=>gestures.release());
  await map.write([...legacy,hold]);
  const resolvedHold=await map.resolve();
  assert.equal(resolvedHold.delivery,'globalHold');assert.equal(resolvedHold.keyCode,0x69);assert.equal(resolvedHold.code,'F13');
  assert.deepEqual(resolvedHold.modifiers,['control','shift','option','command']);
  assert.equal((await gestures.inspectDictation(action)).mode,'hold');
  await gestures.execute(action,{phase:'down',source:'F9'});await gestures.execute(action,{phase:'up',source:'F9'});
  assert.deepEqual(sent.map(request=>request.phase),['down','up']);assert.equal(sent[0].keyCode,0x69);
  await map.write([...legacy,hold,tap]);
  const resolvedTap=await map.resolve();
  assert.equal(resolvedTap.delivery,'globalTap');assert.equal(resolvedTap.keyCode,0x40);assert.equal(resolvedTap.code,'F17');
  assert.deepEqual(resolvedTap.modifiers,['control','shift','command']);
  assert.deepEqual(await gestures.inspectDictation(action),{mode:'toggle',accelerator:tap.key});
  await gestures.execute(action,{phase:'down',source:'F9'});await gestures.execute(action,{phase:'up',source:'F9'});
  assert.deepEqual(sent.map(request=>request.phase),['down','up','tap']);assert.equal(sent[2].keyCode,0x40);assert.equal(gestures.held,null);
  assert.equal(await readFile(map.file,'utf8'),JSON.stringify([...legacy,hold,tap]),'resolver/execution never modifies the keymap');
});

test('bare F13/F17 bindings remain blocked while modified chords can be forwarded',async t=>{
  const map=await keymap(t);
  for(const [code,command] of [['F13','globalDictationHold'],['F17','globalDictationSingleTap']]){
    await map.write([...legacy,{command,key:code}]);
    assert.equal((await map.resolve()).code,code);
    await assert.rejects(map.resolve({blockedCodes:[code]}),/冲突/);
    await map.write([...legacy,{command,key:'Control+'+code}]);
    assert.equal((await map.resolve({blockedCodes:[code]})).code,code);
  }
});

test('explicitly disabled active global bindings cannot fall back to legacy or send a key',async t=>{
  const map=await keymap(t),sent=[];
  const gestures=new CodexKeyGestures({resolve:()=>map.resolve(),send:async request=>sent.push(request)});
  for(const entries of [[...legacy,{...hold,key:null}],[...legacy,hold,tap,{...tap,key:null}]]){
    await map.write(entries);await assert.rejects(map.resolve(),/停用/);
    await assert.rejects(gestures.execute(action,{phase:'down',source:'F9'}),/停用/);
    assert.match(gestures.dictation.error,/停用/);assert.equal(gestures.held,null);
  }
  assert.equal(sent.length,0);
});
