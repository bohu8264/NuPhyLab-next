import {features} from './FeatureCenter';
import {messages} from '../../shared/i18n.mjs';
import {FEATURE_IDS, sidebarFeatures, type FeatureId} from '../../shared/sidebar-features.mjs';
import type {AppState, Command} from './types';

type Names = readonly [string, string];
type Kind = 'open' | 'add' | 'remove' | 'on' | 'off' | 'number' | 'choice' | 'named' | 'shortcut';
export type VoicePage = FeatureId | 'features' | 'device' | 'settings' | 'audio';
type Target = {id:string; names:Names; kind:Kind; page?:VoicePage; marker?:string; feature?:FeatureId; min?:number; max?:number; choices?:readonly string[]};
type Value = number | string | {label:string; value:number|string};
type Step = {target:Target; value?:Value};
const targets = new Map<string, Target>();
const add = (entry:Target) => { targets.set(entry.id, entry); };
const toggle = (id:string, names:Names, page?:VoicePage, marker?:string) => {
  for (const kind of ['on','off'] as const) add({id:kind+':'+id,names,kind,page,marker});
};
for (const {id,zh,en} of features) {
  for (const kind of ['open','add','remove'] as const) add({id:kind+':'+id,names:[zh,en],kind,page:id,feature:id});
}
for (const [id,zh,en] of [
  ['features','功能中心','Feature Center'],['device','设备','Device'],['settings','设置','Settings'],
  ['settings.general','通用设置','General settings'],['settings.lighting','灯光与休眠','Lighting and sleep'],
  ['settings.ai','模型与 API','Models & API'],['settings.permissions','权限','Permissions'],['settings.about','关于与更新','About & updates'],
  ['studio.paint','绘制','Paint'],['studio.animation','动画','Animation'],['studio.trigger','按键触发','Key triggers'],['audio','声音律动','Audio reactive'],
  ['codex.tasks','任务与快捷键','Tasks and shortcuts'],['codex.lights','AI 状态灯','AI status lights'],['codex.setup','接入设置','Integration setup'],
  ['library.lighting','灯光作品','Lighting works'],['library.music','演奏作品','Music works'],
] as const) add({id:'open:'+id, names:[zh,en],kind:'open',page:id.split('.')[0] as VoicePage});

for (const id of ['selection-question','typing-sounds','music','keyboard-pocket','drag-convert','voice-input','dock-scenes','color-picker','screen-replay'] as const) {
  const feature = features.find(f=>f.id===id)!;
  toggle(id,id==='dock-scenes'?['Dock 场景快捷键','Dock scene shortcuts']:[feature.zh,feature.en],id,id);
}
toggle('agent',['AI 助手（当前任务来源）','AI Assistant (selected task source)'],'codex');
toggle('game',['灯光游戏（开始或结束当前游戏）','Lighting Games (start or end the current game)'],'game');
toggle('codex-mode',['Codex 模式','Codex mode'],'codex');
toggle('claude-mode',['Claude Code 模式','Claude Code mode'],'codex');
toggle('audio',['声音律动','Audio reactive lighting'],'audio','audio');
toggle('voice-control',['语音控制','Voice Control']);
add({id:'shortcut:voice-input',kind:'shortcut',names:['设置语音输入快捷键，例如 Q、左 Ctrl 或 Control+Shift+Q','Set the dictation shortcut, for example Q, Left Control or Control+Shift+Q'],page:'voice-input'});
toggle('auto-connect',['插线后自动连接','Connect automatically'],'settings');
toggle('ambient',['自动感光背光','Automatic backlight'],'settings');
toggle('selection-speech',['智能框选按住说话','Smart Selection voice questions'],'selection-question','selection-speech');
toggle('selection-images',['发送选区图片','Send selection images'],'selection-question','selection-images');
toggle('pocket-preview',['口袋浮窗预览','Pocket floating preview'],'keyboard-pocket','pocket-preview');
add({id:'value:brightness',kind:'number',names:['全局背光亮度 %','Global keyboard brightness %'],min:0,max:100});
add({id:'value:sound-volume',kind:'number',names:['模拟声浪输出音量 %','Typing Sounds volume %'],page:'typing-sounds',marker:'sound-volume',min:0,max:100});
for (const [id,zh,en] of [['idle','空闲后休眠','Idle sleep'],['duration','每次亮灯时长','Lighting duration']] as const) {
  add({id:'value:'+id,kind:'number',names:[zh+'（秒，0 为不限）',en+' (seconds, 0 unlimited)'],min:0,max:86400});
}
add({id:'value:language',kind:'choice',names:['界面语言','Interface language'],choices:['zh-CN','en']});
add({id:'value:translation',kind:'choice',names:['智能框选翻译目标语言','Smart Selection translation language'],page:'selection-question',marker:'translation',
  choices:['zh-CN','zh-TW','en','ja','ko','fr','de','es','pt','it','ru','ar','hi','th','vi','id']});
for (const id of ['on','off','press','value'] as const) {
  const description = id==='value' ? 'Set a named visible range or choice, value={label,value}' :
    id==='press' ? 'Press a named visible NuPhy Lab button or tab, value=label' : 'Set a named visible switch '+id+', value=label';
  add({id:id+':screen',kind:'named',names:[description,description]});
}

export const voiceCatalog = [...targets.values()].map(t=>t.id+' '+t.names.join(' / ')+(t.min!=null?' ['+t.min+'..'+t.max+']':'')+(t.choices?' ['+t.choices.join('|')+']':'')).join('\n');
const short = (v:unknown):v is string => typeof v==='string' && v.trim().length>0 && v.length<=100 && !/[\u0000-\u001f]/.test(v);
const record = (v:unknown):v is Record<string,unknown> => v!=null && typeof v==='object' && !Array.isArray(v);
const copy = (en:boolean,zh:string,english:string) => en?english:zh;
const invalid = (en:boolean) => new Error(copy(en,'没能确定要执行的操作，请说出功能名称和动作。','Name the feature and what you want to do, then try again.'));

const modifierNames = new Map<string,string>([
  ['ctrl','Control'],['control','Control'],['控制','Control'],['⌃','Control'],
  ['option','Option'],['alt','Option'],['选项','Option'],['選項','Option'],['⌥','Option'],
  ['shift','Shift'],['上档','Shift'],['上檔','Shift'],['⇧','Shift'],
  ['command','Command'],['cmd','Command'],['命令','Command'],['⌘','Command'],
]);

function shortcutName(raw:string):string|null {
  let key=raw.normalize('NFKC').trim().replace(/^(?:英文字母|字母|按键|(?:the )?letter\s+)\s*/i,'').replace(/(?:键|\s+key)$/i,'').trim();
  // Keep a modifier tap's physical side. Only normalize a whole modifier name,
  // so composite requests and an ordinary arrow key still take their own paths.
  const compact=key.toLowerCase().replace(/[\s.·]+/g,'');
  const sided=/^(left|right|左|右)(?:-?hand|手?[边邊]|[侧側])?(?:的|那[个個])?(.+)$/.exec(compact);
  if(sided) {
    const modifier=modifierNames.get(sided[2]);
    if(modifier)return (sided[1]==='left'||sided[1]==='左'?'Left ':'Right ')+modifier;
  }
  if(/^fn$/i.test(key))return 'Fn';
  for(const [symbol,name] of [['⌃','Control'],['⌥','Option'],['⇧','Shift'],['⌘','Command']])key=key.replaceAll(symbol,name+'+');
  key=key.replace(/\s*(?:\+|加号|加上?|\bplus\b)\s*/gi,'+').replace(/^cue$/i,'Q');
  const parts=key.split('+'),base=parts.pop()??'';
  const flags=parts.map(p=>modifierNames.get(p.toLowerCase()));
  if(flags.some(f=>!f)||new Set(flags).size!==flags.length||!(/^(?:[a-z0-9]|f(?:[1-9]|1\d|20)|space(?:bar)?|return|enter|tab|delete|backspace|left|right|up|down|home|end|page (?:up|down)|空格|回车|[←→↑↓]|[.,;/'\x60=\\\[\]-])$/i.test(base)))return null;
  return [...flags,base.length===1?base.toUpperCase():base].join('+');
}

// A complete, literal remap is deterministic across model providers. Multi-step
// requests, paraphrases and corrections go through the configured interpreter.
export function explicitDictationShortcut(text:string):string|null {
  const utterance=text.normalize('NFKC').trim().replace(/[。.!！]+$/,'').trim().replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,'$1');
  const zh=/^(?:请(?:帮我)?|帮我)?(?:把|将)?(?:语音输入|听写)(?:的)?(?:快捷键|热键)(?:给我|帮我)?(?:修改为|修改成|改成|改为|设置为|设为|设置成|换成)\s*(.+)$/i;
  const en=/^(?:please\s+)?(?:set|change)\s+(?:the\s+|my\s+)?(?:voice input|dictation)\s+(?:keyboard\s+)?(?:shortcut|hotkey)\s+to\s+(.+)$/i;
  const value=(zh.exec(utterance)??en.exec(utterance))?.[1];
  return value?shortcutName(value):null;
}

export function parseVoicePlan(raw:string, en:boolean):Step[] {
  if (typeof raw!=='string' || raw.length>8192) throw invalid(en);
  let result:unknown;
  try {result=JSON.parse(raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,'$1'));} catch {throw invalid(en);}
  if (!record(result)||Object.keys(result).length!==1||!Array.isArray(result.steps)||!result.steps.length||result.steps.length>6) throw invalid(en);
  return result.steps.map((s:unknown,index:number) => {
    if (!record(s)||typeof s.id!=='string'||Object.keys(s).some(k=>k!=='id'&&k!=='value')) throw invalid(en);
    const t=targets.get(s.id), v=s.value;
    if (!t) throw invalid(en);
    if (t.kind==='number') {
      if (typeof v!=='number'||!Number.isInteger(v)||v<t.min!||v>t.max!) throw invalid(en);
    } else if (t.kind==='choice') {
      if (typeof v!=='string'||!t.choices!.includes(v)) throw invalid(en);
    } else if (t.kind==='shortcut') {
      const name=short(v)?shortcutName(v):null;
      if (!name) throw invalid(en);
      return {target:t,value:name};
    } else if (s.id==='value:screen') {
      if (!record(v)||Object.keys(v).length!==2||!short(v.label)||!(short(v.value)||typeof v.value==='number'&&Number.isFinite(v.value))) throw invalid(en);
    } else if (t.kind==='named') {
      if (!short(v)) throw invalid(en);
    } else if ('value' in s) throw invalid(en);
    if (s.id==='off:voice-control' && index!==(result as {steps:unknown[]}).steps.length-1) throw invalid(en);
    return {target:t,value:v as Value|undefined};
  });
}

type Control = HTMLButtonElement | HTMLInputElement | HTMLSelectElement;
export type VoiceContext = {
  en:boolean; check:()=>void; read:()=>Promise<AppState>; command:Command;
  membership:(id:FeatureId,added:boolean,check:()=>void)=>Promise<void>; open:(destination:string)=>void;
  confirm:(description:string)=>Promise<boolean>; setEnabled:(value:boolean)=>Promise<void>;
  setInputShortcut:(name:string)=>Promise<string>;
};
const delay = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
function normalized(s:string) {return s.normalize('NFKC').toLowerCase().replace(/[\s·:：%]/g,'');}
function labels(el:Control):string[] {
  return [el.getAttribute('aria-label'),el.title,el instanceof HTMLButtonElement?el.textContent:el.labels?.[0]?.textContent]
    .filter((s):s is string=>!!s?.trim());
}
// Supply exact names for the active page. Match only fixed product translations
// so user projects, file paths, slot contents and field values never enter this inventory.
const productLabels = new Set([...Object.keys(messages),...Object.values(messages),
  '浮窗预览','Floating preview','以纯文本复制','Copy as plain text','取用后清空','Clear after retrieval',
  '演奏模式','Performance','开启演奏','Enable performance','输出音量','Output volume']);
export function catalogForCurrentPage() {
  const controls=new Set<string>();
  const root=document.querySelector('main .page-content');
  if(root)for(const el of root.querySelectorAll('button,select,input[type=checkbox],input[type=range]')) {
    if(!isControl(el)||!enabled(el))continue;
    const label=labels(el).find(s=>s.length<=60&&productLabels.has(s));
    if(!label)continue;
    const kind=readChecked(el)!==undefined?'switch':el instanceof HTMLButtonElement?'button':'value';
    controls.add(kind+' '+label);
    if(controls.size>=64)break;
  }
  return controls.size?voiceCatalog+'\nCurrent page labels (use only with screen IDs):\n'+[...controls].join('\n'):voiceCatalog;
}
function enabled(el:Control) {
  return el.getClientRects().length>0 && !el.matches(':disabled,[aria-disabled=true]') && !el.closest('[inert],[hidden],[aria-hidden=true]');
}
function isControl(el:Element):el is Control {return el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement;}
function readChecked(el:Control) {
  if(el instanceof HTMLInputElement && el.type==='checkbox') return el.checked;
  const state=el.getAttribute('aria-checked')??el.getAttribute('aria-pressed');
  return state==='true'?true:state==='false'?false:undefined;
}
async function waitFor<T>(test:()=>T|null,ctx:VoiceContext):Promise<T> {
  const deadline=performance.now()+4000;
  do {ctx.check();const result=test();if(result!==null)return result;await delay(60);} while(performance.now()<deadline);
  throw new Error(copy(ctx.en,'当前页面未能确认这个操作，请检查功能是否可用。','This action could not be confirmed. Check whether the control is available.'));
}
function locate(label:string, selector:string, marker:string|undefined, ctx:VoiceContext):Control|null {
  const root=document.querySelector('main .page-content');
  if(!root)return null;
  const items=Array.from(root.querySelectorAll(marker?'[data-voice-control]':selector)).filter(isControl)
    .filter(el=>marker?el.dataset.voiceControl===marker:labels(el).some(s=>normalized(s)===normalized(label)))
    .filter(el=>el.getClientRects().length && !el.closest('[hidden],[inert],[aria-hidden=true]'));
  if(items.length>1)throw new Error(copy(ctx.en,'有多个同名控件，请先打开需要的页面。','Several controls have that name. Open the intended view first.'));
  return items.length===1 && enabled(items[0])?items[0]:null;
}
async function controlStep(step:Step,ctx:VoiceContext) {
  const {target:t,value}=step, named=t.kind==='named';
  const label=named?(typeof value==='string'?value:(value as {label:string}).label):t.names[Number(ctx.en)];
  const op=t.id.split(':')[0];
  const selector=op==='value'?'input[type=range],select':op==='press'?'button':'button[role=switch],input[type=checkbox],button.ml-toggle';
  const find=()=>locate(label,selector,t.marker,ctx);
  const el=await waitFor(find,ctx);
  if(op==='on'||op==='off') {
    const expected=op==='on';
    if(readChecked(el)===undefined)throw invalid(ctx.en);
    if(readChecked(el)!==expected){ctx.check();el.click();await waitFor(()=>{const live=find();return live&&readChecked(live)===expected?true:null;},ctx);}
    return;
  }
  if(op==='press') {
    if(!(el instanceof HTMLButtonElement))throw invalid(ctx.en);
    // Tabs and navigation are unambiguous. For other named buttons show the exact
    // action before dispatch: they can export, remove data, or affect other apps.
    const navigation=el.getAttribute('role')==='tab'||!!el.closest('nav')||el.hasAttribute('data-voice-action');
    if(!navigation && !await ctx.confirm(label))throw new DOMException('Cancelled','AbortError');
    ctx.check();
    if(find()!==el)throw invalid(ctx.en);
    el.click();return;
  }
  const wanted=named?(value as {value:string|number}).value:value;
  let next:string;
  if(el instanceof HTMLSelectElement) {
    const options=Array.from(el.options).filter(opt=>!opt.disabled && (opt.value===String(wanted)||normalized(opt.text)===normalized(String(wanted))));
    if(options.length!==1)throw invalid(ctx.en);
    next=options[0].value;
  } else if(el instanceof HTMLInputElement && el.type==='range') {
    const n=Number(wanted),min=Number(el.min||0),max=Number(el.max||100),stepSize=el.step==='any'?0:Number(el.step||1);
    if(!Number.isFinite(n)||n<min||n>max||stepSize && Math.abs((n-min)/stepSize-Math.round((n-min)/stepSize))>1e-6)throw invalid(ctx.en);
    next=String(n);
  } else throw invalid(ctx.en);
  const confirmed=(field:Control|null)=>field&&'value' in field&&field.value===next&&
    (field.dataset.voiceSaved===undefined||field.dataset.voiceSaved===next);
  if(confirmed(el))return;
  // Use the DOM setter so controlled React fields deliver their normal change event.
  const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,next);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));
  if(el instanceof HTMLInputElement){await delay(0);ctx.check();el.dispatchEvent(new KeyboardEvent('keyup',{key:'End',bubbles:true}));}
  await waitFor(()=>confirmed(find())?true:null,ctx);
}

export async function executeVoiceStep(step:Step,ctx:VoiceContext):Promise<string> {
  const {target:t,value}=step,op=t.kind,slug=t.id.split(':')[1],en=ctx.en;
  const label=t.names[Number(en)];
  ctx.check();
  if(op==='add'||op==='remove') {
    await ctx.membership(t.feature!,op==='add',ctx.check);
    return en?(op==='add'?'In sidebar: ':'Removed from sidebar: ')+label:label+(op==='add'?'已添加到侧栏':'已从侧栏移除');
  }
  const state=await ctx.read();ctx.check();
  const needed=t.page==='audio'?'studio':t.page;
  if(needed && FEATURE_IDS.includes(needed as FeatureId) && !sidebarFeatures(state.settings.sidebarFeatures).includes(needed as FeatureId)) {
    if(op==='off')return en?label+' is off':label+'已关闭';
    throw new Error(copy(en,'请先从功能中心添加「'+(features.find(f=>f.id===needed)?.zh??label)+'」，也可以说“添加并开启”。','Add '+(features.find(f=>f.id===needed)?.en??label)+' in Feature Center first. You can say “add and enable”.'));
  }
  if(op==='open') {
    ctx.open(slug);
    await waitFor(()=>document.querySelector('.app-shell')?.getAttribute('data-page')===t.page?true:null,ctx);
    const [,tab]=slug.split('.');
    if(tab && ['codex','settings','studio'].includes(t.page!)){
      // These identifiers come exclusively from the built-in catalog.
      const find=()=>document.querySelector<HTMLButtonElement>(t.page==='settings'?'#settings-tab-'+tab:'main [data-voice-tab="'+tab+'"]');
      const button=await waitFor(()=>{const b=find();return b&&enabled(b)?b:null;},ctx);
      const selected=()=>find()?.getAttribute('aria-selected')==='true'||find()?.getAttribute('aria-current')==='page';
      if(!selected()){ctx.check();button.click();await waitFor(()=>selected()?true:null,ctx);}
    }
    return en?'Opened '+label:'已打开'+label;
  }
  if(op==='shortcut') {
    const saved=await ctx.setInputShortcut(String(value));
    return en?'Voice Input shortcut set to '+saved:'语音输入快捷键已设为 '+saved;
  }
  const expected=op==='on',settings=state.settings;
  if(slug==='voice-control') {
    await ctx.setEnabled(expected);
  } else if(slug==='game') {
    const finished=(status:string|undefined)=>expected?status==='running':status==='idle';
    if(!finished(state.game?.status)){
      ctx.open('game');
      const controls=await waitFor(()=>document.querySelector<HTMLElement>('main [data-voice-game-state]'),ctx);
      if(!finished(controls.dataset.voiceGameState)){
        const button=controls.querySelector<HTMLButtonElement>(expected?'[data-voice-action="game-play"]':'[data-voice-action="game-stop"]');
        if(!button||!enabled(button))throw new Error(copy(en,'请先连接支持逐键灯光的 USB 键盘。','Connect a USB keyboard that supports per-key lighting first.'));
        ctx.check();button.click();
        await waitFor(()=>finished(controls.dataset.voiceGameState)?true:null,ctx);
      }
    }
  } else if(slug==='agent'||slug==='codex-mode'||slug==='claude-mode') {
    const source=slug==='claude-mode'||(slug==='agent'&&settings.agentSource==='claude')?'claude':'codex';
    if(Boolean(settings[source+'Enabled'])!==expected) {
      if(expected && state.device.capabilities?.perKey===false)throw new Error(copy(en,'当前键盘不支持此模式。','This keyboard does not support this mode.'));
      await ctx.command({op:'agentMode',source,enabled:expected});
    }
    if(Boolean((await ctx.read()).settings[source+'Enabled'])!==expected)throw invalid(en);
  } else if(['auto-connect','ambient','brightness','idle','duration','language'].includes(slug)) {
    const key:Record<string,string>={'auto-connect':'autoConnect',ambient:'ambientLighting',brightness:'brightness',idle:'lightIdleMs',duration:'lightDurationMs',language:'language'};
    const field=key[slug],desired=op==='on'||op==='off'?expected:slug==='idle'||slug==='duration'?Number(value)*1000:value;
    const get=(s:AppState)=>field==='ambientLighting'?s.settings.ambientLighting?.enabled:s.settings[field];
    if(get(state)!==desired){
      await ctx.command({op:'settings',settings:{[field]:field==='ambientLighting'?{enabled:desired}:desired}});
      if(get(await ctx.read())!==desired)throw invalid(en);
    }
  } else {
    if(t.page){ctx.open(t.page);await waitFor(()=>document.querySelector('.app-shell')?.getAttribute('data-page')===t.page?true:null,ctx);}
    await controlStep(step,ctx);
  }
  if(op==='named'){
    const name=typeof value==='string'?value:(value as {label:string}).label;
    return en?(t.id==='press:screen'?'Pressed ':'Updated ')+name:(t.id==='press:screen'?'已点击':'已设置')+name;
  }
  if(op==='on'||op==='off')return en?label+(expected?' is on':' is off'):label+(expected?'已开启':'已关闭');
  return label+' · '+String(value);
}
