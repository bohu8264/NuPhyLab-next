import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,textOf,walkAll,plain} from './helpers/source-ui-vm.mjs';
const stub=()=>null;
for(const language of ['zh','en'])test(`built-in controls explain restoration and send only bounded stock settings in ${language}`,async()=>{
  const commands=[],ui=createVMEnvironment({
    'lucide-react':new Proxy({},{get:()=>stub}),
    '../../shared/layout.mjs':{blank:()=>Array(84).fill('#000000'),getLayoutModel:()=> 'kick75'},
    './Keyboard':{Keyboard:stub},'./ColorWheel':{ColorWheel:stub},
    './rangeStyle':{rangeStyle:()=>({})},
    './primitives':{Button:stub,run:value=>ui.track(value)},'./api':{readAppState:async()=>null},
    './StartupGuide':{useStartupCopy:()=> (zh,en)=>language==='en'?en:zh},'./i18n':{t:value=>value},
  });
  const {NativeLighting}= (await ui.load(new URL('../ui/src/NativeLighting.tsx',import.meta.url))).exports;
  const state={device:{modelId:'kick75',connected:true,capabilities:{perKey:true,stockEffects:true},state:[3,60,2,0,1,3,31,47,63,2,45,1,0,0,12,34,56]},playback:{mode:'idle'},colors:[]};
  const panel=ui.mount(NativeLighting,{state,layout:[],command:async body=>{commands.push(plain(body));return{};},onOffline(){},onDevice(){}});
  assert.doesNotMatch(textOf(panel.tree),/旧固件兼容状态|Legacy firmware compatibility|升级固件后|Update firmware to enable/);
  assert.match(textOf(panel.tree),language==='en'?/Stop or exit to restore/:/停止或退出时恢复原设置/);
  const buttons=()=>walkAll(panel.tree,node=>node.type===stub);
  buttons().find(n=>textOf(n)===(language==='en'?'Apply built-in effect':'应用内置灯效')).props.onClick();await ui.settle(panel);
  assert.deepEqual(commands,[{op:'nativeLighting',mode:3,brightness:60,speed:2,color:'#1F2F3F'}]);
  buttons().find(n=>textOf(n)===(language==='en'?'Restore lighting':'恢复原灯效')).props.onClick();await ui.settle(panel);
  assert.deepEqual(commands.at(-1),{op:'restore'});
  state.device.capabilities.stockEffects=false;panel.update({state,layout:[],command:async()=>{},onOffline(){},onDevice(){}});
  const apply=buttons().find(n=>/应用内置灯效|Apply built-in effect/.test(textOf(n)));assert.equal(apply.props.disabled,true);panel.unmount();
});
