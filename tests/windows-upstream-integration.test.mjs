import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePreviewCommand} from '../server/platform/preview-policy.mjs';
import {getKeyboardProfile} from '../shared/keyboard-models.mjs';
import {deviceModels} from '../scripts/windows/prepare.mjs';
import {windowsLightingPolicy,windowsBoardSleepSupported} from '../shared/windows-lighting-firmware.mjs';
import {appDraftFixture} from './helpers/app-draft-fixture.mjs';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';
const animation={effect:'static',direction:'right',speed:4,loop:true};
test('official editor metadata works in qualified Windows playback without accepting native paths or invalid ownership',()=>{
 const body={op:'preview',colors:Array(84).fill('#123456'),animation,editorId:'new-official-editor',connectionSessionId:'probe:1'};
 assert.doesNotThrow(()=>validatePreviewCommand(body,{lightingAvailable:true}));
 assert.doesNotThrow(()=>validatePreviewCommand({...body,op:'play'},{lightingAvailable:true}));
 assert.doesNotThrow(()=>validatePreviewCommand({op:'endEditorLighting',editorId:body.editorId}));
 for(const patch of [{path:'C:/other'},{editorId:{}},{editorId:'x'.repeat(81)},{connectionSessionId:{}}])
  assert.throws(()=>validatePreviewCommand({...body,...patch},{lightingAvailable:true}));
 assert.throws(()=>validatePreviewCommand({op:'endEditorLighting',editorId:''}));
});
test('Windows feature membership accepts supported tools and rejects unported native tools',()=>{
 assert.doesNotThrow(()=>validatePreviewCommand({op:'settings',settings:{sidebarFeatures:['studio','library','codex','game']}}));
 for(const ids of [['studio','screen-replay'],['dock-scenes'],['music'],['studio','studio']])
  assert.throws(()=>validatePreviewCommand({op:'settings',settings:{sidebarFeatures:ids}}));
});
test('Mac firmware defaults and Windows restoration qualifications remain independent',()=>{
 assert.equal(getKeyboardProfile('air75-v3').qualifiedFirmware,'2.0.0.7');
 assert.equal(deviceModels().find(p=>p.id==='air75-v3').qualifiedFirmware,'1.0.23.6');
 assert.equal(windowsLightingPolicy('air75-v3','2.0.0.7'),'air75-v3-2.0.0.7');
 assert.equal(windowsBoardSleepSupported('air75-v3','2.0.0.7'),false);
 assert.equal(windowsBoardSleepSupported('air75-v3','1.0.23.6'),true);
 assert.equal(windowsLightingPolicy('air75-v3','2.0.0.8'),null);
});
test('Windows official shell filters Mac-only tools and saves feature membership without Swift calls',async()=>{
 const f=await appDraftFixture({tauri:true,state:{desktop:{host:'tauri',capabilities:{}},settings:{language:'zh-CN',sidebarFeatures:['studio','library','codex','screen-replay']}},
  onNativeCodexRequest:async()=>{throw Error('Unexpected Swift request');}});
 try{
  assert(!f.button('刚刚怎么了'));
  await f.click('功能中心');
  assert.deepEqual([...f.child('FeatureCenter').props.available],['studio','library','codex','game']);
  f.child('FeatureCenter').props.onToggle('game');await f.flush();
  assert(f.button('灯光游戏'));assert.deepEqual(f.state.settings.sidebarFeatures,['studio','library','codex','game']);
  await f.click('作品库');assert.equal(f.child('Library').props.musicAvailable,false);
 }finally{f.unmount();}
});
test('new official editor ownership is admitted by the real isolated Windows service and invalid membership preserves settings',async t=>{
 const fixture=await previewServiceFixture(t,{connected:true,identityQualification:{status:'qualified',source:'embeddedUsbSerial',reasonCode:null}});
 const s=await fixture.start();assert.equal((await s.command({op:'connect'})).ok,true);
 const state=await s.state(),editorId='official-editor-1';
 assert.equal((await s.command({op:'preview',colors:Array(84).fill('#123456'),animation,editorId,connectionSessionId:state.device.connectionSessionId})).ok,true);
 assert.equal((await s.state()).playback.editorId,editorId);
 assert.equal((await s.command({op:'endEditorLighting',editorId})).ok,true);
 assert.equal((await s.state()).playback.editorId,undefined);
 assert.equal((await s.command({op:'settings',settings:{sidebarFeatures:['studio','library','codex','game']}})).ok,true);
 assert.equal((await s.command({op:'settings',settings:{sidebarFeatures:['screen-replay']}})).ok,false);
 assert.deepEqual((await s.state()).settings.sidebarFeatures,['studio','library','codex','game']);
 await s.close();assert.equal(s.hostMessages.at(-1).keyboardVerified,true);
});

import {createVMEnvironment,walkAll,plain} from './helpers/source-ui-vm.mjs';
const stub=()=>null;
test('actual feature center retains all Mac tools while Windows lists only implemented tools',async()=>{
 const ui=createVMEnvironment({'lucide-react':new Proxy({},{get:()=>stub}),'./i18n':{useLanguage:()=> 'en'}});
 const FeatureCenter=(await ui.load(new URL('../ui/src/FeatureCenter.tsx',import.meta.url))).exports.FeatureCenter;
 const props={added:[],busy:false,onToggle:stub,onOpen:stub,available:['studio','library','codex','game']};
 const panel=ui.mount(FeatureCenter,props);
 assert.deepEqual(plain(walkAll(panel.tree,n=>n.type==='article').map(n=>n.props['data-feature'])),props.available);
 panel.update({...props,available:undefined});
 assert(walkAll(panel.tree,n=>n.props['data-feature']==='screen-replay').length);
 assert(walkAll(panel.tree,n=>n.props['data-feature']==='dock-scenes').length);
 panel.unmount();
});
test('Windows unified library never mounts native music tools and Mac keeps them',async()=>{
 const Library=()=>null,MusicWorks=()=>null;
 const ui=createVMEnvironment({'lucide-react':new Proxy({},{get:()=>stub}),
  './Library':{Library},'./music/MusicWorks':{MusicWorks},
  './music/model':{initialSession:()=>({})},'./music/client':{withNewId:v=>v},
  './i18n':{useLanguage:()=> 'en',t:v=>v},'./presets':{presetCatalog:()=>[]},
  './Keyboard':{Keyboard:stub},'../../shared/render-animation.mjs':{applyArtworkAppearance:v=>v},
  './primitives':{Button:stub,Modal:stub}});
 const UnifiedLibrary=(await ui.load(new URL('../ui/src/UnifiedLibrary.tsx',import.meta.url))).exports.UnifiedLibrary;
 const props={musicAvailable:false,filter:'all',source:'presets',onSource:stub,onFilter:stub,
  lightingAdded:true,musicAdded:false,onMusicEdit:stub,layout:[],state:{scenes:[]}};
 const panel=ui.mount(UnifiedLibrary,props);
 assert.equal(walkAll(panel.tree,n=>n.type===MusicWorks).length,0);
 panel.update({...props,musicAvailable:true});
 assert.equal(walkAll(panel.tree,n=>n.type===MusicWorks).length,1);
 panel.unmount();
});
