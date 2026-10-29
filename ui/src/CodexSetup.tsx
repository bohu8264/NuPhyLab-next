import {useEffect,useState} from 'react';
import {Check,CircleAlert,Keyboard,ArrowUpRight} from 'lucide-react';
import {Button,Modal,run} from './primitives';
import {t} from './i18n';
import {refreshAppPermissions,requestAppPermission,showFirmwareGuide,useStartupCopy} from './StartupGuide';
import {friendlyConnectionError,keyRecoveryProblem} from './KeyRecoveryPanel';
import type {AppState,Command} from './types';

type Adaptation={status?:string;ready?:string[];unsupported?:string[];shared?:string[];mapped?:number;error?:string};
export function CodexSetup({state,command,source='codex'}:{state:AppState|null;command:Command;source?:'codex'|'claude'}){
  const copy=useStartupCopy(),connectionIssue=keyRecoveryProblem(state);
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false);
  const enabled=state?.settings.codexKeyAdaptation===true,a=(state?.codex.adaptation??{}) as Adaptation;
  const host=(state?.codex.keys as {host?:{registered:string[];failed:string[];suspended:boolean}}|undefined)?.host;
  const permissions=state?.native??{},input=permissions.inputMonitoring===true,access=permissions.accessibility===true&&permissions.canPostEvents===true;
  const wireless=state?.bluetooth?.connected===true&&!state?.device.connected,connected=state?.device.connected===true||wireless;
  const firmwareUpdate=state?.firmware?.upgradeRecommended===true;
  const registered=host?.registered.length===12&&host.failed.length===0;
  const complete=!connectionIssue&&enabled&&a.status==='ready'&&registered&&host?.suspended!==true&&input&&access;
  const title=firmwareUpdate?copy('请更新键盘固件','Update keyboard firmware'):!connected?copy('等待连接键盘','Connect your keyboard'):!input||!access?copy('完成授权后即可使用','Allow permissions to continue'):connectionIssue?copy('正在连接键盘','Connecting to your keyboard'):complete?copy('功能键已就绪','Function keys are ready'):enabled?copy('正在设置功能键','Setting up function keys'):copy(source==='claude'?'让功能键控制 Claude Code':'让功能键控制 Codex',source==='claude'?'Use function keys with Claude Code':'Use function keys with Codex');
  const act=async(op:string)=>{setBusy(true);try{await command({op,source});}finally{setBusy(false);}};
  const begin=()=>{if(firmwareUpdate){showFirmwareGuide();return;}setOpen(true);if(!connectionIssue)run(act('codexAdapt'));};
  const check=()=>{if(firmwareUpdate){setOpen(false);showFirmwareGuide();return;}run(act(connectionIssue||!connected?'connect':enabled?'codexAdaptCheck':'codexAdapt'));};
  useEffect(()=>{if(!open)return;const refresh=()=>{void refreshAppPermissions(command).catch(()=>{});};window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[open,command]);
  const row=(label:string,ok:boolean,detail:string,action?:React.ReactNode)=><div className="codex-setup-row">{ok?<Check size={17}/>:<CircleAlert size={17}/>}<div><strong>{t(label)}</strong><p>{t(detail)}</p></div>{action}</div>;
  if(complete&&!open)return null;
  return <>
    <section className="codex-setup-banner" aria-label={t('键盘设置')}>
      <Keyboard size={19}/><div><strong>{t(title)}</strong><p>{copy(firmwareUpdate?'前往 NuPhyIO 安装最新固件后即可使用。':wireless?'任务键和命令键可用，灯光请使用 USB 连接。':complete?'设置已保存，下次连接可直接使用。':connectionIssue?'请关闭其他键盘设置程序，重新连接键盘。':'连接并完成 macOS 授权后会自动设置。',firmwareUpdate?'Install the latest firmware in NuPhyIO to continue.':wireless?'Task and command keys are available. Connect USB to use lighting.':complete?'Your settings are saved for the next connection.':connectionIssue?'Close other keyboard apps and reconnect your keyboard.':'Connect your keyboard and allow macOS permissions to finish setup.')}</p></div>
      <Button busy={busy} onClick={firmwareUpdate?showFirmwareGuide:enabled?()=>setOpen(true):begin}>{copy(firmwareUpdate?'前往更新':enabled?'按键设置':'启用功能键',firmwareUpdate?'Update firmware':enabled?'Key settings':'Enable function keys')}</Button>
    </section>
    {open&&<Modal title={copy('键盘设置','Keyboard settings')} onClose={()=>setOpen(false)}>
      <div className="codex-setup-dialog">
        {row('键盘连接',connected,wireless?'Air75 V3 蓝牙已连接':connected?`${state?.device.model?.replace(/ ANSI$/,'')||'键盘'} 已连接`:'请使用 USB 数据线连接键盘。',!connected&&<Button busy={busy} onClick={()=>run(act('connect'))}>{t('连接键盘')}</Button>)}
        {row('输入监控',input,input?'已允许':'接收功能键和按键灯效。',!input&&<Button onClick={()=>run(requestAppPermission(command,'inputMonitoring'))}>{t('允许')}</Button>)}
        {row('辅助功能',access,access?'已允许':'执行快捷操作。',!access&&<Button onClick={()=>run(requestAppPermission(command,'accessibility'))}>{t('允许')}</Button>)}
        {firmwareUpdate?row(copy('键盘固件','Keyboard firmware'),false,copy('请前往 NuPhyIO 安装最新固件。','Install the latest firmware in NuPhyIO.'),<Button icon={<ArrowUpRight size={14}/>} onClick={()=>{setOpen(false);showFirmwareGuide();}}>{copy('前往更新','Update firmware')}</Button>):row(copy('功能键','Function keys'),complete,copy(complete?'F1–F12 已就绪。':connectionIssue?'请关闭其他键盘设置程序，再重新连接键盘。':host?.suspended?'编辑或游戏期间暂时暂停。':'连接并授权后自动设置。',complete?'F1–F12 are ready.':connectionIssue?'Close other keyboard apps, then reconnect your keyboard.':host?.suspended?'Temporarily paused while editing or playing a game.':'Setup continues after connecting and allowing permissions.'))}
        {wireless&&<p className="muted">{t('如果按键仍在调节亮度或音量，请使用标准 F 键的 Fn 组合，或更改绑定。')}</p>}
        {a.error&&!firmwareUpdate&&<p className="codex-key-warning" role="alert">{t(friendlyConnectionError(a.error))}</p>}
        <details className="product-details"><summary>{t('更多按键选项')}</summary>
          <label>{t('关闭模式后')} <select aria-label={t('关闭模式后的功能')} value={state?.settings.codexKeycapFallback?'keycaps':'device'} onChange={e=>run(command({op:'settings',settings:{codexKeycapFallback:e.target.value==='keycaps'}}))}><option value="device">{t('键盘当前配置')}</option><option value="keycaps">{t('键帽上的原厂功能')}</option></select></label>
          <p>{t('键帽功能兼容用于 F13–F24 扩展层，需要保持 NuPhy Lab 运行；退出应用后使用键盘自身配置。')}</p>
          {!!a.shared?.length&&<p>{t('媒体键转换也会作用于本键盘上执行相同功能的按键或旋钮；关闭适配即可恢复。')}</p>}
        </details>
        <div className="codex-setup-actions"><Button kind="ghost" onClick={()=>setOpen(false)}>{t('完成')}</Button>{!complete&&<Button kind="primary" busy={busy} onClick={check}>{copy(firmwareUpdate?'前往更新':connectionIssue||!connected?'重新连接':'重新检查',firmwareUpdate?'Update firmware':connectionIssue||!connected?'Reconnect':'Check again')}</Button>}</div>
      </div>
    </Modal>}
  </>;
}
