import {useEffect,useRef,useState} from 'react';
import {Check,CircleAlert,Keyboard} from 'lucide-react';
import {Button,Modal} from './primitives';
import {t} from './i18n';
import {refreshAppPermissions,requestAppPermission,showFirmwareGuide} from './StartupGuide';
import {friendlyConnectionError,keyRecoveryProblem} from './KeyRecoveryPanel';
import type {AppState,Command} from './types';

type Adaptation={status?:string;ready?:string[];unsupported?:string[];shared?:string[];mapped?:number;error?:string};
export function CodexSetup({state,command,source='codex'}:{state:AppState|null;command:Command;source?:'codex'|'claude'}){
  const connectionIssue=keyRecoveryProblem(state);
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  const name=source==='claude'?'Claude Code':'Codex';
  const enabled=(state?.settings.agentSource==='claude'?'claude':'codex')===source&&state?.settings[`${source}Enabled`]===true,a=(state?.codex.adaptation??{}) as Adaptation;
  const host=(state?.codex.keys as {host?:{registered?:string[];failed?:string[];suspended?:boolean}}|undefined)?.host;
  const permissions=state?.native??{},input=permissions.inputMonitoring===true,access=permissions.accessibility===true&&permissions.canPostEvents===true;
  const wireless=state?.bluetooth?.connected===true&&!state?.device.connected,connected=state?.device.connected===true||wireless;
  const firmwareUpdate=state?.firmware?.upgradeRecommended===true;
  const registered=host?.registered?.length===12&&host.failed?.length===0;
  const complete=!connectionIssue&&enabled&&a.status==='ready'&&registered&&host?.suspended!==true&&input&&access;
  const model=state?.device.model?.replace(/ ANSI$/,'')??state?.firmware?.modelName??'键盘';
  const summary=firmwareUpdate?'请先在 NuPhyIO 安装推荐固件。':!connected?'请使用 USB 数据线连接键盘。':!input||!access?'完成下面两项授权后继续。':connectionIssue?'请关闭其他键盘设置程序，再重新连接。':busy?'正在检查当前绑定按键…':complete?'当前绑定按键已准备好。':host?.suspended?'编辑、按键触发或游戏期间，快捷控制暂时暂停。':wireless?'蓝牙已连接。灯光播放仍需 USB。':'连接并授权后继续设置绑定按键。';
  const act=async(op:string)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await command(op==='agentMode'?{op,source,enabled:true}:{op,source},{silent:true});}catch(failure){setError(failure instanceof Error?failure.message:'设置尚未完成，请重新检查。');}finally{lock.current=false;setBusy(false);}};
  const begin=()=>{if(firmwareUpdate){showFirmwareGuide();return;}setOpen(true);setError('');if(!connectionIssue)void act('agentMode');};
  const check=()=>{if(firmwareUpdate){setOpen(false);showFirmwareGuide();return;}void act(connectionIssue||!connected?'connect':enabled?'codexAdaptCheck':'agentMode');};
  const permission=async(kind:'inputMonitoring'|'accessibility')=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await requestAppPermission(command,kind,{silent:true});}catch(failure){setError(failure instanceof Error?failure.message:'无法完成授权请求，请重试。');}finally{lock.current=false;setBusy(false);}};
  useEffect(()=>{if(!open)return;const refresh=()=>{void refreshAppPermissions(command,{silent:true}).catch(()=>{});};window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[open,command]);
  const row=(label:string,ok:boolean,detail:string,action?:React.ReactNode)=><div className="agent-setup-row-v6">{ok?<Check size={16} strokeWidth={1.5}/>:<CircleAlert size={16} strokeWidth={1.5}/>}<div><strong>{t(label)}</strong><p>{t(detail)}</p></div>{action??<span className={ok?'agent-row-ready':'agent-row-pending'}>{t(ok?'已就绪':'待完成')}</span>}</div>;
  return <>
    <section className="codex-setup-banner" aria-label={t('键盘设置')}>
      <Keyboard size={19}/><div><strong>{t('功能键')}</strong><p>{t(firmwareUpdate?'前往 NuPhyIO 安装最新固件后即可使用。':!connected?'请使用 USB 数据线连接键盘。':!input||!access?'完成授权后即可使用':connectionIssue?'请关闭其他键盘设置程序，重新连接键盘。':complete?'当前绑定按键已准备好':host?.suspended?'编辑或游戏期间暂时暂停。':enabled?'正在检查当前绑定按键':`${name} 模式未开启`)}</p></div>
      <Button busy={busy} onClick={firmwareUpdate?showFirmwareGuide:enabled?()=>{setOpen(true);check();}:begin}>{firmwareUpdate?t('前往更新'):enabled?t('重新检查'):t(`开启 ${name} 模式`)}</Button>
    </section>
    {open&&<Modal title={t('键盘设置')} width={560} className="agent-overlay-v6" initialFocus="title" onClose={()=>setOpen(false)} footer={<><Button kind="ghost" onClick={()=>setOpen(false)}>{t(complete?'完成':'稍后')}</Button><Button kind="primary" busy={busy} onClick={check}>{t(firmwareUpdate?'前往更新':connectionIssue||!connected?'重新连接':enabled?'重新检查':`开启 ${name} 模式`)}</Button></>}>
      <div className="agent-setup-content-v6"><p className="agent-overlay-intro" role="status">{t(summary)}</p>
        {row('键盘连接',connected,connected?`${model} · ${wireless?t('蓝牙'):'USB'}`:'使用支持数据传输的 USB 线。',!connected?<Button disabled={busy} onClick={()=>{void act('connect');}}>{t('连接键盘')}</Button>:<span className="agent-row-ready">{t('已连接')}</span>)}
        {row('输入监控',input,'接收所选按键与按键灯效。',input?<span className="agent-row-ready">{t('已允许')}</span>:<Button disabled={busy} onClick={()=>{void permission('inputMonitoring');}}>{t('允许')}</Button>)}
        {row('辅助功能',access,'执行系统快捷操作。',access?<span className="agent-row-ready">{t('已允许')}</span>:<Button disabled={busy} onClick={()=>{void permission('accessibility');}}>{t('允许')}</Button>)}
        {firmwareUpdate?row('键盘固件',false,'前往 NuPhyIO 更新。'):row('绑定按键',complete,complete?'按实际绑定位置响应。':busy?'正在检查…':host?.suspended?'当前操作结束后恢复。':'连接并授权后继续。')}
        {wireless&&<p className="agent-overlay-hint">{t('若按键仍在调节亮度或音量，请使用标准 F 键的 Fn 组合，或更改绑定。')}</p>}
        {(error||a.error)&&<p className="agent-inline-error" role="alert">{t(error||friendlyConnectionError(a.error??''))}</p>}
        <details className="agent-details-v6"><summary>{t('更多按键选项')}</summary>
          <div className="agent-expanded-content-v6">
          <label className="agent-option-v6"><span>{t('关闭模式后')}</span><select aria-label={t('关闭模式后的功能')} disabled={busy} value={state?.settings.codexKeycapFallback?'keycaps':'device'} onChange={e=>{const value=e.target.value==='keycaps';if(lock.current)return;lock.current=true;setBusy(true);setError('');void command({op:'settings',settings:{codexKeycapFallback:value}},{silent:true}).catch(failure=>setError(failure instanceof Error?failure.message:'未能确认保存结果，请重新检查。')).finally(()=>{lock.current=false;setBusy(false);});}}><option value="device">{t('键盘当前配置')}</option><option value="keycaps">{t('键帽上的原厂功能')}</option></select></label>
          <p>{t('键帽功能兼容用于 F13–F24 扩展层，需要保持 NuPhy Lab 运行；退出应用后使用键盘自身配置。')}</p>
          {!!a.shared?.length&&<p>{t('媒体键转换也会作用于本键盘上执行相同功能的按键或旋钮；关闭适配即可恢复。')}</p>}
          </div>
        </details>
      </div>
    </Modal>}
  </>;
}
