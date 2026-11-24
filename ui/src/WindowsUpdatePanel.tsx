import {useEffect,useRef,useState} from 'react';
import {Button,run} from './primitives';
import {nativeCodexRequest} from './codexKeys';
import {useStartupCopy} from './StartupGuide';
import type {AppState} from './types';
import packageInfo from '../../package.json';
type UpdateState={available:boolean;phase:string;latest?:{version:string;notes:string}|null;error?:string|null;progress?:{received:number;total?:number|null};restartRequired?:boolean};
export function WindowsUpdatePanel({state}:{state:AppState|null}){
  const copy=useStartupCopy(),[update,setUpdate]=useState<UpdateState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const pending=useRef(false),mounted=useRef(true),generation=useRef(0);
  const request=async(kind:string,version?:string)=>{
    const response=await nativeCodexRequest({kind,...(version?{version}:{})});
    if(!response.available)throw Error(copy('请在 Windows 桌面应用中操作。','Use the Windows desktop app.'));
    return response.result as UpdateState;
  };
  useEffect(()=>{
    mounted.current=true;let stopped=false;
    const poll=async()=>{const at=generation.current;try{const value=await request('windowsUpdateStatus');if(!stopped&&at===generation.current)setUpdate(value);}catch{if(!stopped&&at===generation.current)setError(copy('无法读取更新状态。','Could not read the update status.'));}};
    void poll();const timer=window.setInterval(()=>{void poll();},1000);
    return()=>{stopped=true;mounted.current=false;window.clearInterval(timer);};
  },[]);
  const perform=async(install=false)=>{
    if(pending.current)return;pending.current=true;generation.current++;setBusy(true);setError('');
    try{
      if(install){if(!update?.latest?.version)throw Error(copy('请先检查新版本。','Check for a new version first.'));await request('installWindowsUpdate',update.latest.version);}
      else{const value=await request('checkForUpdates');if(mounted.current)setUpdate(value);}
    }catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:copy('更新失败，请稍后重试。','Update failed. Try again later.'));}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  const phases:Record<string,string>={checking:copy('正在检查新版本…','Checking for updates…'),downloading:copy('正在下载更新…','Downloading the update…'),verifying:copy('正在核对文件签名与发布者…','Verifying the signature and publisher…'),restoring:copy('正在恢复键盘并保存退出状态…','Restoring the keyboard before closing…'),installing:copy('正在启动安装程序…','Starting the installer…'),upToDate:copy('当前已是最新版本。','You are up to date.')};
  const active=busy||!!update&&['checking','downloading','verifying','restoring','installing'].includes(update.phase);
  return <section className="lab-setting-panel lab-update-panel" aria-label={copy('Windows 软件更新','Windows software updates')}>
    <div className="lab-setting-row"><div><h2>NuPhy Lab · Windows</h2><p>{copy('当前版本','Installed version')} {state?.build?.version||packageInfo.version}</p></div>
      {update?.available&&<Button busy={active} disabled={active||update.restartRequired} onClick={()=>run(perform())}>{copy('检查软件更新','Check app updates')}</Button>}</div>
    {update?.available?<p>{copy('更新前会核对文件签名和发布者，并等待键盘恢复完成。下载或检查失败时不会开始安装，作品继续保存在本机。','Updates verify the signature and publisher, then wait for the keyboard to be restored. A failed download or verification never starts installation. Artwork stays on this PC.')}</p>
      :<p>{copy('此预览包尚未配置签名更新服务。后续可使用完整安装包升级，已有作品保存在本机。','Signed updates are not configured in this preview. Upgrade with a complete installer when available. Artwork is saved locally.')}</p>}
    {update&&phases[update.phase]&&<p role="status">{phases[update.phase]}</p>}
    {update?.latest&&<><h3>{copy('可用版本','Available version')} {update.latest.version}</h3><p className="settings-v6-note">{update.latest.notes}</p>
      <Button disabled={active||update.restartRequired} busy={active} onClick={()=>run(perform(true))}>{copy('安装并重新打开','Install and reopen')}</Button></>}
    {(error||update?.error)&&<p className="settings-v6-note is-error" role="alert">{error||update?.error}</p>}
    {update?.restartRequired&&<p role="alert">{copy('后台已经安全关闭。请正常关闭窗口并重新打开应用后重试。','The background service has closed safely. Close this window and reopen the app before retrying.')}</p>}
    <p>{copy('键盘固件升级仍请使用 NuPhy 官方工具；此处仅更新 NuPhy Lab 软件。','Use the official NuPhy tool for keyboard firmware. This page updates NuPhy Lab only.')}</p>
  </section>;
}
