import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,walkAll,textOf,deferred,plain} from './helpers/source-ui-vm.mjs';

const stub=name=>Object.defineProperty(()=>null,'name',{value:name});
const state=()=>({settings:{codexEnabled:false,claudeEnabled:false},device:{connected:true,transport:'USB',readOnly:false,modelId:'kick75',firmware:'4.0.18.6',connectionSessionId:'fixture:1',keyRecovery:{pending:true,unownedHistory:true}},playback:{},layout:[]});
const preview=()=>({token:'private-preview-token',canConfirm:true,original:{model:'Kick75 ANSI',firmware:'4.0.18.6',serial:'private-serial',port:'private-port'},current:{model:'Kick75 ANSI',firmware:'4.0.18.6'},checks:[{raw:'private-protocol'}]});
async function fixture({current=state(),language='zh-CN',handler=body=>body.op==='previewFunctionKeyRecovery'?preview():{restored:true,verified:true},read}={}){
  const nodes={Button:stub('Button'),Modal:stub('Modal')},commands=[],closed=[];
  const ui=createVMEnvironment({'./primitives':{...nodes,run:promise=>promise.catch(()=>{})},'./i18n':{useLanguage:()=>language},'./api':{readAppState:()=>read?read():Promise.resolve(current)}});
  const command=async body=>{commands.push(plain(body));return handler(body);};
  const Component=(await ui.load(new URL('../ui/src/FunctionKeyRecoveryDialog.tsx',import.meta.url))).exports.FunctionKeyRecoveryDialog;
  const props={state:current,command,onClose:()=>closed.push(true)},instance=ui.mount(Component,props);
  const all=()=>[instance.tree,instance.tree?.props.footer];
  const find=predicate=>walkAll(all(),predicate)[0];
  const button=label=>find(node=>node.type===nodes.Button&&textOf(node)===label);
  const checkbox=()=>find(node=>node.type==='input'&&node.props.type==='checkbox');
  const flush=async()=>{for(let i=0;i<20;i++){await Promise.resolve();instance.render();}};
  const click=label=>{const node=button(label);assert.ok(node,`missing ${label}`);node.props.onClick();instance.render();};
  const check=()=>{assert.ok(checkbox());checkbox().props.onChange({target:{checked:true}});instance.render();};
  return{ui,nodes,commands,closed,current,props,instance,all,find,button,checkbox,flush,click,check,words:()=>textOf(all())};
}

test('recovery mounts with a read-only preview, requires a human checkbox, and never renders or stores private diagnostics',async()=>{
  const f=await fixture();await f.flush();assert.deepEqual(f.commands,[{op:'previewFunctionKeyRecovery'}]);
  assert.equal(f.instance.tree.props.width,460);assert.equal(f.instance.tree.props.initialFocus,'title');
  assert.equal(f.checkbox().props.checked,false);assert.equal(f.button('恢复原功能').props.disabled,true);
  f.click('恢复原功能');await f.flush();assert.equal(f.commands.length,1,'even invoking the disabled callback cannot confirm');
  assert.match(f.words(),/Kick75/);assert.match(f.words(),/4\.0\.18\.6/);
  const rendered=JSON.stringify(f.all());for(const secret of['private-preview-token','private-serial','private-port','private-protocol'])assert.equal(rendered.includes(secret),false);
  assert.equal(f.ui.storage.size,0);assert.equal(f.ui.sessionStorage.size,0);f.instance.unmount();
});

test('human confirmation consumes the token once and only a fully verified restoration is success',async()=>{
  const wait=deferred();const f=await fixture({handler:body=>body.op==='previewFunctionKeyRecovery'?preview():wait.promise});await f.flush();f.check();assert.equal(f.button('恢复原功能').props.disabled,false);
  const old=f.button('恢复原功能');old.props.onClick();old.props.onClick();f.instance.render();await f.flush();
  assert.deepEqual(f.commands,[{op:'previewFunctionKeyRecovery'},{op:'confirmFunctionKeyRecovery',token:'private-preview-token',confirmSameKeyboard:true}]);
  f.instance.tree.props.onClose();assert.deepEqual(f.closed,[],'the write in flight cannot be dismissed');
  wait.resolve({restored:true,verified:true});await f.flush();assert.match(f.words(),/F4 已恢复为原来的功能/);assert.ok(f.button('完成'));f.click('完成');assert.equal(f.closed.length,1);f.instance.unmount();
});

for(const bad of[{restored:true},{verified:true},{restored:false,verified:true},null])test(`incomplete restore receipt ${JSON.stringify(bad)} requires a fresh preview and a new human confirmation`,async()=>{
  const f=await fixture({handler:body=>body.op==='previewFunctionKeyRecovery'?preview():bad});await f.flush();f.check();f.click('恢复原功能');await f.flush();
  assert.equal(f.button('完成'),undefined);assert.match(f.words(),/暂时无法确认恢复结果/);assert.equal(f.checkbox(),undefined);assert.equal(f.button('恢复原功能').props.disabled,true);
  f.click('恢复原功能');await f.flush();assert.equal(f.commands.length,2);f.click('重新检查');await f.flush();assert.equal(f.checkbox().props.checked,false);assert.equal(f.commands.length,3);f.instance.unmount();
});

for(const bad of[{canConfirm:false},{token:null},{original:{model:'Other private-serial',firmware:'4.0.18.6'}},{current:{model:'Kick75 ANSI',firmware:'4.0.1.1'}}])test(`failed preview boundary ${Object.keys(bad)[0]} never offers confirmation`,async()=>{
  const f=await fixture({handler:()=>({...preview(),...bad})});await f.flush();assert.equal(f.checkbox(),undefined);assert.equal(f.button('恢复原功能').props.disabled,true);assert.equal(f.commands.length,1);assert.equal(f.words().includes('private-serial'),false);f.instance.unmount();
});

for(const enabled of['codexEnabled','claudeEnabled'])test(`active ${enabled} prevents preview and explains the mode-off requirement`,async()=>{
  const current=state();current.settings[enabled]=true;const f=await fixture({current});await f.flush();assert.deepEqual(f.commands,[]);assert.match(f.words(),/请先关闭/);assert.equal(f.button('重新检查').props.disabled,true);f.instance.unmount();
});

test('a fresh state read blocks confirmation if the mode or keyboard changed before the next poll',async()=>{
  for(const change of['mode','session','model']){
    const fresh=state();if(change==='mode')fresh.settings.codexEnabled=true;else if(change==='session')fresh.device.connectionSessionId='fixture:2';else fresh.device.modelId='air75-v3';
    const f=await fixture({read:async()=>fresh});await f.flush();f.check();f.click('恢复原功能');await f.flush();assert.equal(f.commands.length,1);assert.match(f.words(),/键盘连接或模式已改变/);assert.equal(f.checkbox(),undefined);f.instance.unmount();
  }
});

test('context changes invalidate both pending previews and confirmations, including late successful replies',async()=>{
  for(const phase of['preview','confirm'])for(const change of['mode','session','model','disconnect','service']){
    const wait=deferred(),f=await fixture({handler:body=>body.op==='previewFunctionKeyRecovery'?(phase==='preview'?wait.promise:preview()):wait.promise});
    if(phase==='confirm'){await f.flush();f.check();f.click('恢复原功能');await f.flush();assert.equal(f.commands.length,2);}
    if(change==='mode')f.current.settings.claudeEnabled=true;else if(change==='session')f.current.device.connectionSessionId='fixture:2';else if(change==='model')f.current.device.modelId='air75-v3';else if(change==='disconnect')f.current.device.connected=false;else f.props.serviceError='unavailable';
    f.instance.update(f.props);wait.resolve(phase==='preview'?preview():{restored:true,verified:true});await f.flush();assert.equal(f.checkbox(),undefined);assert.equal(f.button('完成'),undefined);assert.equal(f.button('恢复原功能').props.disabled,true);f.instance.unmount();
  }
});

test('unmounting discards late preview and confirm replies without callbacks or another command',async()=>{
  for(const phase of['preview','confirm']){
    const wait=deferred(),f=await fixture({handler:body=>body.op==='previewFunctionKeyRecovery'?(phase==='preview'?wait.promise:preview()):wait.promise});
    if(phase==='confirm'){await f.flush();f.check();f.click('恢复原功能');await f.flush();}
    const count=f.commands.length;f.instance.unmount();wait.resolve(phase==='preview'?preview():{restored:true,verified:true});for(let i=0;i<20;i++)await Promise.resolve();
    assert.equal(f.commands.length,count);assert.deepEqual(f.closed,[]);assert.equal(f.instance.hooks.some(h=>h?.kind==='state'&&h.value===true),false,'no late success or checkbox state');
  }
});

test('errors remain local and sanitized, retry does not carry the previous human confirmation, and English copy is available',async()=>{
  let attempts=0;const f=await fixture({language:'en',handler:()=>{if(++attempts===1)throw Error('private-preview-token private-serial');return preview();}});await f.flush();assert.match(f.words(),/The check did not finish/);assert.equal(f.words().includes('private-'),false);f.click('Check again');await f.flush();assert.equal(f.checkbox().props.checked,false);assert.match(f.words(),/same keyboard/);f.click('Cancel');assert.equal(f.closed.length,1);f.instance.unmount();
});

test('Device exposes the dialog for legacy pending F4 without blocking ordinary RGB or automatically confirming it',async()=>{
  const names=['Button','Keyboard','FunctionKeyRecoveryDialog'],nodes=Object.fromEntries(names.map(name=>[name,stub(name)])),commands=[];
  const ui=createVMEnvironment({'lucide-react':Object.fromEntries(['ArrowLeft','Bluetooth','Cable','ChevronRight','CircleAlert','RotateCcw','Unplug'].map(name=>[name,stub(name)])),
    './primitives':{Button:nodes.Button,run:promise=>promise.catch(()=>{})},'./Keyboard':{Keyboard:nodes.Keyboard},'./FunctionKeyRecoveryDialog':{FunctionKeyRecoveryDialog:nodes.FunctionKeyRecoveryDialog},
    './StartupGuide':{firmwarePrompt:()=>null,showFirmwareGuide(){},useStartupCopy:()=>zh=>zh},'./KeyRecoveryPanel':{friendlyConnectionError:value=>value,keyRecoveryProblem:()=>null},'./codexKeys':{nativeCodexKeys:async()=>{}},'./connection-copy-v7':{connectionCopy:value=>value}});
  const Device=(await ui.load(new URL('../ui/src/Device.tsx',import.meta.url))).exports.Device,current=state(),props={state:current,command:async body=>commands.push(body),serviceError:''},instance=ui.mount(Device,props);
  const find=predicate=>walkAll(instance.tree,predicate)[0],entry=find(n=>n.type===nodes.Button&&textOf(n)==='检查并恢复按键'),lighting=find(n=>n.type===nodes.Button&&textOf(n)==='恢复键盘原灯效');
  assert.ok(entry);assert.equal(entry.props.disabled,false);assert.equal(lighting.props.disabled,false);const focus={id:'fixture-trigger'};entry.props.onClick({currentTarget:focus});instance.render();
  const dialog=find(n=>n.type===nodes.FunctionKeyRecoveryDialog);assert.ok(dialog);assert.equal(dialog.props.returnFocus,focus);assert.equal(dialog.props.state,current);assert.deepEqual(commands,[]);
  current.device.keyRecovery.pending=false;instance.render();assert.ok(find(n=>n.type===nodes.FunctionKeyRecoveryDialog),'success can remain visible after pending clears');
  current.settings.codexEnabled=true;instance.render();assert.equal(find(n=>n.type===nodes.FunctionKeyRecoveryDialog),undefined);instance.unmount();
});
