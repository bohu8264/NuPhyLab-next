import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVMEnvironment,textOf,walkAll,plain} from './helpers/source-ui-vm.mjs';
import * as power from '../shared/lighting-power.mjs';
import * as firmware from '../shared/firmware-onboarding.mjs';
import * as codexKeys from '../shared/codex-keys.mjs';
import * as claudeKeys from '../shared/claude-keys.mjs';
import {deriveConnectionDisplay} from '../shared/connection-display.mjs';

const stub=()=>null;
async function devicePanel(){
  const ui=createVMEnvironment({'lucide-react':new Proxy({},{get:()=>stub}),
    './primitives':{Button:stub,run:p=>ui.track(p)},'./Keyboard':{Keyboard:stub},
    './StartupGuide':{firmwarePrompt:()=>false,showFirmwareGuide(){},useStartupCopy:()=>zh=>zh},
    './KeyRecoveryPanel':{friendlyConnectionError:value=>value,keyRecoveryProblem:()=>null},
    './FirmwareManagement':{FirmwareManagement:stub},
    './WindowsRecoveryPanel':{WindowsRecoveryPanel:stub},
    './WindowsFunctionKeys':{WindowsFunctionKeys:stub},
    './codexKeys':{nativeCodexKeys:async()=>false},'./FunctionKeyRecoveryDialog':{FunctionKeyRecoveryDialog:stub},
    './connection-copy-v7':{connectionCopy:value=>value?.zh??''},'./i18n':{t:value=>value}});
  return {ui,Device:(await ui.load(new URL('../ui/src/Device.tsx',import.meta.url))).exports.Device};
}
test('Windows device panel explains unverified lighting and reports the actual switch position',async()=>{
  const {ui,Device}=await devicePanel(),calls=[];
  const state={desktop:{host:'tauri',capabilities:{lighting:false}},settings:{},playback:{},device:{connected:true,identified:true,readOnly:true,
    modelId:'air75-v3',firmware:'2.0.0.7',lightingProfile:0,errorCode:'WINDOWS_PROBE_ONLY',lightingInspection:{available:false},connection:{status:'attention'}}};
  const props={state,command:async body=>calls.push(plain(body)),serviceError:'',display:deriveConnectionDisplay({state})};
  const panel=ui.mount(Device,props);assert.match(textOf(panel.tree),/Mac 档/);assert.match(textOf(panel.tree),/灯光结构尚未核对/);
  assert.doesNotMatch(textOf(panel.tree),/恢复键盘原灯效|请检查连接|检查固件/);
  assert.equal(walkAll(panel.tree,node=>node.type===stub&&textOf(node)==='读取灯效信息')[0].props.disabled,true);
  state.device.lightingProfile=1;panel.update(props);assert.match(textOf(panel.tree),/Windows 档/);assert.deepEqual(calls,[]);panel.unmount();
});
test('Windows device inspection sends only the read command and hides cached samples when service is stale',async()=>{
  const {ui,Device}=await devicePanel(),calls=[];
  const state={desktop:{host:'tauri',capabilities:{lighting:false}},settings:{},playback:{},device:{connected:true,identified:true,readOnly:true,
    modelId:'air75-v3',firmware:'1.0.23.6',lightingProfile:1,errorCode:'WINDOWS_PROBE_ONLY',lightingInspection:{available:true},
    lightingSnapshot:{ledCount:104,state:Array(22).fill(0)}}};
  const props={state,command:async body=>calls.push(plain(body)),serviceError:'',display:deriveConnectionDisplay({state})};
  const panel=ui.mount(Device,props);const button=walkAll(panel.tree,node=>node.type===stub&&textOf(node)==='读取灯效信息')[0];
  assert.equal(button.props.disabled,false);button.props.onClick();await ui.settle(panel);assert.deepEqual(calls,[{op:'inspectLighting'}]);
  assert.match(textOf(panel.tree),/还不是可恢复的备份/);
  props.serviceError='lost';props.display=deriveConnectionDisplay({state,serviceError:'lost'});panel.update(props);
  assert.doesNotMatch(textOf(panel.tree),/104 个灯位的颜色采样|Windows 档/);panel.unmount();
});
test('Windows preview permission screen does not ask for or report macOS grants',async t=>{
  const commands=[];
  const ui=createVMEnvironment({
    'lucide-react':{},'./primitives':{Button:stub,Modal:stub,Switch:stub,run:p=>p},
    './AmbientLightingPreferences':{AmbientLightingPreferences:stub},
    './SelectionLab':{SelectionAPISettings:stub,SelectionPermissionSettings:stub},
    './DurationField':{DurationField:stub},'../../shared/lighting-power.mjs':power,
    './StartupGuide':{useStartupCopy:()=>zh=>zh,refreshAppPermissions:async()=>commands.push('refresh')},
    './i18n':{useLanguage:()=> 'zh-CN',t:v=>v},'../../package.json':{default:{version:'1.2.40'}},
    './api':{readAppState:async()=>null},'./connection-copy-v7':{connectionCopy:v=>v.zh},
    './UpdatePreferences':{UpdatePreferences:stub},'../../shared/firmware-onboarding.mjs':firmware,
  });
  const source=new URL('../ui/src/Settings.tsx',import.meta.url),dir=await mkdtemp(path.join(tmpdir(),'nuphy-windows-settings-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'Settings.tsx');
  await writeFile(file,(await readFile(source,'utf8')).replaceAll('import.meta.url',JSON.stringify(source.href)));
  const Settings=(await ui.load(file)).exports.Settings;
  const state={desktop:{host:'tauri',stage:'probe'},settings:{language:'zh-CN'},device:{connected:false}};
  const panel=ui.mount(Settings,{state,initialTab:'permissions',command:async body=>commands.push(body)});
  assert.match(textOf(panel.tree),/不采集系统按键或声音/);assert.doesNotMatch(textOf(panel.tree),/模型与 API|Models & API/);
  assert.doesNotMatch(textOf(panel.tree),/Mac 权限|已允许|前往授权/);
  assert.deepEqual(commands,[]);panel.unmount();
});
test('Windows sleep inspection is explicit reports enable state and hides stale observations',async()=>{
  const {ui,Device}=await devicePanel(),calls=[];
  const state={desktop:{host:'tauri',capabilities:{lighting:false}},settings:{},playback:{},device:{connected:true,identified:true,readOnly:true,
    modelId:'air75-v3',firmwareVersion:'2.0.0.7',lightingProfile:1,errorCode:'WINDOWS_PROBE_ONLY',sleepInspection:{available:true},
    sleepSnapshot:{enabled:true,state:[1,10,30,213]}}};
  const props={state,command:async body=>calls.push(plain(body)),serviceError:'',display:deriveConnectionDisplay({state})};
  const panel=ui.mount(Device,props);assert.deepEqual(calls,[]);assert.match(textOf(panel.tree),/键盘当前已启用自动休眠/);
  const button=()=>walkAll(panel.tree,n=>n.type===stub&&textOf(n)==='读取休眠设置')[0];
  assert.equal(button().props.disabled,false);button().props.onClick();await ui.settle(panel);assert.deepEqual(calls,[{op:'inspectSleep'}]);
  state.device.sleepSnapshot.enabled=false;panel.update(props);assert.match(textOf(panel.tree),/键盘当前未启用自动休眠/);
  state.device.windowsRecovery={status:'recovering'};panel.update(props);assert.equal(button().props.disabled,true);
  props.serviceError='lost';props.display=deriveConnectionDisplay({state,serviceError:'lost'});panel.update(props);
  assert.doesNotMatch(textOf(panel.tree),/键盘当前未启用自动休眠/);assert.equal(button().props.disabled,true);panel.unmount();
});
test('Windows update entry uses its native Windows panel',async()=>{
  const ui=createVMEnvironment({
    './primitives':{Button:stub,run:p=>p},'./codexKeys':{nativeCodexKeys:async()=>{throw Error('must not call native updater');}},
    './StartupGuide':{useStartupCopy:()=>zh=>zh},'../../shared/firmware-onboarding.mjs':firmware,
    '../../package.json':{default:{version:'1.2.40'}},
    './WindowsUpdatePanel':{WindowsUpdatePanel:stub},
  });
  const Panel=(await ui.load(new URL('../ui/src/UpdatePreferences.tsx',import.meta.url))).exports.UpdatePreferences;
  const panel=ui.mount(Panel,{state:{desktop:{host:'tauri'},device:{connected:false}},command:async()=>{throw Error('must not update');}});
  assert.equal(walkAll(panel.tree,node=>node.type===stub).length,1);panel.unmount();
});
test('Tauri does not swallow function keys while Windows global-key control is unavailable',async()=>{
  const calls=[],ui=createVMEnvironment({});
  ui.window.__TAURI__={core:{invoke:async()=>{throw Error('unexpected native call');}}};
  const {useCodexKeys}= (await ui.load(new URL('../ui/src/codexKeys.ts',import.meta.url))).exports;
  const panel=ui.mount(()=>{useCodexKeys({codex:{keys:{enabled:true,bindings:[{code:'F1'}]}}},async body=>calls.push(body),()=>{});return null;});
  let swallowed=false;
  ui.window.dispatchEvent({type:'keydown',code:'F1',preventDefault(){swallowed=true;}});
  ui.window.dispatchEvent({type:'keyup',code:'F1',preventDefault(){swallowed=true;}});
  await ui.settle(panel);assert.equal(swallowed,false);assert.deepEqual(calls,[]);panel.unmount();
});
test('Windows AI pages show unavailable capability instead of Mac setup or automatic retry',async()=>{
  const modules={'./StartupGuide':{useStartupCopy:()=>zh=>zh},'./AgentSideLighting':{AgentLightingZone:stub},'lucide-react':{},'../../shared/codex-lighting.mjs':{},'../../shared/claude-lighting.mjs':{},
    '../../shared/codex-keys.mjs':codexKeys,'../../shared/claude-keys.mjs':claudeKeys,
    './api':{readAppState:async()=>null},'./i18n':{t:value=>value},
    './primitives':{Button:stub,Modal:stub,Switch:stub,run:p=>p},
    './CodexKeyRecorder':{CodexKeyRecorder:stub,useAgentKeyCapture:()=>({ready:false})}};
  for(const name of ['WindowsAgentDashboard','AgentTabs','AgentQuota','CodexLightMode','ClaudeLightMode','CodexSetup','ClaudeSetup','FunctionKeyRecoveryDialog'])modules['./'+name]={[name]:stub};
  const ui=createVMEnvironment(modules),Dashboard=(await ui.load(new URL('../ui/src/AgentDashboard.tsx',import.meta.url))).exports.AgentDashboard;
  const reason='Windows 预览版尚未接入 AI 工具';
  const integration={available:false,reason,tasks:[],slots:[],shortcuts:[],commands:[]};
  const state={desktop:{host:'tauri',capabilities:{agentControl:false}},settings:{language:'zh-CN'},device:{},codex:integration,claude:integration};
  for(const source of ['codex','claude']){
    const panel=ui.mount(Dashboard,{source,state,command:async()=>{throw Error('must not attempt setup');}});
    assert.match(textOf(panel.tree),new RegExp(reason));assert.doesNotMatch(textOf(panel.tree),/自动重试|辅助功能|需要完成.*接入/);
    assert.equal(walkAll(panel.tree,node=>node.type===stub).length,0);panel.unmount();
  }
});
