import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeDesktopRequest} from '../shared/desktop-transport.mjs';
import {createVMEnvironment,textOf,walkAll,deferred,plain} from './helpers/source-ui-vm.mjs';
const stub=()=>null;
test('Windows updater transport never takes a download URL installer path or inherited command name',async()=>{
  const calls=[],window={__TAURI__:{core:{invoke:async(...args)=>{calls.push(args);return {available:false};}}}};
  for(const kind of ['windowsUpdateStatus','checkForUpdates'])await nativeDesktopRequest('codexKeys',{kind},window);
  await nativeDesktopRequest('codexKeys',{kind:'installWindowsUpdate',version:'1.2.41-beta.1'},window);
  assert.deepEqual(calls,[['update_status',{}],['update_check',{}],['update_install',{version:'1.2.41-beta.1'}]]);
  for(const value of [{kind:'constructor'},{kind:'toString'},{kind:'installWindowsUpdate',version:'1.2.41',path:'C:\\bad.exe'},{kind:'checkForUpdates',url:'https://bad'},{kind:'windowsUpdateStatus',version:'1.2.41'}])assert.equal((await nativeDesktopRequest('codexKeys',value,window)).available,false);
  await assert.rejects(nativeDesktopRequest('codexKeys',{kind:'installWindowsUpdate',version:'C:\\bad.exe'},window));assert.equal(calls.length,3);
});
async function panelWith(request){
  const ui=createVMEnvironment({'./primitives':{Button:stub,run:p=>ui.track(p)},'./codexKeys':{nativeCodexRequest:request},'./StartupGuide':{useStartupCopy:()=>zh=>zh},'../../package.json':{default:{version:'1.2.40'}}});
  const Panel=(await ui.load(new URL('../ui/src/WindowsUpdatePanel.tsx',import.meta.url))).exports.WindowsUpdatePanel;
  const panel=ui.mount(Panel,{state:{build:{version:'1.2.40'}}});await new Promise(setImmediate);await ui.settle(panel);return {ui,panel};
}
test('unconfigured Windows builds never check or install automatically',async()=>{
  const calls=[];const {ui,panel}=await panelWith(async value=>{calls.push(plain(value));return {available:true,result:{available:false,phase:'idle'}};});
  await ui.settle(panel);assert.match(textOf(panel.tree),/尚未配置签名更新服务/);assert.deepEqual(calls,[{kind:'windowsUpdateStatus'}]);
  assert.equal(walkAll(panel.tree,n=>n.type===stub).length,0);panel.unmount();assert.equal(ui.timers.size,0);
});
test('Windows update installation requires a listed version and coalesces duplicate clicks',async()=>{
  const calls=[],install=deferred();
  const {ui,panel}=await panelWith(async value=>{calls.push(plain(value));if(value.kind==='installWindowsUpdate')return install.promise;return {available:true,result:{available:true,phase:'available',latest:{version:'1.2.41',notes:'更新说明'}}};});
  await ui.settle(panel);assert.deepEqual(calls,[{kind:'windowsUpdateStatus'}]);
  const button=walkAll(panel.tree,n=>n.type===stub&&textOf(n)==='安装并重新打开')[0];button.props.onClick();button.props.onClick();
  assert.equal(calls.filter(x=>x.kind==='installWindowsUpdate').length,1);assert.deepEqual(calls.at(-1),{kind:'installWindowsUpdate',version:'1.2.41'});
  install.reject(Error('键盘恢复尚未完成'));await ui.settle(panel);assert.match(textOf(panel.tree),/键盘恢复尚未完成/);panel.unmount();
});
