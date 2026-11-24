import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimePaths} from '../server/platform/runtime.mjs';
import {deviceModels} from '../scripts/windows/prepare.mjs';
import {KEYBOARD_MODELS} from '../shared/keyboard-models.mjs';
import {createPlatformServices} from '../server/platform/services.mjs';
import {validatePreviewCommand} from '../server/platform/preview-policy.mjs';

test('Windows runtime uses LocalAppData and explicit native arguments without changing the Mac default',()=>{
  const win=runtimePaths('C:\\Program Files\\NuPhyLab',{platform:'win32',home:'C:\\Users\\测试 用户',env:{LOCALAPPDATA:'D:\\应用数据'}});
  assert.equal(win.dataDir,'D:\\应用数据\\NuPhyLab');
  assert.equal(win.hardware.command,'C:\\Program Files\\NuPhyLab\\bin\\nuphylab-hid.exe');
  assert.equal(win.hardware.protocol,'windows-readonly-v1');
  assert.equal(runtimePaths('/app',{platform:'darwin',home:'/Users/test',env:{}}).dataDir,'/Users/test/Library/Application Support/Air Studio');
  const override=runtimePaths('/app',{platform:'darwin',home:'/test',env:{AIR_STUDIO_DATA:'/isolated',AIR_STUDIO_HID:'/helper',AIR_STUDIO_HID_MODELS:'/models with spaces.json'}});
  assert.equal(override.dataDir,'/isolated');assert.deepEqual(override.hardware,{command:'/helper',args:['--models','/models with spaces.json']});
  const scripted=runtimePaths('C:\\App',{platform:'win32',home:'C:\\User',env:{AIR_STUDIO_HID:'C:\\Node\\node.exe',AIR_STUDIO_HID_ARGS:'["C:\\\\test helper.mjs"]'}});
  assert.deepEqual(scripted.hardware.args,['C:\\test helper.mjs']);
  assert.throws(()=>runtimePaths('/app',{env:{AIR_STUDIO_HID_ARGS:'[1]'}}),/arguments/);
});
test('native model resources derive identities and geometry from the existing shared profiles',()=>{
  const values=deviceModels();assert.deepEqual(values.map(p=>p.id),Object.keys(KEYBOARD_MODELS));
  const products=new Set();
  for(const model of values){const shared=KEYBOARD_MODELS[model.id];assert.equal(model.keyCount+model.sideCount,shared.keyCount+shared.sideCount);assert.equal(model.vendorId,0x19f5);for(const pid of model.productIds){assert(!products.has(pid));products.add(pid);}assert(!Object.hasOwn(model,'layout'));}
});
test('Windows platform cannot construct Mac agent adapters or advertise their actions',async()=>{
  const never=()=>{throw new Error('Mac adapter constructed');};
  for(const options of [{platform:'win32',env:{}},{platform:'darwin',env:{AIR_STUDIO_DESKTOP_HOST:'tauri'}}]){
    const services=createPlatformServices('/isolated',{...options,home:'/unused',createCodex:never,createClaude:never});
    assert.equal(services.agentControl,false);
    for(const [source,agent] of Object.entries(services.agents)){
      await agent.start();await agent.refresh();await agent.stop();
      const state=agent.snapshot();assert.equal(state.available,false);assert.equal(state.taskSource.available,false);
      assert.deepEqual(state.tasks,[]);assert.deepEqual(state.quota.buckets,[]);
      for(const action of state.shortcuts??state.commands){assert.equal(action.available,false);assert.deepEqual(action.keys,[]);}
      assert.equal(agent.action('approve').available,false);
      await assert.rejects(agent.execute(),{code:'WINDOWS_AGENT_UNAVAILABLE'});
      if(source==='claude'){assert.equal(agent.hookStatus().installed,false);await assert.rejects(agent.install(),{code:'WINDOWS_AGENT_UNAVAILABLE'});await assert.rejects(agent.remove(),{code:'WINDOWS_AGENT_UNAVAILABLE'});}
      state.tasks.push({id:'mutated'});assert.deepEqual(agent.snapshot().tasks,[]);
    }
  }
});
test('Mac composition retains the existing adapters and original data path',()=>{
  const codex={},claude={},calls=[];
  const services=createPlatformServices('/app',{platform:'darwin',home:'/Users/test',env:{},
    createCodex:()=>{calls.push('codex');return codex;},createClaude:options=>{calls.push(options);return claude;}});
  assert.equal(services.agentControl,true);assert.equal(services.preview,false);
  assert.equal(services.agents.codex,codex);assert.equal(services.agents.claude,claude);
  assert.deepEqual(calls,['codex',{dataDir:'/Users/test/Library/Application Support/Air Studio'}]);
});
test('the service rejects preview write and privileged commands even with a valid local token',()=>{
  for(const body of [null,[],{op:'play'},{op:'codexKey'},{op:'nativePermissions'},{op:'claudeHookInstall'},
    {op:'audioPacket'},{op:'settings',settings:[]},{op:'settings',settings:{codexEnabled:true}}])
    assert.throws(()=>validatePreviewCommand(body),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
  for(const body of [{op:'saveScene'},{op:'importScenes'},{op:'settings',settings:{language:'en',audio:{source:'system'}}}])
    assert.doesNotThrow(()=>validatePreviewCommand(body));
});
test('basic Windows playback is admitted only by backend qualification and cannot supply identity or paths',()=>{
  for(const body of [{op:'play',colors:[],animation:{}},{op:'preview',colors:[]},{op:'pause'}]){
    assert.throws(()=>validatePreviewCommand(body),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
    assert.doesNotThrow(()=>validatePreviewCommand(body,{lightingAvailable:true}));
    assert.throws(()=>validatePreviewCommand({...body,serial:'invented'},{lightingAvailable:true}),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
  }
  assert.throws(()=>validatePreviewCommand({op:'nativeLighting'},{lightingAvailable:true}),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
  const native={op:'nativeLighting',mode:3,brightness:60,speed:2,color:'#112233'};
  assert.doesNotThrow(()=>validatePreviewCommand(native,{lightingAvailable:true}));
  for(const patch of [{mode:0},{mode:21},{mode:3.1},{brightness:101},{speed:5},{color:null},{color:'x'},{path:'x'}])assert.throws(()=>validatePreviewCommand({...native,...patch},{lightingAvailable:true}),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
});
test('Windows recovery and inspection accept only explicit actions without caller-supplied identity or storage',()=>{
  for(const op of ['checkWindowsRecovery','recoverWindowsLighting','inspectLighting','inspectSleep','inspectFunctionKeys']){
    assert.doesNotThrow(()=>validatePreviewCommand({op}));
    for(const [key,value] of Object.entries({serial:'invented',path:'C:\\other',modelId:'air75-v3',lightingProfile:0,confirmed:true}))assert.throws(()=>validatePreviewCommand({op,[key]:value}),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
  }
});
test('Windows audio and key triggers require native capability independently of lighting qualification',()=>{
  for(const [body,capability] of [[{op:'audioStart'},'audioAvailable'],[{op:'triggerArm',colors:[],trigger:{}},'globalKeysAvailable']]){
    assert.throws(()=>validatePreviewCommand(body,{lightingAvailable:true}),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
    assert.doesNotThrow(()=>validatePreviewCommand(body,{lightingAvailable:true,[capability]:true}));
    assert.throws(()=>validatePreviewCommand({...body,path:'untrusted'},{lightingAvailable:true,[capability]:true}),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
  }
  for(const op of ['audioPacket','audioInventory','codexKey'])assert.throws(()=>validatePreviewCommand({op},{lightingAvailable:true,audioAvailable:true,globalKeysAvailable:true}),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});
});
test('Windows status-light preferences are available independently of physical AI key adaptation',()=>{
  for(const source of ['codex','claude'])assert.doesNotThrow(()=>validatePreviewCommand({op:'settings',settings:{[source+'Brightness']:70,[source+'SelectedPulse']:true,[source+'Ambient']:false,[source+'WholeTaskId']:'task-0'}}));
  for(const key of ['codexTaskKeys','claudeCommandKeys','codexKeycapFallback'])assert.throws(()=>validatePreviewCommand({op:'settings',settings:{[key]:true}},{agentStatus:true}));
});
