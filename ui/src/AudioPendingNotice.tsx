import {useSyncExternalStore} from 'react';
import {audioPending} from './audioPending';
import {connectionCopy} from './connection-copy-v7';
import {Button} from './primitives';
import './audio-pending.css';

export function AudioPendingNotice({onReturn}:{onReturn:()=>void}){
  const pending=useSyncExternalStore(audioPending.subscribe,audioPending.getSnapshot,audioPending.getSnapshot);
  if(!pending.dirty||pending.attached)return null;
  const both=pending.audioPending&&pending.brightnessPending;
  const text=both?connectionCopy({zh:'声音设置与输出亮度的保存结果尚未确认，修改已保留。',en:'Saving audio settings and output brightness is not confirmed. Your changes are kept.'}):pending.audioPending?connectionCopy({zh:'声音设置的保存结果尚未确认，修改已保留。',en:'Saving audio settings is not confirmed. Your changes are kept.'}):connectionCopy({zh:'输出亮度的保存结果尚未确认，修改已保留。',en:'Saving output brightness is not confirmed. Your changes are kept.'});
  return <div className="audio-pending-notice" role={pending.audioError||pending.brightnessError?'alert':'status'}><p>{text}</p><Button kind="ghost" onClick={()=>{audioPending.requestReturnFocus();onReturn();}}>{connectionCopy({zh:'返回并重试',en:'Return and retry'})}</Button></div>;
}
