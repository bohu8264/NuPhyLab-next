import {useCallback, useEffect, useRef, useState} from 'react';
import {FolderOpen, Play, Save, X} from 'lucide-react';
import {Button, Switch} from './primitives';
import {useLanguage} from './i18n';
import './screen-replay.css';

type ReplayState = {
  enabled:boolean; phase:'off'|'starting'|'recording'|'stopping'; saving:boolean;
  display:string; displays:{id:string;name:string}[]; lastFile:string;
  shortcutLabel:string; shortcutReady:boolean; shortcutIssue:string;
  issue:string; needsScreenPermission:boolean;
};
type ReplayBridge = {postMessage:(message:Record<string,unknown>)=>Promise<ReplayState>};

export function ScreenReplay({onPermissions}:{onPermissions:()=>void}) {
  const en=useLanguage()==='en';
  const [state,setState]=useState<ReplayState>(), [error,setError]=useState(''), [pending,setPending]=useState('');
  const active=useRef(false), recording=useRef(false), busy=useRef(false), revision=useRef(0);
  const send=useCallback((op:string,values:Record<string,unknown>={})=>{
    const bridge=(window as unknown as {webkit?:{messageHandlers?:{screenReplay?:ReplayBridge}}}).webkit?.messageHandlers?.screenReplay;
    if(!bridge)return Promise.reject(new Error(en?'Open Instant Replay in the Mac app.':'请在 Mac 应用中打开屏幕回放。'));
    return bridge.postMessage({op,language:en?'en':'zh-CN',...values});
  },[en]);
  const refresh=useCallback(async()=>{
    if(busy.current)return;
    const ticket=++revision.current;
    try {
      const value=await send('state');
      if(active.current&&ticket===revision.current)setState(value);
    } catch(reason) {
      if(active.current&&ticket===revision.current)setError(reason instanceof Error?reason.message:String(reason));
    }
  },[send]);
  useEffect(()=>{
    active.current=true;
    const update=()=>{void refresh();};
    update();
    window.addEventListener('nuphylab:screen-replay',update);
    window.addEventListener('focus',update);
    return ()=>{
      active.current=false;
      ++revision.current;
      window.removeEventListener('nuphylab:screen-replay',update);
      window.removeEventListener('focus',update);
      if(recording.current)void send('cancelRecording').catch(()=>{});
    };
  },[send,refresh]);
  async function act(op:string,values:Record<string,unknown>={}) {
    if(busy.current)return;
    ++revision.current;
    busy.current=true; recording.current=op==='record';
    setPending(op); setError('');
    try {
      const value=await send(op,values);
      if(active.current)setState(value);
    } catch(reason) {
      if(active.current)setError(reason instanceof Error?reason.message:String(reason));
    } finally {
      busy.current=false; recording.current=false;
      if(active.current){setPending('');void refresh();}
    }
  }
  const wait=!state||!!pending, live=state?.phase==='recording';
  const statuses={off:en?'Off':'已关闭',starting:en?'Starting…':'正在启动…',recording:en?'Buffering':'正在缓存',stopping:en?'Stopping…':'正在停止…'};
  const issue=error||state?.issue||state?.shortcutIssue;
  const needsShortcutAccess=live&&!!state?.shortcutLabel&&!state.shortcutReady&&!state.shortcutIssue;
  const missingDisplay=state&&state.display!=='main'&&!state.displays.some(d=>d.id===state.display);
  return <section className="screen-replay">
    <div className="replay-controls">
      <div className="replay-head">
        <Switch voiceId="screen-replay" label={en?'Full-screen replay':'全屏回放'} checked={state?.enabled??false}
          disabled={wait||state?.phase==='stopping'} onChange={on=>void act(on?'start':'stop')}/>
        <p>{en?'Keeps the last 15 seconds of this display in memory, without audio. Turning it off clears the buffer.':'开启后，在内存中保留这个屏幕最近 15 秒的无声画面。关闭即清空缓存。'}</p>
      </div>
      {(!!state && (state.displays.length>1 || state.display!=='main')) &&
        <label className="replay-row"><strong>{en?'Display':'录制屏幕'}</strong>
          <select value={state.display} disabled={wait||state.phase!=='off'} onChange={e=>void act('display',{value:e.target.value})}>
            <option value="main">{en?'Main display':'主显示器'}</option>
            {missingDisplay&&<option value={state.display}>{en?'Disconnected display':'已断开的显示器'}</option>}
            {state.displays.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label>}
      <div className="replay-row"><div><strong>{en?'Save shortcut':'保存快捷键'}</strong>
        <p>{en?'Click to record a key, key combination or mouse side button.':'点击录制单键、组合键或鼠标侧键。'}</p></div>
        <div className="replay-actions"><button className="replay-key" disabled={wait} onClick={()=>void act('record')}>
          {pending==='record'?(en?'Press a key…':'等待按键…'):state?.shortcutLabel||(en?'Set shortcut':'设置快捷键')}</button>
          {pending==='record'?<Button kind="ghost" onClick={()=>void send('cancelRecording').catch(()=>{})}>{en?'Cancel':'取消'}</Button>:
          !!state?.shortcutLabel&&<button className="replay-clear" aria-label={en?'Clear shortcut':'清除快捷键'} disabled={wait} onClick={()=>void act('clear')}><X size={15}/></button>}</div>
      </div>
      <div className="replay-row replay-save"><span role="status"><i className={live?'live':''}/>{state?statuses[state.phase]:'…'}</span>
        <Button icon={<Save size={16}/>} kind="primary" disabled={wait||!live||state?.saving} onClick={()=>void act('save')}>
          {state?.saving?(en?'Saving…':'正在保存…'):(en?'Save last 15 seconds':'保存最近 15 秒')}</Button></div>
    </div>
    {issue&&<div className="replay-feedback" role="alert">{issue} {state?.needsScreenPermission&&
      <Button kind="ghost" onClick={()=>void act('permissions')}>{en?'Open Screen Recording settings':'打开录屏权限设置'}</Button>}</div>}
    {needsShortcutAccess&&<div className="replay-feedback">{en?'Allow Accessibility to use the global shortcut.':'使用全局快捷键需要辅助功能权限。'} <Button kind="ghost" onClick={onPermissions}>{en?'View permissions':'查看权限'}</Button></div>}
    {state?.lastFile&&<div className="replay-last"><div><strong>{en?'Last saved replay':'最近保存'}</strong><p>{state.lastFile}</p></div>
      <div className="replay-actions"><Button kind="ghost" icon={<Play size={15}/>} onClick={()=>void act('play')}>{en?'Play':'播放'}</Button>
      <Button kind="ghost" icon={<FolderOpen size={15}/>} onClick={()=>void act('reveal')}>{en?'Show in Finder':'在访达中显示'}</Button></div></div>}
    <p className="replay-path">{en?'MP4 files are saved in Movies / NuPhy Lab / Replays.':'MP4 将保存到「影片 / NuPhy Lab / Replays」。'}</p>
  </section>;
}
