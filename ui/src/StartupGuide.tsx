import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Check,CircleAlert,Clock,Info,Keyboard,ShieldCheck} from 'lucide-react';
import {nativeCodexKeys,nativeCodexRequest} from './codexKeys';
import {useLanguage,t} from './i18n';
import {Button,Modal,run} from './primitives';
import type {AppState,Command} from './types';
import {coalescePermissionRefresh,refreshPermissionSession,watchPermissionRefresh} from '../../shared/permission-refresh.mjs';
import './settings-overlays-v6.css';

export const OFFICIAL_DRIVER_URL='https://drive.nuphy.io/?lang=zh-CN';
type Permission='inputMonitoring'|'accessibility';
export type OfficialDriverResult={opened:boolean;url:string;browser?:string;browserBundleId?:string;browserSupportsUSB?:boolean;needsSupportedBrowser?:boolean;message?:string;manual?:boolean;safeReleased?:boolean;prepareError?:string};
import {firmwarePrompt,currentFirmwareReady,firmwareUpdateSatisfied,type FirmwarePrompt} from '../../shared/firmware-onboarding.mjs';
export {firmwarePrompt,currentFirmwareReady};
const firmwareEvent='nuphylab:firmware-guide';

export function useStartupCopy(){const language=useLanguage();return useCallback((zh:string,en:string)=>language==='en'?en:zh,[language]);}
export function showFirmwareGuide(){window.dispatchEvent(new Event(firmwareEvent));}
export function refreshAppPermissions(command:Command,options?:{silent?:boolean}){
  // Keep the original command as owner so startup, settings and focus checks still share in-flight work.
  return coalescePermissionRefresh(command,()=>refreshPermissionSession(body=>command(body,options),()=>nativeCodexRequest({kind:'refreshPermissions'})));
}
export async function requestAppPermission(command:Command,permission:Permission,options?:{silent?:boolean}){
  if(!await nativeCodexKeys({kind:'permission',permission}))return command({op:'openPermissionSettings',permission},options);
  return refreshAppPermissions(command,options);
}
function officialUpdateURL(value:unknown){
  const raw=value&&typeof value==='object'&&'url' in value?String(value.url):'';
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.hostname!=='drive.nuphy.io'||url.username||url.password||url.port)throw new Error('Invalid official firmware update address.');
  return url.href;
}
// USB handoff stays inside the native host. Product UI only asks the user to
// update in NuPhyIO and reconnect afterwards.
export async function openOfficialDriver():Promise<OfficialDriverResult>{
  const reply=await nativeCodexRequest({kind:'openOfficialDriver'});
  if(!reply.available)return {opened:false,url:OFFICIAL_DRIVER_URL,manual:true,needsSupportedBrowser:true};
  const result=reply.result;
  if(!result||typeof result!=='object'||!('opened' in result)||result.opened!==true)throw new Error('The official driver could not be opened.');
  return {...result,url:officialUpdateURL(result)} as OfficialDriverResult;
}
export function OfficialDriverAccess({compact=false}:{prepared?:boolean;compact?:boolean}){
  const copy=useStartupCopy();const [busy,setBusy]=useState(false),[result,setResult]=useState<OfficialDriverResult|null>(null),[failed,setFailed]=useState(false);
  const open=async()=>{setBusy(true);setFailed(false);try{setResult(await openOfficialDriver());}catch{setFailed(true);}finally{setBusy(false);}};
  return <div className={`official-driver-access ${compact?'is-compact':''}`}>
    <Button icon={<ArrowUpRight size={14}/>} busy={busy} onClick={()=>run(open())}>{copy('前往 NuPhyIO 更新','Update in NuPhyIO')}</Button>
    {result?.opened&&<p role="status">{copy('完成更新后，关闭 NuPhyIO，再返回软件。','After updating, close NuPhyIO and return here.')}</p>}
    {result?.prepareError&&<p className="error-text" role="alert">{copy('请关闭其他键盘设置程序，重新插拔键盘后再更新。','Close other keyboard apps and reconnect the cable before updating.')}</p>}
    {(failed||result?.manual)&&<p role="status">{copy('请使用 Chrome 或 Edge 打开：','Open this address in Chrome or Edge: ')}<a href={OFFICIAL_DRIVER_URL}>{OFFICIAL_DRIVER_URL}</a></p>}
    {result?.needsSupportedBrowser&&!result.manual&&<p>{copy('请在 Chrome 或 Edge 中完成更新。','Complete the update in Chrome or Edge.')}</p>}
  </div>;
}
export function StartupGuide({state,command,disabled=false}:{state:AppState|null;command:Command;disabled?:boolean}){
  const copy=useStartupCopy();
  const [permissionOpen,setPermissionOpen]=useState(false),[permissionBusy,setPermissionBusy]=useState<Permission|'refresh'|null>(null),[permissionError,setPermissionError]=useState('');
  const [firmware,setFirmware]=useState<FirmwarePrompt|null>(null),[firmwareOpen,setFirmwareOpen]=useState(false),[opening,setOpening]=useState(false),[awaitingUpdate,setAwaitingUpdate]=useState(false),[driver,setDriver]=useState<OfficialDriverResult|null>(null),[openFailed,setOpenFailed]=useState(false),[reconnecting,setReconnecting]=useState(false),[reconnectFailed,setReconnectFailed]=useState(false);
  const prompted=useRef(false),initialCheck=useRef(false),attempted=useRef(new Set<string>()),handoff=useRef(0),alive=useRef(true),latest=useRef(state);latest.current=state;
  const native=state?.native??{},input=native.inputMonitoring===true,access=native.accessibility===true&&native.canPostEvents===true;
  const permissionKnown=typeof native.inputMonitoring==='boolean'&&typeof native.accessibility==='boolean'&&typeof native.canPostEvents==='boolean';
  const permissionsReady=input&&access,candidate=firmwarePrompt(state),ready=firmwareUpdateSatisfied(state,firmware);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;handoff.current++;};},[]);
  // Showing a reminder never opens a browser or changes the USB connection.
  useEffect(()=>{
    if(disabled||!candidate||attempted.current.has(candidate.key))return;
    attempted.current.add(candidate.key);setFirmware(candidate);setFirmwareOpen(true);setDriver(null);setOpenFailed(false);setReconnectFailed(false);
  },[candidate?.key,disabled]);
  useEffect(()=>{
    if(!ready)return;
    handoff.current++;setFirmware(null);setFirmwareOpen(false);setAwaitingUpdate(false);setOpening(false);setDriver(null);setOpenFailed(false);setReconnectFailed(false);
  },[ready,state?.device.modelId,state?.firmware?.current]);
  useEffect(()=>{
    if(firmware&&!candidate&&state?.device.connected&&state.device.modelId!==firmware.modelId){handoff.current++;setFirmware(null);setFirmwareOpen(false);setAwaitingUpdate(false);setOpening(false);setDriver(null);}
  },[state?.device.connected,state?.device.modelId,firmware?.modelId,candidate?.key]);
  useEffect(()=>{
    if(disabled)return;
    const open=()=>{const prompt=firmwarePrompt(latest.current);if(!prompt)return;attempted.current.add(prompt.key);setFirmware(prompt);setFirmwareOpen(true);setOpenFailed(false);};
    window.addEventListener(firmwareEvent,open);return()=>window.removeEventListener(firmwareEvent,open);
  },[disabled]);
  const visit=async()=>{
    if(opening)return;const token=++handoff.current;setOpening(true);setOpenFailed(false);setReconnectFailed(false);
    try{const result=await openOfficialDriver();if(!alive.current||token!==handoff.current)return;setDriver(result);if(result.opened){setAwaitingUpdate(true);setFirmwareOpen(false);}}
    catch{if(alive.current&&token===handoff.current)setOpenFailed(true);}
    finally{if(alive.current&&token===handoff.current)setOpening(false);}
  };
  const reconnect=async()=>{
    setReconnecting(true);setReconnectFailed(false);
    try{await command({op:'connect'},{silent:true});await command({op:'checkFirmware'},{silent:true});}
    catch{setReconnectFailed(true);}finally{setReconnecting(false);}
  };
  useEffect(()=>{if(!state||disabled||initialCheck.current)return;initialCheck.current=true;void refreshAppPermissions(command,{silent:true}).catch(()=>{});},[state,disabled,command]);
  const hasState=state!==null;
  useEffect(()=>{if(disabled||!hasState||permissionsReady)return;return watchPermissionRefresh({refresh:()=>refreshAppPermissions(command,{silent:true}),isVisible:()=>!document.hidden,windowTarget:window,documentTarget:document});},[disabled,hasState,permissionsReady,command]);
  useEffect(()=>{if(disabled||!permissionKnown||permissionsReady||prompted.current||firmwareOpen||candidate||awaitingUpdate)return;prompted.current=true;setPermissionOpen(true);},[disabled,permissionKnown,permissionsReady,firmwareOpen,candidate?.key,awaitingUpdate]);
  useEffect(()=>{if(permissionsReady){setPermissionError('');setPermissionOpen(false);}},[permissionsReady]);
  const closeFirmware=()=>{if(!opening)setFirmwareOpen(false);};
  const refresh=async()=>{if(permissionBusy)return;setPermissionBusy('refresh');setPermissionError('');try{await refreshAppPermissions(command,{silent:true});}catch{setPermissionError(copy('暂时无法检查权限，请稍后重试。','Could not check permissions. Try again shortly.'));}finally{setPermissionBusy(null);}};
  const allow=async(permission:Permission)=>{if(permissionBusy)return;setPermissionBusy(permission);setPermissionError('');try{await requestAppPermission(command,permission,{silent:true});}catch{setPermissionError(copy('请在系统设置中允许 NuPhy Lab，然后返回软件。','Allow NuPhy Lab in System Settings, then return here.'));}finally{setPermissionBusy(null);}};
  const permissionRow=(permission:Permission,allowed:boolean,title:string,detail:string)=><div className={`settings-v6-permission-row ${allowed?'is-ready':''}`}>
    {allowed?<Check size={16}/>:<Clock size={16}/>}<div><strong>{title}</strong><p>{detail}</p></div>
    {allowed?<span>{copy('已允许','Allowed')}</span>:<Button autoFocus={permission==='inputMonitoring'||input} busy={permissionBusy===permission} disabled={permissionBusy!==null} onClick={()=>run(allow(permission))}>{copy('去授权','Allow')}</Button>}
  </div>;
  if(disabled)return null;
  return <>
    {awaitingUpdate&&!ready&&!firmwareOpen?<div className="startup-notice firmware-notice" role="status"><Keyboard size={17}/><span>{copy('完成更新后，关闭 NuPhyIO，再返回软件。','After updating, close NuPhyIO and return here.')}{driver?.prepareError&&<small>{copy('请关闭其他键盘设置程序，重新插拔键盘后再更新。','Close other keyboard apps and reconnect the cable before updating.')}</small>}{reconnectFailed&&<small>{copy('暂时无法连接，请重新插拔键盘后再试。','Could not connect. Reconnect the cable and try again.')}</small>}</span><Button busy={reconnecting} onClick={()=>run(reconnect())}>{copy('已更新，重新连接','Updated — reconnect')}</Button></div>:candidate&&!firmwareOpen&&<div className="startup-notice firmware-notice" role="status"><CircleAlert size={17}/><span>{copy('请前往 NuPhyIO 更新键盘固件。','Update your keyboard firmware in NuPhyIO.')}</span><Button onClick={()=>{setFirmware(candidate);setFirmwareOpen(true);}}>{copy('前往更新','Update firmware')}</Button></div>}
    {permissionKnown&&!permissionsReady&&!firmwareOpen&&!awaitingUpdate&&<div className="startup-notice" role="status"><ShieldCheck size={17}/><span>{copy('完成 macOS 授权后即可使用功能键和快捷操作。','Allow macOS permissions to use function keys and shortcuts.')}</span><Button kind="ghost" onClick={()=>setPermissionOpen(true)}>{copy('授权设置','Permission setup')}</Button></div>}
    {firmwareOpen&&firmware&&!ready&&<Modal title={copy('请更新键盘固件','Update keyboard firmware')} width={560} busy={opening} initialFocus="title" className="settings-overlay-v6" onClose={closeFirmware} footer={<>
      <Button kind="ghost" disabled={opening} onClick={closeFirmware}>{copy('稍后','Later')}</Button><Button kind="primary" busy={opening} onClick={()=>run(visit())}>{copy(opening?'正在打开…':'前往 NuPhyIO 更新',opening?'Opening…':'Update in NuPhyIO')}</Button>
    </>}>
      <div className="settings-v6-firmware-guide">
        <h3>{firmware.model}</h3>
        <div className="settings-v6-firmware-row"><Clock size={16}/><div><strong>{copy('当前固件','Current firmware')}</strong><p>{firmware.current}</p></div></div>
        <div className="settings-v6-firmware-row"><Clock size={16}/><div><strong>{copy('目标固件','Target firmware')}</strong><p>{copy('NuPhyIO 为当前型号提供的最新版本','The latest version NuPhyIO provides for this model')}</p></div></div>
        <p>{copy('安装最新固件后可使用逐键创作。完成更新后，关闭 NuPhyIO，再返回软件。','Install the latest firmware to use per-key creation. After updating, close NuPhyIO and return here.')}</p>
        {(openFailed||driver?.manual||driver?.needsSupportedBrowser)&&<div className={openFailed?'overlay-error':'overlay-notice'} role={openFailed?'alert':'status'}><Info size={14}/><div>{copy('请使用 Chrome 或 Edge 打开：','Open this address in Chrome or Edge: ')}<a href={OFFICIAL_DRIVER_URL}>{OFFICIAL_DRIVER_URL}</a></div></div>}
        {driver?.prepareError&&<div className="overlay-error" role="alert">{copy('请关闭其他键盘设置程序，重新插拔键盘后再更新。','Close other keyboard apps and reconnect the cable before updating.')}</div>}
      </div>
    </Modal>}
    {permissionOpen&&!firmwareOpen&&!awaitingUpdate&&<Modal title={copy('完成 NuPhy Lab 首次设置','Set up NuPhy Lab')} width={560} initialFocus="title" className="settings-overlay-v6" onClose={()=>setPermissionOpen(false)} footer={<>
      <Button kind="ghost" disabled={permissionBusy!==null} onClick={()=>setPermissionOpen(false)}>{copy(permissionsReady?'完成':'稍后',permissionsReady?'Done':'Later')}</Button><Button kind={permissionsReady?'secondary':'primary'} busy={permissionBusy==='refresh'} disabled={permissionBusy!==null} onClick={()=>run(refresh())}>{copy(permissionBusy==='refresh'?'检查中…':'重新检查授权',permissionBusy==='refresh'?'Checking…':'Check permissions again')}</Button>
    </>}>
      <div className="settings-v6-permission-guide">
        <p>{copy('开启下面两项 macOS 权限，即可使用快捷键、按键灯效和快捷操作。','Allow these two macOS permissions to use shortcuts, key-triggered lighting and system actions.')}</p>
        {permissionRow('inputMonitoring',input,copy('输入监控','Input Monitoring'),copy('接收你选择的按键灯效。','Receive your selected lighting triggers.'))}
        {permissionRow('accessibility',access,copy('辅助功能','Accessibility'),copy('执行系统快捷操作。','Run system shortcuts.'))}
        <p className="settings-v6-permission-instructions">{copy('在「隐私与安全性」中打开 NuPhy Lab 的开关。返回后自动检查；如系统要求重新打开应用，请按提示操作。','Enable NuPhy Lab under Privacy & Security, then return here. If macOS asks you to reopen the app, follow that prompt.')}</p>
        <p className="overlay-helper">{copy('声音权限仅在使用声音律动时请求。','Audio permissions are requested when you use audio-reactive lighting.')}</p>
        {permissionError&&<div className="overlay-error" role="alert">{t(permissionError)}</div>}
        {permissionsReady&&<div className="overlay-notice" role="status"><Check size={16}/>{copy('授权已就绪，可以开始使用。','Permissions are ready. You can start using NuPhy Lab.')}</div>}
      </div>
    </Modal>}
  </>;
}
