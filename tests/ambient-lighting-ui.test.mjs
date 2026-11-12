import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,walkAll,textOf,plain} from './helpers/source-ui-vm.mjs';
import * as ambient from '../shared/ambient-lighting.mjs';
import * as firmware from '../shared/firmware-onboarding.mjs';
const stub=name=>Object.defineProperty(()=>null,'name',{value:name});
for (const language of ['zh-CN','en']) test(`automatic backlight UI in ${language}: toggles, manual preference, reset, errors and sensor fallback`,async()=>{
  const calls=[],Button=stub('Button'),Switch=stub('Switch');let failed=false;
  const ui=createVMEnvironment({
    './primitives':{Button,Switch,run:p=>ui.track(p)},
    './StartupGuide':{useStartupCopy:()=> (zh,en)=>language==='en'?en:zh},
    '../../shared/ambient-lighting.mjs':ambient,
  });
  const {AmbientLightingPreferences:Panel}=(await ui.load(new URL('../ui/src/AmbientLightingPreferences.tsx',import.meta.url))).exports;
  const state={settings:{brightness:70,ambientLighting:ambient.validateAmbientLighting({enabled:true,profiles:{kick75:[{lux:80,brightness:40}],'air75-v3':[{lux:20,brightness:60}]}})},device:{modelId:'kick75'},ambientLighting:{status:'active',effectiveBrightness:40,learnedPoints:1}};
  const instance=ui.mount(Panel,{state,command:async c=>{calls.push(plain(c));if(failed)throw Error('test');}});
  const text=textOf(instance.tree);
  assert.ok(text.includes(language==='en'?'Following ambient light':'正在跟随环境光'));
  if(language==='en')assert.equal(/[\u4e00-\u9fff]/.test(text),false);
  const slider=()=>walkAll(instance.tree,n=>n.type==='input')[0];
  slider().props.onChange({target:{value:'32'}});instance.render();slider().props.onKeyUp({key:'ArrowLeft'});await ui.settle(instance);
  assert.deepEqual(calls.at(-1),{op:'settings',settings:{brightness:32}});
  walkAll(instance.tree,n=>n.type===Button)[0].props.onClick();await ui.settle(instance);
  assert.deepEqual(calls.at(-1).settings.ambientLighting.profiles,{'air75-v3':[{lux:20,brightness:60}]});
  walkAll(instance.tree,n=>n.type===Switch)[1].props.onChange(false);await ui.settle(instance);
  assert.deepEqual(calls.at(-1).settings.ambientLighting,{learn:false});
  failed=true;walkAll(instance.tree,n=>n.type===Switch)[0].props.onChange(false);await ui.settle(instance);
  assert.ok(walkAll(instance.tree,n=>n.props?.role==='alert').length>0);
  for(const status of ['waiting','unavailable','lidClosed','sleeping','manualOff','idle','noKeyboard','unsupportedKeyboard']){
    state.ambientLighting.status=status;instance.render();const text=textOf(instance.tree);
    assert.ok(text.length>50);if(language==='en')assert.equal(/[\u4e00-\u9fff]/.test(text),false);
  }
  instance.unmount();
});

test('legacy Kick startup displays a local update guide before API success and again on a new USB connection',async()=>{
  const requests=[],Modal=stub('Modal'),Button=stub('Button');
  const ui=createVMEnvironment({
    'lucide-react':{}, './primitives':{Modal,Button,run:p=>ui.track(p)},
    './codexKeys':{nativeCodexKeys:async()=>false,nativeCodexRequest:async body=>{requests.push(body);return {available:false};}},
    '../../shared/permission-refresh.mjs':{coalescePermissionRefresh:(_owner,fn)=>fn(),refreshPermissionSession:async()=>{},watchPermissionRefresh:()=>()=>{}},
    '../../shared/firmware-onboarding.mjs':firmware,
  });
  const {StartupGuide}=(await ui.load(new URL('../ui/src/StartupGuide.tsx',import.meta.url))).exports;
  const state={device:{connected:true,identified:true,firmwareDetectionAvailable:true,firmware:'4.0.12.6',modelId:'kick75',readOnly:true,connectionSessionId:'usb-1'},firmware:{modelId:'kick75',current:'4.0.12.6',latest:null,latestConfirmed:false,status:'checking'}};
  const instance=ui.mount(StartupGuide,{state,command:async()=>({})});
  const modal=()=>walkAll(instance.tree,n=>n.type===Modal)[0];
  assert.ok(modal());assert.ok(textOf(modal()).includes('4.0.18.6'));
  assert.equal(requests.length,0,'showing the guide must not seize USB or open a browser');
  modal().props.onClose();instance.render();assert.equal(modal(),undefined);
  state.device.connectionSessionId='usb-2';instance.render();assert.ok(modal());
  assert.equal(requests.length,0);
  Object.assign(state.device,{firmware:'4.0.18.6'});Object.assign(state.firmware,{current:'4.0.18.6',compatible:true});instance.render();assert.equal(modal(),undefined);
  instance.unmount();
});
