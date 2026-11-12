import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVMEnvironment,walkAll,textOf} from './helpers/source-ui-vm.mjs';
import * as firmware from '../shared/firmware-onboarding.mjs';
import * as power from '../shared/lighting-power.mjs';

const stub=name=>Object.defineProperty(()=>null,'name',{value:name});
for(const language of ['zh-CN','en'])test(`merged About & updates keeps legacy links, firmware notification and help in ${language}`,async t=>{
 const UpdatePreferences=stub('UpdatePreferences'),Modal=stub('Modal');
 const ui=createVMEnvironment({
  'lucide-react':{},'./AmbientLightingPreferences':{AmbientLightingPreferences:()=>null},'./SelectionLab':{SelectionAPISettings:stub('SelectionAPISettings'),SelectionPermissionSettings:stub('SelectionPermissionSettings')},'./primitives':{Button:stub('Button'),Modal,Switch:stub('Switch'),run:value=>value},
  './DurationField':{DurationField:stub('DurationField')},'../../shared/lighting-power.mjs':power,
  './StartupGuide':{useStartupCopy:()=> (zh,en)=>language==='en'?en:zh,OFFICIAL_DRIVER_URL:'https://drive.nuphyio.com/#/setting'},
  './i18n':{useLanguage:()=>language,t:value=>value},'../../package.json':{default:{version:'fixture-version'}},
  './api':{readAppState:async()=>null},'./connection-copy-v7':{connectionCopy:()=>''},
  './UpdatePreferences':{UpdatePreferences},'../../shared/firmware-onboarding.mjs':firmware,
 });
 const source=new URL('../ui/src/Settings.tsx',import.meta.url),dir=await mkdtemp(path.join(tmpdir(),'nuphy-settings-merge-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'Settings.tsx');
 await writeFile(file,(await readFile(source,'utf8')).replaceAll('import.meta.url',JSON.stringify(source.href)));
 const Settings=(await ui.load(file)).exports.Settings;
 const state={settings:{language},build:{version:'1.2.15',platform:'darwin',arch:'arm64'},playback:{mode:'idle'},
  device:{connected:true,modelId:'air75-v3',firmware:'1.0.16.6'},
  firmware:{modelId:'air75-v3',modelName:'Air75 V3',current:'1.0.16.6',latest:'1.0.23.6',latestConfirmed:true,updateAvailable:true,status:'updateAvailable',stale:false}};
 const command=async()=>{};
 const parent=ui.mount(Settings,{state,command,initialTab:'updates'});
 t.after(()=>parent.unmount());
 const tabs=()=>walkAll(parent.tree,n=>n.props?.role==='tab');
 assert.equal(tabs().length,5);
 assert.equal(tabs().filter(n=>textOf(n)===(language==='en'?'About & updates':'关于与更新')).length,1);
 assert.equal(tabs().find(n=>n.props['aria-selected']).props.id,'settings-tab-about');
 assert.equal(walkAll(parent.tree,n=>n.props?.className==='settings-update-dot').length,1);
 const aboutNode=walkAll(parent.tree,n=>n.type?.name==='AboutPreferences')[0];
 const about=ui.mount(aboutNode.type,aboutNode.props);t.after(()=>about.unmount());
 const updates=walkAll(about.tree,n=>n.type===UpdatePreferences);
 assert.equal(updates.length,1);assert.equal(updates[0].props.command,command);assert.equal(updates[0].props.state,state);
 const links=walkAll(about.tree,n=>n.type==='button');
 assert.deepEqual(links.map(textOf),language==='en'?['Help','Open-source licenses','Diagnostics']:['使用帮助','开源许可','诊断详情']);
 links[0].props.onClick();await ui.settle(about);
 const modal=walkAll(about.tree,n=>n.type===Modal)[0];
 assert.equal(modal.props.title,language==='en'?'Help':'使用帮助');
 modal.props.onClose();await ui.settle(about);assert.equal(walkAll(about.tree,n=>n.type===Modal).length,0);
 tabs()[0].props.onClick();parent.render();assert.equal(tabs().find(n=>n.props['aria-selected']).props.id,'settings-tab-general');
 const languages=walkAll(parent.tree,n=>n.type==='option');
 assert.deepEqual(languages.map(textOf),['简体中文','English']);
 assert.deepEqual(languages.map(n=>n.props.value),['zh-CN','en']);
 parent.update({state,command,initialTab:'about'});assert.equal(tabs().find(n=>n.props['aria-selected']).props.id,'settings-tab-about');
 state.firmware.stale=true;parent.render();assert.equal(walkAll(parent.tree,n=>n.props?.className==='settings-update-dot').length,0);
 if(language==='en'){assert.doesNotMatch(textOf(parent.tree),/[\u3400-\u9fff]/);assert.doesNotMatch(textOf(about.tree),/[\u3400-\u9fff]/);}
});
