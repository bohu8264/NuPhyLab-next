import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store,validateSettings} from '../server/storage.mjs';
import {DEFAULT_SIDEBAR_FEATURES} from '../shared/sidebar-features.mjs';
import {fakeService} from './helpers/fake-service.mjs';
import {appDraftFixture} from './helpers/app-draft-fixture.mjs';
const temp=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'lab-features-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
test('fresh profiles get four ordered entries and upgrades retain explicitly saved sidebars',async t=>{
 const dir = await temp(t);
 const store = await new Store(dir).load();
 const defaults = ['studio','key-buddy','codex','library'];
 assert.deepEqual(store.data.settings.sidebarFeatures, defaults);
 assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures, defaults);
 for (const saved of [[], ['studio','library','codex'], ['keyboard-pocket','studio'], ['library','key-buddy','codex','studio']]) {
   await store.settings({sidebarFeatures:saved});
   assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures, saved);
 }
 for(const invalid of [null,'studio',['invalid'],['studio','studio'],Array(10).fill('studio')])assert.throws(()=>validateSettings({sidebarFeatures:invalid}));
});
test('legacy migration keeps active tools and saved music without rewriting their data; explicit removals are not re-added',async t=>{
 const dir=await temp(t);await mkdir(path.join(dir,'keyboard-pocket'));await mkdir(path.join(dir,'voice-input'));await mkdir(path.join(dir,'music-works'));
 const files={'dock-scenes-shortcuts.json':true,'voice-input/settings.json':{shortcutKeyCode:61},'library.json':{version:1,scenes:[],settings:{language:'en',codexEnabled:true},gameBestScores:{snake:10}},'selection-preferences.json':{enabled:true,actions:['reply']},'typing-sound-preferences.json':{enabled:true,volume:41},'keyboard-pocket/pockets.json':{slots:[{id:'user-file'}]},'music-works/test.json':{userWork:'not read by navigation'},'drag-convert.json':{enabled:true}};
 for(const [file,data] of Object.entries(files))await writeFile(path.join(dir,file),JSON.stringify(data));
 const before=await Promise.all(Object.keys(files).map(file=>readFile(path.join(dir,file))));const store=await new Store(dir).load();
 assert.deepEqual(store.data.settings.sidebarFeatures,[...DEFAULT_SIDEBAR_FEATURES,'game','typing-sounds','music','selection-question','drag-convert','keyboard-pocket','voice-input','dock-scenes']);assert.equal(store.data.settings.language,'en');assert.equal(store.data.settings.codexEnabled,true);
 for(const [i,file] of Object.keys(files).entries())assert.deepEqual(await readFile(path.join(dir,file)),before[i]);
 await store.settings({sidebarFeatures:['library']});assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures,['library']);
 for(const [i,file] of Object.keys(files).entries())if(file!=='library.json')assert.deepEqual(await readFile(path.join(dir,file)),before[i]);
});
test('removing a running lighting feature stops output and preserves works; additions are inert',async t=>{
 const s=await fakeService(t,{freshLibrary:true,storedSettings:{sidebarFeatures:['studio','library','codex']}});await s.command({op:'preview',colors:Array(84).fill('#445566')});const before=await s.state(),ops=(await s.operations()).length;
 assert.equal((await s.command({op:'settings',settings:{sidebarFeatures:[]}})).ok,true);const after=await s.state();
 assert.equal(after.playback.mode,"idle");assert.equal(after.playback.playing,false);assert.deepEqual(after.scenes,before.scenes);assert.deepEqual(after.settings.sidebarFeatures,[]);
 const writes=(await s.operations()).slice(ops).filter(x=>!['status','input','pollInput','systemIdle','bluetoothDevices'].includes(x.op));assert(writes.some(x=>x.op==="restore"));
 const addStart=(await s.operations()).length;await s.command({op:"settings",settings:{sidebarFeatures:["studio","codex","music"]}});assert.equal((await s.state()).playback.mode,"idle");assert.deepEqual((await s.operations()).slice(addStart).filter(x=>!["status","input","pollInput","systemIdle","bluetoothDevices"].includes(x.op)),[]);
 const start=(await s.operations()).length;const invalid=await s.command({op:'settings',settings:{sidebarFeatures:['music'],brightness:18}});assert.equal(invalid.ok,false);assert.deepEqual((await s.operations()).slice(start).filter(x=>!['status','input','pollInput','systemIdle','bluetoothDevices'].includes(x.op)),[]);assert.deepEqual((await s.state()).settings.sidebarFeatures,["studio","codex","music"]);
});
test('a native-only old profile keeps active entries without a lighting library',async t=>{
 const dir=await temp(t);await mkdir(path.join(dir,'music-works'));
 const prefs=JSON.stringify({enabled:true,hotkey:'Control'});await writeFile(path.join(dir,'selection-preferences.json'),prefs);await writeFile(path.join(dir,'music-works/old.json'),'original music');
 const store=await new Store(dir).load();assert.deepEqual(store.data.settings.sidebarFeatures,[...DEFAULT_SIDEBAR_FEATURES,'music','selection-question']);
 await assert.rejects(readFile(path.join(dir,'library.json')),e=>e.code==='ENOENT');
 await store.settings({sidebarFeatures:[]});assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures,[]);
 assert.equal(await readFile(path.join(dir,'selection-preferences.json'),'utf8'),prefs);
 await assert.rejects(store.settings({sidebarFeatures:['music'],brightness:55}),/单独保存/);assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures,[]);
 await store.settings({brightness:66});const disk=JSON.parse(await readFile(path.join(dir,'library.json'),'utf8'));assert.equal(disk.settings.brightness,66);assert(!Object.hasOwn(disk.settings,'sidebarFeatures'));assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures,[]);
});
test('a late add-editor response cannot override a newer sidebar selection',async()=>{
 let finish;const gate=new Promise(r=>finish=r);const f=await appDraftFixture({state:{settings:{sidebarFeatures:['library']}},onCommand:async(body,{state})=>{if(body.op==='settings'){await gate;Object.assign(state.settings,body.settings);}return {ok:true};}});
 await f.click('作品库');const open=f.child('Library').props.onMusicEdit({requestId:'later',session:{}});await Promise.resolve();await f.click('设备');finish();await open;await f.flush();assert(f.child('Device'));assert(!f.child('MusicLab'));f.unmount();
});
test('App removes even default entries and reopens into Feature Center when no studio entry is selected',async()=>{
 const f=await appDraftFixture();await f.click('功能中心');const center=f.child('FeatureCenter');assert(center);center.props.onToggle('studio');await f.flush();
 assert.deepEqual(f.state.settings.sidebarFeatures,['key-buddy','codex','library']);assert(!f.button('灯光创作'));assert(f.child('FeatureCenter'));
 f.child('FeatureCenter').props.onToggle('music');await f.flush();assert(f.button('演奏模式'));f.unmount();
 const empty=await appDraftFixture({state:{settings:{sidebarFeatures:[]}}});assert(empty.child('FeatureCenter'));assert(empty.button('功能中心'));assert(empty.button('设备'));assert(empty.button('设置'));assert(!empty.button('作品库'));empty.unmount();
});

test('hidden AI modes are persistently off after removal, stale enables, re-add and legacy restart',async t=>{
 const dir=await temp(t),store=await new Store(dir).load();
 await store.settings({codexEnabled:true,claudeEnabled:true,brightness:47});
 await store.settings({sidebarFeatures:['studio','library']});
 assert.equal(store.data.settings.codexEnabled,false);assert.equal(store.data.settings.claudeEnabled,false);
 await store.settings({codexEnabled:true});assert.equal(store.data.settings.codexEnabled,false);
 await store.settings({sidebarFeatures:['studio','library','codex']});
 const reopened=await new Store(dir).load();assert.equal(reopened.data.settings.codexEnabled,false);assert.equal(reopened.data.settings.claudeEnabled,false);assert.equal(reopened.data.settings.brightness,47);
 await reopened.settings({codexEnabled:true});assert.equal(reopened.data.settings.codexEnabled,true);
 await writeFile(path.join(dir,'sidebar-features.json'),'[]');
 const upgraded=await new Store(dir).load();assert.equal(upgraded.data.settings.codexEnabled,false);
 assert.equal(JSON.parse(await readFile(path.join(dir,'library.json'),'utf8')).settings.codexEnabled,false);
});
test('removing AI Assistant releases its F-key ownership and re-add does not restart it',async t=>{
 const s=await fakeService(t,{storedSettings:{codexEnabled:true,sidebarFeatures:['studio','library','codex']}});
 await s.command({op:'settings',settings:{sidebarFeatures:['studio','library']}});
 const after=await s.state();assert.equal(after.settings.codexEnabled,false);assert.equal(after.settings.claudeEnabled,false);assert.notEqual(after.playback.mode,'agent');assert.equal(after.codex.keys.enabled,false);
 await s.command({op:'settings',settings:{sidebarFeatures:['studio','library','codex']}});
 const added=await s.state();assert.equal(added.settings.codexEnabled,false);assert.equal(added.codex.keys.enabled,false);
});

test('a partial sidebar/off write cannot resurrect AI when re-added',async t=>{
 const dir=await temp(t),store=await new Store(dir).load();await store.settings({codexEnabled:true});
 const commit=store.commit.bind(store);store.commit=async()=>{throw new Error('isolated disk failure');};
 await assert.rejects(store.settings({sidebarFeatures:[]}),/disk failure/);
 assert.equal(store.data.settings.codexEnabled,false);assert.deepEqual(JSON.parse(await readFile(path.join(dir,'sidebar-features.json'),'utf8')),[]);
 await assert.rejects(store.settings({sidebarFeatures:['codex']}),/disk failure/);
 assert.deepEqual(JSON.parse(await readFile(path.join(dir,'sidebar-features.json'),'utf8')),[]);
 store.commit=commit;await store.settings({sidebarFeatures:['codex']});
 assert.equal((await new Store(dir).load()).data.settings.codexEnabled,false);
});

test('startup retains a safe off runtime while an off-switch write is temporarily unavailable',async t=>{
 const dir=await temp(t),store=await new Store(dir).load();await store.settings({codexEnabled:true});await writeFile(path.join(dir,'sidebar-features.json'),'[]');
 const broken=new Store(dir);broken.commit=async()=>{throw new Error('disk unavailable')};await broken.load();
 assert.equal(broken.data.settings.codexEnabled,false);assert(broken.warning);assert(broken.pendingFeatureOffCommit);
 await assert.rejects(broken.settings({sidebarFeatures:['codex']}),/disk unavailable/);
});
test('native ON files must be durably off before a hidden tool can be added, including after restart',async t=>{
 const dir=await temp(t);await writeFile(path.join(dir,'sidebar-features.json'),'[]');await writeFile(path.join(dir,'drag-convert.json'),JSON.stringify({enabled:true,trigger:'shift'}));
 let store=await new Store(dir).load();await assert.rejects(store.settings({sidebarFeatures:['drag-convert']}),/尚未完成关闭/);
 store=await new Store(dir).load();await assert.rejects(store.settings({sidebarFeatures:['drag-convert']}),/尚未完成关闭/);
 await writeFile(path.join(dir,'drag-convert.json'),JSON.stringify({enabled:false,trigger:'shift'}));await store.settings({sidebarFeatures:['drag-convert']});assert.deepEqual(store.data.settings.sidebarFeatures,['drag-convert']);
});
test('delayed activation requests cannot restart removed lighting tools or games',async t=>{
 const s=await fakeService(t,{storedSettings:{sidebarFeatures:['studio','library','codex','game']}});
 await s.command({op:'settings',settings:{sidebarFeatures:['library']}});
 for(const req of [{op:'nativeLighting',mode:1},{op:'audioStart'},{op:'gameStart',gameType:'snake'},{op:'play',colors:Array(84).fill('#334455'),animation:{effect:'static'}},{op:'preview',colors:Array(84).fill('#334455')}]) {
  const result=await s.command(req);assert.equal(result.ok,false);assert.equal((await s.state()).playback.mode,'idle');
 }
});

test('legacy native settings without enabled use the same off default when re-added',async t=>{
 const dir=await temp(t);await mkdir(path.join(dir,'keyboard-pocket'));await writeFile(path.join(dir,'sidebar-features.json'),'[]');await writeFile(path.join(dir,'keyboard-pocket/settings.json'),JSON.stringify({previewEnabled:true}));
 const store=await new Store(dir).load();await store.settings({sidebarFeatures:['keyboard-pocket']});assert.deepEqual(store.data.settings.sidebarFeatures,['keyboard-pocket']);
});

test('removing Color Picker preserves its shortcut and requires a durable off switch before re-add',async t=>{
 const dir=await temp(t);
 await writeFile(path.join(dir,'sidebar-features.json'),'[]');
 const file=path.join(dir,'color-picker.json');
 const shortcuts=[{keyCode:0,modifiers:0,mouseButton:4}];
 await writeFile(file,JSON.stringify({enabled:true,shortcuts}));
 const store=await new Store(dir).load();
 assert(!store.data.settings.sidebarFeatures.includes('color-picker'));
 await assert.rejects(store.settings({sidebarFeatures:['color-picker']}),/尚未完成关闭/);
 await writeFile(file,JSON.stringify({enabled:false,shortcuts}));
 await store.settings({sidebarFeatures:['color-picker']});
 assert.deepEqual(JSON.parse(await readFile(file)),{enabled:false,shortcuts});
});

test('R54 sidebar drops only the retired tool and persists the remaining order on reopen', async t => {
  for (const [before, expected] of [
    [['desktop-shelf','keyboard-click'],['desktop-shelf']],
    [['keyboard-click'],[]],
    [['codex','desktop-shelf','keyboard-click','studio'],['codex','desktop-shelf','studio']],
  ]) {
    const dir = await temp(t), file = path.join(dir, 'sidebar-features.json');
    await writeFile(file, JSON.stringify(before));
    assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures, expected);
    assert.deepEqual(JSON.parse(await readFile(file)), expected);
    assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures, expected);
  }
  assert.throws(() => validateSettings({sidebarFeatures:['keyboard-click']}));
});
test('R54 library-only sidebar migrates to the dedicated file and keeps the library readable', async t => {
  const dir = await temp(t);
  const library = JSON.stringify({version:1,scenes:[],settings:{language:'en',sidebarFeatures:['keyboard-click','desktop-shelf']}});
  await writeFile(path.join(dir, 'library.json'), library);
  const store = await new Store(dir).load();
  assert.equal(store.data.settings.language, 'en');
  assert.equal(store.warning, null);
  assert.deepEqual(store.data.settings.sidebarFeatures, ['desktop-shelf']);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'sidebar-features.json'))), ['desktop-shelf']);
  assert.equal(await readFile(path.join(dir,'library.json'),'utf8'), library);
});
