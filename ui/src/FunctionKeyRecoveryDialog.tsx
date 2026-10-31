import {useEffect,useRef,useState} from 'react';
import {Button,Modal,run} from './primitives';
import {useLanguage} from './i18n';
import {readAppState} from './api';
import type {AppState,Command} from './types';
import './function-key-recovery-dialog.css';

type Props={state:AppState|null;command:Command;onClose:()=>void;serviceError?:string;returnFocus?:HTMLElement|null};
type Identity={model:string;modelId:string;firmware:string};
type Preview={original:Identity;current:Identity;ready:boolean;alreadyRestored:boolean};
type Problem='mode'|'connection'|'changed'|'check'|'mismatch'|'result'|'';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const firmware=(value:unknown)=>typeof value==='string'&&/^\d{1,4}(?:\.\d{1,5}){3}$/.test(value)?value:'';
function identity(value:unknown):Identity {
  const raw=object(value),name=typeof raw.model==='string'?raw.model:'';
  const modelId=/^air75 v3(?: ansi)?$/i.test(name)?'air75-v3':/^kick75(?: ansi)?$/i.test(name)?'kick75':'';
  return {modelId,model:modelId==='kick75'?'Kick75':modelId==='air75-v3'?'Air75 V3':'',firmware:firmware(raw.firmware)};
}
function context(state:AppState|null,serviceError='') {
  const device=state?.device,model=device?.modelId??'',session=device?.connectionSessionId??'';
  const version=firmware(device?.firmwareVersion??device?.firmware);
  const modeOff=state?.settings.codexEnabled===false&&state?.settings.claudeEnabled===false;
  const connected=device?.connected===true&&device.transport==='USB'&&device.readOnly!==true;
  const ready=!serviceError&&connected&&modeOff&&Boolean(session)&&['air75-v3','kick75'].includes(model);
  return {key:JSON.stringify([model,session,version,connected,modeOff,Boolean(serviceError)]),ready,modeOff,model,version};
}

export function FunctionKeyRecoveryDialog({state,command,onClose,serviceError='',returnFocus}:Props) {
  const language=useLanguage(),copy=(zh:string,en:string)=>language==='en'?en:zh;
  const next=context(state,serviceError),scope=useRef(next);
  const authorization=useRef<{token:string;scope:typeof next}|null>(null),lock=useRef<symbol|null>(null),mounted=useRef(false);
  if(scope.current.key!==next.key){scope.current=next;authorization.current=null;}
  const [preview,setPreview]=useState<Preview|null>(null),[confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState<''|'checking'|'restoring'>(''),[problem,setProblem]=useState<Problem>(''),[success,setSuccess]=useState(false);
  const current=(started:typeof next,request:symbol)=>mounted.current&&scope.current===started&&lock.current===request;
  const invalidate=()=>{authorization.current=null;setConfirmed(false);setPreview(null);setSuccess(false);};
  const check=async()=>{
    if(lock.current||!mounted.current)return;
    invalidate();setProblem('');
    const started=scope.current;
    if(!started.ready){setProblem(started.modeOff?'connection':'mode');return;}
    const request=Symbol('recovery-preview');lock.current=request;setBusy('checking');
    try {
      const result=object(await command({op:'previewFunctionKeyRecovery'},{silent:true}));
      if(!current(started,request))return;
      const original=identity(result.original),now=identity(result.current);
      const token=typeof result.token==='string'&&result.token.length>0&&result.token.length<=200?result.token:null;
      const ready=result.canConfirm===true&&Boolean(token)&&original.modelId===started.model&&now.modelId===started.model&&Boolean(original.firmware)&&Boolean(now.firmware)&&(!started.version||now.firmware===started.version);
      setPreview({original,current:now,ready,alreadyRestored:result.alreadyRestored===true});
      if(ready&&token)authorization.current={token,scope:started};
      else setProblem('mismatch');
    } catch {if(current(started,request)){invalidate();setProblem('check');}}
    finally {if(lock.current===request){lock.current=null;if(mounted.current)setBusy('');}}
  };
  const restore=async()=>{
    const permission=authorization.current,started=scope.current;
    if(lock.current||!mounted.current||!confirmed||!preview?.ready||!permission||permission.scope!==started||!started.ready)return;
    const request=Symbol('recovery-confirm');lock.current=request;
    authorization.current=null;setConfirmed(false);setProblem('');setBusy('restoring');
    try {
      // A current read narrows the poll gap; the backend is still the authority
      // for mode/session checks before touching the keyboard.
      const fresh=await readAppState();
      if(!current(started,request))return;
      if(context(fresh).key!==started.key||!context(fresh).ready){invalidate();setProblem('changed');return;}
      const result=object(await command({op:'confirmFunctionKeyRecovery',token:permission.token,confirmSameKeyboard:true},{silent:true}));
      if(!current(started,request))return;
      if(result.restored!==true||result.verified!==true){invalidate();setProblem('result');return;}
      setSuccess(true);setPreview(null);
    } catch {if(current(started,request)){invalidate();setProblem('result');}}
    finally {if(lock.current===request){lock.current=null;if(mounted.current)setBusy('');}}
  };
  useEffect(()=>{
    invalidate();lock.current=null;setBusy('');setProblem(scope.current.modeOff?'changed':'mode');
  },[next.key]);
  useEffect(()=>{mounted.current=true;void check();return()=>{mounted.current=false;authorization.current=null;lock.current=null;};},[]);
  const canRestore=Boolean(scope.current.ready&&authorization.current?.scope===scope.current&&preview?.ready&&confirmed&&!busy&&!success);
  const close=()=>{if(lock.current&&busy==='restoring')return;authorization.current=null;setConfirmed(false);onClose();};
  const message=problem==='mode'?copy('请先关闭 Codex 或 Claude Code 模式，再检查按键。','Turn off Codex or Claude Code mode before checking the keys.')
    :problem==='connection'?copy('请连接原来那把键盘，再重新检查。','Connect the original keyboard, then check again.')
    :problem==='changed'?copy('键盘连接或模式已改变。请连接原来那把键盘，再重新检查。','The keyboard connection or mode changed. Connect the original keyboard and check again.')
    :problem==='check'?copy('检查未完成，请确认键盘连接后重试。','The check did not finish. Confirm the keyboard connection and try again.')
    :problem==='mismatch'?copy('当前键盘或设置尚未通过检查，请连接原来那把键盘后重新检查。','The current keyboard or settings did not pass the check. Connect the original keyboard and check again.')
    :copy('暂时无法确认恢复结果，请重新检查后再重试。','The recovery result could not be confirmed. Check again before retrying.');
  const model=(value:Identity)=>value.model||copy('未确认','Not confirmed');
  const version=(value:Identity)=>value.firmware||copy('未确认','Not confirmed');
  return <Modal title={copy('检查并恢复按键','Check and restore keys')} width={460} busy={busy==='restoring'} initialFocus="title" returnFocus={returnFocus} onClose={close} className="function-key-recovery-dialog" footer={success
    ?<Button kind="primary" onClick={close}>{copy('完成','Done')}</Button>
    :<><Button kind="ghost" data-modal-cancel disabled={busy==='restoring'} onClick={close}>{copy('取消','Cancel')}</Button><Button kind="primary" busy={busy==='restoring'} disabled={!canRestore} onClick={()=>run(restore())}>{copy('恢复原功能','Restore original function')}</Button></>}>
    {success?<p className="function-key-recovery-success" role="status">{copy('F4 已恢复为原来的功能。','F4 has been restored to its original function.')}</p>:<>
      <p>{preview?.alreadyRestored?copy('F4 当前已是原来的功能。确认同一把键盘后，可完成检查。','F4 already has its original function. Confirm this is the same keyboard to finish the check.'):copy('之前的 F4 临时设置尚未确认恢复。请先检查键盘，再恢复原来的功能。','The previous temporary F4 setting has not been confirmed as restored. Check the keyboard before restoring its original function.')}</p>
      <p className="muted">{copy('恢复范围：仅恢复 F4 原功能。','Scope: restore only the original F4 function.')}</p>
      {busy==='checking'&&<p role="status">{copy('正在检查键盘…','Checking the keyboard…')}</p>}
      {preview&&<dl className="function-key-recovery-identities">{[[copy('之前使用的键盘','Previous keyboard'),preview.original],[copy('当前连接的键盘','Connected keyboard'),preview.current]].map(([label,value])=><div key={String(label)}><dt>{String(label)}</dt><dd>{model(value as Identity)}<span>{copy('固件','Firmware')} {version(value as Identity)}</span></dd></div>)}</dl>}
      {preview?.ready&&scope.current.ready&&!problem&&<label className="checkbox-field function-key-recovery-confirm"><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={event=>{if(!lock.current&&authorization.current?.scope===scope.current)setConfirmed(event.target.checked);}}/><span>{copy('我确认这是之前使用的同一把键盘','I confirm this is the same keyboard I used before')}</span></label>}
      {problem&&<div className="function-key-recovery-error" role="alert"><p>{message}</p><Button kind="ghost" data-modal-retry disabled={Boolean(busy)||!scope.current.ready} onClick={()=>run(check())}>{copy('重新检查','Check again')}</Button></div>}
    </>}
  </Modal>;
}
