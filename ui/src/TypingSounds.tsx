import {useEffect, useId, useRef, useState} from 'react';
import {ArrowLeft, Check, ChevronRight, Play, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Square, Star, Volume2, VolumeX} from 'lucide-react';
import {useLanguage} from './i18n';
import './typing-sounds.css';

type KeyGroup = 'regular' | 'space' | 'enter' | 'backspace' | 'shiftLeft' | 'shiftRight' | 'tab' | 'caps';
type LargeKey = Exclude<KeyGroup, 'regular'>;
type Preferences = {enabled:boolean;pack:string;volume:number;muted:boolean;release:number;variation:boolean;gains:Record<LargeKey,number>;favorites:string[]};
type Sound = {id:string;name:string;names?:{zh:string;en:string};category:string;description?:{zh:string;en:string};designed?:boolean;dedicatedLargeKeys?:boolean;source?:string};
type Category = {id:string;zh:string;en:string};
type TypingStatus = {preferences:Preferences;state:'off'|'preparing'|'permission'|'paused'|'ready'|'error';reason:string;inputMonitoring:boolean;previewing:boolean;catalog:{categories:Category[];packs:Sound[]};issue:string};
type RequestBody = Record<string,unknown> | ((preferences:Preferences)=>Record<string,unknown>);
const keys: {id:KeyGroup;zh:string;en:string;cap:string}[] = [
  {id:'regular',zh:'普通键',en:'Regular',cap:'A'}, {id:'space',zh:'空格',en:'Space',cap:'Space'},
  {id:'enter',zh:'回车',en:'Return',cap:'↵'}, {id:'backspace',zh:'退格',en:'Backspace',cap:'⌫'},
  {id:'shiftLeft',zh:'左 Shift',en:'Left Shift',cap:'⇧ L'}, {id:'shiftRight',zh:'右 Shift',en:'Right Shift',cap:'⇧ R'},
  {id:'tab',zh:'Tab',en:'Tab',cap:'⇥'}, {id:'caps',zh:'Caps Lock',en:'Caps Lock',cap:'⇪'},
];
const recommended = ['mahjong-crisp','wood-bamboo','soft-velvet'];
const initial:Preferences={enabled:false,pack:'mahjong-crisp',volume:50,muted:false,release:70,variation:true,gains:{space:100,enter:100,backspace:100,shiftLeft:100,shiftRight:100,tab:100,caps:100},favorites:[]};
const nameOf=(sound:Sound,en:boolean)=>sound.names?.[en?'en':'zh']||sound.name;
function bridge() {
  return (window as unknown as {webkit?:{messageHandlers?:{typingSounds?:{postMessage:(body:unknown)=>Promise<unknown>}}}}).webkit?.messageHandlers?.typingSounds;
}
export function parseTypingStatus(value:unknown):TypingStatus {
  const s=value as TypingStatus|undefined,p=s?.preferences;
  const within=(v:unknown,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max;
  if(!s||!p||!['off','preparing','permission','paused','ready','error'].includes(s.state)
    ||typeof p.enabled!=='boolean'||typeof p.pack!=='string'||typeof p.muted!=='boolean'||typeof p.variation!=='boolean'
    ||!within(p.volume,100)||!within(p.release,100)||!keys.slice(1).every(k=>within(p.gains?.[k.id as LargeKey],150))
    ||!Array.isArray(p.favorites)||!p.favorites.every(x=>typeof x==='string')
    ||typeof s.inputMonitoring!=='boolean'||typeof s.previewing!=='boolean'
    ||!Array.isArray(s.catalog?.packs)||!Array.isArray(s.catalog?.categories)
    ||!s.catalog.packs.every(x=>x&&typeof x.id==='string'&&typeof x.name==='string'&&typeof x.category==='string')
    ||!s.catalog.categories.every(x=>x&&typeof x.id==='string'&&typeof x.zh==='string'&&typeof x.en==='string'))throw Error('invalidStatus');
  return s;
}
export function typingIssue(code:string,en:boolean):string {
  const messages:Record<string,[string,string]>={
    configuration:['声音库未能载入，请重新检查。','The sound library could not load. Please check again.'],
    audio:['暂时无法播放声音，请重新检查音频输出。','Sound could not play. Please check the audio output again.'],
    settings:['设置未能保存，请重试。','Settings could not be saved. Please try again.'],
    cancelled:['试听已取消，可以重新试听。','The preview was cancelled. You can try it again.'],
    unavailable:['模拟声浪暂时不可用，请重新检查。','Typing Sounds is unavailable. Please check again.'],
    unsupported:['此操作暂不可用，请重新检查。','This action is unavailable. Please check again.'],
  };
  return (messages[code]??messages.unavailable)[en?1:0];
}
export function typingReadiness(s:TypingStatus|null,en:boolean,failed=false):{label:string;detail:string;permission?:boolean;retry?:boolean} {
  const say=(zh:string,english:string)=>en?english:zh;
  if(!s)return {label:say(failed?'暂时不可用':'正在读取',failed?'Unavailable':'Loading'),detail:say('请在 NuPhy Lab 中使用模拟声浪。','Use Typing Sounds in NuPhy Lab.'),retry:true};
  if(failed)return {label:say('状态待确认','Status unconfirmed'),detail:say('刚才的操作未完成，请重新检查。','The last action did not complete. Please check again.'),retry:true};
  if(s.state==='error')return {label:say('声音暂时不可用','Sound unavailable'),detail:typingIssue(s.issue,en),retry:true};
  if(!s.preferences.enabled)return {label:say('已关闭','Off'),detail:say('仍可点击试听。开启后，在其他应用打字时也会播放声音。','You can still preview sounds. Turn on to hear them while typing in other apps.')};
  if(s.state==='permission'||!s.inputMonitoring)return {label:say('待授权','Permission needed'),detail:say('在其他应用打字时播放声音，需要允许输入监控。点击试听无需授权。','Allow Input Monitoring to play sounds while typing in other apps. Click previews need no permission.'),permission:true,retry:true};
  if(s.state==='paused') {
    const detail=s.reason==='secureInput'?say('系统正在保护当前输入，打字音效已暂停。','Typing sounds are paused while macOS protects the current input.')
      :s.reason==='dictationUnconfirmed'?say('听写结束状态未确认。请先在 Codex 停止听写，再关闭并重新开启模拟声浪。','Dictation could not be confirmed stopped. Stop dictation in Codex, then turn Typing Sounds off and on.')
      :s.reason==='recording'?say('正在使用语音、麦克风或录制快捷键，打字音效暂时暂停。','Typing sounds are paused while voice input, microphone capture or shortcut recording is active.')
      :s.reason==='session'?say('当前会话暂不播放声音，返回后可重新检查。','Sounds are paused for this session. Check again after returning.')
      :say('打字音效暂时暂停，请重新检查。','Typing sounds are paused. Please check again.');
    return {label:say('已暂停','Paused'),detail,retry:true};
  }
  if(s.state!=='ready')return {label:say('正在准备','Preparing'),detail:say('正在准备打字音效，请稍候。','Getting typing sounds ready. Please wait.'),retry:true};
  if(s.preferences.muted||s.preferences.volume===0)return {label:say('输出已静音','Output muted'),detail:say('调高音量并取消静音即可恢复声音。','Raise the volume and unmute to hear sounds.')};
  return {label:say('已开启','On'),detail:say('打字音效已就绪。','Typing sounds are ready.')};
}
function useTypingStatus() {
  const [status,setStatus]=useState<TypingStatus|null>(null),[failed,setFailed]=useState(false),[failureCode,setFailureCode]=useState(''),[busy,setBusy]=useState(false);
  const mounted=useRef(false),generation=useRef(0),latest=useRef<TypingStatus|null>(null),queue=useRef<Promise<unknown>>(Promise.resolve()),pending=useRef(0),reading=useRef(false);
  function run(op:string,body:RequestBody={},background=false):Promise<boolean> {
    const requestGeneration=generation.current;
    if(!background){pending.current++;setBusy(true);}
    const result=queue.current.catch(()=>{}).then(async()=>{
      // Pending user saves finish on leaving, but a queued preview must never start after leaving.
      try {
        if((!mounted.current||generation.current!==requestGeneration)&&op!=='save')return false;
        const handler=bridge();if(!handler)throw Error('unavailable');
        const payload=typeof body==='function'?body(latest.current?.preferences??initial):body;
        const next=parseTypingStatus(await handler.postMessage({op,...payload}));latest.current=next;
        if(mounted.current&&generation.current===requestGeneration){setStatus(next);setFailed(false);}return true;
      } catch(error) {if(mounted.current&&generation.current===requestGeneration){setFailed(true);setFailureCode(typeof error==='string'?error:error instanceof Error?error.message:'unavailable');if(background){latest.current=null;setStatus(null);}}return false;}
      finally {if(!background){pending.current--;if(mounted.current)setBusy(pending.current>0);}}
    });
    queue.current=result;return result;
  }
  useEffect(()=>{
    mounted.current=true;generation.current++;
    const read=()=>{
      if(reading.current||pending.current||document.hidden)return;
      reading.current=true;void run('status',{},true).finally(()=>{reading.current=false;});
    };
    read();const timer=window.setInterval(read,1500);window.addEventListener('focus',read);document.addEventListener('visibilitychange',read);
    return()=>{
      mounted.current=false;generation.current++;window.clearInterval(timer);window.removeEventListener('focus',read);document.removeEventListener('visibilitychange',read);
      // Queue cleanup after any in-flight preview or save. Never turn global typing playback off.
      queue.current=queue.current.catch(()=>{}).then(async()=>{try{await bridge()?.postMessage({op:'stopPreview'});}catch{/* Native lifetime may end at the same time. */}});
    };
  },[]);
  return {status,failed,failureCode,busy,run};
}
// Keep a local slider draft; debounce native writes and also commit on pointer/keyboard completion.
export function SoundRange({label,value,max=100,disabled,onCommit,voiceId}:{voiceId?:string;label:string;value:number;max?:number;disabled:boolean;onCommit:(value:number)=>void}) {
  const id=useId(),[draft,setDraft]=useState(value),current=useRef(value),last=useRef(value),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const commitRef=useRef(onCommit);commitRef.current=onCommit;
  const flush=()=>{if(timer.current!==null)clearTimeout(timer.current);timer.current=null;if(current.current!==last.current){last.current=current.current;commitRef.current(current.current);}};
  useEffect(()=>{if(!disabled&&timer.current===null){current.current=value;last.current=value;setDraft(value);}},[value,disabled]);
  useEffect(()=>()=>{flush();},[]);
  return <div className="ts-range"><label htmlFor={id}>{label}</label><input data-voice-control={voiceId} data-voice-saved={value} id={id} aria-label={label} type="range" min={0} max={max} step={1} value={draft} disabled={disabled}
    onChange={event=>{const next=Number(event.target.value);current.current=next;setDraft(next);if(timer.current!==null)clearTimeout(timer.current);timer.current=setTimeout(flush,200);}}
    onPointerUp={flush} onKeyUp={flush} onBlur={flush}/><output htmlFor={id}>{draft}%</output></div>;
}
function SwitchGlyph(){return <svg viewBox="0 0 64 66" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M9 14 32 5 55 14 32 24ZM9 14v9l23 10 23-10v-9M32 24v9M26 14h12M32 11v6M26 33v7M38 33v7M27 39q10-4 10 2t-10 2 10 2-10 2 10 2M13 45l9-4m20 0 9 4-19 9-19-9v7l19 9 19-9v-7M32 54v7"/></svg>;}
export function TypingSounds() {
  const en=useLanguage()==='en',say=(zh:string,english:string)=>en?english:zh;
  const {status,failed,failureCode,busy,run}=useTypingStatus();
  const [view,setView]=useState<'home'|'library'|'tuning'>('home'),[category,setCategory]=useState('all'),[query,setQuery]=useState(''),[favoritesOnly,setFavoritesOnly]=useState(false),[previewPack,setPreviewPack]=useState('');
  const prefs=status?.preferences??initial,packs=status?.catalog.packs??[],categories=status?.catalog.categories??[],selected=packs.find(p=>p.id===prefs.pack);
  const unavailable=!status,disabled=unavailable||busy,readiness=typingReadiness(status,en,failed);
  const save=(patch:Partial<Preferences>|((p:Preferences)=>Partial<Preferences>))=>run('save',p=>({patch:typeof patch==='function'?patch(p):patch}));
  const preview=async(pack:string,group?:KeyGroup)=>{if(await run('preview',{pack,...(group?{group}:{})}))setPreviewPack(pack);};
  const stop=async()=>{if(await run('stopPreview'))setPreviewPack('');};
  const favorite=(id:string)=>void save(p=>({favorites:p.favorites.includes(id)?p.favorites.filter(x=>x!==id):[...p.favorites,id]}));
  const catName=(id:string)=>{const c=categories.find(c=>c.id===id);return c?(en?c.en:c.zh):'';};
  const matches=(pack:Sound)=>{const q=query.trim().toLocaleLowerCase();return (category==='all'||pack.category===category)&&(!favoritesOnly||prefs.favorites.includes(pack.id))&&(!q||[pack.name,pack.names?.zh,pack.names?.en,pack.description?.zh,pack.description?.en,catName(pack.category)].join(' ').toLocaleLowerCase().includes(q));};
  const visible=packs.filter(matches),suggestions=recommended.map(id=>packs.find(p=>p.id===id)).filter((p):p is Sound=>!!p);
  const card=(pack:Sound)=>{const chosen=pack.id===prefs.pack,playing=status?.previewing&&previewPack===pack.id;return <article className={'ts-sound-card'+(chosen?' selected':'')} key={pack.id} data-sound={pack.id}>
    <div className="ts-card-top"><SwitchGlyph/><div><h3>{nameOf(pack,en)}</h3><p>{catName(pack.category)} · {pack.designed?say('调校音色','Tuned sound'):say('经典采样','Classic sample')}</p></div><button type="button" className="ts-icon" aria-label={say('收藏 ','Favorite ')+nameOf(pack,en)} aria-pressed={prefs.favorites.includes(pack.id)} disabled={disabled} onClick={()=>favorite(pack.id)}><Star size={15} fill={prefs.favorites.includes(pack.id)?'currentColor':'none'}/></button></div>
    <p className="ts-description">{pack.description?.[en?'en':'zh']}</p><div className="ts-card-actions"><button type="button" disabled={disabled} onClick={()=>playing?stop():preview(pack.id)}>{playing?<Square size={13}/>:<Play size={13}/>} {playing?say('停止','Stop'):say('试听','Preview')}</button><button type="button" className={chosen?'ts-primary':''} disabled={disabled||chosen} aria-label={say('选用 ','Use ')+nameOf(pack,en)} onClick={()=>void save({pack:pack.id})}>{chosen?<><Check size={13}/>{say('已选用','Selected')}</>:say('选用','Use sound')}</button></div>
  </article>;};
  return <section className="typing-sounds" aria-label={say('模拟声浪','Typing Sounds')}>
    <p className="ts-subtitle">{say('为打字选择你喜欢的声音。','Choose how your keyboard sounds.')}</p>
    <div className="ts-hero">
      <div className="ts-hero-glyph"><SwitchGlyph/></div><div className="ts-hero-main"><div className="ts-current-row"><div><span className="ts-eyebrow">{say('当前声音','Current sound')}</span><h2>{selected?nameOf(selected,en):failed?say('声音暂不可用','Sounds unavailable'):say('正在读取声音','Loading sounds')}</h2><p>{selected?(selected.designed?say('调校音色','Tuned sound'):say('经典采样','Classic sample')):say('从声音库选择','Choose from the sound library')}</p></div>
        <div className="ts-hero-actions"><div className="ts-switch-row"><span>{readiness.label}</span><button type="button" role="switch" data-voice-control="typing-sounds" aria-label={say('开启模拟声浪','Enable typing sounds')} aria-checked={prefs.enabled} className={'ts-switch'+(prefs.enabled?' checked':'')} disabled={disabled} onClick={()=>void save({enabled:!prefs.enabled})}><span/></button></div>
        <button type="button" className="ts-primary" disabled={disabled||!selected} onClick={()=>status?.previewing?stop():preview(prefs.pack)}>{status?.previewing?<Square size={14}/>:<Play size={14}/>} {status?.previewing?say('停止试听','Stop preview'):say('试听','Preview')}</button></div></div>
        <div className="ts-output"><button type="button" className="ts-icon" aria-label={prefs.muted?say('取消静音','Unmute'):say('静音输出','Mute output')} aria-pressed={prefs.muted} disabled={disabled} onClick={()=>void save({muted:!prefs.muted})}>{prefs.muted?<VolumeX size={18}/>:<Volume2 size={18}/>}</button><SoundRange voiceId="sound-volume" label={say('输出音量','Output volume')} value={prefs.volume} disabled={disabled} onCommit={volume=>void save({volume})}/></div></div>
    </div>
    <div className={'ts-status'+(readiness.permission||readiness.retry?' ts-notice':'')} role="status"><span>{readiness.detail}</span><div>{readiness.permission&&<button type="button" disabled={disabled} onClick={()=>void run('permission')}>{say('前往系统设置','Open System Settings')}<ChevronRight size={14}/></button>}{readiness.retry&&<button type="button" disabled={busy} onClick={()=>void run('refresh')}>{say('重新检查','Check again')}</button>}</div></div>
    {failed&&status&&<div className="ts-operation-error" role="alert">{typingIssue(failureCode,en)}</div>}
    <nav className="ts-view-nav" aria-label={say('声音视图','Sound views')}>{view!=='home'&&<button type="button" onClick={()=>setView('home')}><ArrowLeft size={14}/>{say('返回','Back')}</button>}<button type="button" aria-current={view==='home'?'page':undefined} onClick={()=>setView('home')}>{say('推荐听感','Recommended')}</button><button type="button" aria-current={view==='library'?'page':undefined} onClick={()=>setView('library')}>{say('声音库','Sound library')}</button><button type="button" aria-current={view==='tuning'?'page':undefined} onClick={()=>setView('tuning')}><SlidersHorizontal size={14}/>{say('大键调音','Key tuning')}</button></nav>
    {view==='home'&&<><div className="ts-section-title"><h2>{say('推荐听感','Recommended sounds')}</h2><button type="button" onClick={()=>setView('library')}>{say('查看全部','Browse all')}<ChevronRight size={14}/></button></div><div className="ts-card-grid">{suggestions.map(card)}</div>{!suggestions.length&&<p className="ts-empty">{say('声音库尚未就绪，请重新检查。','The sound library is not ready. Please check again.')}</p>}</>}
    {view==='library'&&<div className="ts-library"><div className="ts-library-tools"><h2>{say('声音库','Sound library')}<small>{say(`${categories.length} 类 · ${packs.length} 款声音`,`${categories.length} categories · ${packs.length} sounds`)}</small></h2><button type="button" aria-pressed={favoritesOnly} onClick={()=>setFavoritesOnly(!favoritesOnly)}><Star size={14}/>{say('收藏','Favorites')}</button><label className="ts-search"><Search size={15}/><input type="search" value={query} aria-label={say('搜索声音或听感','Search sounds or character')} placeholder={say('搜索声音或听感','Search sounds or character')} onChange={e=>setQuery(e.target.value)}/></label></div>
      <div className="ts-categories" aria-label={say('听感类别','Sound categories')}><button type="button" aria-pressed={category==='all'} onClick={()=>setCategory('all')}>{say('全部','All')}</button>{categories.map(c=><button type="button" key={c.id} aria-pressed={category===c.id} onClick={()=>setCategory(c.id)}>{en?c.en:c.zh}</button>)}</div>
      {categories.map(c=>{const group=visible.filter(p=>p.category===c.id);return group.length>0&&<section className="ts-sound-group" key={c.id}><div className="ts-section-title"><h3>{en?c.en:c.zh}</h3><span>{say(`${group.length} 款`,`${group.length} sounds`)}</span></div><div className="ts-card-grid">{group.map(card)}</div></section>;})}
      {!visible.length&&<div className="ts-empty"><p>{favoritesOnly?say('这里还没有收藏的声音。','No favorite sounds here yet.'):say('没有找到声音。','No sounds found.')}</p><button type="button" onClick={()=>{setQuery('');setCategory('all');setFavoritesOnly(false);}}>{say('清除筛选','Clear filters')}</button></div>}</div>}
    <div className="ts-section-title"><h2>{view==='tuning'?say('逐键试听与调音','Preview and tune keys'):say('按键试听','Try individual keys')}</h2>{view!=='tuning'&&<button type="button" onClick={()=>setView('tuning')}>{say('调节大键','Tune large keys')}<ChevronRight size={14}/></button>}</div>
    <div className={view==='tuning'?'ts-tuning-layout':'ts-key-panel'}><div><div className={'ts-key-grid'+(view==='tuning'?' tuning':'')}>{keys.map(k=><button type="button" key={k.id} disabled={disabled||!selected} onClick={()=>preview(prefs.pack,k.id)} aria-label={say('试听 ','Preview ')+(en?k.en:k.zh)}><span className="ts-keycap">{k.cap}</span><span>{en?k.en:k.zh}</span></button>)}</div><p className="ts-hint">{say('点击试听，无需输入监控授权。','Click to preview. No Input Monitoring permission needed.')}</p></div>
      {view==='tuning'&&<div className="ts-gain-panel"><div className="ts-section-title"><h3>{say('逐键音量','Per-key volume')}</h3><button type="button" disabled={disabled} onClick={()=>void save({gains:{...initial.gains}})}><RotateCcw size={13}/>{say('全部重置','Reset all')}</button></div><p className="ts-hint">{say('100% 为此声音默认，范围 0–150%。','100% is the sound’s default. Range: 0–150%.')}</p>{keys.slice(1).map(k=><SoundRange key={k.id} label={en?k.en:k.zh} value={prefs.gains[k.id as LargeKey]} max={150} disabled={disabled} onCommit={value=>void save(p=>({gains:{...p.gains,[k.id]:value}}))}/>)}</div>}</div>
    <details className="ts-details"><summary>{say('高级调音','Advanced tuning')}</summary><SoundRange label={say('回弹强度','Release strength')} value={prefs.release} disabled={disabled} onCommit={release=>void save({release})}/><div className="ts-setting"><div><strong>{say('自然变化','Natural variation')}</strong><p>{say('让连续敲击保留细微差异。','Add subtle differences between repeated keystrokes.')}</p></div><button type="button" role="switch" className={'ts-switch'+(prefs.variation?' checked':'')} aria-label={say('自然变化','Natural variation')} aria-checked={prefs.variation} disabled={disabled} onClick={()=>void save({variation:!prefs.variation})}><span/></button></div></details>
    <details className="ts-details"><summary>{say('关于此声音','About this sound')}</summary><p>{selected?.designed?say('这是基于公开采样调整的音色。木质、绒面等名称描述听感，并非对应材质或每个按键的独立录音。','This sound is tuned from public recordings. Names such as woody or felted describe its character, not recordings of those materials or of each individual key.'):say('经典声音来自 Keyboard Simulator 的 MIT 授权素材。部分按键由现有采样调整。','Classic sounds use MIT-licensed Keyboard Simulator samples. Some keys are adapted from existing samples.')}</p>{selected?.source&&<p>{say('来源：','Source: ')}{selected.source}</p>}</details>
    <footer className="ts-footer"><ShieldCheck size={15}/>{say('不记录输入文字，不上传。','No typed text is recorded or uploaded.')}</footer>
  </section>;
}
