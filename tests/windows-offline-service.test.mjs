import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';

const scene={name:'Windows 离线作品 0',colors:Array(84).fill('#123456'),animation:{effect:'static',speed:4,loop:true}};
test('real preview service preserves saved/imported works and settings across shutdown and reopen',{timeout:30000},async t=>{
  const fixture=await previewServiceFixture(t),first=await fixture.start();
  assert.equal((await first.command({op:'refreshPermissions'})).ok,true);
  assert.equal((await first.state()).desktop.host,'tauri');
  assert.equal((await first.command({op:'settings',settings:{language:'en',autoConnect:false,brightness:37}})).ok,true);
  const saved=await first.command({op:'saveScene',scene});assert.equal(saved.ok,true);
  const exported={format:'air-studio',version:1,scenes:[{...saved.result.savedScene,name:'跨平台导入 0',colors:Array(84).fill('#abcdef')}]};
  const exportFile=path.join(fixture.directory,'导出 作品.json');
  await writeFile(exportFile,JSON.stringify(exported));
  const imported=JSON.parse(await readFile(exportFile,'utf8'));
  assert.equal((await first.command({op:'importScenes',scenes:imported.scenes})).result.count,1);
  await first.close();
  const second=await fixture.start(),state=await second.state();
  assert.equal((await second.command({op:'refreshPermissions'})).ok,true);
  const restored=state.scenes.find(value=>value.id===saved.result.savedScene.id);
  assert.equal(restored.name,scene.name);assert.deepEqual(restored.colors,scene.colors);
  assert.equal(state.scenes.find(value=>value.name==='跨平台导入 0').colors[0],'#abcdef');
  assert.equal(state.settings.language,'en');assert.equal(state.settings.brightness,37);assert.equal(state.settings.autoConnect,false);
  assert.equal((await second.command({op:'deleteScene',id:restored.id})).ok,true);
  await second.close(true); // Host pipe EOF is a second independent exit path.
  const third=await fixture.start(),afterDelete=await third.state();
  assert.equal((await third.command({op:'refreshPermissions'})).ok,true);
  assert.equal(afterDelete.scenes.some(value=>value.id===restored.id),false);
  assert.equal(afterDelete.scenes.filter(value=>value.name==='跨平台导入 0').length,1);
  await third.close();
  const rows=await fixture.operations(),starts=rows.filter(row=>row.event==='started');
  assert.equal(starts.length,3,'each launch must explicitly acknowledge the pipe helper before testing exit');
  for(const start of starts){assert(rows.some(row=>row.pid===start.pid&&row.op==='quit'));assert(rows.some(row=>row.pid===start.pid&&row.event==='exited'));}
});
test('preview service exposes truthful unavailable AI state and enforces policy independently of Tauri',{timeout:15000},async t=>{
  const fixture=await previewServiceFixture(t),service=await fixture.start();
  for(const source of ['codex','claude']){
    const agent=(await service.state())[source];
    assert.equal(agent.available,false);assert.equal(agent.reasonCode,'WINDOWS_AGENT_UNAVAILABLE');
    assert.equal(agent.taskSource.available,false);assert.deepEqual(agent.tasks,[]);
    assert((agent.shortcuts??agent.commands).every(action=>action.available===false));
  }
  for(const body of [{op:'play',colors:scene.colors},{op:'codexKey',code:'F1',phase:'down'},
    {op:'claudeHookInstall'},{op:'nativePermissions',accessibility:true},
    {op:'settings',settings:{codexEnabled:true,language:'en'}}]){
    const result=await service.request('/api/command',body);
    assert.equal(result.status,400);assert.equal(result.value.ok,false);assert.match(result.value.error,/Windows/);
  }
  const state=await service.state();assert.equal(state.settings.language,'zh-CN');assert.equal(state.codex.keys.enabled,false);
  await service.close();
  const operations=await fixture.operations();
  assert(!operations.some(value=>['codexPrepare','codexControl','shortcut','paint','arm'].includes(value.op)));
});
