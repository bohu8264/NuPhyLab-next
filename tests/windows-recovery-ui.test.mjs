import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,textOf,walkAll,plain} from './helpers/source-ui-vm.mjs';
const Button=()=>null,Modal=()=>null;
async function fixture(){
  const ui=createVMEnvironment({'./primitives':{Button,Modal,run:p=>ui.track(p)},'./StartupGuide':{useStartupCopy:()=>zh=>zh}});
  const Panel=(await ui.load(new URL('../ui/src/WindowsRecoveryPanel.tsx',import.meta.url))).exports.WindowsRecoveryPanel;
  const calls=[],state={device:{connected:true,identityQualification:{status:'qualified'},lightingProfile:1,modelId:'air75-v3',connectionSessionId:'native:1',windowsRecovery:{status:'unchecked'}},playback:{playing:false}};
  const props={state,current:true,command:async body=>calls.push(plain(body))};
  const panel=ui.mount(Panel,props),button=label=>walkAll(panel.tree,n=>n.type===Button&&textOf(n)===label)[0];
  return {ui,panel,props,state,calls,button};
}
test('checking recovery sends no identity or paths and never automatically restores',async()=>{
  const f=await fixture();assert.deepEqual(f.calls,[]);assert.match(textOf(f.panel.tree),/不会修改键盘或清理旧记录/);
  f.button('检查待恢复记录').props.onClick();await f.ui.settle(f.panel);assert.deepEqual(f.calls,[{op:'checkWindowsRecovery'}]);
  f.state.device.identityQualification.status='unverified';f.panel.update(f.props);assert.equal(f.button('检查待恢复记录').props.disabled,true);assert.equal(f.button('恢复原设置').props.disabled,true);f.panel.unmount();
});
test('unqualified firmware can inspect records while restoration remains disabled',async()=>{
  const f=await fixture();f.state.device.windowsRecovery={status:'pending',canRestore:false,pending:{lightingProfiles:[1],boardSleep:true,keymapProfiles:[]}};f.panel.update(f.props);
  assert.equal(f.button('检查待恢复记录').props.disabled,false);assert.equal(f.button('恢复原设置').props.disabled,true);assert.match(textOf(f.panel.tree),/当前固件暂未开放恢复/);assert.deepEqual(f.calls,[]);f.panel.unmount();
});
test('restoration requires confirmation and a connection change dismisses stale confirmation',async()=>{
  const f=await fixture();f.state.device.windowsRecovery={status:'pending',canRestore:true,pending:{lightingProfiles:[1],boardSleep:true,keymapProfiles:[]}};f.panel.update(f.props);
  f.button('恢复原设置').props.onClick({currentTarget:null});f.panel.render();let dialog=walkAll(f.panel.tree,n=>n.type===Modal)[0];assert(dialog);assert.deepEqual(f.calls,[]);
  f.state.device.connectionSessionId='native:2';f.panel.update(f.props);assert.equal(walkAll(f.panel.tree,n=>n.type===Modal).length,0);
  f.button('恢复原设置').props.onClick({currentTarget:null});f.panel.render();dialog=walkAll(f.panel.tree,n=>n.type===Modal)[0];
  walkAll(dialog.props.footer,n=>n.type===Button&&textOf(n)==='确认恢复')[0].props.onClick();await f.ui.settle(f.panel);assert.deepEqual(f.calls,[{op:'recoverWindowsLighting'}]);f.panel.unmount();
});
test('partial recovery shows independent results and asks for the other switch position',async()=>{
  const f=await fixture();f.state.device.windowsRecovery={status:'failed',result:{lightingProfile:1,complete:false,deferredProfiles:[0],completedCleanup:{lightingProfiles:[],boardSleep:false,keymapProfiles:[]},functionKeys:{status:'notNeeded'},lighting:{status:'restored'},boardSleep:{status:'failed',error:{code:'FAILED',message:'休眠读回未通过'}}}};f.panel.update(f.props);
  const text=textOf(f.panel.tree);assert.match(text,/已恢复并核对/);assert.match(text,/未完成，保留记录/);assert.match(text,/手动切到Mac 档/);assert.match(text,/休眠读回未通过/);assert.doesNotMatch(text,/本次恢复已全部确认/);
  f.props.current=false;f.panel.update(f.props);assert.equal(f.button('检查待恢复记录').props.disabled,true);f.panel.unmount();
});

test('key-only pending records and partial key failures stay visible without inventing success',async()=>{
  const f=await fixture();
  f.state.device.windowsRecovery={status:'pending',canRestore:true,pending:{lightingProfiles:[],boardSleep:false,keymapProfiles:[1]}};f.panel.update(f.props);
  assert.match(textOf(f.panel.tree),/功能键：.*Windows 档/);
  f.state.device.windowsRecovery={status:'failed',result:{lightingProfile:1,complete:false,deferredProfiles:[],completedCleanup:{lightingProfiles:[],boardSleep:false,keymapProfiles:[]},
    lighting:{status:'restored'},boardSleep:{status:'notNeeded'},functionKeys:{status:'failed',error:{code:'FUNCTION_KEYS_BARRIER_UNQUALIFIED',message:'改键提交尚未核对，原记录已保留'}}}};
  f.panel.update(f.props);const text=textOf(f.panel.tree);
  assert.match(text,/灯光：已恢复并核对/);assert.match(text,/功能键：未完成，保留记录/);assert.match(text,/改键提交尚未核对/);assert.doesNotMatch(text,/本次恢复已全部确认/);assert.deepEqual(f.calls,[]);f.panel.unmount();
});
