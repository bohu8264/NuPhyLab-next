import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,walkAll,textOf,plain} from './helpers/source-ui-vm.mjs';
const file=new URL('../ui/src/SelectionLab.tsx',import.meta.url);
const providers=(await import('../ui/src/selection-providers.ts')).providers;
const configuration={provider:'deepSeek',endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',apiProtocol:'chatCompletions',imageInputConfirmed:false,maximumOutputTokens:4096};
async function fixture(patch={},component='SelectionLab'){
 let state={supported:true,ready:true,setupState:'ready',hasKey:true,screenRecording:true,accessibility:true,inputMonitoring:true,microphone:false,speechRecognition:false,shortcutRegistered:true,shortcutNotice:'',issue:'',phase:'idle',configurationIssue:'',preferences:{enabled:true,voiceEnabled:false,defaultAction:'translate',shortcut:{keyCode:0,modifiers:256,label:'⌃',modifierOnly:true},configuration:{...configuration}},...patch};
 const calls=[],events=[];let failure='',onStatus=null,onRecord=null;
 const ui=createVMEnvironment({'lucide-react':new Proxy({},{get:()=>()=>null}),'./primitives':{Button:()=>null},'./selection-providers':{providers}});
 ui.window.webkit={messageHandlers:{selectionLab:{postMessage:body=>{
  calls.push(plain(body));
  const result=(async()=>{
   if(body.op==='status'&&onStatus){onStatus(state);onStatus=null;}
   if(body.op==='recordShortcut'&&onRecord)onRecord(state);
   if(body.op===failure)throw Error('合成失败');
   if(body.op==='save'){state.preferences=plain(body.preferences);if(body.apiKey)state.hasKey=true;}
   if(body.op==='deleteKey')state.hasKey=false;
   if(body.op==='disableVoice'){state.preferences.voiceEnabled=false;state.ready=true;state.setupState='ready';}
   if(body.op==='refresh'){state.ready=true;state.shortcutRegistered=true;state.setupState='ready';}
   if(body.op==='models')return {models:['account-alpha','account-beta'],hasMore:false};
   if(body.op==='test')return {message:'合成测试成功'};
   if(body.op==='relaunch')return {relaunching:true};
   return structuredClone(state);
  })();ui.track(result);return result;
 }}}};
 ui.window.addEventListener('nuphylab:navigate',event=>events.push(event.detail));
 const module=await ui.load(file),instance=ui.mount(module.exports[component]);await ui.settle(instance);
 const find=predicate=>{const nodes=walkAll(instance.tree,predicate);assert.equal(nodes.length,1,'expected one matching control');return nodes[0];};
 return {ui,instance,calls,events,get state(){return state;},find,nextStatus(fn){onStatus=fn;},recordWith(fn){onRecord=fn;},fail(op){failure=op;},async focus(){ui.window.dispatchEvent({type:'focus'});await ui.settle(instance);},async click(label){const node=find(n=>n.props?.onClick&&textOf(n)===label);assert(!node.props.disabled);await node.props.onClick();await ui.settle(instance);},async change(id,value){find(n=>n.props?.id===id).props.onChange({target:{value}});await ui.settle(instance);},async toggle(label,value){const node=find(n=>n.props?.label===label);assert(!node.props.disabled);node.props.onChange(value);await ui.settle(instance);},close(){instance.unmount();}};
}
const content=f=>textOf(f.instance.tree);

test('true ready is required, even when every permission is granted',async()=>{
 for(const patch of [{ready:false,setupState:'monitorPaused',shortcutRegistered:false},{ready:false,setupState:'monitorPaused',shortcutRegistered:true},{ready:undefined,setupState:undefined,shortcutRegistered:true}]){
  const f=await fixture({...patch,microphone:true,speechRecognition:true});assert.doesNotMatch(content(f),/已就绪/);assert.match(content(f),/基础权限已允许/);
  assert(f.find(n=>n.type==='button'&&textOf(n)==='立即框选').props.disabled);assert(!f.calls.some(x=>x.op==='capture'));
  await f.click('重新检查');assert.match(content(f),/已就绪/);assert.equal(f.calls.filter(x=>x.op==='refresh').length,1);assert(!f.calls.some(x=>x.op==='capture'));f.close();
 }
});
test('permission page separates authorized rows and actual selection readiness',async()=>{
 const f=await fixture({ready:false,setupState:'monitorPaused',shortcutRegistered:false,microphone:true,speechRecognition:true},'SelectionPermissionSettings');assert.match(content(f),/已允许/);assert.match(content(f),/监听已暂停/);assert.doesNotMatch(content(f),/已就绪/);await f.click('重新检查');assert.match(content(f),/已就绪/);f.close();
});
test('secure input is reported accurately and never captures during refresh',async()=>{
 const f=await fixture({ready:false,setupState:'secureInput'});assert.match(content(f),/安全输入中/);assert.doesNotMatch(content(f),/已就绪/);assert(f.find(n=>n.type==='button'&&textOf(n)==='立即框选').props.disabled);assert(!f.calls.some(x=>x.op==='capture'));f.close();
});
test('voice can be disabled to continue text without requesting audio permission',async()=>{
 const f=await fixture({ready:false,setupState:'permissions'});f.state.preferences.voiceEnabled=true;await f.focus();assert.match(content(f),/语音权限待开启/);await f.click('关闭语音，继续文字框选');assert.equal(f.state.preferences.voiceEnabled,false);assert.match(content(f),/已就绪/);assert(!f.calls.some(x=>['permission','capture'].includes(x.op)));f.close();
});
test('relaunch remains explicit and does not immediately query a stopping app',async()=>{
 const f=await fixture({ready:false,needsRelaunch:true,setupState:'relaunch'});assert.match(content(f),/等待重新打开/);assert(!f.calls.some(x=>x.op==='relaunch'));await f.click('完成授权并重新打开');assert.equal(f.calls.at(-1).op,'relaunch');f.close();
});
test('missing API goes directly to settings without capture, preserves default configuration',async()=>{
 const f=await fixture({hasKey:false,configurationIssue:'请先配置模型',ready:false});f.state.preferences.enabled=false;await f.focus();await f.click('配置模型');assert.deepEqual(f.events,['ai']);assert(!f.calls.some(x=>x.op==='capture'));await f.toggle('开启框选提问',true);assert.equal(f.state.preferences.enabled,true);assert.deepEqual(f.events,['ai','ai']);f.close();
});
test('unsupported system disables selection controls without ready claims',async()=>{
 const f=await fixture({supported:false,ready:false,setupState:'unsupported'});assert.match(content(f),/macOS 14/);assert(f.find(n=>n.props?.label==='开启框选提问').props.disabled);assert(f.find(n=>n.props?.label==='发送选区图片').props.disabled);assert.doesNotMatch(content(f),/已就绪/);f.close();
});
test('image consent is directly below voice and changes only that configuration field',async()=>{
 const f=await fixture();const switches=walkAll(f.instance.tree,n=>n.props?.label&&n.props?.onChange).map(n=>n.props.label);assert.deepEqual(switches,['开启框选提问','开启按住说话','发送选区图片']);
 f.nextStatus(s=>{s.preferences.configuration.maximumOutputTokens=8192;s.preferences.configuration.anthropicWorkspaceID='keep-workspace';s.preferences.defaultAction='explain';});
 // Turning off must preserve even a concurrently changed credential scope.
 await f.toggle('发送选区图片',false);assert.equal(f.state.preferences.configuration.maximumOutputTokens,8192);assert.equal(f.state.preferences.configuration.anthropicWorkspaceID,'keep-workspace');assert.equal(f.state.preferences.defaultAction,'explain');
 const saved=f.calls.find(x=>x.op==='save');assert.equal(saved.apiKey,undefined);assert.equal(saved.preferences.configuration.endpoint,configuration.endpoint);assert.equal(saved.preferences.configuration.model,configuration.model);f.close();
});
test('explicit image consent is never silently applied to a newly changed model',async()=>{
 const f=await fixture();f.nextStatus(s=>{s.preferences.configuration.model='changed-by-other-view';s.preferences.configuration.endpoint='https://new.example.invalid/v1/chat/completions';});await f.toggle('发送选区图片',true);assert.equal(f.state.preferences.configuration.imageInputConfirmed,false);assert(!f.calls.some(x=>x.op==='save'));assert.match(content(f),/模型设置已更新/);f.close();
});
test('turning images off preserves latest provider, model, endpoint, workspace and voice',async()=>{
 const f=await fixture();f.state.preferences.configuration.imageInputConfirmed=true;await f.focus();f.nextStatus(s=>{s.preferences.configuration={provider:'anthropic',endpoint:'https://new.example.invalid/v1/messages',model:'external-claude',apiProtocol:'anthropicMessages',anthropicWorkspaceID:'external-workspace',maximumOutputTokens:6000,imageInputConfirmed:true};s.preferences.voiceEnabled=true;});await f.toggle('发送选区图片',false);assert.deepEqual(f.state.preferences.configuration,{provider:'anthropic',endpoint:'https://new.example.invalid/v1/messages',model:'external-claude',apiProtocol:'anthropicMessages',anthropicWorkspaceID:'external-workspace',maximumOutputTokens:6000,imageInputConfirmed:false});assert.equal(f.state.preferences.voiceEnabled,true);assert.equal(f.calls.at(-1).apiKey,undefined);f.close();
});
test('relaunch remains available even when selection is disabled',async()=>{
 const f=await fixture({needsRelaunch:true,ready:false,setupState:'disabled'});f.state.preferences.enabled=false;await f.focus();await f.click('完成授权并重新打开');assert.equal(f.calls.at(-1).op,'relaunch');f.close();
});
test('explicit same-model image consent saves latest other preferences and can be turned off',async()=>{
 const f=await fixture();f.nextStatus(s=>{s.preferences.configuration.maximumOutputTokens=8192;s.preferences.defaultAction='summarize';});await f.toggle('发送选区图片',true);assert.equal(f.state.preferences.configuration.imageInputConfirmed,true);assert.equal(f.state.preferences.configuration.maximumOutputTokens,8192);assert.equal(f.state.preferences.defaultAction,'summarize');await f.toggle('发送选区图片',false);assert.equal(f.state.preferences.configuration.imageInputConfirmed,false);f.close();
});
test('feature changes merge latest API and shortcut values instead of stale snapshots',async()=>{
 const f=await fixture();f.nextStatus(s=>{s.preferences.configuration.endpoint='https://latest.example.invalid/v1/chat/completions';s.preferences.shortcut.label='⌥ Q';});await f.toggle('开启按住说话',true);assert.equal(f.state.preferences.configuration.endpoint,'https://latest.example.invalid/v1/chat/completions');assert.equal(f.state.preferences.shortcut.label,'⌥ Q');f.close();
});
test('API form has no duplicate image switch and preserves saved custom values',async()=>{
 const f=await fixture({},'SelectionAPISettings');f.state.preferences.configuration={...configuration,endpoint:'https://custom.example.invalid/v1/chat/completions',model:'team-private-model'};await f.focus();assert.equal(f.find(n=>n.props?.id==='models-model-id').props.value,'team-private-model');assert.equal(f.find(n=>n.props?.id==='models-endpoint').props.value,'https://custom.example.invalid/v1/chat/completions');assert.equal(walkAll(f.instance.tree,n=>n.props?.label==='确认模型支持图片'||n.props?.label==='发送选区图片').length,0);assert(!f.calls.some(x=>x.op==='save'));f.close();
});
test('provider, endpoint, protocol, workspace all clear a new typed key',async()=>{
 for(const [id,value] of [['models-provider','openAI'],['models-endpoint','https://new.example.invalid/v1/chat/completions'],['models-protocol','anthropicMessages'],['models-workspace','next-workspace']]){
  const f=await fixture({},'SelectionAPISettings');if(id==='models-workspace'){await f.change('models-provider','anthropic');}
  await f.change('models-key','synthetic-only-key');await f.change(id,value);assert.equal(f.find(n=>n.props?.id==='models-key').props.value,'');assert(f.find(n=>n.props?.onClick&&textOf(n)==='测试连接').props.disabled);f.close();
 }
});
test('API save retains latest image consent for the same model, new model always resets it',async()=>{
 const f=await fixture({},'SelectionAPISettings');await f.change('models-tokens','8000');f.nextStatus(s=>{s.preferences.configuration.imageInputConfirmed=true;s.preferences.voiceEnabled=true;});await f.click('保存设置');assert.equal(f.state.preferences.configuration.imageInputConfirmed,true);assert.equal(f.state.preferences.voiceEnabled,true);await f.click('手填 ID');await f.change('models-model-id','another-model');await f.click('保存设置');assert.equal(f.state.preferences.configuration.imageInputConfirmed,false);assert.equal(f.state.preferences.configuration.model,'another-model');f.close();
});
test('account fetch preserves selected model and provides searchable options',async()=>{
 const f=await fixture({},'SelectionAPISettings');await f.click('读取账户模型');const picker=f.find(n=>typeof n.type==='function'&&n.type.name==='ModelPicker');assert.equal(picker.props.value,'deepseek-flash');assert(picker.props.items.includes('account-alpha'));assert(picker.props.items.includes('account-beta'));assert.equal(f.calls.filter(x=>x.op==='models').length,1);assert.match(content(f),/可在模型列表中搜索/);f.close();
});
test('model picker filters and makes exactly one keyboard selection; Escape closes',async()=>{
 const f=await fixture({},'SelectionAPISettings');await f.click('读取账户模型');const child=f.find(n=>typeof n.type==='function'&&n.type.name==='ModelPicker');const selected=[];const picker=f.ui.mount(child.type,{...child.props,onChange:value=>selected.push(value)});
 const find=pred=>walkAll(picker.tree,pred)[0];find(n=>n.props?.id==='models-model-trigger').props.onClick();picker.render();let search=find(n=>n.props?.['aria-label']==='搜索模型');search.props.onChange({target:{value:'ACCOUNT-B'}});picker.render();const options=walkAll(picker.tree,n=>n.props?.role==='option');assert.equal(options.length,1);assert.equal(textOf(options[0]).includes('account-beta'),true);search=find(n=>n.props?.['aria-label']==='搜索模型');search.props.onKeyDown({key:'Enter',preventDefault(){}});picker.render();assert.deepEqual(selected,['account-beta']);assert.equal(find(n=>n.props?.id==='models-model-trigger').props['aria-expanded'],false);
 find(n=>n.props?.id==='models-model-trigger').props.onClick();picker.render();picker.tree.props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});picker.render();assert.equal(find(n=>n.props?.id==='models-model-trigger').props['aria-expanded'],false);picker.unmount();f.close();
});
test('Qwen uses expanded presets/manual IDs and never offers unsupported account read',async()=>{
 const f=await fixture({},'SelectionAPISettings');await f.change('models-provider','qwenChina');assert.equal(walkAll(f.instance.tree,n=>n.props?.onClick&&textOf(n)==='读取账户模型').length,0);const picker=f.find(n=>typeof n.type==='function'&&n.type.name==='ModelPicker');assert.equal(picker.props.items.length,6);assert.equal(picker.props.value,'qwen-plus');assert.match(content(f),/此服务使用预设或手填 ID/);f.close();
});
test('save success and account request failure remain distinguishable',async()=>{
 const f=await fixture({},'SelectionAPISettings');f.fail('models');await f.click('读取账户模型');assert.match(content(f),/设置已保存；合成失败/);f.close();
});
test('old key deletion is refused when saved credential scope changed externally',async()=>{
 const f=await fixture({},'SelectionAPISettings');f.nextStatus(s=>{s.preferences.configuration.endpoint='https://external.example.invalid/v1/chat/completions';});await f.click('移除密钥');assert(!f.calls.some(x=>x.op==='deleteKey'));assert.match(content(f),/服务配置已更新/);f.close();
});

// Recording is native, so WebKit focus or browser mouse navigation cannot turn
// a button number into a keyboard key. The UI preserves the resulting binding.
test('side-button recorder result stays selected and survives unrelated preference changes',async()=>{
 const f=await fixture();const before=structuredClone(f.state.preferences.configuration);
 f.recordWith(s=>{s.preferences.shortcut={keyCode:0,modifiers:0,buttonIndex:3,label:'鼠标侧键 1'};});
 const button=f.find(n=>n.props?.['aria-label']==='录制框选快捷键');let focused=false;
 await button.props.onClick({currentTarget:{focus(){focused=true;}}});await f.ui.settle(f.instance);
 assert(focused);assert.equal(f.calls.filter(x=>x.op==='recordShortcut').length,1);
 assert.match(content(f),/鼠标侧键 1/);assert.match(content(f),/键盘快捷键或鼠标侧键/);
 await f.toggle('开启按住说话',true);
 assert.equal(f.state.preferences.shortcut.buttonIndex,3);assert.deepEqual(f.state.preferences.configuration,before);
 assert(!f.calls.some(x=>['capture','permission','test'].includes(x.op)));f.close();
});
test('cancelled native recording leaves the old shortcut and re-enables the control',async()=>{
 const f=await fixture(),before=structuredClone(f.state.preferences.shortcut);f.fail('recordShortcut');
 await f.find(n=>n.props?.['aria-label']==='录制框选快捷键').props.onClick({currentTarget:{focus(){}}});await f.ui.settle(f.instance);
 assert.deepEqual(f.state.preferences.shortcut,before);
 assert(!f.find(n=>n.props?.['aria-label']==='录制框选快捷键').props.disabled);f.close();
});

test('Reply is a fourth persisted action and preserves the latest side-button and voice settings',async()=>{
 const f=await fixture();const group=f.find(n=>n.props?.['aria-label']==='默认框选动作');
 assert.deepEqual(walkAll(group,n=>n.type==='button').map(textOf),['翻译','总结','解释','回复']);
 f.nextStatus(s=>{s.preferences.shortcut={keyCode:0,modifiers:0,buttonIndex:4,label:'鼠标侧键 2'};s.preferences.configuration.model='latest-model';s.preferences.voiceEnabled=true;});
 await f.click('回复');assert.equal(f.state.preferences.defaultAction,'reply');assert.equal(f.state.preferences.shortcut.buttonIndex,4);assert.equal(f.state.preferences.configuration.model,'latest-model');assert(f.state.preferences.voiceEnabled);
 assert(f.find(n=>n.type==='button'&&textOf(n)==='回复').props['aria-pressed']);assert.match(content(f),/结合选中内容和口述要求生成回复/);
 assert(!f.calls.some(x=>['capture','permission','test'].includes(x.op)));f.close();
});
