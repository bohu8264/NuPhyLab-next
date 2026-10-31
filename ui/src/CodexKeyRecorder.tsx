import {useEffect,useRef,useState} from 'react';
import {CODEX_KEYS} from '../../shared/codex-keys.mjs';
import {Button,Modal} from './primitives';
import {nativeCodexKeys} from './codexKeys';
import {t} from './i18n';
import type {Command} from './types';

export type AgentCaptureState={ready:boolean;error:string;retry:()=>void;release:()=>Promise<void>};
/** One owner keeps both capture layers suspended across the complete edit flow. */
export function useAgentKeyCapture(enabled:boolean,command:Command):AgentCaptureState {
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const releaseCurrent=useRef<()=>Promise<void>>(()=>Promise.resolve());
  useEffect(()=>{
    setReady(false);setError('');
    if(!enabled)return;
    let active=true,heartbeat:ReturnType<typeof setInterval>|undefined;
    const session=crypto.randomUUID();
    const begin=(async()=>{
      await nativeCodexKeys({kind:'capture',active:true,session});
      if(!active)return;
      await command({op:'codexCapture',session,active:true},{silent:true});
      if(!active)return;
      setReady(true);
      heartbeat=setInterval(()=>{
        void command({op:'codexCapture',session,active:true},{silent:true}).catch(()=>{
          if(active){setReady(false);setError('无法确认快捷控制已暂停，请重新准备后录入。');}
        });
      },4000);
    })();
    void begin.catch(()=>{if(active)setError('无法暂停快捷控制。请重新准备或关闭后重试。');});
    let releasing:Promise<void>|undefined;
    const release=()=>{
      active=false;clearInterval(heartbeat);
      // Preserve order even if close wins the race with a pending begin.
      if(!releasing)releasing=begin.catch(()=>{}).then(async()=>{try{await command({op:'codexCapture',session,active:false},{silent:true});}finally{await nativeCodexKeys({kind:'capture',active:false,session});}}).catch(error=>{releasing=undefined;throw error;});
      return releasing;
    };
    releaseCurrent.current=release;
    return()=>{void release().catch(()=>{});};
  },[enabled,command,attempt]);
  return {ready,error,retry:()=>setAttempt(value=>value+1),release:()=>releaseCurrent.current()};
}

type Binding={code:string;label?:string};
type Props={title:string;onSave:(code:string)=>Promise<unknown>;onClose:()=>void;command:Command;bindings:Binding[];group:'task'|'command';index:number;source?:'codex'|'claude';draft?:boolean;capture?:AgentCaptureState};
export function CodexKeyRecorder({title,onSave,onClose,command,bindings,group,index,source='codex',draft=false,capture:managedCapture}:Props) {
  const ownCapture=useAgentKeyCapture(!managedCapture,command),capture=managedCapture??ownCapture;
  const [phase,setPhase]=useState<'listening'|'held'|'candidate'>('listening'),[candidate,setCandidate]=useState<string|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[invalid,setInvalid]=useState(false),[savedPending,setSavedPending]=useState(false);
  const root=useRef<HTMLDivElement>(null),busyRef=useRef(false),held=useRef<string|null>(null);
  const latest=useRef({onSave,onClose,capture,phase});latest.current={onSave,onClose,capture,phase};
  const listening=capture.ready&&phase!=='candidate',position=index+(group==='command'?6:0);
  const keyLabel=(code?:string)=>t(CODEX_KEYS.find(key=>key.code===code)?.label??code??'—');
  const slotLabel=(slot:number)=>t(slot<6?`${source==='claude'?'会话':'任务'} ${slot+1}`:`命令 ${slot-5}`);
  const duplicate=candidate?bindings.findIndex((key,i)=>i!==position&&key.code===candidate):-1;
  const old=bindings[position]?.code;
  useEffect(()=>{
    if(listening)root.current?.focus();
    else if(phase==='candidate')root.current?.focus();
  },[listening,phase]);
  useEffect(()=>{
    const down=(code:string,repeat=false,modified=false)=>{
      if(!latest.current.capture.ready||latest.current.phase==='candidate'||busyRef.current||held.current||repeat)return;
      if(modified||!CODEX_KEYS.some(key=>key.code===code)){setInvalid(true);setError('');return;}
      held.current=code;setCandidate(code);setPhase('held');setInvalid(false);setError('');
    };
    const up=(code:string)=>{
      if(!held.current||code!==held.current||busyRef.current)return;
      held.current=null;setPhase('candidate');
    };
    const keydown=(event:KeyboardEvent)=>{
      if(!latest.current.capture.ready||latest.current.phase==='candidate')return;
      event.preventDefault();event.stopImmediatePropagation();down(event.code,event.repeat,event.ctrlKey||event.altKey||event.shiftKey||event.metaKey);
    };
    const keyup=(event:KeyboardEvent)=>{
      if(!latest.current.capture.ready||latest.current.phase==='candidate')return;
      event.preventDefault();event.stopImmediatePropagation();up(event.code);
    };
    const nativeKey=(event:Event)=>{const {code,phase}=(event as CustomEvent<{code:string;phase:string}>).detail;if(phase==='down')down(code);else if(phase==='up')up(code);};
    const blur=()=>{if(!busyRef.current)latest.current.onClose();};
    window.addEventListener('keydown',keydown,true);window.addEventListener('keyup',keyup,true);
    window.addEventListener('nuphylab:function-key',nativeKey);window.addEventListener('blur',blur);
    return()=>{window.removeEventListener('keydown',keydown,true);window.removeEventListener('keyup',keyup,true);window.removeEventListener('nuphylab:function-key',nativeKey);window.removeEventListener('blur',blur);};
  },[]);
  const save=async()=>{
    if(!candidate||phase!=='candidate'||busyRef.current||!capture.ready)return;
    busyRef.current=true;setBusy(true);setError('');
    try{await onSave(candidate);if(!draft){setSavedPending(true);await capture.release();}onClose();}
    catch(failure){setError(failure instanceof Error?failure.message:'未能确认保存结果。已保留候选按键，请重试。');}
    finally{busyRef.current=false;setBusy(false);}
  };
  const retry=()=>{if(busyRef.current)return;held.current=null;setCandidate(null);setPhase('listening');setError('');setInvalid(false);if(!capture.ready)capture.retry();};
  const message=savedPending?'按键已保存，键盘同步尚未完成。请重新检查。':capture.error||error||(invalid?'Fn、修饰键和组合键不能单独绑定。请录入一个普通按键。':phase==='held'?'已识别按键，松开后可确认。':phase==='candidate'?(duplicate>=0?'此按键已被占用，请确认下面的交换关系。':draft?'此按键可用。返回后点击保存设置才会生效。':'此按键可用。点击保存后生效。'):capture.ready?'按下一个普通按键，再松开。':'正在暂停快捷控制，请稍候。');
  return <Modal title={title} width={480} className="agent-overlay-v6 agent-recorder-v6" busy={busy} captureKeys={listening} initialFocus="title" onClose={()=>{if(!busyRef.current)onClose();}} footer={<>
    <Button kind="ghost" onClick={onClose} disabled={busy}>{t(savedPending?'完成':'取消')}</Button>
    {!savedPending&&(phase==='candidate'||capture.error)&&<Button onClick={retry} disabled={busy}>{t(capture.error?'重新准备':'重新录入')}</Button>}
    {savedPending?<Button kind="primary" busy={busy} onClick={()=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);void capture.release().then(()=>command({op:'codexAdaptCheck',source},{silent:true})).then(onClose).catch(()=>setError('按键已保存，键盘同步尚未完成。请重新检查。')).finally(()=>{busyRef.current=false;setBusy(false);});}}>{t('重新检查')}</Button>:<Button kind="primary" busy={busy} disabled={phase!=='candidate'||!candidate||!capture.ready} onClick={()=>{void save();}}>{t(draft?'使用此按键':duplicate>=0?'交换并保存':'保存按键')}</Button>}
  </>}>
    <div ref={root} tabIndex={-1} data-codex-recording className="agent-capture-v6">
      <p className="agent-overlay-intro">{slotLabel(position)}</p>
      <kbd className="agent-captured-key">{candidate?keyLabel(candidate):t(capture.error?'尚未准备好':capture.ready?'请按键':'准备中…')}</kbd>
      <p className={error||capture.error||invalid?'agent-inline-error':'agent-capture-message'} role={error||capture.error||invalid?'alert':'status'}>{t(message)}</p>
      {phase==='candidate'&&duplicate>=0&&<div className="agent-swap-plan"><p>{slotLabel(position)}<span>{keyLabel(old)} → {keyLabel(candidate!)}</span></p><p>{slotLabel(duplicate)}<span>{keyLabel(candidate!)} → {keyLabel(old)}</span></p></div>}
      <p className="agent-overlay-hint">{t(listening?'录入时 Esc、Tab 也是候选按键；取消请点击按钮。':'快捷控制保持暂停；Tab 可切换按钮，Esc 可取消。')}</p>
    </div>
  </Modal>;
}
