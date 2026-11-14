import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVMEnvironment,walkAll,textOf,plain} from './helpers/source-ui-vm.mjs';
import {translate} from '../shared/i18n.mjs';
import {displayPresetName} from '../shared/preset-names.mjs';
import {createPresets} from '../shared/presets.mjs';
import {airLayout,kickLayout} from '../shared/layout.mjs';
import {translationLanguages} from '../ui/src/selection-languages.ts';
import {providers} from '../ui/src/selection-providers.ts';
import selectionMessages from '../shared/selection-messages.json' with {type:'json'};

const han=/[\u3400-\u9fff]/;
const file=new URL('../ui/src/SelectionLab.tsx',import.meta.url);
const config={provider:'deepSeek',endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',apiProtocol:'chatCompletions',imageInputConfirmed:false,maximumOutputTokens:4096};
async function fixture(patch={},component='SelectionLab'){
 let state={supported:true,ready:true,setupState:'ready',hasKey:true,screenRecording:true,accessibility:true,inputMonitoring:true,microphone:true,speechRecognition:true,shortcutRegistered:true,shortcutNotice:'',issue:'',phase:'等待框选',configurationIssue:'',preferences:{enabled:true,voiceEnabled:true,defaultAction:'translate',shortcut:{keyCode:0,modifiers:256,label:'⌃',modifierOnly:true},configuration:{...config}},...patch};
 const calls=[];let nextStatus;
 const ui=createVMEnvironment({'lucide-react':new Proxy({},{get:()=>()=>null}),'./primitives':{Button:()=>null},'./selection-providers':{providers}});
 ui.document.documentElement.lang='en';
 ui.window.webkit={messageHandlers:{selectionLab:{postMessage:body=>{
  calls.push(plain(body));const result=(async()=>{
   if(body.op==='status'&&nextStatus){nextStatus(state);nextStatus=null;}
   if(body.op==='save')state.preferences=plain(body.preferences);
   if(body.op==='models')return {models:['account-fixture'],hasMore:true};
   return structuredClone(state);
  })();ui.track(result);return result;
 }}}};
 const loaded=await ui.load(file);let instance=ui.mount(loaded.exports[component]);await ui.settle(instance);
 const find=predicate=>{const found=walkAll(instance.tree,predicate);assert.equal(found.length,1);return found[0];};
 return {ui,get instance(){return instance;},state,calls,find,next(fn){nextStatus=fn;},async remount(){instance.unmount();instance=ui.mount(loaded.exports[component]);await ui.settle(instance);},async change(id,value){find(n=>n.props?.id===id).props.onChange({target:{value}});await ui.settle(instance);},async click(label){await find(n=>n.props?.onClick&&textOf(n)===label).props.onClick();await ui.settle(instance);},close(){instance.unmount();}};
}
function englishOnly(tree){
 // The requested language endonym is the single deliberate exception.
 assert.doesNotMatch(textOf(tree).replaceAll('简体中文',''),han,textOf(tree));
 for(const node of walkAll(tree,n=>textOf(n)==='简体中文'))if(node.type==='option')assert.equal(node.props.value,'zh-CN');
 for(const node of walkAll(tree,()=>true))for(const key of ['aria-label','label','title','placeholder'])if(typeof node.props?.[key]==='string')assert.doesNotMatch(node.props[key],han,key+': '+node.props[key]);
}

test('all selection pages render English across ready, first-run, permission and error states',async()=>{
 for(const component of ['SelectionLab','SelectionAPISettings','SelectionPermissionSettings'])for(const patch of [
  {},{hasKey:false,ready:false,configurationIssue:'请先配置模型'},
  {ready:false,accessibility:false,screenRecording:false,inputMonitoring:false,microphone:false,speechRecognition:false,setupState:'permissions'},
  {ready:false,needsRelaunch:true,microphoneState:'denied',speechRecognitionState:'restricted'},
  {ready:false,setupState:'secureInput',issue:'当前输入受到系统保护，结束安全输入后可重新检查。'},
  {ready:false,setupState:'monitorPaused',shortcutRegistered:false},
  {ready:false,supported:false,issue:'智能框选需要 macOS 14 或更新版本；键盘功能可继续使用。'},
 ]){
  const f=await fixture(patch,component);englishOnly(f.instance.tree);f.close();
 }
});
test('translation target defaults safely, persists independently and merges the latest model and shortcut settings',async()=>{
 const f=await fixture();const target=()=>f.find(n=>n.props?.id==='selection-translation-language');
 assert.equal(target().props.value,'zh-CN');const options=walkAll(target(),n=>n.type==='option');assert.equal(options.length,16);
 assert.deepEqual(options.map(n=>n.props.value),translationLanguages.map(x=>x.id));
 assert.deepEqual(options.slice(0,5).map(textOf),['简体中文','Traditional Chinese','English','Japanese','Korean']);
 f.next(s=>{s.preferences.configuration.model='newer-model';s.preferences.configuration.maximumOutputTokens=8000;s.preferences.shortcut.label='⌥ Q';s.preferences.voiceEnabled=false;});
 await f.change('selection-translation-language','ja');assert.equal(f.state.preferences.translationLanguage,'ja');
 assert.equal(f.state.preferences.configuration.model,'newer-model');assert.equal(f.state.preferences.configuration.maximumOutputTokens,8000);assert.equal(f.state.preferences.shortcut.label,'⌥ Q');assert.equal(f.state.preferences.voiceEnabled,false);
 const saved=f.calls.find(x=>x.op==='save');assert.equal(saved.apiKey,undefined);assert(!f.calls.some(x=>['capture','test','permission','deleteKey'].includes(x.op)));
 await f.remount();assert.equal(target().props.value,'ja');englishOnly(f.instance.tree);
 f.ui.document.documentElement.lang='zh-CN';f.instance.render();assert.equal(target().props.value,'ja');assert.match(textOf(f.instance.tree),/翻译为/);assert.equal(f.calls.filter(x=>x.op==='save').length,1);f.close();
});
test('model catalog controls and region choices stay English, including dynamic result counts',async()=>{
 const f=await fixture({},'SelectionAPISettings');await f.click('List account models');englishOnly(f.instance.tree);
 const child=f.find(n=>typeof n.type==='function'&&n.type.name==='ModelPicker');const picker=f.ui.mount(child.type,child.props);
 walkAll(picker.tree,n=>n.props?.id==='models-model-trigger')[0].props.onClick();picker.render();englishOnly(picker.tree);picker.unmount();
 await f.change('models-provider','qwenChina');englishOnly(f.instance.tree);assert.match(textOf(f.instance.tree),/Qwen · Beijing/);assert.match(textOf(f.instance.tree),/Qwen · Singapore/);f.close();
});
test('native and WebKit system messages share the same English vocabulary',async()=>{
 const source=await readFile(new URL('../native/selection/LabLocalization.swift',import.meta.url),'utf8');
 const pairs=[...source.matchAll(/^\s*("(?:[^"\\]|\\.)*"):("(?:[^"\\]|\\.)*")[,]?$/gm)].map(([,a,b])=>[JSON.parse(a),JSON.parse(b)]);
 assert.deepEqual(Object.fromEntries(pairs),selectionMessages);
 for(const [zh,en] of pairs){assert.doesNotMatch(en,han,zh);assert.equal(translate('en',zh),en);}
});
test('existing Chinese preset titles display in English without changing artwork data or custom names',()=>{
 for(const layout of [airLayout,kickLayout])for(const preset of createPresets(layout)){
  const copy=structuredClone(preset),english=displayPresetName(preset.name,value=>translate('en',value));assert.doesNotMatch(english,han);
  assert.equal(displayPresetName(english,value=>value),preset.name);assert.deepEqual(preset,copy);
 }
 assert.equal(displayPresetName('一石二鸟',value=>translate('en',value)),'One stone, two birds');
 for(const name of ['设置','我的灯效','中文任务 · 作品库'])assert.equal(displayPresetName(name,value=>translate('en',value)),name);
});
test('changing the app language updates the native HUD immediately without requesting capture or changing preferences',async()=>{
 const calls=[];const ui=createVMEnvironment({'../../shared/i18n.mjs':{translate}});
 ui.window.webkit={messageHandlers:{selectionLab:{postMessage:body=>{calls.push(plain(body));return Promise.resolve({});}}}};
 const module=(await ui.load(new URL('../ui/src/i18n.ts',import.meta.url))).exports;
 module.setLanguage('en');module.setLanguage('en');module.setLanguage('zh-CN');
 assert.deepEqual(calls,[{op:'language',language:'en'},{op:'language',language:'zh-CN'}]);assert.equal(ui.document.documentElement.lang,'zh-CN');
});

test('mouse shortcut names and recording hints render fully in English',async()=>{
 const f=await fixture();f.state.preferences.shortcut={keyCode:0,modifiers:0,buttonIndex:4,label:'Mouse side button 2'};
 await f.remount();englishOnly(f.instance.tree);assert.match(textOf(f.instance.tree),/Mouse side button 2/);
 assert.match(textOf(f.instance.tree),/keyboard shortcut or mouse side button/);
 f.state.setupState='recording';f.state.ready=false;await f.remount();englishOnly(f.instance.tree);
 assert.match(textOf(f.instance.tree),/Release to save; Esc to cancel/);f.close();
});

test('Reply action and its explanation are fully localized and can be selected in English',async()=>{
 const f=await fixture();await f.click('Reply');englishOnly(f.instance.tree);
 assert.equal(f.state.preferences.defaultAction,'reply');assert.match(textOf(f.instance.tree),/Draft a reply from the selection and your spoken requirements/);
 f.ui.document.documentElement.lang='zh-CN';f.instance.render();assert.match(textOf(f.instance.tree),/回复/);assert.equal(f.state.preferences.defaultAction,'reply');f.close();
});

test('Smart Selection renders four English actions and no retired controls',async()=>{
 const f=await fixture();await f.click('Reply');englishOnly(f.instance.tree);assert.equal(f.state.preferences.defaultAction,'reply');
 assert.match(textOf(f.instance.tree),/Enable Smart Selection/);assert.match(textOf(f.instance.tree),/Enabled actions/);assert(!/Identify|Enhanced identification|Reference source/.test(textOf(f.instance.tree)));
 const item=walkAll(f.instance.tree,n=>n.type==='input'&&n.props?.['aria-label']==='Explain')[0];item.props.onChange();await f.ui.settle(f.instance);englishOnly(f.instance.tree);assert(!f.state.preferences.enabledActions.includes('explain'));f.close();
});
