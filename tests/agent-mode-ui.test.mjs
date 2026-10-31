import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,walkAll,textOf,deferred,plain} from './helpers/source-ui-vm.mjs';
import * as codexKeys from '../shared/codex-keys.mjs';
import * as claudeKeys from '../shared/claude-keys.mjs';
import * as codex from '../shared/codex-lighting.mjs';
import * as claude from '../shared/claude-lighting.mjs';
import * as view from '../shared/agent-lighting-view.mjs';
import * as layouts from '../shared/layout.mjs';

const stub=name=>Object.defineProperty(()=>null,'name',{value:name});
function state(source='codex',enabled=false){
  const task={id:'task-a',title:'Task A',status:'running'};
  const integration={available:true,taskSource:{available:true},tasks:[task],slots:[task],shortcuts:[],commands:[],lighting:{selectedId:'task-a'}};
  return{settings:{agentSource:source,codexEnabled:source==='codex'&&enabled,claudeEnabled:source==='claude'&&enabled,codexKeyAdaptation:true,brightness:27},
    device:{connected:true,armed:true,connectionSessionId:'fixture:1',modelId:'air75-v3',capabilities:{perKey:true}},native:{inputMonitoring:true,accessibility:true,canPostEvents:true},
    playback:{mode:'animation',playing:true},colors:Array(84).fill('#d07d74'),codex:{...structuredClone(integration),keys:{enabled,host:{registered:[],failed:[]}},adaptation:{status:'ready',ready:[]}},claude:structuredClone(integration)};
}
async function fixture({source='codex',enabled=false,tab='tasks',handler=async()=>({})}={}){
  const commands=[],nodes=Object.fromEntries(['AgentTabs','AgentQuota','CodexLightMode','ClaudeLightMode','CodexSetup','ClaudeSetup','FunctionKeyRecoveryDialog','CodexKeyRecorder','Button','Modal','Switch','Keyboard','CodexStatusColors','ClaudeStatusColors'].map(name=>[name,stub(name)]));
  const ui=createVMEnvironment({
    'lucide-react':Object.fromEntries(['ChevronRight','Info','RefreshCw','Check','CircleAlert','Keyboard','Moon','ArrowUp'].map(name=>[name,stub(name)])),
    '../../shared/codex-lighting.mjs':codex,'../../shared/claude-lighting.mjs':claude,'../../shared/codex-keys.mjs':codexKeys,'../../shared/claude-keys.mjs':claudeKeys,
    '../../shared/agent-lighting-view.mjs':view,'../../shared/layout.mjs':layouts,'../../shared/device-status.mjs':{lightingUnavailableMessage:()=> 'Unsupported fixture'},
    './AgentTabs':{AgentTabs:nodes.AgentTabs},'./AgentQuota':{AgentQuota:nodes.AgentQuota},'./CodexLightMode':{CodexLightMode:nodes.CodexLightMode},'./ClaudeLightMode':{ClaudeLightMode:nodes.ClaudeLightMode},
    './CodexSetup':{CodexSetup:nodes.CodexSetup},'./ClaudeSetup':{ClaudeSetup:nodes.ClaudeSetup},'./CodexKeyRecorder':{CodexKeyRecorder:nodes.CodexKeyRecorder,useAgentKeyCapture:()=>({ready:true,error:'',release:async()=>{}})},
    './FunctionKeyRecoveryDialog':{FunctionKeyRecoveryDialog:nodes.FunctionKeyRecoveryDialog},
    './api':{readAppState:async()=>({settings:{}})},'./primitives':{Button:nodes.Button,Modal:nodes.Modal,Switch:nodes.Switch,run:promise=>promise.catch(()=>{})},'./i18n':{t:value=>value},
    './StartupGuide':{useStartupCopy:()=>zh=>zh,refreshAppPermissions:async()=>{},requestAppPermission:async()=>{},showFirmwareGuide(){}},
    './KeyRecoveryPanel':{keyRecoveryProblem:()=>null,friendlyConnectionError:value=>value},'./Keyboard':{Keyboard:nodes.Keyboard},'./CodexStatusColors':{CodexStatusColors:nodes.CodexStatusColors},'./ClaudeStatusColors':{ClaudeStatusColors:nodes.ClaudeStatusColors},
    './useWorkspaceLayout':{useWorkspaceLayout:()=>({mode:'flow',style:{},previewAway:false,gridRef:{},stageRef:{},keyboardRef:{},auxiliaryRef:{},headerRef:{},returnToKeyboard(){}})},
  },{sessionStorage:{'nuphylab-agent-tab':tab}});
  ui.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  const current=state(source,enabled),command=async body=>{commands.push(plain(body));return handler(body);};
  const Dashboard=(await ui.load(new URL('../ui/src/AgentDashboard.tsx',import.meta.url))).exports.AgentDashboard;
  const props={source,state:current,command};const instance=ui.mount(Dashboard,props);
  const find=predicate=>walkAll(instance.tree,predicate)[0],mode=()=>find(node=>node.type===nodes.Switch&&node.props.label===(props.source==='claude'?'Claude Code 模式':'Codex 模式'));
  const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();await ui.settle(instance);};
  return{ui,nodes,props,instance,current,commands,command,find,mode,flush,alerts:()=>walkAll(instance.tree,node=>node.props?.role==='alert').map(textOf).join('\n')};
}

for(const source of['codex','claude'])test(`actual ${source} mode switch is the same master on all three tabs and uses the unified command`,async()=>{
  const f=await fixture({source});assert.ok(f.mode());assert.equal(f.mode().props.checked,false);
  for(const tab of['lights','setup','tasks']){
    f.find(node=>node.type===f.nodes.AgentTabs).props.onChange(tab);f.instance.render();assert.equal(f.ui.sessionStorage.get('nuphylab-agent-tab'),tab);assert.ok(f.mode());
    assert.equal(walkAll(f.instance.tree,node=>node.type===f.nodes.Switch&&node.props.label.endsWith('模式')).length,1);
  }
  f.mode().props.onChange(true);await f.flush();assert.deepEqual(f.commands,[{op:'agentMode',source,enabled:true}]);assert.equal(f.mode().props.checked,false,'do not pretend the settings poll has confirmed the switch');
  f.current.settings[`${source}Enabled`]=true;f.instance.render();assert.equal(f.mode().props.checked,true);f.mode().props.onChange(false);await f.flush();assert.deepEqual(f.commands.at(-1),{op:'agentMode',source,enabled:false});f.instance.unmount();
});

test('actual mode request is locked while pending, surfaces failure and releases for retry',async()=>{
  const first=deferred();let attempts=0;const f=await fixture({handler:()=>++attempts===1?first.promise:Promise.resolve({})});
  const old=f.mode();old.props.onChange(true);f.instance.render();assert.equal(f.mode().props.disabled,true);assert.equal(f.find(node=>node.type===f.nodes.AgentTabs).props.sourceDisabled,true,'a pending mode change cannot race a source selection based on stale flags');old.props.onChange(true);assert.equal(f.commands.length,1);
  first.reject(new Error('fixture mode result unknown'));await f.flush();assert.equal(f.mode().props.disabled,false);assert.equal(f.mode().props.checked,false);assert.ok(f.alerts().includes('fixture mode result unknown'));
  f.find(node=>node.type===f.nodes.Button&&textOf(node)==='重试开启模式').props.onClick();await f.flush();assert.equal(f.commands.length,2);assert.equal(f.commands[1].enabled,true,'retry keeps the requested direction even when old polled settings remain off');assert.equal(f.alerts(),'');f.instance.unmount();
});

test('actual failed mode-off retry remains off even after a partial settings commit',async()=>{
  const first=deferred();let attempts=0;const f=await fixture({enabled:true,handler:()=>++attempts===1?first.promise:Promise.resolve({})});
  f.mode().props.onChange(false);f.current.settings.codexEnabled=false;f.instance.render();first.reject(new Error('fixture key restoration pending'));await f.flush();
  assert.equal(f.mode().props.checked,false);const retry=f.find(node=>node.type===f.nodes.Button&&textOf(node)==='重试关闭模式');assert.ok(retry);retry.props.onClick();await f.flush();assert.deepEqual(f.commands.at(-1),{op:'agentMode',source:'codex',enabled:false});f.instance.unmount();
});

test('actual source/context switch discards a late mode failure instead of assigning it to another AI',async()=>{
  const wait=deferred(),f=await fixture({handler:()=>wait.promise});f.mode().props.onChange(true);f.instance.render();
  f.props.source='claude';f.props.state=state('claude',true);f.instance.update(f.props);assert.equal(f.mode().props.checked,true);assert.equal(f.mode().props.disabled,false);
  wait.reject(new Error('old Codex failure'));await f.flush();assert.equal(f.alerts(),'');assert.equal(f.mode().props.label,'Claude Code 模式');f.instance.unmount();
});

test('actual mode control blocks unavailable service and enabling unsupported firmware, but permits turning an active mode off',async()=>{
  const f=await fixture();f.props.serviceError='fixture unavailable';f.instance.update(f.props);assert.equal(f.mode().props.disabled,true);f.mode().props.onChange(true);assert.deepEqual(f.commands,[]);
  f.props.serviceError='';f.current.device.capabilities.perKey=false;f.instance.update(f.props);assert.equal(f.mode().props.disabled,true);
  f.current.settings.codexEnabled=true;f.instance.render();assert.equal(f.mode().props.disabled,false);f.mode().props.onChange(false);await f.flush();assert.equal(f.commands.at(-1).enabled,false);f.instance.unmount();
});

test('actual mode-off view reports unconfirmed original keys without automatically restoring an unowned F4 record',async()=>{
  for(const status of['confirmationRequired','active','blocked']){
    const f=await fixture({tab:'lights'});f.current.device.keyRecovery={status,pending:true,blocking:true,unownedHistory:true,ownsCurrentHandle:false};f.instance.render();
    const notice=f.find(node=>String(node.props?.className??'').includes('agent-mode-recovery'));assert.ok(notice);assert.ok(textOf(notice).includes('原功能尚未确认'));assert.equal(f.mode().props.checked,false);assert.deepEqual(f.commands,[]);
    assert.equal(walkAll(f.instance.tree,node=>textOf(node)==='重试恢复'&&node.props?.onClick).length,0);f.instance.unmount();
  }
});

test('actual mode-off recovery entry mounts the confirmed-recovery dialog and closes it when mode or connection changes',async()=>{
  for(const transition of['modeOn','connection','disconnect']){
    const f=await fixture();f.current.device.keyRecovery={status:'confirmationRequired',pending:true,blocking:true,unownedHistory:true,ownsCurrentHandle:false};f.instance.render();
    const button=f.find(node=>node.type===f.nodes.Button&&textOf(node)==='检查并恢复按键');assert.ok(button);const focus={id:'fixture-recovery-button'};button.props.onClick({currentTarget:focus});f.instance.render();
    const dialog=f.find(node=>node.type===f.nodes.FunctionKeyRecoveryDialog);assert.ok(dialog);assert.equal(dialog.props.state,f.current);assert.equal(dialog.props.command,f.command);assert.equal(dialog.props.returnFocus,focus);assert.deepEqual(f.commands,[],'parent mounts only; it never previews or confirms a keyboard identity itself');
    if(transition==='modeOn')f.current.settings.codexEnabled=true;
    else if(transition==='connection')f.current.device.connectionSessionId='new-session';
    else f.current.device.connected=false;
    f.instance.render();assert.equal(f.find(node=>node.type===f.nodes.FunctionKeyRecoveryDialog),undefined);assert.deepEqual(f.commands,[]);f.instance.unmount();
  }
});

test('actual mode stays checked during the game/trigger and recording safety pauses with a clear explanation',async()=>{
  for(const mode of['game','trigger']){
    const f=await fixture({enabled:true,tab:'setup'});f.current.playback.mode=mode;f.current.codex.keys.enabled=false;f.instance.render();assert.equal(f.mode().props.checked,true);assert.ok(textOf(f.instance.tree).includes('快捷控制暂停'));assert.deepEqual(f.commands,[]);f.instance.unmount();
  }
  const f=await fixture({enabled:true});f.current.codex.keys.capturing=true;f.instance.render();assert.ok(textOf(f.instance.tree).includes('正在录入按键'));assert.equal(f.mode().props.checked,true);f.instance.unmount();
});

for(const source of['codex','claude'])test(`actual ${source} setup enables the same mode rather than exposing a separate function-key switch`,async()=>{
  const f=await fixture({source}),Setup=(await f.ui.load(new URL('../ui/src/CodexSetup.tsx',import.meta.url))).exports.CodexSetup;
  const instance=f.ui.mount(Setup,{source,state:f.current,command:f.command});
  const label=source==='claude'?'开启 Claude Code 模式':'开启 Codex 模式',button=walkAll(instance.tree,node=>node.type===f.nodes.Button&&textOf(node)===label)[0];assert.ok(button);button.props.onClick();await f.flush();await f.ui.settle(instance);
  assert.deepEqual(f.commands.at(-1),{op:'agentMode',source,enabled:true});assert.equal(textOf(instance.tree).includes('启用功能键'),false);instance.unmount();f.instance.unmount();
});

test('actual AI lighting has no second start/stop/sleep action and uses the committed frame while artwork sleeps',async()=>{
  const f=await fixture({enabled:true}),Lighting=(await f.ui.load(new URL('../ui/src/AgentLighting.tsx',import.meta.url))).exports.AgentLighting;
  f.current.lightPower={sleeping:true};f.current.codex.lighting={selectedId:'task-a',ownsOutput:true,outputOwner:{source:'codex',connectionSessionId:'fixture:1',mode:'keys',frameCommittedAt:10},pausedReason:null,sleeping:false,backgroundSleeping:true};
  f.current.previewColors=Array(84).fill('#d07d74');
  const instance=f.ui.mount(Lighting,{source:'codex',state:f.current,command:f.command}),buttons=walkAll(instance.tree,node=>node.type===f.nodes.Button).map(textOf);
  for(const label of['开始显示','停止显示','唤醒灯光'])assert.equal(buttons.includes(label),false);assert.ok(buttons.includes('普通作品休眠设置'));
  const keyboard=walkAll(instance.tree,node=>node.type===f.nodes.Keyboard)[0];assert.equal(keyboard.props.colors,f.current.previewColors);assert.notEqual(keyboard.props.colors,f.current.colors);assert.ok(textOf(instance.tree).includes('正在显示 Codex 任务状态'));assert.equal(textOf(instance.tree).includes('灯光已休眠'),false);assert.deepEqual(f.commands,[]);instance.unmount();f.instance.unmount();
});

test('actual source selector hands an active mode over atomically and leaves an off mode off',async()=>{
  for(const enabled of[true,false]){
    const f=await fixture({enabled}),Source=(await f.ui.load(new URL('../ui/src/AgentSourceSwitch.tsx',import.meta.url))).exports.AgentSourceSwitch;
    const instance=f.ui.mount(Source,{state:f.current,command:f.command}),buttons=walkAll(instance.tree,node=>node.type==='button');
    buttons.find(button=>textOf(button)==='Codex').props.onClick();assert.deepEqual(f.commands,[],'selected source does not reapply a mode');
    buttons.find(button=>textOf(button)==='Claude Code').props.onClick();await f.flush();
    assert.deepEqual(f.commands,[enabled?{op:'agentMode',source:'claude',enabled:true}:{op:'settings',settings:{agentSource:'claude'}}]);
    assert.equal(f.current.settings.agentSource,'codex','wait for state polling before claiming source handoff');instance.update({state:f.current,command:f.command,disabled:true});const start=f.commands.length;walkAll(instance.tree,node=>node.type==='button').find(button=>textOf(button)==='Claude Code').props.onClick();assert.equal(f.commands.length,start,'disabled source selector rejects synthetic repeated input too');instance.unmount();f.instance.unmount();
  }
});
