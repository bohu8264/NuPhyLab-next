import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import path from 'node:path';
import keys from '../shared/trigger-keys.json' with {type:'json'};

const commandIds={dictation:'composer.startDictation',voice:'composer.startVoiceMode',modelPicker:'composer.openModelPicker',
  approve:'approval.approve',decline:'approval.decline',newWindow:'newWindow',sendPrompt:'composer.submit',toggleFastMode:'composer.toggleFastMode'};
const modifiers={cmd:'command',command:'command',cmdorctrl:'command',commandorcontrol:'command',super:'command',ctrl:'control',control:'control',alt:'option',option:'option',shift:'shift',fn:'fn'};
const modifierCodes={control:59,shift:56,option:58,command:55,fn:63};
// Public HIToolbox Events.h virtual codes for forwarding only. The recorder's
// ordinary-key catalogue remains separate; the SDK defines no F21-F24 here.
const extendedFunctionCodes=new Map([['F13',0x69],['F14',0x6B],['F15',0x71],['F16',0x6A],['F17',0x40],['F18',0x4F],['F19',0x50],['F20',0x5A]]);
export function parseMacShortcut(value,{allowBareModifiers=false}={}) {
  if(typeof value!=='string'||value.length>100) return null;
  const parts=value.split('+').map(x=>x.trim());
  if(allowBareModifiers&&parts.every(x=>modifiers[x.toLowerCase()])) {
    const flags=parts.map(x=>modifiers[x.toLowerCase()]);
    if(new Set(flags).size!==flags.length)return null;
    return {keyCode:modifierCodes[flags.at(-1)],modifiers:flags,code:'Modifiers',modifierOnly:true};
  }
  const key=parts.pop();
  const flags=parts.map(x=>modifiers[x.toLowerCase()]);
  if(flags.some(x=>!x)||new Set(flags).size!==flags.length) return null;
  const aliases={enter:'Enter',return:'Enter',escape:'Escape',esc:'Escape',space:'Space',backspace:'Backspace',delete:'Delete',up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',right:'ArrowRight'};
  const code=/^[a-z]$/i.test(key)?'Key'+key.toUpperCase():/^[0-9]$/.test(key)?'Digit'+key:aliases[key.toLowerCase()];
  const punctuation={'`':'Backquote',',':'Comma','.':'Period','/':'Slash',';':'Semicolon',"'":'Quote','[':'BracketLeft',']':'BracketRight','\\':'Backslash','-':'Minus','=':'Equal'};
  const parsedCode=code??punctuation[key]??key;
  const keyCode=keys.find(x=>x.code===parsedCode)?.keyCode??extendedFunctionCodes.get(parsedCode);
  return keyCode===undefined?null:{keyCode,modifiers:flags,code:parsedCode};
}

// 26.1027's desktop registry has no default global dictation accelerator;
// composer.startDictation is retired on macOS. The host supplies public bundle
// metadata without opening Codex. Unversioned callers retain legacy support.
function globalDictationRequired(version) {
  if(!version)return false;
  const match=/^(\d{2})\.(\d{3,4})\.\d+(?:[-+].*)?$/.exec(version);
  return !match||Number(match[1])>26||Number(match[1])===26&&Number(match[2])>=1027;
}
async function legacyDictationSettings(codexHome) {
  try {
    const text=await readFile(path.join(codexHome,'.codex-global-state.json'),'utf8');
    if(text.length>8*1024*1024)throw new Error('state too large');
    const state=JSON.parse(text);
    if(!state||typeof state!=='object'||Array.isArray(state))throw new Error('invalid state');
    // These are the only values consumed. Never retain or expose other state.
    const hold=state.globalDictationHotkey,tap=state.globalDictationToggleHotkey;
    if([hold,tap].some(value=>value!=null&&typeof value!=='string'))throw new Error('invalid shortcut');
    return {hold:hold==null?tap:hold==='Fn'?null:hold,tap,configured:hold!==undefined||tap!==undefined};
  } catch(error) {
    if(error.code==='ENOENT')return {};
    throw new Error('无法读取 Codex 听写设置，请检查 .codex-global-state.json。');
  }
}
// PC names can reach the same macOS virtual key as F13-F15. Recognize them
// conservatively for collision checks without expanding the capture catalogue.
function collisionShortcut(value) {
  if(typeof value!=='string')return null;
  const parts=value.split('+'),key=parts.pop().trim();
  const aliases={printscreen:'F13',scrolllock:'F14',pause:'F15'};
  return parseMacShortcut([...parts,aliases[key.toLowerCase()]??key].join('+'),{allowBareModifiers:true});
}
function sameChord(left,right) {
  const a=collisionShortcut(left),b=collisionShortcut(right);
  return a&&b&&Boolean(a.modifierOnly)===Boolean(b.modifierOnly)&&(a.modifierOnly||a.keyCode===b.keyCode)
    &&[...a.modifiers].sort().join(',')===[...b.modifiers].sort().join(',');
}

// Only read Codex configuration; neither keymap nor legacy state is modified.
export async function resolveCodexShortcut(action,{codexHome=process.env.CODEX_HOME??path.join(homedir(),'.codex'),blockedCodes=[],codexDesktopVersion=process.env.AIR_STUDIO_CODEX_DESKTOP_VERSION,avoidCollisions=false}={}) {
  if(action.unavailableReason)throw new Error(action.unavailableReason);
  let entries=[];
  try {
    const text=await readFile(path.join(codexHome,'keybindings.json'),'utf8');
    if(text.length>262144) throw new Error('keymap too large');
    entries=JSON.parse(text);
    if(!Array.isArray(entries)||entries.some(x=>!x||typeof x.command!=='string'||!(x.key===null||typeof x.key==='string')||(Object.hasOwn(x,'version')&&x.version!==1))) throw new Error('invalid keymap');
  } catch(error) {
    if(error.code!=='ENOENT') throw new Error('无法读取 Codex 自定义快捷键，请检查 keybindings.json。');
  }
  let globalTap=false,globalHold=false,custom=false;
  let overrides=entries.filter(x=>x.command===(commandIds[action.id]??action.id));
  let candidates;
  const disabled=()=>new Error('这个动作的快捷键已在 Codex 中停用。');
  if(action.id==='dictation') {
    const tapEntries=entries.filter(x=>x.command==='globalDictationSingleTap');
    const holdEntries=entries.filter(x=>x.command==='globalDictationHold');
    const legacy=tapEntries.length&&holdEntries.length?{}:await legacyDictationSettings(codexHome);
    const binding=(items,value)=>({values:items.length?items.filter(x=>x.key!==null).map(x=>x.key):value?[value]:[],
      disabled:items.some(x=>x.key===null)});
    const tap=binding(tapEntries,legacy.tap),hold=binding(holdEntries,legacy.hold);
    if(tap.values.length&&tap.disabled)throw disabled();
    // Codex disables its toggle listener when the hold chord conflicts. Match
    // that effective configuration rather than sending an unobserved tap.
    if(tap.values.length&&!(hold.values.length&&!hold.disabled&&sameChord(tap.values[0],hold.values[0]))) {
      globalTap=true;candidates=tap.values;
    } else if(hold.values.length&&!hold.disabled) {
      globalHold=true;candidates=hold.values;
    } else if(tapEntries.length||holdEntries.length||legacy.configured||globalDictationRequired(codexDesktopVersion)) {
      if(tap.disabled||hold.disabled)throw disabled();
      throw new Error('请先在 Codex 的「设置 → 语音」中配置听写快捷键。');
    }
    if(candidates)custom=true;
  }
  if(!candidates) {
    if(overrides.some(x=>x.key===null))throw disabled();
    if(action.requiresDedicatedShortcut&&!overrides.length)
      throw new Error('请先在 Codex 的键盘快捷键设置中为此操作配置专用快捷键。');
    candidates=overrides.length?overrides.map(x=>x.key):[action.keys.join('+')];
    custom=overrides.length>0;
  }
  // Dictation's press/hold listener uses the primary accelerator only.
  const blockedKeyCodes=new Set(blockedCodes.map(code=>collisionShortcut(code)?.keyCode).filter(code=>code!==undefined));
  // A bridge may append a dedicated binding while preserving a user's normal
  // shortcut. Prefer a safe dedicated candidate instead of rejecting the first
  // ordinary binding; explicit null disabling above still wins.
  const eligible=action.requiresDedicatedShortcut?candidates.filter(value=>{
    const parsed=parseMacShortcut(value);
    return parsed&&extendedFunctionCodes.has(parsed.code)&&parsed.modifiers.some(flag=>flag!=='fn');
  }):candidates;
  if(action.requiresDedicatedShortcut&&!eligible.length)
    throw new Error('请为此操作配置 F13–F20 专用快捷键，并搭配 Ctrl、⌘、⌥ 或 ⇧ 修饰键。');
  let dedicatedConflict=false;
  for(const value of action.id==='dictation'?eligible.slice(0,1):eligible) {
    const shortcut=parseMacShortcut(value,{allowBareModifiers:globalHold||globalTap});
    // F-row captures ignore the semantic Fn bit. Compare virtual codes too:
    // aliases such as F13/PrintScreen must not re-enter a source binding.
    if(shortcut && !(!shortcut.modifierOnly&&!shortcut.modifiers.some(flag=>flag!=='fn')&&blockedKeyCodes.has(shortcut.keyCode))) {
      if(avoidCollisions&&entries.some(entry=>entry.command!==(commandIds[action.id]??action.id)&&entry.key&&sameChord(entry.key,value)))
        throw new Error('这个专用快捷键还绑定了其他 Codex 操作，请先消除冲突。');
      if(action.requiresDedicatedShortcut) {
        if(!extendedFunctionCodes.has(shortcut.code)||!shortcut.modifiers.some(flag=>flag!=='fn'))
          throw new Error('请为此操作配置 F13–F20 专用快捷键，并搭配 Ctrl、⌘、⌥ 或 ⇧ 修饰键。');
        if(entries.some(entry=>entry.command!==commandIds[action.id]&&entry.key&&sameChord(entry.key,value))) {
          dedicatedConflict=true;continue;
        }
      }
      return {...shortcut,accelerator:value,custom,...(globalTap?{delivery:'globalTap'}:globalHold?{delivery:'globalHold'}:{})};
    }
  }
  if(dedicatedConflict)throw new Error('这个专用快捷键还绑定了其他 Codex 操作，请先消除冲突。');
  throw new Error('Codex 快捷键无法转发，或与 NuPhyLab 的任务／命令键冲突。请更改其中一处绑定。');
}

export class CodexKeyGestures {
  #releasing=null;
  constructor({send,resolve,now=Date.now,onReleaseError=()=>{}}) {this.send=send;this.resolve=resolve;this.now=now;this.onReleaseError=onReleaseError;this.held=null;this.dictation={mode:'hold'};this.dictationRevision=0;}
  async inspectDictation(action) {
    const revision=++this.dictationRevision;
    try {
      const shortcut=await this.resolve(action);
      if(revision===this.dictationRevision)this.dictation={mode:shortcut.delivery==='globalTap'?'toggle':'hold',accelerator:shortcut.accelerator,...(shortcut.delivery==='accessibility'?{delivery:'accessibility',physicalOnly:true}:{})};
    } catch(error) {if(revision===this.dictationRevision)this.dictation={mode:this.dictation.mode,error:error.message};}
    return this.dictation;
  }
  async release(source=null) {
    if(!this.held||(source!==null&&this.held.source!==source)) return {released:false};
    const held=this.held;
    if(this.#releasing?.held===held)return this.#releasing.promise;
    clearTimeout(this.timer);
    // Set the in-flight identity before send can run or synchronously throw.
    // Key-up, the watchdog and mode cleanup may all release this same lease.
    const promise=Promise.resolve().then(async()=>{
      try {
        const result=await this.send(held.releaseRequest??{phase:'up'});
        if(!held.releaseRequest)return result;
        const control=this.controlResult(result,'dictation');
        if(control.released!==true)throw Object.assign(new Error('未能确认听写已结束，请在 Codex 中手动停止。'),
          {code:'CONTROL_CAPTURE_NOT_OWNED',controlDiagnostic:control.controlDiagnostic});
        if(!['idle','finishing'].includes(control.observedState))throw Object.assign(new Error('未能确认听写已结束，请在 Codex 中手动停止。'),
          {code:'CONTROL_CAPTURE_STOP_UNCONFIRMED',controlDiagnostic:control.controlDiagnostic});
        return control;
      }
      catch(error) {
        // Cleanup and watchdog releases need the same visible failure reporting
        // as a physical key-up. Private capture ownership stays inside release.
        try {await this.onReleaseError(error,{source:held.source,action:held.action});}
        catch {/* Reporting must never replace the original stop failure. */}
        throw error;
      }
      finally {
        if(this.held===held)this.held=null;
        if(this.#releasing?.held===held)this.#releasing=null;
      }
    });
    this.#releasing={held,promise};
    return promise;
  }
  controlResult(result,action) {
    // An ownership nonce is only for the native down/up transaction. It is not
    // public recording state and must never leave through a command result.
    const {owner,releaseRequest,gestureId,sourceKeyCode,bindingEpoch,...safe}=result??{};
    return {...safe,delivery:'accessibility',action};
  }
  async execute(action,{phase='tap',source='button',physicalHold}={}) {
    if(!['tap','down','up'].includes(phase)) throw new Error('按键阶段无效');
    if(phase==='up') return this.release(source);
    if(this.held?.source===source&&action.id==='dictation') return {held:true};
    await this.release();
    const revision=action.id==='dictation'?++this.dictationRevision:null;
    let shortcut;
    try {shortcut=await this.resolve(action);}
    catch(error) {
      if(revision===this.dictationRevision)this.dictation={mode:this.dictation.mode,error:error.message};
      throw error;
    }
    const semantic=shortcut.delivery==='accessibility';
    const hold=action.id==='dictation'&&shortcut.delivery!=='globalTap';
    if(revision===this.dictationRevision)this.dictation={mode:hold?'hold':'toggle',accelerator:shortcut.accelerator,
      ...(shortcut.delivery==='accessibility'?{delivery:'accessibility',physicalOnly:true}:{})};
    if(hold&&phase!=='down') throw new Error('听写需要按住命令键，松开后结束。');
    // Approval and submission keep the already visible target. A genuine
    // dictation hold may bring Codex forward and focus its current composer.
    const owner=semantic&&hold?randomUUID():null;
    const holdContext=semantic&&hold&&physicalHold?{gestureId:physicalHold.gestureId,sourceKeyCode:physicalHold.sourceKeyCode,bindingEpoch:physicalHold.bindingEpoch}:{};
    const result=await this.send({...shortcut,...(owner?{owner}:{}),...holdContext,phase:hold?'down':'tap',target:'com.openai.codex',activateTarget:semantic?action.id==='dictation':!action.requiresPhysicalPress});
    if(hold&&(!semantic||result?.performed===true)) {
      const held={source,action:'dictation',startedAt:this.now()};
      if(semantic)Object.defineProperty(held,'releaseRequest',{value:Object.freeze({delivery:'accessibility',action:'dictation',phase:'up',owner,
        target:'com.openai.codex',activateTarget:false}),enumerable:false});
      this.held=held;
      this.timer=setTimeout(()=>{if(this.held===held)void this.release(source).catch(()=>{});},120000);
      this.timer.unref?.();
    }
    return semantic?this.controlResult(result,action.id):result;
  }
}

// Carbon and a local window listener can report the same gesture across focus
// transitions. Gate it at the shared boundary before a toggle reaches Codex.
export class PhysicalPressGate {
  constructor(now=Date.now){this.now=now;this.held=new Set();this.last=new Map();this.gestures=new Map();this.activeGestures=new Map();}
  seen(code,gestureId){return gestureId!==undefined && this.gestures.has(`${code}:${gestureId}`);}
  down(code,gestureId){
    if(gestureId!==undefined){
      if(typeof gestureId!=='string'||!gestureId.length||gestureId.length>160||!/^[A-Za-z0-9:._-]+$/.test(gestureId))throw new Error('按键手势无效');
      const identity=`${code}:${gestureId}`;
      if(this.gestures.has(identity))return false;
      this.gestures.set(identity,true);
      if(this.gestures.size>2048)this.gestures.delete(this.gestures.keys().next().value);
      if(this.held.has(code))return false;
      this.held.add(code);this.activeGestures.set(code,gestureId);return true;
    }
    if(this.held.has(code))return false;
    this.held.add(code);
    const now=this.now();
    if(now-(this.last.get(code)??-Infinity)<250)return false;
    this.last.set(code,now);return true;
  }
  up(code,gestureId){
    if(gestureId!==undefined){
      if(this.activeGestures.get(code)!==gestureId)return false;
      this.activeGestures.delete(code);this.held.delete(code);return true;
    }
    if(this.activeGestures.has(code))return false;
    this.held.delete(code);return true;
  }
  // Preserve structured identities across binding/focus resets: a delayed
  // delivery of the same gesture must not become a new action after reset.
  reset(){this.held.clear();this.last.clear();this.activeGestures.clear();}
}
