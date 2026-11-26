import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import ts from '../ui/node_modules/typescript/lib/typescript.js';
import {messages,translate} from '../shared/i18n.mjs';
import {createPresets} from '../shared/presets.mjs';
import {airLayout,kickLayout} from '../shared/layout.mjs';
import {SHORTCUTS} from '../server/codex.mjs';
import {CLAUDE_COMMANDS} from '../server/claude-actions.mjs';
import {AUDIO_EFFECTS} from '../shared/audio-effects.mjs';
import {createVMEnvironment,textOf,walkAll} from './helpers/source-ui-vm.mjs';

const han=/[\u3400-\u9fff]/;
const en=value=>translate('en',value);

test('all English system translations are English and retain their placeholders',()=>{
  for(const [source,target] of Object.entries(messages)){
    assert.equal(han.test(target),false,source+' -> '+target);
    const placeholders=value=>[...new Set(value.match(/\{\d+\}/g)??[])].sort();
    assert.deepEqual(placeholders(target),placeholders(source),source);
  }
});

test('direct production UI labels and conditional labels have English translations',async()=>{
  const missing=[];
  for(const file of await readdir(new URL('../ui/src/',import.meta.url))){
    if(!/\.tsx?$/.test(file))continue;
    const source=ts.createSourceFile(file,await readFile(new URL('../ui/src/'+file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    const check=node=>{
      if(ts.isStringLiteralLike(node)&&han.test(node.text)&&han.test(en(node.text)))missing.push(file+': '+node.text);
      else if(ts.isConditionalExpression(node)){check(node.whenTrue);check(node.whenFalse);}
    };
    const visit=node=>{
      if(file==='DesktopToolsSettings.tsx' && ts.isArrayLiteralExpression(node) && node.elements.length===3){
        const [id,zh,english]=node.elements;
        if(ts.isStringLiteralLike(id)&&ts.isStringLiteralLike(zh)&&han.test(zh.text)&&(!ts.isStringLiteralLike(english)||!english.text.trim()||han.test(english.text))){
          missing.push(file+': '+zh.text);
        }
      }
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['t','tr'].includes(node.expression.text)&&node.arguments[0]){
        if((['DockScenes.tsx','AssistSettings.tsx'].includes(file) || file==='DesktopToolsSettings.tsx' && ts.isStringLiteralLike(node.arguments[0])) && node.expression.text==='t'){
          const english=node.arguments[1];
          if(!english||!ts.isStringLiteralLike(english)||!english.text.trim()||han.test(english.text)){
            missing.push(file+': '+node.arguments[0].getText(source));
          }
        }else check(node.arguments[0]);
      }
      ts.forEachChild(node,visit);
    };
    visit(source);
  }
  assert.deepEqual(missing,[]);
});

test('built-in preset names, descriptions and cross-trigger controls are translated',()=>{
  for(const layout of [airLayout,kickLayout])for(const preset of createPresets(layout)){
    assert.equal(han.test(en(preset.name)),false,preset.name);
    assert.equal(han.test(en(preset.description)),false,preset.description);
  }
  assert.equal(en('一石二鸟'),'One stone, two birds');
  for(const label of ['触发颜色','扩散速度','按任意键，从对应位置向横纵扩散。','连续按键独立叠加','等待按键 · 每次按键产生独立光波','在此输入以预览灯效','预览输入仅用于触发灯效，不会保存文字。','启用后在其他应用打字也会触发，按键照常输入。','颜色和速度已修改，点击应用设置更新键盘。','触发颜色必须是有效的 RGB 颜色','触发速度应在 1–10 之间','不支持的按键触发灯效','此触发效果不支持颜色或速度设置'])assert.equal(han.test(en(label)),false,label);
});

test('all production AI command and audio effect labels and explanations are translated',()=>{
  for(const entry of [...SHORTCUTS,...CLAUDE_COMMANDS,...AUDIO_EFFECTS]){
    for(const key of ['label','description','reason'])if(entry[key])assert.equal(han.test(en(entry[key])),false,entry[key]);
  }
});

test('artwork and task parameters retain their original text even when names match UI labels',()=>{
  for(const name of ['我的作品：设备','设置','一颗小心意','中文任务 · 作品库']){
    assert.equal(en(`播放作品 ${name} 到键盘`),`Play artwork ${name} on keyboard`);
    assert.equal(en(`作品 ${name} 的更多操作`),`More actions for ${name}`);
    assert.equal(en(`打开作品 ${name}`),`Open scene ${name}`);
    assert.equal(en(`打开任务 ${name}`),`Open task ${name}`);
  }
  const task={title:'设置'},artwork={name:'一颗小心意'};
  assert.equal(en(task),task);assert.equal(en(artwork),artwork);
  assert.equal(translate('zh-CN','设备'),'设备');
});

test('dynamic audio capture labels translate their system source without translating arbitrary parameters',()=>{
  assert.equal(en('系统声音 · 正在采集'),'System audio · Capturing');
  assert.equal(en('麦克风 · 正在采集'),'Microphone · Capturing');
  assert.equal(en('用户设备：麦克风 · 正在采集'),'用户设备：麦克风 · Capturing');
});

test('actual quota component renders localized compound labels for every supported quota shape',async()=>{
  const ui=createVMEnvironment({'./i18n':{t:en,dateLocale:()=> 'en-US'}});
  const Quota=(await ui.load(new URL('../ui/src/AgentQuota.tsx',import.meta.url))).exports.AgentQuota;
  for(const quota of [
    {primary:{usedPercent:25,windowDurationMins:300},secondary:{usedPercent:40,windowDurationMins:10080}},
    {windows:[{usedPercent:25,windowDurationMins:300},{usedPercent:20,windowDurationMins:120}]},
    {rateLimitsByLimitId:{codex:{primary:{usedPercent:25,windowDurationMins:300},secondary:{usedPercent:40,windowDurationMins:10080}},review:{secondary:{usedPercent:40,windowDurationMins:10080}}}},
    {buckets:[{id:'codex',windows:[{usedPercent:25,windowDurationMins:300},{usedPercent:null,windowDurationMins:10080}]}]},
  ]){
    const instance=ui.mount(Quota,{state:{codex:{quota}},source:'codex'});
    assert.equal(han.test(textOf(instance.tree)),false,textOf(instance.tree));
    for(const meter of walkAll(instance.tree,node=>node.props?.role==='meter'))assert.equal(han.test(meter.props['aria-label']),false,meter.props['aria-label']);
    assert.doesNotMatch(textOf(instance.tree),/5 hours · 5 hours|Weekly · Weekly/);
    instance.unmount();
  }
});

test('actual device component translates firmware, storage, connection and action failures',async()=>{
  const child=()=>null,Button=()=>null;
  const ui=createVMEnvironment({
    'lucide-react':new Proxy({},{get:()=>child}),
    './primitives':{Button,run:promise=>ui.track(promise)},
    './Keyboard':{Keyboard:child},
    './StartupGuide':{firmwarePrompt:()=>null,showFirmwareGuide(){},useStartupCopy:()=>((_zh,english)=>english)},
    './KeyRecoveryPanel':{friendlyConnectionError:value=>value,keyRecoveryProblem:()=>null},
    './codexKeys':{nativeCodexKeys:async()=>false},
    './FunctionKeyRecoveryDialog':{FunctionKeyRecoveryDialog:child},
    './FirmwareManagement':{FirmwareManagement:child},
    './connection-copy-v7':{connectionCopy:pair=>pair?.en??''},
    './i18n':{t:en},
  });
  const Device=(await ui.load(new URL('../ui/src/Device.tsx',import.meta.url))).exports.Device;
  const state={settings:{},playback:{},device:{connected:true,modelId:'air75-v3',error:'键盘连接正在恢复，请稍候。',storageWarning:'无法保存本机数据，请稍后重试。'},firmware:{current:'1.0.23.6',error:'暂时无法检查官方最新固件，请稍后重试。'}};
  const instance=ui.mount(Device,{state,layout:[],serviceError:'',command:async()=>{throw new Error('设置未保存，请重试。');}});
  assert.equal(han.test(textOf(instance.tree)),false,textOf(instance.tree));
  const action=walkAll(instance.tree,node=>node.type===Button&&textOf(node)==='Restore keyboard lighting')[0];
  assert.ok(action);action.props.onClick();await ui.settle(instance);
  assert.equal(han.test(textOf(instance.tree)),false,textOf(instance.tree));
  assert.match(textOf(instance.tree),/Could not save the setting/);
  assert.deepEqual(ui.asyncErrors,[]);instance.unmount();
});
