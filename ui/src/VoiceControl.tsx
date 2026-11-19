import {useEffect, useRef, useState} from 'react';
import {Keyboard, Mic, Settings2, Square, X} from 'lucide-react';
import {features} from './FeatureCenter';
import {useLanguage} from './i18n';
import {catalogForCurrentPage, executeVoiceStep, explicitDictationShortcut, parseVoicePlan, type VoiceContext} from './voice-control-actions';
import './voice-control.css';

type Response = {enabled?:boolean; text?:string; transcript?:string; phase?:string; cancelled?:boolean; review?:boolean; plan?:string; shortcutLabel?:string; shortcutIssue?:string};
type Bridge = {postMessage:(request:Record<string,unknown>)=>Promise<Response>};
function bridge() {return (window as unknown as {webkit?:{messageHandlers?:{voiceControl?:Bridge}}}).webkit?.messageHandlers?.voiceControl;}
type Props = Pick<VoiceContext,'command'|'read'|'membership'|'open'> & {page:string; unavailable:boolean};
type Phase = 'idle'|'listen'|'plan'|'execute'|'review'|'result'|'error';

export function VoiceControl(props:Props) {
  const en=useLanguage()==='en', copy=(zh:string,english:string)=>en?english:zh;
  const latest=useRef(props);latest.current=props;
  const [enabled,setEnabled]=useState(false), [ready,setReady]=useState(false), [saving,setSaving]=useState(false);
  const [show,setShow]=useState(false), [phase,setPhase]=useState<Phase>('idle');
  const [words,setWords]=useState(''), [entry,setEntry]=useState(false), [notice,setNotice]=useState('');
  const [micPhase,setMicPhase]=useState('authorizing'), [confirmLabel,setConfirmLabel]=useState('');
  const [shortcut,setShortcut]=useState(''), [shortcutIssue,setShortcutIssue]=useState('');
  const [recordingKey,setRecordingKey]=useState(false), [manual,setManual]=useState(false);
  const active=useRef(false), ticket=useRef(0), locked=useRef(false), savingLock=useRef(false);
  const recordingKeyRef=useRef(false), onShortcut=useRef<(id:string)=>void>(()=>{});
  const confirmReply=useRef<((ok:boolean)=>void)|null>(null), root=useRef<HTMLDivElement>(null);
  const busy=phase==='listen'||phase==='plan'||phase==='execute';
  function updateShortcut(r:Response) {
    if(r.shortcutLabel!==undefined)setShortcut(r.shortcutLabel);
    if(r.shortcutIssue!==undefined)setShortcutIssue(r.shortcutIssue);
  }

  function cancel(hide:boolean) {
    ++ticket.current; locked.current=false;
    recordingKeyRef.current=false;setRecordingKey(false);
    confirmReply.current?.(false);confirmReply.current=null;
    setConfirmLabel('');setPhase('idle');setWords('');setNotice('');setEntry(false);
    if(hide)setShow(false);
    void bridge()?.postMessage({op:'cancel'}).catch(()=>{});
  }
  useEffect(()=>{
    let live=true;
    void bridge()?.postMessage({op:'status'}).then(r=>{if(live){active.current=r.enabled===true;setEnabled(active.current);updateShortcut(r);setReady(true);}}).catch(()=>{});
    const pressed=(event:Event)=>{const id=(event as CustomEvent).detail;if(typeof id==='string')onShortcut.current(id);};
    window.addEventListener('nuphylab:voice-control-shortcut',pressed);
    return ()=>{live=false;window.removeEventListener('nuphylab:voice-control-shortcut',pressed);++ticket.current;confirmReply.current?.(false);void bridge()?.postMessage({op:'cancel'}).catch(()=>{});};
  },[]);
  useEffect(()=>{
    if(props.unavailable)cancel(true);
  },[props.unavailable]);
  useEffect(()=>{
    if(!show)return;
    const key=(ev:KeyboardEvent)=>{if(ev.key==='Escape'){ev.preventDefault();cancel(true);}};
    const outside=(ev:PointerEvent)=>{if(!root.current?.contains(ev.target as Node))cancel(true);};
    const hidden=()=>{if(document.hidden)cancel(true);};
    const interrupted=()=>cancel(true);
    window.addEventListener('nuphylab:voice-control-interrupted',interrupted);
    document.addEventListener('keydown',key,true);document.addEventListener('pointerdown',outside,true);document.addEventListener('visibilitychange',hidden);
    return ()=>{window.removeEventListener('nuphylab:voice-control-interrupted',interrupted);document.removeEventListener('keydown',key,true);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('visibilitychange',hidden);};
  },[show]);
  useEffect(()=>{
    if(phase!=='listen')return;
    let live=true,pending=false;
    const timer=window.setInterval(async()=>{if(pending)return;pending=true;try{const r=await bridge()?.postMessage({op:'status'});if(live&&r){setMicPhase(r.phase??'authorizing');setWords(r.transcript??'');}}catch{}finally{pending=false;}},180);
    return ()=>{live=false;clearInterval(timer);};
  },[phase]);

  async function changeEnabled(value:boolean) {
    if(savingLock.current)return;
    savingLock.current=true;setSaving(true);
    if(!value){active.current=false;cancel(true);}
    try{
      const result=await bridge()?.postMessage({op:'enable',enabled:value});
      if(result?.enabled!==value)throw new Error(copy('未能保存语音控制设置。','Could not save the Voice Control setting.'));
      updateShortcut(result);
      active.current=value;setEnabled(value);setShow(value);setEntry(false);setNotice('');setPhase('idle');
    }catch(e){active.current=enabled;setNotice(String(e instanceof Error?e.message:e));setPhase('error');setShow(true);throw e;}
    finally{savingLock.current=false;setSaving(false);}
  }
  function check(id:number) {
    if(ticket.current!==id||!active.current||latest.current.unavailable||document.hidden||window.__AIR_EXITING__)
      throw new DOMException('Cancelled','AbortError');
    if(document.getElementById('root')?.inert || document.querySelector('[role="dialog"][aria-modal="true"]'))
      throw new Error(copy('请先处理当前打开的对话框。','Finish the open dialog first.'));
  }
  function confirm(description:string):Promise<boolean> {
    setConfirmLabel(description);
    return new Promise(resolve=>{confirmReply.current=(ok)=>{confirmReply.current=null;setConfirmLabel('');resolve(ok);};});
  }
  async function runCommand(spoken:boolean,shortcutID?:string) {
    if(locked.current||recordingKeyRef.current||savingLock.current||!active.current||props.unavailable)return;
    const host=bridge();if(!host)return;
    const id=++ticket.current;locked.current=true;setShow(true);setNotice('');setConfirmLabel('');
    const done:string[]=[];
    try{
      check(id);
      let text=words.trim();
      if(spoken){
        setWords('');setEntry(false);setPhase('listen');setMicPhase('authorizing');setManual(!!shortcutID);
        const result=await host.postMessage({op:'listen',...(shortcutID?{shortcutID}:{}),hints:[...features.flatMap(f=>[f.zh,f.en]),'语音输入快捷键','字母 Q','左边的 Ctrl','右边的 Ctrl','Left Control','Right Control','dictation shortcut']});
        check(id);if(result.cancelled){setPhase('idle');return;}
        text=result.text?.trim()??'';setWords(text);
        if(result.review){setEntry(true);setPhase('review');setNotice(copy('只识别到部分指令，可以修改后执行。','Only part of the command was recognized. Review it before running.'));return;}
      }
      if(!text)throw new Error(copy('没有听到指令。','No command was heard.'));
      setEntry(false);setPhase('plan');
      const literal=explicitDictationShortcut(text);
      const result:Response=literal?{plan:JSON.stringify({steps:[{id:'shortcut:voice-input',value:literal}]})}:
        await host.postMessage({op:'interpret',text,catalog:catalogForCurrentPage(),page:latest.current.page});
      check(id);if(result.cancelled){setPhase('idle');return;}
      const steps=parseVoicePlan(result.plan??'',en);
      setPhase('execute');
      const context:VoiceContext={en,check:()=>check(id),read:()=>latest.current.read(),command:(...args)=>latest.current.command(...args),
        membership:(...args)=>latest.current.membership(...args),open:dest=>latest.current.open(dest),confirm,setEnabled:changeEnabled,
        setInputShortcut:async value=>{
          check(id);
          const saved=await host.postMessage({op:'setInputShortcut',value});
          check(id);
          if(!saved.shortcutLabel)throw new Error(copy('未能保存语音输入快捷键。','The Voice Input shortcut could not be saved.'));
          return saved.shortcutLabel;
        }};
      for(const step of steps){check(id);done.push(await executeVoiceStep(step,context));}
      if(id===ticket.current){setNotice(done.join(en?' · ':'，'));setPhase('result');}
    } catch(e){
      if(ticket.current!==id)return;
      if(e instanceof DOMException&&e.name==='AbortError'){setPhase('idle');return;}
      const msg=e instanceof Error?e.message:String(e);
      setNotice([done.join(en?' · ':'，'),msg].filter(Boolean).join('\n'));setPhase('error');
    } finally {if(id===ticket.current)locked.current=false;}
  }
  onShortcut.current=id=>{if(!confirmReply.current)void runCommand(true,id);};
  async function recordShortcut() {
    const host=bridge();
    if(!host||locked.current||savingLock.current||recordingKeyRef.current)return;
    const id=++ticket.current;
    recordingKeyRef.current=true;setRecordingKey(true);setPhase('idle');setNotice('');
    try {
      const result=await host.postMessage({op:'recordShortcut'});
      if(id===ticket.current&&!result.cancelled)updateShortcut(result);
    } catch(e) {
      if(id===ticket.current){setNotice(e instanceof Error?e.message:String(e));setPhase('error');}
    } finally {if(id===ticket.current){recordingKeyRef.current=false;setRecordingKey(false);}}
  }
  const toggle=()=>{void changeEnabled(!enabled).catch(()=>{});};
  const finish=()=>{void bridge()?.postMessage({op:'finish'}).catch(()=>cancel(false));};
  return <div className="lab-voice-control" ref={root}>
    <div className="lvc-toolbar">
      <button className="lvc-talk" aria-label={enabled?copy('说指令','Speak a command'):copy('语音控制','Voice Control')} aria-expanded={show}
        title={ready?copy('语音控制','Voice Control'):copy('请在 Mac 应用中使用','Available in the Mac app')} disabled={!ready||saving||recordingKey||props.unavailable||phase==='plan'||phase==='execute'}
        onClick={()=>{if(!enabled)toggle();else if(phase==='listen')finish();else void runCommand(true);}}>
        {phase==='listen'?<Square size={14}/>:<Mic size={15}/>}<span>{enabled?copy('说指令','Speak a command'):copy('语音控制','Voice Control')}</span>
      </button>
      <button className="lvc-icon lvc-settings" type="button" title={copy('语音控制设置','Voice Control settings')} aria-label={copy('语音控制设置','Voice Control settings')} aria-expanded={show} disabled={!ready||saving||recordingKey||busy||props.unavailable} onClick={()=>{setShow(true);setEntry(false);}}><Settings2 size={14}/></button>
      <button type="button" className="lvc-switch" role="switch" aria-label={copy('语音控制','Voice Control')} aria-checked={enabled} disabled={!ready||saving||recordingKey||props.unavailable} onClick={toggle}><span/></button>
    </div>
    {show&&<section className="lvc-panel" aria-label={copy('语音指令','Voice commands')}>
      <header><strong>{copy('语音控制','Voice Control')}</strong><button className="lvc-icon" aria-label={copy('关闭面板','Close panel')} onClick={()=>cancel(true)}><X size={15}/></button></header>
      {!busy&&!entry&&<div className="lvc-shortcut"><div><span>{copy('指令快捷键','Command shortcut')}</span>
        <button type="button" id="lvc-shortcut-value" aria-label={recordingKey?copy('正在录制指令快捷键','Recording command shortcut'):copy('更改指令快捷键，当前为 ','Change command shortcut, currently ')+shortcut} onClick={()=>void recordShortcut()} disabled={recordingKey||saving}>{recordingKey?copy('请按键…','Press keys…'):shortcut||copy('设置','Set')}</button></div>
        <small>{recordingKey?copy('按下并松开单键或组合键，Esc 取消。','Press and release a key or chord. Esc cancels.'):copy('按一次开始说，再按一次执行。','Press once to speak. Press again to run.')}</small>
        {enabled&&shortcutIssue&&<small role="status">{shortcutIssue}</small>}</div>}
      {entry?<form onSubmit={event=>{event.preventDefault();void runCommand(false);}}>
        <label htmlFor="lvc-command">{copy('指令','Command')}</label><input autoFocus id="lvc-command" value={words} maxLength={600} onChange={event=>setWords(event.target.value)} placeholder={copy('把键盘口袋添加到侧栏','Add Keyboard Pocket to my sidebar')}/>
        <button className="lvc-primary" disabled={!enabled||!words.trim()||busy}>{copy('执行指令','Run command')}</button>
      </form>:<>
        {words&&<p className="lvc-words">“{words}”</p>}
        {phase==='idle'&&<p>{copy('试着说“把键盘口袋添加到侧栏”或“关闭模拟声浪”。','Try “Add Keyboard Pocket to my sidebar” or “Turn off Typing Sounds.”')}</p>}
      </>}
      <div aria-live="polite" role={phase==='error'?'alert':'status'} className="lvc-feedback">
        {phase==='listen'?(micPhase==='authorizing'?copy('正在准备麦克风…','Preparing the microphone…'):micPhase==='finishing'?copy('正在完成识别…','Finishing transcription…'):micPhase==='awaitingFinish'?copy('录音已中断，再按一次核对已识别的指令。','Recording stopped. Press again to review the recognized command.'):manual?copy('再按一次 '+shortcut+' 结束指令。','Press '+shortcut+' again to finish.'):copy('正在听，停顿后执行…','Listening. Pause when finished…')):
          phase==='plan'?copy('正在理解指令…','Interpreting your command…'):phase==='execute'&&!confirmLabel?copy('正在执行…','Running…'):notice}
      </div>
      {confirmLabel&&<div className="lvc-review"><p>{copy('执行「'+confirmLabel+'」？','Press “'+confirmLabel+'”?')}</p><button className="lvc-primary" onClick={()=>confirmReply.current?.(true)}>{copy('执行','Run')}</button><button onClick={()=>cancel(false)}>{copy('取消','Cancel')}</button></div>}
      {!entry&&!confirmLabel&&<div className="lvc-actions">
        {busy?<><button onClick={()=>cancel(false)}>{copy('取消','Cancel')}</button>{phase==='listen'&&micPhase==='recording'&&<button className="lvc-primary" onClick={finish}>{copy('说完了','Done speaking')}</button>}</>:
        <><button className="lvc-icon" aria-label={copy('键入指令','Type a command')} title={copy('键入指令','Type a command')} onClick={()=>{setEntry(true);setNotice('');setPhase('idle');}}><Keyboard size={16}/></button>
        <button onClick={()=>{cancel(true);void props.open('settings.ai');}}>{copy('模型与 API','Models & API')}</button>
        <button className="lvc-primary" disabled={!enabled||recordingKey} onClick={()=>void runCommand(true)}><Mic size={14}/>{copy('说指令','Speak')}</button></>}
      </div>}
      {phase==='idle'&&!entry&&<small>{copy('语音在本机识别，需要模型理解时发送指令文字。','Speech is transcribed on this Mac. Commands that need interpretation go to your model.')}</small>}
    </section>}
  </div>;
}
