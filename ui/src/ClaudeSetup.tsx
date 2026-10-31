import {useEffect,useRef,useState} from 'react';
import {Check,CircleAlert,Plug,Trash2} from 'lucide-react';
import {Button,Modal} from './primitives';
import {readAppState} from './api';
import {t as tr} from './i18n';
import type {AppState,Command} from './types';

type Hooks={status?:string;installed?:boolean;reason?:string|null;settingsPath?:string;hookDir?:string;spoolDir?:string;events?:string[];missing?:string[];outdated?:string[];otherHooks?:number;scripts?:boolean;disabled?:boolean};
/** Install, repair and remove only the hooks owned by NuPhy Lab. */
export function ClaudeSetup({state,command}:{state:AppState|null;command:Command}) {
  const [open,setOpen]=useState(false),[operation,setOperation]=useState(''),[confirmRemove,setConfirmRemove]=useState(false);
  const [note,setNote]=useState(''),[error,setError]=useState(''),[removed,setRemoved]=useState(false);
  const trigger=useRef<HTMLElement|null>(null);
  const lock=useRef(false),[observed,setObserved]=useState<Hooks|null>(null);
  const hooks=observed??(state?.claude?.hooks??{}) as Hooks,status=String(hooks.status??'unknown'),installed=hooks.installed===true,busy=Boolean(operation);
  useEffect(()=>{setObserved(null);},[state?.claude?.hooks]);
  const summary=operation==='claudeHookRemove'?'正在移除本应用的接入…':operation==='claudeHookInstall'?(installed||status==='needsRepair'?'正在修复本应用的接入配置…':'正在备份并合并本应用的钩子配置…'):removed?'NuPhy Lab 接入已移除。':status==='unknown'?'正在检查 Claude Code 接入…':installed?'已接入本机 Claude Code。':status==='needsRepair'?(hooks.outdated?.length?'接入配置指向旧的安装位置。':hooks.scripts===false?'钩子脚本缺失，需要修复接入。':'接入需要修复。'):status==='disabled'?'Claude Code 已停用全部钩子。':status==='error'?'无法读取 Claude Code 配置。':'尚未接入本机 Claude Code。';
  const close=()=>{if(lock.current)return;setOpen(false);setConfirmRemove(false);};
  const act=async(op:string)=>{
    if(lock.current)return;lock.current=true;setOperation(op);setNote('');setError('');
    try{
      const result=await command({op},{silent:true}) as Hooks;
      let next=result;
      try{next=(await readAppState()).claude?.hooks as Hooks??result;}catch{/* successful operation result remains authoritative */}
      setObserved(next);
      if(op==='claudeHookRemove'){setRemoved(true);setConfirmRemove(false);setNote('本应用的钩子、脚本及本机会话状态已移除。其他设置保持不变。');}
      else if(op==='claudeHookStatus'){setNote('已重新检查接入状态。');}
      else{setRemoved(false);setNote(next.installed?'接入已配置，等待 Claude Code 会话活动。':'已写入配置，请检查接入状态与 Claude Code 的钩子开关。');}
    }catch(failure){
      let next:Hooks|null=null;try{next=(await readAppState()).claude?.hooks as Hooks;setObserved(next);}catch{/* outcome unknown */}
      setError(op==='claudeHookRemove'?'未能确认移除结果，请重新检查。':next?.installed?'接入配置已写入，键盘同步尚未完成。请重新检查。':failure instanceof Error?failure.message:'未能完成接入，原配置读取结果已保留。');
    }finally{lock.current=false;setOperation('');}
  };
  const row=(label:string,ok:boolean,detail:string)=><div className="agent-setup-row-v6">{ok?<Check size={16} strokeWidth={1.5}/>:<CircleAlert size={16} strokeWidth={1.5}/>}<div><strong>{tr(label)}</strong><p>{tr(detail)}</p></div>{ok&&<span className="agent-row-ready">{tr('已完成')}</span>}</div>;
  return <>
    <section className="codex-setup-banner" aria-label={tr('Claude Code 接入')}>
      {installed?<Check size={19}/>:<Plug size={19}/>}<div><strong>{tr('本机接入')}</strong><p className={`agent-live-status ${installed?'connected':''}`}><i/>{tr(installed?'Claude Code 已接入':status==='unknown'?'正在检查接入…':status==='needsRepair'?'接入需要修复':status==='disabled'?'Claude Code 已停用全部钩子':status==='error'?'无法读取 Claude Code 配置':'尚未接入 Claude Code')}</p></div>
      <Button busy={busy} kind={installed?'secondary':'primary'} onClick={()=>{trigger.current=document.activeElement as HTMLElement;setOpen(true);setError('');setConfirmRemove(false);}}>{tr(installed?'接入详情':status==='needsRepair'?'修复接入':'安装接入')}</Button>
    </section>
    {open&&<Modal key={confirmRemove?'remove':'details'} returnFocus={trigger.current} title={tr('Claude Code 接入')} width={560} className="agent-overlay-v6" busy={busy} initialFocus={confirmRemove?'cancel':'title'} onClose={close} footer={confirmRemove?<><Button kind="ghost" disabled={busy} onClick={()=>{setConfirmRemove(false);setError('');}}>{tr('取消')}</Button><Button kind="danger" busy={busy} onClick={()=>{void act('claudeHookRemove');}}>{tr('确认移除')}</Button></>:<>{installed&&<Button kind="ghost" icon={<Trash2 size={14}/>} disabled={busy} onClick={()=>{setConfirmRemove(true);setError('');}}>{tr('移除接入')}</Button>}<Button kind="ghost" disabled={busy} onClick={close}>{tr('完成')}</Button><Button kind="primary" busy={busy} onClick={()=>{void act(status==='unknown'||status==='error'||status==='disabled'?'claudeHookStatus':'claudeHookInstall');}}>{tr(status==='unknown'||status==='error'||status==='disabled'?'重新检查':installed?'重新安装':status==='needsRepair'?'修复接入':'安装接入')}</Button></>}>
      <div className="agent-setup-content-v6">
        {confirmRemove?<><p className="agent-overlay-intro">{tr(operation==='claudeHookRemove'?'正在移除本应用的接入…':'移除 NuPhy Lab 添加的 Claude Code 接入？')}</p><p>{tr('将移除 NuPhy Lab 添加的钩子，并清理本应用保存的本机会话状态文件。其他钩子与 Claude Code 设置会保留。')}</p><p className="agent-overlay-hint">{tr('移除后，新的会话状态将不再显示到键盘。')}</p></>:<><p className="agent-overlay-intro" role="status">{tr(summary)}</p>
          {!removed&&<><p className="agent-overlay-hint">{tr('安装前备份原配置，只合并本应用需要的条目。其他钩子和设置保持不变。')}</p>
          {row('钩子配置',installed,installed?'11 个生命周期事件已注册。':status==='needsRepair'?`缺少 ${hooks.missing?.length??0} 项，${hooks.outdated?.length??0} 项指向旧位置。`:status==='unknown'?'正在检查…':'尚未完成接入。')}
          {row('钩子脚本',hooks.scripts===true,hooks.scripts===false?'脚本文件缺失，请修复。':hooks.scripts?'安装到 NuPhy Lab 数据目录的固定路径。':'正在检查脚本状态。')}
          {row('其他钩子',status!=='unknown'&&status!=='error',`配置中另有 ${hooks.otherHooks??0} 个非本应用的钩子，安装与移除都不会改动它们。`)}
          </>}
          {note&&<p className="agent-overlay-notice" role="status">{tr(note)}</p>}
          {installed&&<p className="agent-overlay-hint">{tr('已打开的会话在下一次活动时开始上报，不补发历史状态。需要立即看到状态请新开一个会话。')}</p>}
          {hooks.disabled&&<p className="agent-inline-error" role="alert">{tr('请在 Claude Code 设置中把 disableAllHooks 改回 false；NuPhy Lab 不会代为修改此开关。')}</p>}
          {status==='error'&&hooks.reason&&<p className="agent-inline-error" role="alert">{tr(hooks.reason)}</p>}
          {!removed&&<details className="agent-details-v6"><summary>{tr('接入说明')}</summary>
            <div className="agent-expanded-content-v6">
            <p>{tr('配置文件：')}<code>{hooks.settingsPath??'—'}</code></p><p>{tr('钩子脚本：')}<code>{hooks.hookDir??'—'}</code></p><p>{tr('状态文件：')}<code>{hooks.spoolDir??'—'}</code></p><p>{tr('记录的事件：')}{(hooks.events??[]).join(' · ')||'—'}</p>
            <p>{tr('只记录会话标识、项目路径、进程号、时间和状态；不记录提示词、工具输入、对话正文或账号凭据。')}</p><p>{tr('钩子只在本机记录状态，不会调用模型，也不会改变 Claude Code 的权限判断。')}</p><p>{tr('已经打开的会话会在下一次活动时开始上报，但不会补发之前的状态；需要立即看到状态请新开一个会话。')}</p>
            </div>
          </details>}
        </>}
        {error&&<p className="agent-inline-error" role="alert">{tr(error)}</p>}
      </div>
    </Modal>}
  </>;
}
