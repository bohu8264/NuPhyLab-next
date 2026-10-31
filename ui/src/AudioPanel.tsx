import { rangeStyle } from "./rangeStyle";
import {lightingUnavailableMessage} from '../../shared/device-status.mjs';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {AudioLines,Play,Square,SlidersHorizontal,ArrowUpRight,ShieldCheck,Moon,ArrowUp} from 'lucide-react';
import {Keyboard} from './Keyboard';
import {Button,run} from './primitives';
import {readAppState} from './api';
import {audioPending,AudioPendingSaveError,type AudioConfig} from './audioPending';
import {connectionCopy} from './connection-copy-v7';
import {t} from './i18n';
import type {AppState,Command,Key} from './types';
import {AUDIO_EFFECTS} from '../../shared/audio-effects.mjs';
import type {AudioEffect} from '../../shared/audio-effects.mjs';
import './audio-v5.css';
import './inline-overlays-v6.css';
import './creation-experience-v7.css';
import './audio-pending.css';
import {useWorkspaceLayout} from './useWorkspaceLayout';
import './agent-audio-workspace.css';
export type {AudioConfig} from './audioPending';
export type AudioState={active:boolean;available:boolean;systemSupported:boolean;status:string;error:string|null;level:number;bands:number[];devices:{id:string;name:string}[]};
const defaults:AudioConfig={source:'system',deviceId:'',effect:'pulse',colorMode:'single',color:'#6f9e85',sensitivity:1.5,noiseFloor:-55};
const errorText:Record<string,string>={microphonePermission:'请允许 NuPhy Lab 使用麦克风，然后重新开始。',inputUnavailable:'麦克风不可用，请检查连接或选择其他设备。',systemCapture:'系统声音暂不可用，请检查录音权限后重试。',systemPermission:'请允许 NuPhy Lab 录制系统声音，然后重新开始。',systemFormat:'当前输出设备的音频格式暂不支持，请切换输出设备。',systemUnsupported:'系统声音需要 macOS 14.2 或更新版本，请改用麦克风',keyboardDisconnected:'键盘已断开，声音采集已停止。',lightingFailed:'灯效输出已停止，请检查键盘连接后重试。',captureStopped:'声音采集已中断，请重新开始。'};
export function AudioPanel({state,layout,command}:{state:AppState|null;layout:Key[];command:Command}){
  const workspace=useWorkspaceLayout({aspectRatio:layout.length===80?1009/440:959/384});
  const saved=state?.settings.audio as AudioConfig|undefined;
  const audio=state?.audio as AudioState|undefined;
  const [busy,setBusy]=useState(false);
  const [actionError,setActionError]=useState(''),[permissionBusy,setPermissionBusy]=useState(false),[retrying,setRetrying]=useState(false);
  const actionPending=useRef(false),permissionPending=useRef(false);
  const pending=useSyncExternalStore(audioPending.subscribe,audioPending.getSnapshot,audioPending.getSnapshot);
  const config:AudioConfig={...(saved??defaults),...pending.audio},brightness=pending.brightness??state?.settings.brightness??70;
  useEffect(()=>{audioPending.setClient({command,readState:readAppState});},[command]);
  useEffect(()=>{if(state)audioPending.observeSaved(state.settings,true);return audioPending.attach();},[]);
  useEffect(()=>{if(state)audioPending.observeSaved(state.settings);},[saved,state?.settings.brightness]);
  useEffect(()=>{if(!pending.focusGroup)return;const target=document.getElementById(pending.focusGroup==='audio'?'audio-settings-group':'audio-output-brightness-group');if(target){target.scrollIntoView({block:'nearest'});target.focus({preventScroll:true});audioPending.consumeReturnFocus(pending.focusToken);}},[pending.focusGroup,pending.focusToken]);
  const flushBrightness=audioPending.flushBrightness,changeBrightness=audioPending.changeBrightness,change=audioPending.changeAudio;
  const start=async()=>{if(actionPending.current)return;actionPending.current=true;setBusy(true);setActionError('');const wantedActive=!audio?.active;try{if(wantedActive)await audioPending.flushAll();await command({op:wantedActive?'audioStart':'audioStop'},{silent:true});}catch(error){if(!(error instanceof AudioPendingSaveError)){const latest=await readAppState().catch(()=>null);if(!latest||latest.audio?.active!==wantedActive||wantedActive&&latest.audio?.error)setActionError(error instanceof Error?error.message:'操作未完成，请重试。');}}finally{actionPending.current=false;setBusy(false)}};
  const retrySettings=async()=>{if(retrying)return;setRetrying(true);try{await audioPending.flushAll();}catch{/* The shared owner retains pending values and per-group failure. */}finally{setRetrying(false);}};
  const permission=async()=>{
    if(permissionPending.current)return;
    permissionPending.current=true;setPermissionBusy(true);setActionError('');
    const bridge=(window as Window & {webkit?:{messageHandlers?:{audioControl?:{postMessage:(value:unknown)=>Promise<unknown>}}}}).webkit?.messageHandlers?.audioControl;
    try{if(bridge)await bridge.postMessage({permission:config.source==='microphone'?'microphone':'system'});else window.dispatchEvent(new CustomEvent('nuphylab:navigate',{detail:'permissions'}));}
    catch(error){setActionError(error instanceof Error?error.message:'操作未完成，请重试。');}
    finally{permissionPending.current=false;setPermissionBusy(false);}
  };
  const preparing=audio?.active===true&&['requesting','starting'].includes(audio.status)&&!audio.error;
  const capturing=audio?.active===true&&audio.status==='listening'&&!audio.error;
  const missingInput=config.source==='microphone'&&!!config.deviceId&&!!audio?.available&&!audio.devices.some(device=>device.id===config.deviceId);
  const unavailable=state?.device.capabilities?.perKey===false?lightingUnavailableMessage(state):!state?.device.connected?'声音律动需要 USB 有线连接':!audio?.available?'请在 NuPhy Lab 桌面应用中使用声音律动':config.source==='system'&&!audio.systemSupported?'系统声音需要 macOS 14.2 或更新版本，请改用麦克风':null;
  const navigate=(target:string)=>window.dispatchEvent(new CustomEvent('nuphylab:navigate',{detail:target}));
  const level=capturing ? Math.max(0,Math.min(1,audio.level||0)) : 0;
  const currentError=actionError||(audio?.error?t(errorText[audio.error]??errorText.captureStopped):'');
  const permissionsError=['microphonePermission','systemPermission','systemCapture'].includes(audio?.error??'');
  const statusText=audio?.error?'声音律动已停止':audio?.status==='paused'?'随键盘休眠':audio?.status==='requesting'?'等待声音权限':audio?.status==='starting'?'正在连接声音':capturing?`${config.source==='system'?'系统声音':'麦克风'} · 正在采集`:'尚未采集声音';
  return <section className="audio-v5" data-workspace-layout={workspace.mode} style={workspace.style}>
    <header ref={workspace.headerRef} className="audio-work-row"><div><h2>{t('声音律动')}</h2><p>{t('跟随声音实时变化')}</p></div>{workspace.previewAway&&<Button kind="ghost" className="audio-workspace-return" data-workspace-navigation onClick={workspace.returnToKeyboard}><ArrowUp size={14}/>{t('回到键盘')}</Button>}<Button kind="primary" icon={audio?.active?<Square/>:<Play/>} busy={busy||preparing} disabled={!audio?.active&&(!!unavailable||missingInput)} onClick={()=>run(start())}>{t(preparing?audio?.status==='requesting'?'等待声音权限':'正在连接声音':audio?.active?'停止律动':audio?.error?'重新开始':'开始律动')}</Button></header>
    {currentError&&<div className="inline-v6-notice inline-v6-error audio-v6-error" role="alert"><span>{t(currentError)}</span><div>{permissionsError&&<Button icon={<ArrowUpRight size={14}/>} busy={permissionBusy} onClick={()=>run(permission())}>{t('系统设置')}</Button>}{!audio?.active&&<Button kind="ghost" disabled={busy||!!unavailable||missingInput} onClick={()=>run(start())}>{t('重新开始')}</Button>}</div></div>}
    <div ref={workspace.gridRef} className="audio-v5-grid"><div className="audio-v5-canvas">
      <div ref={workspace.stageRef} className="audio-workspace-core" tabIndex={-1}>
      <div className="audio-v5-status" role="status"><i className={capturing?'active':''}/>{t(statusText)}{audio?.status==='paused'&&<Button kind="ghost" busy={busy} onClick={()=>{if(actionPending.current)return;actionPending.current=true;setBusy(true);run(command({op:'lightWake'},{silent:true}).catch(error=>setActionError(error instanceof Error?error.message:'操作未完成，请重试。')).finally(()=>{actionPending.current=false;setBusy(false);}));}}>{t('唤醒灯光')}</Button>}</div>
      {unavailable&&<p className="audio-v5-unavailable">{t(unavailable)}</p>}
      <div ref={workspace.keyboardRef} className="audio-workspace-keyboard"><Keyboard layout={layout} colors={capturing?state?.colors??[]:Array(84).fill('#000000')} sideColor="#000000"/></div>
      </div>
      <div ref={workspace.auxiliaryRef} className="audio-workspace-aux"><div className="audio-v5-footer"><div className="audio-v5-meter" role="meter" aria-label={t('声音电平')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level*100)}><span><AudioLines size={16}/>{t('声音电平')}</span><div>{Array.from({length:32},(_,i)=><i key={i} className={i<Math.round(level*32)?'lit':''}/>)}</div></div>
        <div id="audio-output-brightness-group" tabIndex={-1} className="audio-v5-brightness v7-output-controls"><span>{t('逐键输出亮度')}</span><input aria-label={t('逐键输出亮度')} aria-describedby="audio-output-brightness-help" type="range" min="0" max="100" value={brightness} style={rangeStyle(brightness)} onChange={e=>changeBrightness(Number(e.target.value))} onPointerUp={()=>run(flushBrightness())} onKeyUp={()=>run(flushBrightness())} onBlur={()=>run(flushBrightness())}/><output>{brightness}%</output><button onClick={()=>navigate('permissions')}><ShieldCheck size={16}/>{t('声音与隐私')}</button><div id="audio-output-brightness-help" className="v7-output-help"><p>{t('影响所有逐键输出；不改 HEX，不随作品保存。')}</p><p>{t('AI 状态灯还会叠加此全局亮度。')}</p></div>{pending.brightnessError&&<div className="inline-v6-notice inline-v6-error audio-v6-settings-error" role="alert"><p>{connectionCopy({zh:'输出亮度的保存结果尚未确认，修改已保留。',en:'Saving output brightness is not confirmed. Your changes are kept.'})}</p><Button kind="ghost" busy={retrying} onClick={()=>run(retrySettings())}>{connectionCopy({zh:'重试保存',en:'Retry save'})}</Button></div>}</div>
      </div></div>
    </div><aside id="audio-settings-group" tabIndex={-1} className="audio-v5-properties"><h3>{t('律动设置')}</h3>
      <label className="audio-v5-field"><span>{t('声音来源')}</span><select aria-label={t('声音来源')} disabled={!!audio?.active||busy} value={config.source} onChange={event=>{setActionError('');change({source:event.target.value as AudioConfig['source']});}}><option value="system">{t('系统声音')}</option><option value="microphone">{t('麦克风')}</option></select></label>
      {config.source==='microphone'&&<label className="audio-v5-field"><span>{t('输入设备')}</span><select aria-label={t('输入设备')} aria-invalid={missingInput||undefined} disabled={!!audio?.active||busy} value={config.deviceId} onChange={e=>{setActionError('');change({deviceId:e.target.value});}}><option value="">{t('系统默认麦克风')}</option>{config.deviceId&&!audio?.devices.some(d=>d.id===config.deviceId)&&<option value={config.deviceId}>{t('所选设备已断开')}</option>}{audio?.devices.map(d=><option value={d.id} key={d.id}>{d.name}</option>)}</select>{missingInput&&<span className="inline-v6-field-error" role="alert">{t('所选麦克风已断开，请重新选择')}</span>}</label>}
      {audio?.active&&<p className="audio-v5-description">{t('停止律动后可切换来源。')}</p>}
      <label className="audio-v5-field"><span>{t('律动效果')}</span><select aria-label={t('律动效果')} value={config.effect} onChange={e=>change({effect:e.target.value as AudioEffect})}>{AUDIO_EFFECTS.map(({id,label})=><option key={id} value={id}>{t(label)}</option>)}</select></label>
      <div className="audio-v5-field"><span>{t('颜色')}</span><div className="audio-v5-color"><input aria-label={t('律动颜色')} type="color" value={config.color} disabled={config.colorMode==='colorful'} onChange={e=>change({color:e.target.value})}/><select aria-label={t('颜色模式')} value={config.colorMode} onChange={e=>change({colorMode:e.target.value as AudioConfig['colorMode']})}><option value="single">{t('单色')}</option><option value="colorful">{t('彩色')}</option></select></div></div>
      <details className="audio-v5-adjust inline-v6-details"><summary><SlidersHorizontal size={15}/><span>{t('灵敏度与噪声门限')}</span></summary><label><span>{t('灵敏度')}<output>{config.sensitivity.toFixed(2)}×</output></span><input aria-label={t('灵敏度')} type="range" min="0.25" max="4" step="0.05" value={config.sensitivity} style={rangeStyle(config.sensitivity,.25,4)} onChange={e=>change({sensitivity:Number(e.target.value)})}/></label><label><span>{t('噪声门限')}<output>{config.noiseFloor} dB</output></span><input aria-label={t('噪声门限')} type="range" min="-80" max="-20" step="1" value={config.noiseFloor} style={rangeStyle(config.noiseFloor,-80,-20)} onChange={e=>change({noiseFloor:Number(e.target.value)})}/></label><p>{t('低于门限的声音不会触发灯光。')}</p></details>
      {pending.audioError&&<div className="inline-v6-notice inline-v6-error audio-v6-settings-error" role="alert"><p>{connectionCopy({zh:'声音设置的保存结果尚未确认，修改已保留。',en:'Saving audio settings is not confirmed. Your changes are kept.'})}</p><Button kind="ghost" busy={retrying} onClick={()=>run(retrySettings())}>{connectionCopy({zh:'重试保存',en:'Retry save'})}</Button></div>}
      <button className="audio-v5-link" onClick={()=>navigate('lighting')}><Moon size={16}/>{t('管理灯光休眠')}</button>
      <details className="audio-v5-privacy inline-v6-details"><summary>{t('声音与隐私')}</summary><p>{t('声音仅在本机分析，不保存或上传。休眠时暂停采集。')}</p><p>{t('系统声音与麦克风是不同来源，使用前按需请求对应权限。')}</p><p>{t('切换来源或设备后重新开始采集；停止律动后停止采集。')}</p></details>
    </aside></div>
  </section>;
}
