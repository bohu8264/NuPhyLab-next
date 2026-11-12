import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,walkAll,textOf,plain} from './helpers/source-ui-vm.mjs';

async function fixture(patch={},component='SelectionLab') {
 const commands=[],events=[];let failure=false;
 let state={supported:true,hasKey:false,screenRecording:false,accessibility:false,inputMonitoring:false,microphone:false,speechRecognition:false,
  shortcutRegistered:false,shortcutNotice:'',issue:'',phase:'等待框选',configurationIssue:'请先配置模型',
  preferences:{enabled:false,voiceEnabled:false,defaultAction:'translate',shortcut:{keyCode:12,modifiers:2560,label:'⌥ ⇧ Q'},
   configuration:{provider:'deepSeek',endpoint:'https://api.deepseek.com/chat/completions',model:'fixture',apiProtocol:'chatCompletions',imageInputConfirmed:false,maximumOutputTokens:4096}},...patch};
 const ui=createVMEnvironment({'lucide-react':new Proxy({},{get:()=>()=>null}),'./primitives':{Button:()=>null},'./selection-providers':{providers:[]}});
 ui.window.webkit={messageHandlers:{selectionLab:{postMessage:body=>{
  commands.push(plain(body));
  const result=(async()=>{if(failure)throw Error('权限检查暂不可用');if(body.op==='save')state.preferences=plain(body.preferences);if(body.op==='disableVoice')state.preferences.voiceEnabled=false;return structuredClone(state);})();
  ui.track(result);return result;
 }}}};
 ui.window.addEventListener('nuphylab:navigate',event=>events.push(event.detail));
 const module=await ui.load(new URL('../ui/src/SelectionLab.tsx',import.meta.url));
 const instance=ui.mount(module.exports[component]);await ui.settle(instance);
 return {ui,instance,commands,events,get state(){return state;},setState(next){state={...state,...next};},fail(){failure=true;},async focus(){ui.window.dispatchEvent({type:'focus'});await ui.settle(instance);},async click(label){const node=walkAll(instance.tree,n=>n.props?.onClick&&textOf(n).includes(label))[0];assert(node,label);await node.props.onClick();await ui.settle(instance);},close(){instance.unmount();}};
}
test('fresh selection setup stays off, has no credential, and directs configuration before capture',async()=>{
 const f=await fixture();assert.match(textOf(f.instance.tree),/尚未配置/);assert.match(textOf(f.instance.tree),/已关闭/);
 assert(!f.commands.some(x=>['capture','permission','save','test'].includes(x.op)));
 const configure=walkAll(f.instance.tree,n=>textOf(n).trim()==='配置模型'&&n.type==='button')[0];assert.equal(configure.props.disabled,false);
 await configure.props.onClick();await f.ui.settle(f.instance);assert.deepEqual(f.events,['ai']);f.events.length=0;
 await f.click('设置');assert.deepEqual(f.events,['ai']);f.close();
});
test('voice-denied setup offers a text-only route without requesting audio access',async()=>{
 const f=await fixture({hasKey:true,configurationIssue:'',accessibility:true,inputMonitoring:true,screenRecording:true});
 f.state.preferences.enabled=true;f.state.preferences.voiceEnabled=true;await f.focus();assert.match(textOf(f.instance.tree),/语音权限待开启/);
 await f.click('关闭语音，继续文字框选');assert.equal(f.state.preferences.voiceEnabled,false);assert.doesNotMatch(textOf(f.instance.tree),/语音尚未授权/);
 assert(!f.commands.some(x=>x.op==='permission'||x.op==='capture'));f.close();
});
test('permission page distinguishes denied audio and stale live grants, and reopens only on explicit click',async()=>{
 const f=await fixture({needsRelaunch:true,accessibility:true,inputMonitoring:true,screenRecording:true,microphoneState:'denied',speechRecognitionState:'restricted'},'SelectionPermissionSettings');
 assert.match(textOf(f.instance.tree),/已拒绝/);assert.match(textOf(f.instance.tree),/受系统限制/);assert.match(textOf(f.instance.tree),/已允许/);assert.match(textOf(f.instance.tree),/需要重新打开后生效/);
 assert.doesNotMatch(textOf(f.instance.tree),/已就绪/);
 assert(!f.commands.some(x=>x.op==='relaunch'));await f.click('完成授权并重新打开');assert.equal(f.commands.filter(x=>x.op==='relaunch').length,1);f.close();
});
test('fresh permission setup does not offer a restart before authorization',async()=>{
 const f=await fixture({},'SelectionPermissionSettings');
 assert.match(textOf(f.instance.tree),/前往授权/);
 assert.doesNotMatch(textOf(f.instance.tree),/完成授权并重新打开/);
 f.close();
});
test('returning from System Settings refreshes the permission snapshot and read failure becomes unknown',async()=>{
 const f=await fixture({},'SelectionPermissionSettings');f.setState({accessibility:true,inputMonitoring:true,screenRecording:true});await f.focus();assert.match(textOf(f.instance.tree),/已允许/);
 f.fail();await f.focus();assert.match(textOf(f.instance.tree),/状态未知/);assert.match(textOf(f.instance.tree),/权限检查暂不可用/);f.close();
});
test('macOS 13 feature gate disables selection entry without blocking keyboard UI',async()=>{
 const f=await fixture({supported:false,issue:'框选提问需要 macOS 14 或更新版本；键盘功能可继续使用。'});
 assert.match(textOf(f.instance.tree),/键盘功能可继续使用/);
 const enable=walkAll(f.instance.tree,n=>n.props?.label==='开启框选提问')[0];assert.equal(enable.props.disabled,true);f.close();
});
