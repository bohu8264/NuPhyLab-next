import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,textOf,walkAll,plain,deferred} from './helpers/source-ui-vm.mjs';
const Button=()=>null;
async function fixture(command=async()=>{},language='zh'){
  const ui=createVMEnvironment({'./primitives':{Button,run:p=>ui.track(p)},'./StartupGuide':{useStartupCopy:()=> (zh,en)=>language==='en'?en:zh}});
  const Component=(await ui.load(new URL('../ui/src/WindowsFunctionKeys.tsx',import.meta.url))).exports.WindowsFunctionKeys;
  const state={device:{connected:true,connectionSessionId:'pipe:1',modelId:'air75-v3',firmwareVersion:'2.0.0.7',lightingProfile:1,
    keymapInspection:{available:true},windowsLighting:{phase:'not-started'},keymapSnapshot:{modelId:'air75-v3',firmwareVersion:'2.0.0.7',connectionSessionId:'pipe:1',status:'standard',standardCount:12,lightingProfile:1,
      functions:Array.from({length:12},(_,i)=>({key:`F${i+1}`,status:'standard',shared:false}))}}};
  const props={state,command,current:true},panel=ui.mount(Component,props);
  return {ui,state,props,panel,button:()=>walkAll(panel.tree,n=>n.type===Button)[0]};
}
test('function key inspection is explicit deduplicated read-only and shows no raw keymap',async()=>{
  const calls=[],wait=deferred(),f=await fixture(async body=>{calls.push(plain(body));await wait.promise;});
  assert.deepEqual(calls,[]);assert.match(textOf(f.panel.tree),/当前为标准 F 键，可作为普通功能键使用/);assert.match(textOf(f.panel.tree),/12 \/ 12/);
  assert.match(textOf(f.panel.tree),/不代表 AI 快捷操作已经可用/);
  f.button().props.onClick();f.button().props.onClick();f.panel.render();assert.equal(f.button().props.busy,true);
  assert.deepEqual(calls,[{op:'inspectFunctionKeys'}]);wait.resolve();await f.ui.settle(f.panel);assert.equal(f.button().props.busy,false);
  assert.equal(walkAll(f.panel.tree,n=>n.type==='li').length,12);assert.deepEqual(f.ui.asyncErrors,[]);f.panel.unmount();
});
test('stale busy and unsupported contexts hide readings and cannot offer a new read',async()=>{
  const f=await fixture();
  for(const phase of ['created','arming','armed','restoring','failed']){
    f.state.device.windowsLighting.phase=phase;f.panel.update(f.props);assert.equal(f.button().props.disabled,true);assert.doesNotMatch(textOf(f.panel.tree),/12 \/ 12/);
  }
  f.state.device.windowsLighting.phase='ready';
  for(const status of ['checking','recovering']){
    f.state.device.windowsRecovery={status};f.panel.update(f.props);assert.equal(f.button().props.disabled,true);assert.doesNotMatch(textOf(f.panel.tree),/12 \/ 12/);
  }
  delete f.state.device.windowsRecovery;f.props.current=false;f.panel.update(f.props);assert.equal(f.button().props.disabled,true);assert.doesNotMatch(textOf(f.panel.tree),/12 \/ 12/);
  f.props.current=true;f.state.device.keymapInspection.available=false;f.panel.update(f.props);assert.equal(f.button().props.disabled,true);assert.match(textOf(f.panel.tree),/键位结构尚未核对/);assert.doesNotMatch(textOf(f.panel.tree),/12 \/ 12/);f.panel.unmount();
});
test('old read failures are discarded after connection or mode changes',async()=>{
  for(const change of [f=>f.state.device.connectionSessionId='pipe:2',f=>f.state.device.lightingProfile=0,f=>f.state.device.windowsLighting.phase='arming']){
    const wait=deferred(),f=await fixture(()=>wait.promise);f.button().props.onClick();change(f);f.panel.update(f.props);
    wait.reject(Error('old failure'));await f.ui.settle(f.panel);assert.doesNotMatch(textOf(f.panel.tree),/old failure/);assert.deepEqual(f.ui.asyncErrors,[]);f.panel.unmount();
  }
  const f=await fixture(async()=>{throw Error('fresh failure');});f.button().props.onClick();await f.ui.settle(f.panel);assert.match(textOf(f.panel.tree),/fresh failure/);
  f.state.device.lightingProfile=0;f.panel.update(f.props);assert.doesNotMatch(textOf(f.panel.tree),/fresh failure/);f.panel.unmount();
});
test('nonstandard and compact layouts give plain language limits in both languages',async()=>{
  for(const language of ['zh','en']){
    const f=await fixture(undefined,language);
    for(const [status,expected] of [['custom',language==='en'?/Custom functions/:/自定义功能/],['shared',language==='en'?/share a function/:/共用同一功能/],
      ['unknown',language==='en'?/could not be confirmed/:/无法确认/],['needsAdaptation',language==='en'?/keyboard system functions/:/键盘系统功能/]]){
      f.state.device.keymapSnapshot.status=status;f.panel.update(f.props);assert.match(textOf(f.panel.tree),expected);
    }
    f.state.device.keymapSnapshot.functions.forEach(key=>key.status='extended');f.panel.update(f.props);
    assert.match(textOf(f.panel.tree),language==='en'?/extended F keys/:/扩展 F 键/);assert.doesNotMatch(textOf(f.panel.tree),/Switch to Win mode|切到 Win 档/);
    f.state.device.keymapSnapshot.functions.forEach(key=>key.status='factoryFunction');f.state.device.lightingProfile=0;f.state.device.keymapSnapshot.lightingProfile=0;f.panel.update(f.props);
    assert.match(textOf(f.panel.tree),language==='en'?/Switch to Win mode/:/切到 Win 档/);
    f.state.device.keymapSnapshot={...f.state.device.keymapSnapshot,status:'noFunctionRow',standardCount:0,functions:[]};f.panel.update(f.props);
    assert.doesNotMatch(textOf(f.panel.tree),/0 \/ 12/);assert.equal(walkAll(f.panel.tree,n=>n.type==='details').length,0);f.panel.unmount();
  }
});
test('preparation presents missing requirements without a write action and hides observations from other scopes',async()=>{
  for(const language of ['zh','en']){
    const calls=[],f=await fixture(async body=>calls.push(plain(body)),language);
    f.state.device.keymapSnapshot.preparation={readOnly:true,canPrepare:false,candidateKeys:['F1'],preservedExtendedKeys:['F2'],checks:[
      {id:'completion',status:'blocked',reason:'completionUnqualified'},{id:'input',status:'blocked',reason:'inputUnqualified'},
      {id:'recovery',status:'unchecked',reason:'recoveryUnchecked'},
    ]};f.panel.update(f.props);
    assert.match(textOf(f.panel.tree),language==='en'?/Remapping preparation · not ready/:/改键准备检查 · 尚不能启用/);
    assert.match(textOf(f.panel.tree),language==='en'?/Reliable write-completion/:/可靠的写完确认/);
    assert.match(textOf(f.panel.tree),language==='en'?/Existing extended mappings preserved: F2/:/保留现有扩展映射：F2/);
    assert.equal(walkAll(f.panel.tree,n=>n.type===Button).length,1);assert.deepEqual(calls,[]);
    const old=structuredClone(f.state.device.keymapSnapshot);
    for(const patch of [{connectionSessionId:'pipe:old'},{modelId:'kick75'},{firmwareVersion:'2.0.0.8'},{lightingProfile:0}]){
      f.state.device.keymapSnapshot={...old,...patch};f.panel.update(f.props);
      assert.doesNotMatch(textOf(f.panel.tree),/Remapping preparation|改键准备检查/);
    }
    f.panel.unmount();
  }
});
