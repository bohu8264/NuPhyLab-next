// Production TSX with a controlled geometry result: verifies ref/handler wiring,
// not CSS layout, WebKit/AppKit drawing or real scroll/wheel behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,walkAll,textOf} from './helpers/source-ui-vm.mjs';
import * as view from '../shared/agent-lighting-view.mjs';
import * as codex from '../shared/codex-lighting.mjs';
import * as claude from '../shared/claude-lighting.mjs';
import * as codexKeys from '../shared/codex-keys.mjs';
import * as claudeKeys from '../shared/claude-keys.mjs';
import * as layouts from '../shared/layout.mjs';
import * as rendering from '../shared/render-animation.mjs';
import {AUDIO_EFFECTS} from '../shared/audio-effects.mjs';

const stub=name=>Object.defineProperty(()=>null,'name',{value:name});
const node=(instance,predicate)=>{const found=walkAll(instance.tree,predicate)[0];assert.ok(found,'missing actual-source node');return found;};
const byClass=(instance,name)=>node(instance,entry=>String(entry.props?.className??'').split(' ').includes(name));
const contains=(outer,inner)=>walkAll(outer,entry=>entry===inner).length===1;
function state(source,layout){const task={id:'t',title:'Isolated task',status:'running'};return {layout,settings:{agentSource:source,codexEnabled:true,claudeEnabled:true,brightness:27,audio:{source:'system',deviceId:'',effect:'pulse',colorMode:'single',color:'#6f9e85',sensitivity:1.5,noiseFloor:-55}},device:{connected:true,armed:true,modelId:layout.length===80?'kick75':'air75-v3',capabilities:{perKey:true}},colors:Array(84).fill('#304ffe'),playback:{mode:'agent'},codex:{available:true,tasks:[task],slots:[task],lighting:{selectedId:'t'}},claude:{available:true,tasks:[task],slots:[task],lighting:{selectedId:'t'}},audio:{active:false,available:true,systemSupported:true,status:'idle',error:null,level:0,bands:[],devices:[]}};}
async function environment(mode){
  const args=[],commands=[];let returned=0;
  const workspace={mode,style:{'--workspace-available-height':'460px','--workspace-keyboard-width':'600px','--workspace-header-height':'54px'},previewAway:mode==='flow',returnToKeyboard:()=>{returned++;},gridRef:{current:null},stageRef:{current:null},keyboardRef:{current:null},auxiliaryRef:{current:null},headerRef:{current:null}};
  const ui=createVMEnvironment({
    'lucide-react':Object.fromEntries(['Play','Square','Moon','ArrowUp','AudioLines','SlidersHorizontal','ArrowUpRight','ShieldCheck','RotateCcw','ChevronRight'].map(name=>[name,stub(name)])),
    '../../shared/agent-lighting-view.mjs':view,'../../shared/codex-lighting.mjs':codex,'../../shared/claude-lighting.mjs':claude,'../../shared/codex-keys.mjs':codexKeys,'../../shared/claude-keys.mjs':claudeKeys,'../../shared/layout.mjs':layouts,'../../shared/render-animation.mjs':rendering,
    '../../shared/device-status.mjs':{lightingUnavailableMessage:()=>''},'../../shared/audio-effects.mjs':{AUDIO_EFFECTS},
    './Keyboard':{Keyboard:stub('Keyboard')},'./StartupGuide':{useStartupCopy:()=>zh=>zh},'./CodexStatusColors':{CodexStatusColors:stub('CodexStatusColors')},'./ClaudeStatusColors':{ClaudeStatusColors:stub('ClaudeStatusColors')},'./ColorWheel':{ColorWheel:stub('ColorWheel')},
    './primitives':{Button:stub('Button'),Switch:stub('Switch'),run:promise=>promise},'./i18n':{t:value=>value},'./rangeStyle':{rangeStyle:()=>({})},'./connection-copy-v7':{connectionCopy:value=>value.zh},'./api':{readAppState:async()=>({settings:{}})},
    './useWorkspaceLayout':{useWorkspaceLayout:options=>{args.push(options);return workspace;}},
  });
  ui.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  ui.modules['./audioPending']=(await ui.load(new URL('../ui/src/audioPending.ts',import.meta.url))).exports;
  return {ui,workspace,args,commands,command:async body=>{commands.push(body);},returned:()=>returned};
}

for(const source of ['codex','claude'])for(const mode of ['split','flow'])test(`actual ${source} lighting ${mode} wires every geometry ref and keeps return navigation output-free`,async()=>{
  const f=await environment(mode),component=(await f.ui.load(new URL('../ui/src/AgentLighting.tsx',import.meta.url))).exports.AgentLighting;
  const instance=f.ui.mount(component,{source,state:state(source,layouts.airLayout),command:f.command});
  assert.equal(instance.tree.props['data-workspace-layout'],mode);assert.equal(instance.tree.props.style,f.workspace.style);
  assert.equal(byClass(instance,'agent-light-heading').props.ref,f.workspace.headerRef);assert.equal(byClass(instance,'agent-light-grid').props.ref,f.workspace.gridRef);
  const core=byClass(instance,'agent-workspace-core'),keyboard=byClass(instance,'agent-workspace-keyboard'),aux=byClass(instance,'agent-workspace-aux');
  assert.equal(core.props.ref,f.workspace.stageRef);assert.equal(keyboard.props.ref,f.workspace.keyboardRef);assert.equal(aux.props.ref,f.workspace.auxiliaryRef);
  assert.ok(contains(core,keyboard));assert.equal(contains(core,aux),false);assert.ok(contains(aux,byClass(instance,'agent-brightness')));
  assert.equal(byClass(instance,'agent-light-inspector').props.disabled,false);assert.equal(f.args.at(-1).aspectRatio,959/384);
  const back=walkAll(instance.tree,entry=>entry.props?.['data-workspace-navigation']);assert.equal(back.length,mode==='flow'?1:0);
  if(back.length){back[0].props.onClick();assert.equal(f.returned(),1);}assert.deepEqual(f.commands,[]);
  const kick=state(source,layouts.kickLayout);instance.update({source,state:kick,command:f.command});assert.equal(f.args.at(-1).aspectRatio,1009/440);assert.deepEqual(f.commands,[]);instance.unmount();
});

for(const mode of ['split','flow'])test(`actual Audio ${mode} measures footer in auxiliary wrapper and preserves capture/settings handlers`,async()=>{
  const f=await environment(mode),component=(await f.ui.load(new URL('../ui/src/AudioPanel.tsx',import.meta.url))).exports.AudioPanel;
  const instance=f.ui.mount(component,{state:state('codex',layouts.airLayout),layout:layouts.airLayout,command:f.command});
  assert.equal(instance.tree.props['data-workspace-layout'],mode);assert.equal(byClass(instance,'audio-work-row').props.ref,f.workspace.headerRef);assert.equal(byClass(instance,'audio-v5-grid').props.ref,f.workspace.gridRef);
  const core=byClass(instance,'audio-workspace-core'),keyboard=byClass(instance,'audio-workspace-keyboard'),aux=byClass(instance,'audio-workspace-aux');
  assert.equal(core.props.ref,f.workspace.stageRef);assert.equal(keyboard.props.ref,f.workspace.keyboardRef);assert.equal(aux.props.ref,f.workspace.auxiliaryRef);
  assert.ok(contains(core,keyboard));assert.equal(contains(core,aux),false);assert.ok(contains(aux,byClass(instance,'audio-v5-footer')));assert.ok(contains(aux,byClass(instance,'audio-v5-brightness')));
  assert.ok(byClass(instance,'audio-v5-properties'));assert.equal(f.args.at(-1).aspectRatio,959/384);
  const back=walkAll(instance.tree,entry=>entry.props?.['data-workspace-navigation']);assert.equal(back.length,mode==='flow'?1:0);if(back.length)back[0].props.onClick();assert.deepEqual(f.commands,[]);
  const start=node(instance,entry=>entry.type?.name==='Button'&&textOf(entry)==='开始律动');assert.equal(start.props.disabled,false);
  instance.update({state:state('codex',layouts.kickLayout),layout:layouts.kickLayout,command:f.command});assert.equal(f.args.at(-1).aspectRatio,1009/440);instance.unmount();assert.deepEqual(f.commands,[]);
});

for(const [name,file] of [['CodexStatusColors','CodexStatusColors.tsx'],['ClaudeStatusColors','ClaudeStatusColors.tsx']])test(`actual ${name} focuses nearest instead of centering the document`,async()=>{
  const f=await environment('split'),component=(await f.ui.load(new URL('../ui/src/'+file,import.meta.url))).exports[name];
  const instance=f.ui.mount(component,{settings:{},command:f.command,focusOnMount:false}),calls=[];
  instance.tree.props.ref.current={scrollIntoView:options=>calls.push(['scroll',options]),focus:options=>calls.push(['focus',options])};
  instance.update({settings:{},command:f.command,focusOnMount:true});assert.equal(calls[0][0],'scroll');assert.equal(calls[0][1].block,'nearest');assert.equal(calls[1][1].preventScroll,true);assert.deepEqual(f.commands,[]);instance.unmount();
});
