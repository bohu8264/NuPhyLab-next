import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {voiceFixture} from './helpers/voice-input-fixture.mjs';
import {appDraftFixture} from './helpers/app-draft-fixture.mjs';
test('microphone and shortcut updates preserve unsaved dictionary and service drafts',async()=>{
 const f=await voiceFixture();await f.change('新词条','Unsent name');await f.click('AI 服务与权限');await f.change('服务商','deepseek');await f.change('语句整理模型','my-custom-model');await f.click('语音输入');await f.change('麦克风','fixture-mic');
 assert.equal(f.field('新词条').props.value,'Unsent name');await f.emit({settings:{...f.state.settings,shortcutKeyCode:58},shortcutLabel:'左 Option'});assert.equal(f.field('新词条').props.value,'Unsent name');
 await f.click('AI 服务与权限');assert.equal(f.field('服务商').props.value,'deepseek');assert.equal(f.field('语句整理模型').props.value,'my-custom-model');assert(!Object.hasOwn(f.requests.at(-1),'cleanupKey'));f.unmount();
});
test('dictionary save cannot be reverted by saving an older service draft',async()=>{
 const f=await voiceFixture();await f.click('AI 服务与权限');await f.change('服务商','deepseek');await f.click('语音输入');await f.change('新词条','Preserved new term');await f.click('添加');await f.click('删除词条 NuPhy');await f.click('AI 服务与权限');await f.click('保存设置');
 const body=f.requests.findLast(x=>x.action==='saveSettings');assert(!Object.hasOwn(body.settings,'dictionary'));assert.equal(JSON.stringify(f.state.settings.dictionary),JSON.stringify(['Preserved new term']));f.unmount();
});
test('a failed save keeps the newly typed key and displays the failure',async()=>{
 const f=await voiceFixture({onRequest:(body,state)=>body.action==='saveSettings'?{...state,settingsSaved:false,message:'Rejected synthetic save'}:null});await f.click('AI 服务与权限');await f.change('API Key','SYNTHETIC-UNSAVED');await f.click('保存设置');assert.equal(f.field('API Key').props.value,'SYNTHETIC-UNSAVED');assert(f.nodes().some(n=>n.props.role==='alert'&&f.text(n).includes('Rejected')));f.unmount();
});
test('new keys are tied to exact origins and cleared on service and region changes',async()=>{
 const f=await voiceFixture();await f.click('AI 服务与权限');await f.change('API Key','SYNTHETIC-OPENAI');await f.click('保存设置');let body=f.requests.findLast(x=>x.action==='saveSettings');assert.equal(body.keyOrigins.cleanup,'https://api.openai.com:443');assert.equal(f.field('API Key').props.value,'');
 await f.change('API Key','SYNTHETIC-UNSAVED');await f.change('服务商','alibaba');assert.equal(f.field('API Key').props.value,'');await f.change('API Key','SYNTHETIC-CN');await f.change('地区','intl');assert.equal(f.field('API Key').props.value,'');assert(f.field('语音识别地址').props.value.includes('dashscope-intl'));f.unmount();
});
test('custom Alibaba-compatible origins stay Custom; both official regions recognized',async()=>{
 const f=await voiceFixture();const preset=f.presets.find(p=>p.id==='alibaba');assert.equal(f.exports.inferredProvider({...preset.settings,asrEndpoint:'https://custom.invalid/api',cleanupEndpoint:'https://custom.invalid/api'},f.presets),'custom');
 for(const r of Object.values(preset.regions))assert.equal(f.exports.inferredProvider({...preset.settings,asrEndpoint:r.endpoint,cleanupEndpoint:r.endpoint},f.presets),'alibaba');f.unmount();
});
test('English voice and service pages have English controls and retain text verbatim',async()=>{
 const f=await voiceFixture({language:'en'});assert(f.button('AI Service & Permissions'));assert(f.button('Delete entry NuPhy'));assert.equal(f.field('New dictionary entry').props.value,'');await f.emit({rawText:'测试原文',cleanedText:'保留原文',phase:'done'});assert(f.nodes().some(n=>n.props.className==='vi-result-text'&&f.text(n)==='保留原文'));await f.click('AI Service & Permissions');assert(f.field('Provider'));assert(f.button('Save settings'));assert(f.button('Open System Settings'));f.unmount();
});
test('recording locks settings but keeps stop/cancel; pending text cannot be replaced by preview',async()=>{
 const f=await voiceFixture();await f.emit({phase:'recording'});assert(f.button('结束试录'));assert(f.button('取消'));assert(f.field('麦克风').props.disabled);await f.emit({phase:'pending',cleanedText:'pending draft'});assert(f.button('试录').props.disabled);assert(f.button('取消'));assert(f.button('启用语音输入').props.disabled);f.unmount();
});
test('leaving the page cancels shortcut recording without cancelling speech',async()=>{
 const f=await voiceFixture();await f.click('右 Option');assert(f.state.shortcutRecording);f.unmount();assert.equal(f.requests.at(-1).action,'leave');assert(!f.requests.some(x=>x.action==='cancelRecording'));
});
test('Feature Center adds and opens Voice Input using existing sidebar preferences',async()=>{
 const f=await appDraftFixture();await f.click('功能中心');f.child('FeatureCenter').props.onToggle('voice-input');await f.flush();assert(f.button('语音输入'));await f.click('语音输入');assert(f.child('VoiceInput'));f.unmount();
});
test('dictionary adds, deduplicates and removes all entries with immediate saves',async()=>{
 const f=await voiceFixture();await f.change('新词条','  Air75 V3  ');await f.click('添加');
 assert.equal(JSON.stringify(f.state.settings.dictionary),JSON.stringify(['NuPhy','Air75 V3']));assert.equal(f.field('新词条').props.value,'');
 await f.change('新词条','Air75 V3');const count=f.requests.filter(x=>x.action==='saveDictionary').length;await f.click('添加');
 assert.equal(f.requests.filter(x=>x.action==='saveDictionary').length,count);assert(f.nodes().some(n=>n.props.role==='alert'));
 await f.click('删除词条 NuPhy');await f.click('删除词条 Air75 V3');assert.equal(f.state.settings.dictionary.length,0);assert(f.text(f.nodes()).includes('还没有词条'));f.unmount();
});
test('Enter adds a term after IME composition without prematurely committing it',async()=>{
 const f=await voiceFixture();await f.change('新词条','张小明');await f.key('新词条','Enter',{isComposing:true});assert(!f.requests.some(x=>x.action==='saveDictionary'));
 await f.key('新词条','Enter',{keyCode:229});assert(!f.requests.some(x=>x.action==='saveDictionary'));
 assert(await f.key('新词条','Enter'));assert(f.state.settings.dictionary.includes('张小明'));f.unmount();
});
test('failed dictionary edits keep both existing entries and typed text',async()=>{
 const f=await voiceFixture({onRequest:(body,state)=>body.action==='saveDictionary'?{...state,dictionarySaved:false,message:'Synthetic disk error'}:null});await f.change('新词条','Draft term');await f.click('添加');
 assert.equal(f.field('新词条').props.value,'Draft term');assert.equal(JSON.stringify(f.state.settings.dictionary),'["NuPhy"]');await f.click('删除词条 NuPhy');assert(f.button('删除词条 NuPhy'));assert(f.nodes().some(n=>n.props.role==='alert'&&f.text(n).includes('disk error')));f.unmount();
});
test('dictionary capacity rejects additional entries without modifying saved ones',async()=>{
 const f=await voiceFixture();await f.emit({settings:{...f.state.settings,dictionary:Array.from({length:100},(_,i)=>'Term '+i)}});await f.change('新词条','Overflow');await f.click('添加');assert.equal(f.state.settings.dictionary.length,100);assert(!f.requests.some(x=>x.action==='saveDictionary'));f.unmount();
});
test('complete built-in prompt is editable and an unsaved draft survives native events and dictionary edits',async()=>{
 const f=await voiceFixture();const original=f.field('整理提示词内容').props.value;assert.equal(original,await readFile(new URL('../assets/voice-input/cleanup-prompt.txt',import.meta.url),'utf8'));assert.equal(createHash('sha256').update(original).digest('hex'),'10f64943b641035a73c3cf7c4a3acf31be420ad1673fbcf0a3254d34298fe768');
 await f.change('整理提示词内容',original+'\n只修改标点。');await f.change('新词条','Term');await f.click('添加');await f.change('麦克风','fixture-mic');await f.emit({message:'Ready'});
 assert.equal(f.field('整理提示词内容').props.value,original+'\n只修改标点。');assert(!f.state.settings.customCleanupPrompt);
 await f.click('保存提示词');assert.equal(f.state.settings.customCleanupPrompt,original+'\n只修改标点。');assert(f.button('保存提示词').props.disabled);f.unmount();
});
test('restoring default requires saving and does not change dictionary, provider or key',async()=>{
 const f=await voiceFixture();await f.change('整理提示词内容','Keep my exact wording.');await f.click('保存提示词');await f.click('恢复默认');
 assert.equal(f.state.settings.customCleanupPrompt,'Keep my exact wording.');assert.equal(f.field('整理提示词内容').props.value,f.state.defaultCleanupPrompt);
 await f.click('保存提示词');assert(!f.state.settings.customCleanupPrompt);assert.equal(JSON.stringify(f.state.settings.dictionary),'["NuPhy"]');assert(!f.requests.some(x=>'cleanupKey'in x));f.unmount();
});
test('a failed prompt save retains the draft and exposes the native failure',async()=>{
 const f=await voiceFixture({onRequest:(body,state)=>body.action==='savePrompt'?{...state,promptSaved:false,message:'Empty instructions rejected'}:null});await f.change('整理提示词内容','');await f.click('保存提示词');
 assert.equal(f.field('整理提示词内容').props.value,'');assert(!f.state.settings.customCleanupPrompt);assert(f.nodes().some(n=>n.props.role==='alert'&&f.text(n).includes('rejected')));f.unmount();
});
test('service saves cannot overwrite the newly saved refinement instructions',async()=>{
 const f=await voiceFixture();await f.click('AI 服务与权限');await f.change('服务商','deepseek');await f.click('语音输入');await f.change('整理提示词内容','New custom rules');await f.click('保存提示词');await f.click('AI 服务与权限');await f.click('保存设置');
 assert.equal(f.state.settings.customCleanupPrompt,'New custom rules');assert(!Object.hasOwn(f.requests.findLast(x=>x.action==='saveSettings').settings,'customCleanupPrompt'));f.unmount();
});
test('dictionary and prompt controls lock during recording and use English labels',async()=>{
 const f=await voiceFixture({language:'en'});assert(f.button('Add'));assert(f.button('Restore default'));assert(f.button('Save instructions'));await f.emit({phase:'recording'});
 assert(f.field('New dictionary entry').props.disabled);assert(f.field('Refinement instructions text').props.disabled);assert(f.button('Delete entry NuPhy').props.disabled);f.unmount();
});

test('mouse shortcut recording exposes guidance, updates label and preserves unsaved prompt',async()=>{
 const f=await voiceFixture();await f.change('整理提示词内容','Keep my draft');assert(f.text(f.nodes()).includes('鼠标侧键'));
 await f.click('右 Option');assert(f.button('请按键或侧键 · Esc 取消'));
 await f.emit({shortcutRecording:false,shortcutSaved:true,shortcutLabel:'鼠标侧键 1',settings:{...f.state.settings,shortcutMouseButton:3}});
 assert(f.button('鼠标侧键 1'));assert.equal(f.field('整理提示词内容').props.value,'Keep my draft');
 await f.emit({shortcutSaved:false,message:'此快捷键已用于智能框选，请更换其中一个快捷键。'});
 assert(f.button('鼠标侧键 1'));assert(f.text(f.nodes()).includes('智能框选'));f.unmount();
});
test('English mouse shortcut instructions and recorder cancellation',async()=>{
 const f=await voiceFixture({language:'en'});assert(f.text(f.nodes()).includes('mouse side button'));
 await f.click('右 Option');assert(f.button('Press a key or side button · Esc cancels'));await f.click('Press a key or side button · Esc cancels');
 assert(!f.state.shortcutRecording);assert.equal(f.requests.at(-1).action,'cancelShortcut');f.unmount();
});
