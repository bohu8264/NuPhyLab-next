import {useEffect,useRef,useState} from 'react';
import {Archive,ArrowDownToLine,ArrowUpFromLine,ChevronDown,Copy,FolderOpen,GripVertical,Keyboard,Search,Trash2,Undo2} from 'lucide-react';
import {useLanguage} from './i18n';
import './keyboard-pocket.css';

type PocketSettings={enabled:boolean;previewEnabled:boolean;useModifiers:string[];captureModifiers:string[];useTriggerKeyCode:number|null;captureTriggerKeyCode:number|null;slotKeyCodes:number[];slotKeyNames:string[];slotOrder:number[];clearAfterUse:boolean;plainText:boolean;sequential:boolean;sequenceIndex:number;retainDays:number};
type Slot={index:number;id?:string;empty?:boolean;kind?:string;title?:string;summary?:string;preview?:string;text?:string;thumbnail?:string;pinned?:boolean;missing?:boolean;containsFolders?:boolean;fileCount?:number;count?:number;shortcutKey?:string;shortcutCode?:number};
type Recording={kind:'use'|'capture'|'slot';index?:number};
type PocketStatus={slots:Slot[];canUndo:boolean;settings:PocketSettings;permissions:{accessibility:boolean};hotkeyReady:boolean;hotkeys:{slotStatus:string;functionObserved:boolean;slotReady:boolean};recording?:Recording|null;fileAccessRequiredIndex?:number|null;status:string;issue?:string;keyChoices:{code:number;name:string}[]};
const defaults:PocketSettings={enabled:false,previewEnabled:true,useModifiers:['fn'],captureModifiers:['fn','shift'],useTriggerKeyCode:null,captureTriggerKeyCode:null,slotKeyCodes:[18,19,20,21,23,22,26,28,25],slotKeyNames:['1','2','3','4','5','6','7','8','9'],slotOrder:[0,1,2,3,4,5,6,7,8],clearAfterUse:false,plainText:false,sequential:false,sequenceIndex:0,retainDays:0};
let pageSequence=0;
const modifierLabels:Record<string,string>={fn:'Fn',control:'⌃ Control',option:'⌥ Option',shift:'⇧ Shift',command:'⌘ Command'};
async function native(op:string,values:Record<string,unknown>={}):Promise<PocketStatus>{
 const bridge=(window as unknown as {webkit?:{messageHandlers?:{keyboardPocket?:{postMessage:(body:unknown)=>Promise<PocketStatus>}}}}).webkit?.messageHandlers?.keyboardPocket;
 if(!bridge)throw new Error('请在 NuPhy Lab 中使用 / Open this page in NuPhy Lab');
 return bridge.postMessage({op,...values});
}
function orderedSlots(state:PocketStatus|null):Slot[]{
 const order=state?.settings.slotOrder;
 const valid=Array.isArray(order)&&order.length===9&&new Set(order).size===9&&order.every(x=>Number.isInteger(x)&&x>=0&&x<9);
 return (valid?order:defaults.slotOrder).map(index=>state?.slots.find(slot=>slot.index===index)??{index,empty:true});
}
export function KeyboardPocketLab(){
 const english=useLanguage()==='en',copy=(zh:string,en:string)=>english?en:zh;
 const [state,setState]=useState<PocketStatus|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[keysOpen,setKeysOpen]=useState(false),[dragging,setDragging]=useState<number|null>(null),[recording,setRecording]=useState<Recording|null>(null),[cancelling,setCancelling]=useState(false);
 const alive=useRef(true),writing=useRef(false),generation=useRef(0),recordGeneration=useRef(0),recordingRef=useRef<Recording|null>(null),cancellingRef=useRef(false),latest=useRef<PocketStatus|null>(null),grid=useRef<HTMLDivElement|null>(null),layoutSchedule=useRef<()=>void>(()=>{}),pageTokenRef=useRef<string|null>(null);
 const accept=(next:PocketStatus)=>{latest.current=next;recordingRef.current=next.recording??null;setState(next);};
 useEffect(()=>{
  alive.current=true;let reading=false;
  const read=async()=>{if(reading||writing.current)return;reading=true;const ticket=generation.current;try{const next=await native('refresh');if(alive.current&&!writing.current&&ticket===generation.current)accept(next);}catch(e){if(alive.current&&ticket===generation.current)setError((e as Error).message);}finally{reading=false;}};
  void read();const timer=setInterval(read,500);window.addEventListener('focus',read);
  return()=>{alive.current=false;generation.current++;recordGeneration.current++;clearInterval(timer);window.removeEventListener('focus',read);};
 },[]);
 useEffect(()=>{
  const pageToken=`pocket-${Date.now()}-${++pageSequence}`;pageTokenRef.current=pageToken;let active=true,timer:ReturnType<typeof setTimeout>|null=null;
  void native('page',{active:true,pageToken}).catch(()=>{});
  const sendLayout=()=>{timer=null;if(!active||!grid.current)return;const rects=Array.from(grid.current.querySelectorAll<HTMLElement>('[data-pocket-slot]')).map(node=>{const rect=node.getBoundingClientRect();return {index:Number(node.dataset.pocketSlot),x:rect.x,y:rect.y,width:rect.width,height:rect.height};}).filter(rect=>rect.width>0&&rect.height>0);void native('layout',{pageToken,rects}).catch(()=>{});};
  const schedule=()=>{if(!active)return;if(timer!==null)clearTimeout(timer);timer=setTimeout(sendLayout,40);};
  layoutSchedule.current=schedule;const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(schedule):null;if(grid.current)observer?.observe(grid.current);
  window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);schedule();
  return()=>{active=false;if(recordingRef.current)void native('cancelShortcutRecording',{pageToken}).catch(()=>{});recordingRef.current=null;if(pageTokenRef.current===pageToken)pageTokenRef.current=null;void native('internalDrag',{active:false,pageToken}).catch(()=>{});layoutSchedule.current=()=>{};if(timer!==null)clearTimeout(timer);observer?.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);void native('page',{active:false,pageToken}).catch(()=>{});};
 },[]);
 useEffect(()=>{layoutSchedule.current();},[query,keysOpen,state?.settings.slotOrder?.join(','),state?.slots.map(slot=>`${slot.index}:${slot.id??''}`).join(',')]);
 useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&recordingRef.current){event.preventDefault();event.stopPropagation();void cancelRecording();}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[]);
 async function request(op:string,values:Record<string,unknown>={}):Promise<boolean>{
  if(writing.current||!alive.current)return false;
  writing.current=true;generation.current++;setBusy(true);setError('');
  try{const next=await native(op,values);if(alive.current)accept(next);return true;}
  catch(e){if(alive.current)setError((e as Error).message);return false;}
  finally{writing.current=false;if(alive.current)setBusy(false);}
 }
 async function recordShortcut(target:Recording){
  if(writing.current||!alive.current||!latest.current)return;
  const ticket=++recordGeneration.current;generation.current++;writing.current=true;recordingRef.current=target;setRecording(target);setBusy(true);setError('');
  try{const next=await native('recordShortcut',{...target,pageToken:pageTokenRef.current});if(alive.current&&ticket===recordGeneration.current)accept(next);}
  catch(e){if(alive.current&&ticket===recordGeneration.current)setError((e as Error).message);}
  finally{if(alive.current&&ticket===recordGeneration.current){writing.current=false;recordingRef.current=null;setRecording(null);setBusy(false);}}
 }
 async function cancelRecording(){
  if(!recordingRef.current||cancellingRef.current)return;
  cancellingRef.current=true;const ticket=++recordGeneration.current;generation.current++;setCancelling(true);
  try{const next=await native('cancelShortcutRecording',{pageToken:pageTokenRef.current});if(alive.current&&ticket===recordGeneration.current){accept(next);recordingRef.current=null;writing.current=false;setRecording(null);setBusy(false);}}
  catch(e){if(alive.current&&ticket===recordGeneration.current)setError((e as Error).message);}
  finally{cancellingRef.current=false;if(alive.current&&ticket===recordGeneration.current)setCancelling(false);}
 }
 const settings=state?.settings??defaults,slots=orderedSlots(state),enabled=Boolean(state&&settings.enabled),activeRecording=recording??state?.recording??null,disabled=!state||busy||Boolean(activeRecording);
 const occupied=(slot:Slot)=>Boolean(slot.id)&&slot.empty!==true;
 const localMessage=(message:string)=>{const parts=message.split(' / ');if(parts.length===2&&/[\u3400-\u9fff]/.test(parts[0]))return english?parts[1]:parts[0];return message;};
 const keyName=(index:number)=>state?.slots.find(slot=>slot.index===index)?.shortcutKey||settings.slotKeyNames?.[index]||state?.keyChoices?.find(key=>key.code===settings.slotKeyCodes[index])?.name||String(index+1);
 const kindName=(kind?:string)=>({text:copy('文字','Text'),richText:copy('富文本','Rich text'),link:copy('链接','Link'),image:copy('图片','Image'),files:copy('文件','Files')}[kind??'']??copy('内容','Content'));
 const slotName=(slot:Slot)=>slot.title||kindName(slot.kind);
 const prefixName=(kind:'use'|'capture')=>{const mods=kind==='use'?settings.useModifiers:settings.captureModifiers,key=kind==='use'?settings.useTriggerKeyCode:settings.captureTriggerKeyCode;const parts=mods.map(value=>modifierLabels[value]??value);if(key!=null)parts.push(state?.keyChoices?.find(item=>item.code===key)?.name??String(key));return parts.join(' + ');};
 const update=(values:Partial<PocketSettings>)=>void request('settings',{values});
 function moveSlot(index:number,position:number){
  const order=orderedSlots(latest.current).map(slot=>slot.index),old=order.indexOf(index);if(old<0||position<0||position>8||old===position)return;
  order.splice(old,1);order.splice(position,0,index);update({slotOrder:order});
 }
 function internalDrag(index:number|null){setDragging(index);const pageToken=pageTokenRef.current;if(pageToken)void native('internalDrag',{active:index!==null,pageToken}).catch(()=>{});}
 const occupiedCount=slots.filter(occupied).length;
 const visible=slots.filter(slot=>!query.trim()||[slotName(slot),slot.summary,slot.preview,slot.text,keyName(slot.index)].some(text=>text?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
 const usesFn=settings.useModifiers.includes('fn')||settings.captureModifiers.includes('fn');
 const readiness=!state?copy('正在连接…','Connecting…'):!enabled?copy('已关闭','Off'):!state.permissions.accessibility?copy('需要辅助功能权限','Accessibility access needed'):usesFn&&!state.hotkeys.functionObserved?copy('等待检测 Fn','Waiting for Fn'):state.hotkeys.slotReady?copy('已就绪','Ready'):copy('快捷键未就绪','Shortcuts not ready');
 const showReadiness=Boolean(!activeRecording&&(!state||(enabled&&(!state.permissions.accessibility||(usesFn&&!state.hotkeys.functionObserved)||!state.hotkeys.slotReady))));
 const statusText=state?.status&&!['设置已保存','Settings saved','已就绪','Ready','直达快捷键就绪','Slot shortcuts are ready','快捷键已关闭','Shortcuts are off','已关闭','Off'].includes(state.status)?localMessage(state.status):'';
 return <section className="kp-page">
  <div className="kp-card kp-header"><div><h2>{copy('开启键盘口袋','Enable Keyboard Pocket')}</h2><p>{copy('把常用内容放进九个槽位，随时收纳和取用。','Nine slots for content you want close at hand.')}</p></div><button className={'kp-switch '+(enabled?'is-on':'')} role="switch" aria-checked={enabled} aria-label={copy('开启键盘口袋','Enable Keyboard Pocket')} disabled={disabled} onClick={()=>update({enabled:!settings.enabled})}><span/></button></div>
  <div className="kp-shortcuts" aria-label={copy('收纳与取用快捷键','Store and retrieve shortcuts')}>{(['use','capture'] as const).map(kind=>{const isRecording=activeRecording?.kind===kind;return <div key={kind} className={'kp-card kp-shortcut-card '+(isRecording?'is-recording':'')}><div className="kp-shortcut-heading">{kind==='use'?<ArrowUpFromLine size={18}/>:<ArrowDownToLine size={18}/>}<div><h3>{kind==='use'?copy('取用','Retrieve'):copy('收纳','Store')}</h3><p>{kind==='use'?copy('粘贴对应槽位的内容','Paste content from a slot'):copy('收纳当前选中的内容','Store your current selection')}</p></div></div><button className="kp-record-button" disabled={disabled} aria-label={kind==='use'?copy('录制取用快捷键','Record retrieve shortcut'):copy('录制收纳快捷键','Record store shortcut')} aria-pressed={isRecording} onClick={()=>void recordShortcut({kind})}><Keyboard size={17}/><span>{isRecording?copy('请按键并松开…','Press keys, then release…'):prefixName(kind)}</span><span className="kp-slot-suffix">+ {copy('槽位键','slot key')}</span></button><span className="kp-record-hint">{copy('点击后按下一个或两个按键','Click, then press one or two keys')}</span></div>;})}</div>
  {activeRecording&&<div className="kp-recording-notice" role="status"><span>{activeRecording.kind==='slot'?copy(`请按下槽位 ${(activeRecording.index??0)+1} 的按键后松开。`,`Press and release a key for slot ${(activeRecording.index??0)+1}.`):copy('按下要使用的一个或两个按键，松开保存。','Press one or two keys, then release to save.')} <kbd>Esc</kbd> {copy('取消','to cancel')}</span><button className="kp-button" disabled={cancelling} onClick={()=>void cancelRecording()}>{cancelling?copy('取消中…','Cancelling…'):copy('取消录制','Cancel recording')}</button></div>}
  {(error||state?.issue)&&<div className="kp-notice" role="alert">{localMessage(error||state?.issue||'')}</div>}
  <div className="kp-toolbar"><label className="kp-search"><Search size={16}/><input value={query} disabled={Boolean(activeRecording)} onChange={event=>setQuery(event.target.value)} placeholder={copy('搜索口袋内容','Search your pockets')} aria-label={copy('搜索口袋内容','Search your pockets')}/></label><div className="kp-toolbar-actions"><span className="kp-count">{occupiedCount} / 9</span><button className="kp-icon-button" disabled={disabled||!state?.canUndo} title={copy('撤销','Undo')} aria-label={copy('撤销','Undo')} onClick={()=>void request('undo')}><Undo2 size={16}/></button><button className="kp-button" disabled={disabled||occupiedCount===0} onClick={()=>void request('clearAll')}><Trash2 size={15}/>{copy('清空口袋','Clear pockets')}</button></div></div>
  <div className="kp-grid" ref={grid} aria-label={copy('九个口袋槽位','Nine pocket slots')}>
   {visible.map(slot=><article key={slot.index} data-slot={slot.index} data-pocket-slot={slot.index} className={'kp-slot '+(!occupied(slot)?'is-empty ':'')+(dragging===slot.index?'is-dragging':'')} draggable={!disabled&&!query} onDragStart={event=>{if(disabled||query){event.preventDefault();return;}internalDrag(slot.index);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-nuphy-pocket-slot',String(slot.index));}} onDragOver={event=>{if(dragging!==null&&!disabled&&!query){event.preventDefault();event.dataTransfer.dropEffect='move';}}} onDrop={event=>{if(dragging!==null){event.preventDefault();moveSlot(dragging,slots.findIndex(item=>item.index===slot.index));internalDrag(null);}}} onDragEnd={()=>internalDrag(null)}>
    <div className="kp-slot-header"><kbd>{keyName(slot.index)}</kbd><span>{copy(`槽位 ${slot.index+1}`,`Slot ${slot.index+1}`)}</span><GripVertical className="kp-grip" size={14} aria-hidden="true"/></div>
    {occupied(slot)?<><div className="kp-slot-body">{slot.thumbnail?.startsWith('data:image/')?<img className="kp-thumbnail" src={slot.thumbnail} alt={slotName(slot)}/>:slot.kind==='image'?<Archive className="kp-file-icon" size={28}/>:null}<div><h3 title={slotName(slot)}>{slotName(slot)}</h3><p>{slot.summary||slot.preview||slot.text||(slot.kind==='files'?copy(`${slot.fileCount??slot.count??1} 个文件`,`${slot.fileCount??slot.count??1} files`):kindName(slot.kind))}</p></div></div>{slot.missing&&<span className="kp-missing">{copy('原文件不可用','Original file unavailable')}</span>}<div className="kp-slot-actions"><button className="kp-text-button" disabled={disabled||!enabled||slot.missing} onClick={()=>void request('copy',{index:slot.index})}><Copy size={14}/>{slot.containsFolders?copy('复制 ZIP','Copy ZIP'):copy('复制','Copy')}</button>{state?.fileAccessRequiredIndex===slot.index&&<button className="kp-text-button" disabled={disabled||!enabled} onClick={()=>void request('reconnect',{index:slot.index})}>{copy('重新选择原文件','Reselect original')}</button>}<button className="kp-icon-button" aria-label={copy(`删除槽位 ${slot.index+1} 的内容`,`Delete content from slot ${slot.index+1}`)} title={copy('删除内容','Delete content')} disabled={disabled} onClick={()=>void request('clear',{index:slot.index})}><Trash2 size={14}/></button></div></>:<div className="kp-empty-content"><FolderOpen size={25}/><button className="kp-text-button" disabled={disabled||!enabled} onClick={()=>void request('import',{index:slot.index})}>{copy('选择文件或文件夹','Choose file or folder')}</button><span>{copy('或将内容拖到这里','Or drop content here')}</span></div>}
   </article>)}
  </div>
  {!visible.length&&<div className="kp-no-results">{copy('没有找到匹配的内容','No matching content')}</div>}
  <div className="kp-board-footer"><span>{copy('拖动槽位调整位置，内容和快捷键一起移动。','Drag slots to reorder. Content and keys move together.')}</span><span>{copy('内容保存在本机','Stored on this Mac')}</span></div>
  <section className="kp-card kp-settings" aria-label={copy('口袋设置','Pocket settings')}>
   <div className="kp-setting-row"><div><h3>{copy('浮窗预览','Floating preview')}</h3><p>{copy('按住收纳或取用快捷键，查看各槽内容。','Hold a store or retrieve shortcut to preview your slots.')}</p></div><button className={'kp-switch '+(settings.previewEnabled?'is-on':'')} role="switch" aria-checked={settings.previewEnabled} aria-label={copy('浮窗预览','Floating preview')} disabled={disabled} onClick={()=>update({previewEnabled:!settings.previewEnabled})}><span/></button></div>
   <div className="kp-slot-settings"><button className="kp-disclosure" disabled={Boolean(activeRecording)} aria-expanded={keysOpen} aria-controls="kp-slot-keys" onClick={()=>setKeysOpen(!keysOpen)}><span>{copy('槽位按键','Slot keys')}</span><span className="kp-disclosure-note">{copy('收纳和取用共用','Shared by store and retrieve')}</span><ChevronDown size={15}/></button><div id="kp-slot-keys" className="kp-keymap-grid" hidden={!keysOpen}>{slots.map(slot=>{const isRecording=activeRecording?.kind==='slot'&&activeRecording.index===slot.index;return <div className="kp-keymap-item" key={slot.index}><span>{copy(`槽位 ${slot.index+1}`,`Slot ${slot.index+1}`)}</span><button className={'kp-slot-record '+(isRecording?'is-recording':'')} disabled={disabled} aria-label={copy(`录制槽位 ${slot.index+1} 的按键`,`Record key for slot ${slot.index+1}`)} onClick={()=>void recordShortcut({kind:'slot',index:slot.index})}><Keyboard size={14}/>{isRecording?copy('请按键…','Press a key…'):keyName(slot.index)}</button></div>;})}</div></div>
   <div className="kp-options">{([{field:'plainText',zh:'以纯文本复制',en:'Copy as plain text'},{field:'clearAfterUse',zh:'取用后清空',en:'Clear after retrieval'}] as const).map(item=><label key={item.field}><input type="checkbox" checked={settings[item.field]} disabled={disabled} onChange={event=>update({[item.field]:event.target.checked})}/><span>{copy(item.zh,item.en)}</span></label>)}</div>
  </section>
  <div className="kp-footer"><div>{showReadiness&&<span className="kp-readiness">{readiness}</span>}{statusText&&!activeRecording&&<span role="status">{statusText}</span>}</div><div>{enabled&&state&&!state.permissions.accessibility&&<button className="kp-button" disabled={disabled} onClick={()=>void request('permission')}>{copy('去授权','Allow access')}</button>}<button className="kp-button" disabled={disabled||!enabled||!settings.previewEnabled} onClick={()=>void request('openPanel')}><Archive size={15}/>{copy('打开口袋浮窗','Open pockets')}</button></div></div>
  {enabled&&usesFn&&state?.permissions.accessibility&&!state.hotkeys.functionObserved&&<p className="kp-fn-note">{copy('部分外接键盘不会向系统发送 Fn；若无响应，可重新录制其他按键。','Some external keyboards do not send Fn to macOS. If it does not respond, record another key.')}</p>}
 </section>;
}
