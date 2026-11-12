import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVMEnvironment,walkAll,textOf,plain} from './helpers/source-ui-vm.mjs';
import * as power from '../shared/lighting-power.mjs';
import * as firmwareOnboarding from '../shared/firmware-onboarding.mjs';

const stub=name=>Object.defineProperty(()=>null,'name',{value:name});
async function fixture(language='zh-CN'){
 const commands=[],Button=stub('Button');
 const ui=createVMEnvironment({
  'lucide-react':{},'./AmbientLightingPreferences':{AmbientLightingPreferences:()=>null},'./SelectionLab':{SelectionAPISettings:stub('SelectionAPISettings'),SelectionPermissionSettings:stub('SelectionPermissionSettings')},'./primitives':{Button,Modal:stub('Modal'),Switch:stub('Switch'),run:value=>value},
  './DurationField':{DurationField:stub('DurationField')},'../../shared/lighting-power.mjs':power,
  './StartupGuide':{useStartupCopy:()=> (zh,en)=>language==='en'?en:zh,OFFICIAL_DRIVER_URL:'https://drive.nuphyio.com/#/setting'},'./codexKeys':{nativeCodexKeys:async()=>false},
  './i18n':{useLanguage:()=>language,t:value=>value},'../../package.json':{version:'fixture'},'./api':{readAppState:async()=>null},
  './connection-copy-v7':{connectionCopy:value=>String(value??'')},
  './UpdatePreferences':{UpdatePreferences:stub('UpdatePreferences')},'../../shared/firmware-onboarding.mjs':firmwareOnboarding,
 });
 const sourceURL=new URL('../ui/src/Settings.tsx',import.meta.url),directory=await mkdtemp(path.join(tmpdir(),'nuphy-timer-ui-'));
 let Settings;
 try{
  const file=path.join(directory,'Settings.tsx');
  // The isolated CommonJS VM needs a literal for module metadata. Timer code
  // and its dependencies are otherwise the actual production source.
  await writeFile(file,(await readFile(sourceURL,'utf8')).replaceAll('import.meta.url',JSON.stringify(sourceURL.href)));
  Settings=(await ui.load(file)).exports.Settings;
 }finally{await rm(directory,{recursive:true,force:true});}
 const state={settings:{lightDurationMs:7200000,lightIdleMs:3600000,brightness:89},device:{armed:true,connected:true,modelId:'air75-v3'},
  lightPower:{sleeping:false,reason:null,remainingMs:7200000,idleMs:0}};
 const command=async body=>{commands.push(plain(body));return{};};
 const parent=ui.mount(Settings,{state,command,initialTab:'lighting'});
 const child=walkAll(parent.tree,node=>node.type?.name==='LightingPreferences')[0];
 const instance=ui.mount(child.type,child.props);
 return{ui,state,parent,instance,commands,Button,close(){instance.unmount();parent.unmount();}};
}
for(const language of ['zh-CN','en'])test(`actual lighting preferences show the earlier idle deadline in ${language} and save the two settings independently`,async()=>{
 const f=await fixture(language),text=textOf(f.instance.tree);
 assert.ok(text.includes(language==='en'?'If inactive, sleep in 1 hour':'若无操作，将在此时间后休眠 1 小时'));
 assert.ok(text.includes(language==='en'?'Continued inactivity reaches idle sleep first.':'持续无操作时会先进入空闲休眠'));
 assert.ok(text.includes(language==='en'?'6 minutes without keyboard input':'6 分钟无键盘输入'));
 assert.equal(walkAll(f.instance.tree,node=>node.type==='a')[0].props.href,'https://drive.nuphyio.com/#/setting');
 f.state.device.modelId='kick75';f.state.device.capabilities={boardSleepLease:true};f.instance.render();
 assert.ok(textOf(f.instance.tree).includes(language==='en'?"restores the keyboard's original sleep settings":"恢复键盘原来的休眠设置"));
 assert.ok(!textOf(f.instance.tree).includes(language==='en'?'6 minutes without keyboard input':'6 分钟无键盘输入'));
 const selects=walkAll(f.instance.tree,node=>node.type==='select');
 selects[0].props.onChange({target:{value:'3600000'}});selects[1].props.onChange({target:{value:'0'}});
 assert.deepEqual(f.commands,[{op:'settings',settings:{lightDurationMs:3600000}},{op:'settings',settings:{lightIdleMs:0}}]);
 assert.equal(f.state.settings.lightDurationMs,7200000);assert.equal(f.state.settings.lightIdleMs,3600000);
 f.state.lightPower.sleeping=true;f.state.lightPower.reason='idle';f.instance.render();
 assert.ok(textOf(f.instance.tree).includes(language==='en'?'the current duration keeps counting down':'本次亮灯总时长继续计时'));
 f.state.lightPower.reason='duration';f.instance.render();
 assert.ok(textOf(f.instance.tree).includes(language==='en'?'Restart the lights to begin a new timer.':'点击重新亮灯即可开始新的计时'));
 f.close();
});
