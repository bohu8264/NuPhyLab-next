import {useEffect,useRef,useState} from 'react';
import {Button,Switch,run} from './primitives';
import {useStartupCopy} from './StartupGuide';
import {DEFAULT_AMBIENT_LIGHTING,type AmbientLightingSettings} from '../../shared/ambient-lighting.mjs';
import type {AppState,Command} from './types';
import './ambient-lighting.css';

export function AmbientLightingPreferences({state,command}:{state:AppState|null;command:Command}) {
  const copy=useStartupCopy(),settings=state?.settings.ambientLighting??DEFAULT_AMBIENT_LIGHTING,live=state?.ambientLighting;
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[brightness,setBrightness]=useState(70);
  const lock=useRef(false),editing=useRef(false);
  const shown=live?.status==='active'?live.effectiveBrightness:state?.settings.brightness??70;
  useEffect(()=>{if(!editing.current)setBrightness(shown);},[shown]);
  const save=async(patch:Partial<AmbientLightingSettings>)=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{await command({op:'settings',settings:{ambientLighting:patch}},{silent:true});}
    catch{setError(copy('未能确认保存，请重新检查当前设置。','The save could not be confirmed. Check the current settings.'));}
    finally{lock.current=false;setBusy(false);}
  };
  const setManual=async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{await command({op:'settings',settings:{brightness}},{silent:true});}
    catch{setError(copy('未能确认亮度，请稍后重试。','Brightness could not be confirmed. Try again shortly.'));}
    finally{editing.current=false;lock.current=false;setBusy(false);}
  };
  const messages={
    disabled:copy('手动调节亮度。','Brightness is controlled manually.'),
    active:copy(`正在跟随环境光 · ${live?.effectiveBrightness??0}%`,`Following ambient light · ${live?.effectiveBrightness??0}%`),
    manualOff:copy('已手动关灯；调高亮度后恢复自动调节。','Lights are manually off. Raise brightness to resume automatic adjustment.'),
    noKeyboard:copy('连接支持的 USB 键盘后可用。','Connect a supported keyboard by USB.'),
    unsupportedKeyboard:copy('当前固件不支持逐键灯光，请先检查固件更新。','This firmware does not support per-key lighting. Check for a firmware update.'),
    idle:copy('播放 Lab 灯效后自动调整按键背光。','Start Lab lighting to adjust the key backlight automatically.'),
    waiting:copy('正在读取环境光；暂时使用手动亮度。','Reading ambient light; using manual brightness for now.'),
    unavailable:copy('此 Mac 暂时无法读取环境光，已使用手动亮度。','Ambient light is unavailable on this Mac. Using manual brightness.'),
    lidClosed:copy('屏幕已合上，暂时使用手动亮度。','The lid is closed. Using manual brightness for now.'),
    sleeping:copy('Mac 正在休眠，唤醒后重新感光。','Mac is sleeping. Ambient sensing resumes on wake.'),
  };
  return <section className="lab-setting-panel ambient-lighting-panel" aria-label={copy('自动感光背光','Automatic backlight')}>
    <div className="lab-setting-row"><div><h3>{copy('自动感光背光','Automatic backlight')}</h3><p>{copy('环境变亮时调暗，变暗时缓缓亮起。','Dims in bright surroundings and gently brightens as the room gets darker.')}</p></div>
      <Switch label={copy('自动感光背光','Automatic backlight')} checked={settings.enabled} disabled={!state||busy} onChange={value=>run(save({enabled:value}))}/>
    </div>
    {settings.enabled&&<>
      <div className="ambient-lighting-state" role="status">{messages[live?.status??'waiting']}</div>
      <div className="lab-setting-row"><div><h3>{copy('明亮环境','Bright surroundings')}</h3></div><select aria-label={copy('明亮环境的背光','Backlight in bright surroundings')} value={settings.brightRoom} disabled={busy} onChange={event=>run(save({brightRoom:event.target.value as 'off'|'dim'}))}>
        <option value="off">{copy('关闭背光','Turn off')}</option><option value="dim">{copy('保留微光','Keep a faint glow')}</option></select></div>
      <div className="lab-setting-row"><div><h3>{copy('记住我的亮度习惯','Remember my brightness')}</h3><p>{copy('在较暗环境中手动调节后，记住这个型号键盘的偏好。仅保存在本机。','Manual adjustments in dim surroundings teach this keyboard model your preferences. Saved only on this Mac.')}</p></div>
        <Switch label={copy('记住我的亮度习惯','Remember my brightness')} checked={settings.learn} disabled={busy} onChange={value=>run(save({learn:value}))}/></div>
      <div className="ambient-brightness-row"><label htmlFor="ambient-brightness">{copy('当前亮度','Current brightness')}</label><input id="ambient-brightness" type="range" min="0" max="100" step="1" value={brightness} disabled={busy||!state} onPointerDown={()=>{editing.current=true;}} onChange={event=>{editing.current=true;setBrightness(Number(event.target.value));}} onPointerUp={()=>run(setManual())} onPointerCancel={()=>{editing.current=false;setBrightness(shown);}} onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))run(setManual());}} onBlur={()=>{if(editing.current)run(setManual());}}/><output htmlFor="ambient-brightness">{brightness}%</output></div>
      <div className="ambient-lighting-footer"><p>{copy('适用于 USB 下由 Lab 播放的按键背光。使用 Mac 的感光传感器，无需开启摄像头。','For key backlighting played by Lab over USB. Uses the Mac’s ambient sensor without opening the camera.')}</p>
        {(live?.learnedPoints??0)>0&&<Button kind="ghost" disabled={busy} onClick={()=>{const profiles={...settings.profiles};if(state?.device.modelId)delete profiles[state.device.modelId];run(save({profiles}));}}>{copy('重置学习','Reset learning')}</Button>}</div>
    </>}
    {error&&<p className="settings-v6-note is-error" role="alert">{error}</p>}
  </section>;
}
