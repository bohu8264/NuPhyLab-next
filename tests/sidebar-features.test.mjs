import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store,validateSettings} from '../server/storage.mjs';
import {DEFAULT_SIDEBAR_FEATURES,FEATURE_IDS} from '../shared/sidebar-features.mjs';
import {fakeService} from './helpers/fake-service.mjs';
import {appDraftFixture} from './helpers/app-draft-fixture.mjs';
const temp=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'lab-features-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
test('fresh profile has three entries; an explicitly empty sidebar survives restart',async t=>{
 const dir=await temp(t),store=await new Store(dir).load();assert.deepEqual(store.data.settings.sidebarFeatures,DEFAULT_SIDEBAR_FEATURES);
 await store.settings({sidebarFeatures:[]});assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures,[]);
 await store.settings({sidebarFeatures:['keyboard-pocket','studio']});assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures,['keyboard-pocket','studio']);
 for(const invalid of [null,'studio',['invalid'],['studio','studio'],Array(10).fill('studio')])assert.throws(()=>validateSettings({sidebarFeatures:invalid}));
});
test('legacy migration keeps active tools and saved music without rewriting their data; explicit removals are not re-added',async t=>{
 const dir=await temp(t);await mkdir(path.join(dir,'keyboard-pocket'));await mkdir(path.join(dir,'music-works'));
 const files={'library.json':{version:1,scenes:[],settings:{language:'en',codexEnabled:true},gameBestScores:{snake:10}},'selection-preferences.json':{enabled:true,actions:['reply']},'typing-sound-preferences.json':{enabled:true,volume:41},'keyboard-pocket/pockets.json':{slots:[{id:'user-file'}]},'music-works/test.json':{userWork:'not read by navigation'},'drag-convert.json':{enabled:true}};
 for(const [file,data] of Object.entries(files))await writeFile(path.join(dir,file),JSON.stringify(data));
 const before=await Promise.all(Object.keys(files).map(file=>readFile(path.join(dir,file))));const store=await new Store(dir).load();
 assert.deepEqual(store.data.settings.sidebarFeatures,FEATURE_IDS);assert.equal(store.data.settings.language,'en');assert.equal(store.data.settings.codexEnabled,true);
 for(const [i,file] of Object.keys(files).entries())assert.deepEqual(await readFile(path.join(dir,file)),before[i]);
 await store.settings({sidebarFeatures:['library']});assert.deepEqual((await new Store(dir).load()).data.settings.sidebarFeatures,['library']);
 for(const [i,file] of Object.keys(files).entries())if(file!=='library.json')assert.deepEqual(await readFile(path.join(dir,file)),before[i]);
});
test('sidebar-only settings do not touch hardware, release AI keys, reset playback or modify works',async t=>{
 const s=await fakeService(t,{freshLibrary:true,storedSettings:{sidebarFeatures:['studio','library','codex']}});await s.command({op:'preview',colors:Array(84).fill('#445566')});const before=await s.state(),ops=(await s.operations()).length;
 assert.equal((await s.command({op:'settings',settings:{sidebarFeatures:[]}})).ok,true);const after=await s.state();
 assert.deepEqual(after.playback,before.playback);assert.deepEqual(after.scenes,before.scenes);assert.deepEqual(after.colors,before.colors);assert.deepEqual(after.settings.sidebarFeatures,[]);
 const writes=(await s.operations()).slice(ops).filter(x=>!['status','input','pollInput','systemIdle','bluetoothDevices'].includes(x.op));assert.deepEqual(writes,[]);
 const start=(await s.operations()).length;const invalid=await s.command({op:'settings',settings:{sidebarFeatures:['music'],brightness:18}});assert.equal(invalid.ok,false);assert.deepEqual((await s.operations()).slice(start).filter(x=>!['status','input','pollInput','systemIdle','bluetoothDevices'].includes(x.op)),[]);assert.deepEqual((await s.state()).settings.sidebarFeatures,[]);
});
test('a native-only old profile keeps active entries without a lighting library',async t=>{
 const dir=await temp(t);await mkdir(path.join(dir,'music-works'));
 const prefs=JSON.stringify({enabled:true,hotkey:'Control'});await writeFile(path.join(dir,'selection-preferences.json'),prefs);await writeFile(path.join(dir,'music-works/old.json'),'original music');
 const store=await new Store(dir).load();assert.deepEqual(store.data.settings.sidebarFeatures,['studio','library','codex','music','selection-question']);
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
 assert.deepEqual(f.state.settings.sidebarFeatures,['library','codex']);assert(!f.button('灯光创作'));assert(f.child('FeatureCenter'));
 f.child('FeatureCenter').props.onToggle('music');await f.flush();assert(f.button('演奏模式'));f.unmount();
 const empty=await appDraftFixture({state:{settings:{sidebarFeatures:[]}}});assert(empty.child('FeatureCenter'));assert(empty.button('功能中心'));assert(empty.button('设备'));assert(empty.button('设置'));assert(!empty.button('作品库'));empty.unmount();
});
