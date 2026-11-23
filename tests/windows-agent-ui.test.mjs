import test from 'node:test';import assert from 'node:assert/strict';
import {createVMEnvironment,textOf,walkAll,plain,deferred} from './helpers/source-ui-vm.mjs';
const Button=()=>null,Switch=()=>null,stub=()=>null;
async function fixture(command){
  const ui=createVMEnvironment({'./primitives':{Button,Switch,run:p=>ui.track(p)},'./StartupGuide':{useStartupCopy:()=>zh=>zh},'./AgentSourceSwitch':{AgentSourceSwitch:stub},'./AgentQuota':{AgentQuota:stub},'./CodexLightMode':{CodexLightMode:stub},'./ClaudeLightMode':{ClaudeLightMode:stub},'../../shared/codex-lighting.mjs':{STATUS_NAMES:{running:'进行中'}},'../../shared/claude-lighting.mjs':{CLAUDE_STATUS_NAMES:{awaitingInput:'等待输入'}},'./i18n':{t:v=>v}});
  const Dashboard=(await ui.load(new URL('../ui/src/WindowsAgentDashboard.tsx',import.meta.url))).exports.WindowsAgentDashboard;
  const state={settings:{agentSource:'codex',codexEnabled:false},device:{capabilities:{perKey:false}},codex:{available:true,tasks:[{id:'first-0',title:'任务一',status:'running',cwd:'D:\\one'},{id:'second-0',title:'任务二',status:'running',cwd:'D:\\two'}]},claude:{available:true,hooks:{installed:false},tasks:[]}};
  const props={state,source:'codex',command},panel=ui.mount(Dashboard,props),button=label=>walkAll(panel.tree,n=>n.type===Button&&textOf(n)===label)[0];return {ui,panel,props,button};
}
test('Windows AI page starts without side effects and resolves the explicitly selected task ID',async()=>{
  const calls=[],f=await fixture(async q=>calls.push(plain(q)));assert.deepEqual(calls,[]);assert.match(textOf(f.panel.tree),/当前不会拦截按键/);
  walkAll(f.panel.tree,n=>n.type==='select')[0].props.onChange({target:{value:'second-0'}});f.panel.render();
  f.button('复制 PowerShell 恢复命令').props.onClick();await f.ui.settle(f.panel);
  assert.deepEqual(calls,[{op:'windowsAgentAction',source:'codex',action:'copyResume',id:'second-0'}]);
  assert.equal(walkAll(f.panel.tree,n=>n.type===Switch)[0].props.disabled,true);f.panel.unmount();
});
test('Windows AI actions coalesce duplicate clicks and discard feedback from the previous source',async()=>{
  const calls=[],work=deferred(),f=await fixture(q=>{calls.push(plain(q));return work.promise;});
  f.button('刷新状态').props.onClick();f.button('刷新状态').props.onClick();assert.equal(calls.length,1);
  f.panel.update({...f.props,source:'claude'});work.resolve({});await f.ui.settle(f.panel);
  assert.doesNotMatch(textOf(f.panel.tree),/操作已完成/);assert.deepEqual(calls,[{op:'refreshCodex'}]);f.panel.unmount();
});
test('resume is an explicit desktop action using only the selected historical session identity',async()=>{
  const calls=[],f=await fixture(async q=>{calls.push(plain(q));return {processCreated:true,alreadyOpened:false};});
  assert.equal(f.button('在新终端恢复会话').props.disabled,true);
  const id='12345678-1234-1234-1234-123456789abc';
  f.props.state.desktop={capabilities:{agentResume:true}};f.props.state.codex.tasks=[{id,title:'历史任务',status:'completed'}];f.panel.update(f.props);
  assert.deepEqual(calls,[]);assert.equal(f.button('在新终端恢复会话').props.disabled,false);
  f.button('在新终端恢复会话').props.onClick();await f.ui.settle(f.panel);
  assert.deepEqual(calls,[{op:'windowsAgentAction',source:'codex',action:'resumeTerminal',id}]);
  assert.match(textOf(f.panel.tree),/请在终端中确认会话/);assert.doesNotMatch(textOf(f.panel.tree),/会话恢复成功/);
  f.props.state.codex.tasks[0].status='running';f.panel.update(f.props);assert.equal(f.button('在新终端恢复会话').props.disabled,true);f.panel.unmount();
});
test('an already opened terminal produces guidance without claiming another task was resumed',async()=>{
  const f=await fixture(async()=>({processCreated:false,alreadyOpened:true}));
  f.props.state.desktop={capabilities:{agentResume:true}};f.props.state.codex.tasks=[{id:'12345678-1234-1234-1234-123456789abc',status:'idle'}];f.panel.update(f.props);
  f.button('在新终端恢复会话').props.onClick();await f.ui.settle(f.panel);
  assert.match(textOf(f.panel.tree),/已为此会话打开终端/);f.panel.unmount();
});
test('switching to an owned terminal is explicit and sends only the session identity',async()=>{
  const calls=[],f=await fixture(async q=>{calls.push(plain(q));return {focused:true};});
  assert.equal(f.button('切回 Lab 打开的终端').props.disabled,true);
  const id='12345678-1234-1234-1234-123456789abc';
  f.props.state.desktop={capabilities:{agentTerminalFocus:true}};
  f.props.state.codex.tasks=[{id,status:'running'}];f.panel.update(f.props);
  assert.equal(f.button('切回 Lab 打开的终端').props.disabled,false);assert.deepEqual(calls,[]);
  f.button('切回 Lab 打开的终端').props.onClick();await f.ui.settle(f.panel);
  assert.deepEqual(calls,[{op:'windowsAgentAction',source:'codex',action:'focusTerminal',id}]);
  assert.match(textOf(f.panel.tree),/已切回 Lab 打开的终端/);f.panel.unmount();
});
test('a missing focus receipt cannot claim a successful window switch',async()=>{
  const f=await fixture(async()=>({focused:false}));
  f.props.state.desktop={capabilities:{agentTerminalFocus:true}};
  f.props.state.codex.tasks=[{id:'12345678-1234-1234-1234-123456789abc',status:'running'}];f.panel.update(f.props);
  f.button('切回 Lab 打开的终端').props.onClick();await f.ui.settle(f.panel);
  assert.match(textOf(f.panel.tree),/窗口切换未确认/);assert.doesNotMatch(textOf(f.panel.tree),/已切回 Lab 打开的终端/);f.panel.unmount();
});
test('external Codex window focus requires the new host capability and an explicit selected task',async()=>{
  const calls=[],f=await fixture(async q=>{calls.push(plain(q));return {focused:true};});
  assert.equal(f.button('切到正在运行的任务窗口').props.disabled,true);
  const id='12345678-1234-1234-1234-123456789abc';
  f.props.state.desktop={capabilities:{codexTaskFocus:true}};
  f.props.state.codex.tasks=[{id,status:'running'}];f.panel.update(f.props);
  assert.deepEqual(calls,[]);assert.equal(f.button('切到正在运行的任务窗口').props.disabled,false);
  f.button('切到正在运行的任务窗口').props.onClick();await f.ui.settle(f.panel);
  assert.deepEqual(calls,[{op:'windowsAgentAction',source:'codex',action:'focusTask',id}]);
  assert.match(textOf(f.panel.tree),/已切到核对的任务终端/);
  f.panel.update({...f.props,source:'claude'});assert.equal(f.button('切到正在运行的任务窗口'),undefined);f.panel.unmount();
});
