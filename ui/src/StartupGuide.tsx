import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Check,CircleAlert,Keyboard,RefreshCw,ShieldCheck} from 'lucide-react';
import {nativeCodexKeys,nativeCodexRequest} from './codexKeys';
import {useLanguage,t} from './i18n';
import {Button,Modal,run} from './primitives';
import type {AppState,Command} from './types';
import {coalescePermissionRefresh,watchPermissionRefresh} from '../../shared/permission-refresh.mjs';

export const OFFICIAL_DRIVER_URL='https://drive.nuphy.io/?lang=zh-CN';
type Permission='inputMonitoring'|'accessibility';
export type OfficialDriverResult={opened:boolean;url:string;browser?:string;browserBundleId?:string;browserSupportsUSB?:boolean;needsSupportedBrowser?:boolean;message?:string;manual?:boolean;safeReleased?:boolean;prepareError?:string};
import {firmwarePrompt,currentFirmwareReady,firmwareUpdateSatisfied,type FirmwarePrompt} from '../../shared/firmware-onboarding.mjs';
export {firmwarePrompt,currentFirmwareReady};
const firmwareEvent='nuphylab:firmware-guide';

export function useStartupCopy(){const language=useLanguage();return useCallback((zh:string,en:string)=>language==='en'?en:zh,[language]);}
export function showFirmwareGuide(){window.dispatchEvent(new Event(firmwareEvent));}
export function refreshAppPermissions(command:Command){return coalescePermissionRefresh(command,async()=>{await nativeCodexKeys({kind:'refreshPermissions'}).catch(()=>false);return command({op:'refreshPermissions'});});}
export async function requestAppPermission(command:Command,permission:Permission){
  if(!await nativeCodexKeys({kind:'permission',permission}))return command({op:'openPermissionSettings',permission});
  return command({op:'refreshPermissions'});
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
    try{await command({op:'connect'});await command({op:'checkFirmware'});}
    catch{setReconnectFailed(true);}finally{setReconnecting(false);}
  };
  useEffect(()=>{if(!state||disabled||initialCheck.current)return;initialCheck.current=true;void refreshAppPermissions(command).catch(()=>{});},[state,disabled,command]);
  const hasState=state!==null;
  useEffect(()=>{if(disabled||!hasState||permissionsReady)return;return watchPermissionRefresh({refresh:()=>refreshAppPermissions(command),isVisible:()=>!document.hidden,windowTarget:window,documentTarget:document});},[disabled,hasState,permissionsReady,command]);
  useEffect(()=>{if(disabled||!permissionKnown||permissionsReady||prompted.current||firmwareOpen||candidate||awaitingUpdate)return;prompted.current=true;setPermissionOpen(true);},[disabled,permissionKnown,permissionsReady,firmwareOpen,candidate?.key,awaitingUpdate]);
  useEffect(()=>{if(permissionsReady){setPermissionError('');setPermissionOpen(false);}},[permissionsReady]);
  const closeFirmware=()=>{if(!opening)setFirmwareOpen(false);};
  const refresh=async()=>{setPermissionBusy('refresh');setPermissionError('');try{await refreshAppPermissions(command);}catch{setPermissionError(copy('暂时无法检查权限，请稍后重试。','Could not check permissions. Try again shortly.'));}finally{setPermissionBusy(null);}};
  const allow=async(permission:Permission)=>{setPermissionBusy(permission);setPermissionError('');try{await requestAppPermission(command,permission);}catch{setPermissionError(copy('请在系统设置中允许 NuPhy Lab，然后返回软件。','Allow NuPhy Lab in System Settings, then return here.'));}finally{setPermissionBusy(null);}};
  const permissionRow=(permission:Permission,allowed:boolean,title:string,detail:string)=><div className="startup-check-row">{allowed?<Check size={19}/>:<CircleAlert size={19}/>}<div><strong>{title}</strong><p>{allowed?copy('已允许','Allowed'):detail}</p></div>{!allowed&&<Button autoFocus={permission==='inputMonitoring'||input} busy={permissionBusy===permission} disabled={permissionBusy!==null} onClick={()=>run(allow(permission))}>{copy('去授权','Allow')}</Button>}</div>;
  if(disabled)return null;
  return <>
    {awaitingUpdate&&!ready&&!firmwareOpen?<div className="startup-notice firmware-notice" role="status"><Keyboard size={17}/><span>{copy('完成更新后，关闭 NuPhyIO，再返回软件。','After updating, close NuPhyIO and return here.')}{driver?.prepareError&&<small>{copy('请关闭其他键盘设置程序，重新插拔键盘后再更新。','Close other keyboard apps and reconnect the cable before updating.')}</small>}{reconnectFailed&&<small>{copy('暂时无法连接，请重新插拔键盘后再试。','Could not connect. Reconnect the cable and try again.')}</small>}</span><Button busy={reconnecting} onClick={()=>run(reconnect())}>{copy('已更新，重新连接','Updated — reconnect')}</Button></div>:candidate&&!firmwareOpen&&<div className="startup-notice firmware-notice" role="status"><CircleAlert size={17}/><span>{copy('请前往 NuPhyIO 更新键盘固件。','Update your keyboard firmware in NuPhyIO.')}</span><Button onClick={()=>{setFirmware(candidate);setFirmwareOpen(true);}}>{copy('前往更新','Update firmware')}</Button></div>}
    {permissionKnown&&!permissionsReady&&!firmwareOpen&&!awaitingUpdate&&<div className="startup-notice" role="status"><ShieldCheck size={17}/><span>{copy('完成 macOS 授权后即可使用功能键和快捷操作。','Allow macOS permissions to use function keys and shortcuts.')}</span><Button kind="ghost" onClick={()=>setPermissionOpen(true)}>{copy('授权设置','Permission setup')}</Button></div>}
    {firmwareOpen&&firmware&&!ready&&<Modal title={copy('请更新键盘固件','Update keyboard firmware')} onClose={closeFirmware}>
      <div className="startup-guide firmware-guide">
        <div className="startup-guide-intro"><Keyboard size={27}/><div><strong>{firmware.model}</strong><p>{copy('当前固件','Current firmware')} {firmware.current}</p></div></div>
        <p>{copy('请前往 NuPhyIO 安装最新固件，更新完成后即可使用。','Install the latest firmware in NuPhyIO, then return here to use your keyboard.')}</p>
        {(openFailed||driver?.manual)&&<div className="startup-guide-error" role="alert">{copy('请使用 Chrome 或 Edge 打开：','Open this address in Chrome or Edge: ')}<a href={OFFICIAL_DRIVER_URL}>{OFFICIAL_DRIVER_URL}</a></div>}
        {driver?.needsSupportedBrowser&&!driver.manual&&<p>{copy('请在 Chrome 或 Edge 中完成更新。','Complete the update in Chrome or Edge.')}</p>}
        <div className="startup-guide-actions"><Button kind="ghost" disabled={opening} onClick={closeFirmware}>{copy('稍后','Later')}</Button><Button autoFocus kind="primary" icon={<ArrowUpRight size={14}/>} busy={opening} onClick={()=>run(visit())}>{copy('前往 NuPhyIO 更新','Update in NuPhyIO')}</Button></div>
      </div>
    </Modal>}
    {permissionOpen&&!firmwareOpen&&!awaitingUpdate&&<Modal title={copy('完成 NuPhy Lab 首次设置','Set up NuPhy Lab')} onClose={()=>setPermissionOpen(false)}>
      <div className="startup-guide permission-guide">
        <div className="startup-guide-intro"><ShieldCheck size={27}/><p>{copy('开启下面两项 macOS 权限，即可使用功能键、按键灯效和快捷操作。','Allow these two macOS permissions to use function keys, key-triggered lighting and shortcuts.')}</p></div>
        {permissionRow('inputMonitoring',input,copy('输入监控','Input Monitoring'),copy('接收功能键及你选择的按键灯效。','Receive function keys and your selected lighting triggers.'))}
        {permissionRow('accessibility',access,copy('辅助功能','Accessibility'),copy('执行快捷操作。','Run shortcuts.'))}
        <p className="startup-guide-instructions">{copy('在“隐私与安全性”中打开 NuPhy Lab 的开关。返回软件后会自动检查；如系统要求重新打开应用，请按提示操作。','Enable NuPhy Lab under Privacy & Security, then return here. If macOS asks you to reopen the app, follow that prompt.')}</p>
        <p className="muted">{copy('声音权限仅在使用声音律动时请求。','Audio permissions are requested when you use audio-reactive lighting.')}</p>
        {permissionError&&<p className="startup-guide-error" role="alert">{t(permissionError)}</p>}
        {permissionsReady&&<div className="startup-guide-status is-ready" role="status"><Check size={16}/>{copy('授权已就绪，可以开始使用。','Permissions are ready. You can start using NuPhy Lab.')}</div>}
        <div className="startup-guide-actions"><Button kind="ghost" disabled={permissionBusy!==null} onClick={()=>setPermissionOpen(false)}>{copy(permissionsReady?'完成':'稍后',permissionsReady?'Done':'Later')}</Button><Button kind={permissionsReady?'secondary':'primary'} icon={<RefreshCw size={14}/>} busy={permissionBusy==='refresh'} disabled={permissionBusy!==null} onClick={()=>run(refresh())}>{copy('重新检查授权','Check permissions again')}</Button></div>
      </div>
    </Modal>}
  </>;
}
