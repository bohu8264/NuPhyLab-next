import {useEffect,useRef,useState} from 'react';
import {ChevronRight,Info,RefreshCw} from 'lucide-react';
import {STATUS_NAMES} from '../../shared/codex-lighting.mjs';
import {CLAUDE_STATUS_NAMES} from '../../shared/claude-lighting.mjs';
import {codexBindings,rebindCodexKey,CODEX_KEYS} from '../../shared/codex-keys.mjs';
import {claudeBindings,rebindClaudeKey} from '../../shared/claude-keys.mjs';
import {AgentTabs,type AgentTab} from './AgentTabs';
import {AgentQuota} from './AgentQuota';
import type {AgentSource} from './AgentSourceSwitch';
import {CodexLightMode} from './CodexLightMode';
import {ClaudeLightMode} from './ClaudeLightMode';
import {CodexSetup} from './CodexSetup';
import {FunctionKeyRecoveryDialog} from './FunctionKeyRecoveryDialog';
import {ClaudeSetup} from './ClaudeSetup';
import {CodexKeyRecorder,useAgentKeyCapture} from './CodexKeyRecorder';
import {readAppState} from './api';
import './agent-overlays-v6.css';
import {Button,Modal,Switch,run} from './primitives';
import {t} from './i18n';
import type {AppState,Command,Task} from './types';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};
const taskId=(task:Task)=>String(task.id??task.threadId??'');
const statusClass=(status:string)=>['running','working','thinking','in_progress'].includes(status)?'running':['needsInput','awaitingApproval','approval','waiting'].includes(status)?'waiting':['completed','awaitingInput','complete'].includes(status)?'complete':['error','failed'].includes(status)?'error':'idle';
const defaultCommandIds=['modelPicker','newTask','dictation','voice','toggleTerminal','settings'];
type CommandDraft={ids:string[];keys:string[];baseIds:string[];baseKeys:string[];edits:{index:number;code:string}[]};
const CODE_LABEL=(code:string)=>CODEX_KEYS.find(key=>key.code===code)?.label??code;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const commandShortLabels:Record<string,string>={modelPicker:'模型',newTask:'新任务',dictation:'听写',voice:'语音',toggleTerminal:'终端',settings:'设置'};
function initialTab(focus?:boolean):AgentTab {
  if(focus)return 'lights';
  const value=sessionStorage.getItem('nuphylab-agent-tab');
  return value==='lights'||value==='setup'?value:'tasks';
}
export function AgentDashboard({source,state,command,focusColors,readState=readAppState,serviceError=''}:{source:AgentSource;state:AppState|null;command:Command;focusColors?:boolean;readState?:()=>Promise<AppState>;serviceError?:string}) {
  const [tab,setTab]=useState<AgentTab>(()=>initialTab(focusColors));
  const [recording,setRecording]=useState<{group:'task'|'command';index:number;keys:string[]}|null>(null);
  const [commandDraft,setCommandDraft]=useState<CommandDraft|null>(null),[allOperations,setAllOperations]=useState(false),[search,setSearch]=useState('');
  const [editorBusy,setEditorBusy]=useState(false),[editorError,setEditorError]=useState(''),[savedPending,setSavedPending]=useState(false);
  const [feedback,setFeedback]=useState(''),[operationBusy,setOperationBusy]=useState('');
  const [modeBusy,setModeBusy]=useState(false),[modeError,setModeError]=useState('');
  const [recoveryOpen,setRecoveryOpen]=useState(false);
  const editorLock=useRef(false),operationLock=useRef<symbol|null>(null),editorScroll=useRef<HTMLDivElement>(null),scrollTop=useRef(0);
  const modeLock=useRef<symbol|null>(null);
  const modeRetry=useRef<boolean|null>(null);
  const recoveryTrigger=useRef<HTMLElement|null>(null);
  const editorTrigger=useRef<HTMLElement|null>(null),returnKey=useRef<number|null>(null);
  const notify=(message:string)=>window.dispatchEvent(new CustomEvent('nuphylab:notify',{detail:{message,kind:'success'}}));
  const capture=useAgentKeyCapture(Boolean(commandDraft)&&!savedPending,command);
  const context=`${source}:${state?.device.modelId??''}:${state?.device.connectionSessionId??''}`;
  const operationContext=useRef({key:context});
  if(operationContext.current.key!==context)operationContext.current={key:context};
  useEffect(()=>{setCommandDraft(null);setRecording(null);setEditorError('');setSavedPending(false);setAllOperations(false);setFeedback('');setOperationBusy('');operationLock.current=null;setModeBusy(false);setModeError('');modeLock.current=null;modeRetry.current=null;setRecoveryOpen(false);},[context]);
  useEffect(()=>()=>{operationContext.current={key:operationContext.current.key};operationLock.current=null;modeLock.current=null;modeRetry.current=null;},[]);
  useEffect(()=>{if(!commandDraft||recording)return;const body=editorScroll.current?.closest<HTMLElement>('.modal-body');if(body)body.scrollTop=scrollTop.current;if(returnKey.current!==null){const index=returnKey.current;returnKey.current=null;requestAnimationFrame(()=>document.querySelector<HTMLElement>(`[data-command-index="${index}"]`)?.focus());}},[Boolean(recording),Boolean(commandDraft)]);
  useEffect(()=>{if(focusColors)setTab('lights');},[focusColors]);
  const changeTab=(value:AgentTab)=>{setTab(value);sessionStorage.setItem('nuphylab-agent-tab',value);};
  const claude=source==='claude',name=claude?'Claude Code':'Codex';
  const settings:Record<string,unknown>=state?.settings??{};
  const integration=claude?state?.claude:state?.codex,tasks=integration?.tasks??[];
  const slots=(integration?.slots??[]).map(item=>item&&typeof item==='object'?item as Task:null);
  const bindings=claude?claudeBindings(settings):codexBindings(settings);
  const bound=(claude?settings.claudeSlotIds:settings.slotIds) as string[]|undefined;
  const taskSource=String(settings[`${source}TaskSource`]??'recent');
  const activeSource=settings.agentSource==='claude'?'claude':'codex';
  const enabled=activeSource===source&&settings[`${source}Enabled`]===true;
  useEffect(()=>{if(enabled||state?.device.connected!==true)setRecoveryOpen(false);},[enabled,state?.device.connected]);
  const lighting=object(integration?.lighting),keys=object(integration?.keys??state?.codex.keys);
  const dictation=object(keys.dictation),dictationError=!claude&&typeof dictation.error==='string'?dictation.error:'';
  const releasingDictation=(id:string)=>!claude&&id==='dictation'&&Boolean(keys.held);
  const host=object(keys.host),failedKeys=Array.isArray(host.failed)?host.failed as string[]:[];
  const native=object(state?.native),permissions=object(native.permissions??state?.native??state?.device.permissions);
  const canSend=permissions.accessibility===true&&permissions.canPostEvents===true;
  const commandIds=(settings[`${source}CommandIds`]??(claude?['nextAttention','focusApp','revealProject','copyResume','toggleLightMode','refresh']:defaultCommandIds)) as string[];
  const commands=claude?(state?.claude?.commands??[]):(state?.codex.shortcuts??[]).map(item=>({...item,id:String(item.id??item.action??'')}));
  const currentSource=object(integration?.taskSource),adaptation=object(state?.codex.adaptation),restoreError=object(state?.codex.adaptation).status==='error'&&!enabled&&activeSource===source;
  const recovery=state?.device.keyRecovery;
  const recoveryUnconfirmed=!enabled&&activeSource===source&&(recovery?.pending===true||state?.device.functionKeyRecoveryPending===true);
  const ordinaryKeys=bindings.filter(binding=>!/^F([1-9]|1[0-2])$/.test(binding.code));
  const set=(patch:Record<string,unknown>)=>run(command({op:'settings',settings:patch}));
  const openTask=(task:Task)=>runAction('task',task);
  const execute=(id:string)=>runAction(id);
  const statusLabel=(task:Task|null)=>task?(claude?CLAUDE_STATUS_NAMES[String(task.status)]??t('状态未确认'):task.pendingKind==='approval'?t('等待批准'):STATUS_NAMES[String(task.status)]??t('状态未确认')):t('未绑定');
  const sources=claude?[['recent','最近会话'],['active','仅进行中'],['attention','需要关注优先'],['custom','自定义会话']]:[['recent','最近任务'],['pinned','固定任务'],['priority','优先任务'],['custom','自定义任务']];
  const refresh=()=>{void runAction('refreshState');};
  const integrationReady=integration?.available&&currentSource.available!==false;
  const currentTask=tasks.find(task=>taskId(task)===lighting.selectedId)??slots.find(Boolean)??null;
  const keyPatch=(all:string[])=>({[`${source}TaskKeys`]:all.slice(0,6),[`${source}CommandKeys`]:all.slice(6)});
  const allKeys=(value:Record<string,unknown>)=>(claude?claudeBindings(value):codexBindings(value)).map(item=>item.code);
  const idsFrom=(value:Record<string,unknown>)=>(value[`${source}CommandIds`]??commandIds) as string[];
  const rebind=(all:string[],index:number,code:string)=>allKeys((claude?rebindClaudeKey:rebindCodexKey)(keyPatch(all),'command',index,code));
  const closeEditor=()=>{if(editorLock.current)return;setCommandDraft(null);setRecording(null);setEditorError('');setSavedPending(false);scrollTop.current=0;};
  const openEditor=()=>{if(!state)return;editorTrigger.current=document.activeElement as HTMLElement;returnKey.current=null;const next=allKeys(settings);setEditorError('');setSavedPending(false);setCommandDraft({ids:[...commandIds],keys:next,baseIds:[...commandIds],baseKeys:next,edits:[]});};
  const changeMode=async(value:boolean)=>{
    if(modeLock.current||!state||serviceError)return;
    const request=Symbol('agentMode'),startedContext=operationContext.current;
    modeLock.current=request;modeRetry.current=value;setModeBusy(true);setModeError('');
    try{await command({op:'agentMode',source,enabled:value},{silent:true});}
    catch(error){if(operationContext.current===startedContext&&modeLock.current===request)setModeError(error instanceof Error?error.message:'模式状态暂未确认，请重新检查。');}
    finally{if(operationContext.current===startedContext&&modeLock.current===request){modeLock.current=null;setModeBusy(false);}}
  };
  async function runAction(id:string,task?:Task){
    if(operationLock.current)return;
    const operation=Symbol(id),startedContext=operationContext.current;
    operationLock.current=operation;setOperationBusy(id);setFeedback('');
    try{await command(id==='refreshState'?{op:claude?'refreshClaude':'refreshCodex'}:claude?{op:'claudeAction',action:id,...(task?{sessionId:taskId(task)}:{})}:{op:'codexAction',action:id,...(task?{threadId:taskId(task)}:{}),...(id==='dictation'?{phase:keys.held?'up':'down',source:keys.held?String(object(keys.held).source):'button'}:{})},{silent:true});}
    catch(error){if(operationContext.current===startedContext&&operationLock.current===operation)setFeedback(error instanceof Error?error.message:'操作未完成，请重新检查。');}
    finally{if(operationContext.current===startedContext&&operationLock.current===operation){operationLock.current=null;setOperationBusy('');}}
  }
  const operationUnavailable=(item:{id:string;available?:boolean})=>!releasingDictation(item.id)&&(item.available===false||Boolean(!claude&&item.id==='dictation'&&dictationError));
  const operationReason=(item:{id:string;available?:boolean;reason?:string})=>{
    if(releasingDictation(item.id))return '结束听写';
    if(!claude&&item.id==='dictation'&&dictationError)return dictationError;
    if(item.available===false)return item.reason??'当前版本尚不支持此操作。';
    if(!claude)return canSend?'需 Codex 已打开及辅助功能权限；还取决于当前页面。':'需要辅助功能权限，才能发送此快捷操作。';
    if(['focusApp','openSession'].includes(item.id)&&object(state?.claude?.app).installed===false)return '未找到 Claude 桌面应用，会话状态仍可读取。';
    if(item.id==='openSession'&&currentTask&&!/^local_[A-Za-z0-9-]{1,64}$/.test(String(currentTask.desktopId??'')))return '此会话无法在桌面应用中定位，可打开项目或复制恢复命令。';
    if(item.id==='focusApp'&&currentTask?.entrypoint&&currentTask.entrypoint!=='claude-desktop')return '此会话运行在终端里，可打开项目或复制恢复命令。';
    if(['openSession','focusApp','revealProject','copyResume'].includes(item.id)&&!currentTask)return '请先选择一个会话。';
    if(item.id==='revealProject'&&!currentTask?.cwd)return '此会话还没有有效项目路径。';
    return ({openSession:'桌面会话可定位，终端会话可使用恢复命令。',nextAttention:'选择需要关注的本机会话。',nextTask:'选择下一个本机会话。',prevTask:'选择上一个本机会话。',focusApp:'需要这台 Mac 已安装 Claude 桌面应用。',revealProject:'打开当前会话的项目文件夹。',copyResume:'复制当前会话的恢复命令。',toggleLightMode:'切换本套 AI 的状态灯显示模式。',wakeLights:'唤醒本套 AI 状态灯；灯光输出需 USB 连接。',refresh:'刷新本机会话状态，不要求 Claude 桌面应用。',none:'不执行任何操作。'} as Record<string,string>)[item.id]??'可用性依赖当前会话与应用状态。';
  };
  const operationDisabled=(item:{id:string;available?:boolean})=>operationUnavailable(item)||(!releasingDictation(item.id)&&!claude&&!canSend)||Boolean(operationBusy);
  const saveEditor=async()=>{
    if(!commandDraft||editorLock.current||savedPending)return;
    editorLock.current=true;setEditorBusy(true);setEditorError('');
    let patch:Record<string,unknown>|null=null;
    try{
      const fresh=await readState(),freshKeys=allKeys(fresh.settings),freshIds=idsFrom(fresh.settings);
      if(!same(freshKeys,commandDraft.baseKeys)||!same(freshIds,commandDraft.baseIds)){
        const rebased=commandDraft.edits.reduce((all,edit)=>rebind(all,edit.index,edit.code),freshKeys);
        setCommandDraft({...commandDraft,keys:rebased,baseKeys:freshKeys,baseIds:[...freshIds],ids:commandDraft.ids.map((id,i)=>id===commandDraft.baseIds[i]?freshIds[i]:id)});
        setEditorError('绑定或命令已在其他位置变化。已重新核对下面的修改，请确认交换关系后再次保存。');return;
      }
      patch={[`${source}CommandIds`]:commandDraft.ids,...(!same(commandDraft.keys,commandDraft.baseKeys)?keyPatch(commandDraft.keys):{})};
      await command({op:'settings',settings:patch},{silent:true});
      await capture.release();
      setCommandDraft(null);setRecording(null);scrollTop.current=0;notify('命令设置已保存');
    }catch(error){
      let stored=false;
      if(patch)try{const fresh=await readState();stored=Object.entries(patch).every(([key,value])=>same(fresh.settings[key],value));}catch{/* unknown result retains the draft */}
      if(stored){setSavedPending(true);setEditorError('设置已保存，键盘同步结果尚未确认。请重新检查；已保存的修改不会因关闭而撤销。');}
      else setEditorError(patch?'未能确认保存结果。已保留本次命令草稿，请重新检查后重试。':error instanceof Error?error.message:'无法读取当前设置，请重试。');
    }finally{editorLock.current=false;setEditorBusy(false);}
  };
  const saveRecorded=async(code:string)=>{
    if(!recording)return;
    if(commandDraft){setCommandDraft({...commandDraft,keys:rebind(commandDraft.keys,recording.index,code),edits:[...commandDraft.edits,{index:recording.index,code}]});return;}
    const fresh=await readState(),freshKeys=allKeys(fresh.settings);
    if(!same(freshKeys,recording.keys)){setRecording({...recording,keys:freshKeys});throw new Error('按键绑定已变化。已重新显示交换关系，请确认后再次保存。');}
    const patch=(claude?rebindClaudeKey:rebindCodexKey)(fresh.settings,recording.group,recording.index,code);
    try{await command({op:'settings',settings:patch},{silent:true});}
    catch(error){let stored=false;try{const next=await readState();stored=Object.entries(patch).every(([key,value])=>same(next.settings[key],value));}catch{/* unknown */}
      if(stored){setFeedback('按键已保存，键盘同步尚未完成。请在接入设置中重新检查。');return;}
      throw new Error('未能确认保存结果。已保留候选按键，请重新检查后重试。');
    }
  };
  const initialLoading=!state||(!currentSource.updatedAt&&String(currentSource.reason??'').includes('尚未读取'));
  const hookState=object(state?.claude?.hooks),dataUnavailable=currentSource.available===false;
  const emptySlots=!slots.some(Boolean);
  const statusMessage=initialLoading?'正在读取任务状态…':serviceError?'本地服务暂未响应，正在重新连接。':claude&&hookState.status==='unknown'?'正在检查 Claude Code 接入…':claude&&hookState.installed===false?'需要完成 Claude Code 接入才能确认状态。':claude&&currentSource.spoolReadable===false?'会话事件暂不可读，稍后自动重试。':dataUnavailable?'任务状态暂不可读，保留原有绑定并自动重试。':tasks.length===0?(claude?'本机当前没有可显示的 Claude Code 会话。':'先在 Codex 中打开或创建一个聊天，再刷新状态。'):emptySlots?'此来源下暂无任务。':'';
  const matchingCommands=commands.filter(item=>`${t(item.label)} ${t(operationReason(item))}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="agent-v5">
    <AgentTabs tab={tab} onChange={changeTab} state={state} command={command} sourceDisabled={modeBusy||Boolean(serviceError)}/>
    <section className="agent-shortcut-toggle agent-mode-control" aria-label={t(claude?'Claude Code 模式':'Codex 模式')} aria-busy={modeBusy||undefined}>
      <div><h2>{t(claude?'Claude Code 模式':'Codex 模式')}</h2><p>{t('开启后，对话键显示状态并控制对应对话；关闭后恢复普通按键。')}</p>{!state?.device.connected&&state?.bluetooth?.connected&&<p>{t('实时灯光需要 USB 连接。')}</p>}{modeBusy&&<p role="status">{t('正在切换模式…')}</p>}</div>
      <Switch label={t(claude?'Claude Code 模式':'Codex 模式')} checked={enabled} disabled={!state||Boolean(serviceError)||modeBusy||(state.device.capabilities?.perKey===false&&!enabled)} onChange={value=>{void changeMode(value);}}/>
    </section>
    {modeError&&<div className="agent-feedback-v6" role="alert"><p>{t(modeError)}</p><Button kind="ghost" busy={modeBusy} onClick={()=>{if(modeRetry.current!==null)void changeMode(modeRetry.current);}}>{t(modeRetry.current?'重试开启模式':'重试关闭模式')}</Button></div>}
    {recoveryUnconfirmed&&<div className="agent-feedback-v6 agent-mode-recovery" role="status"><p>{t('模式已关闭，部分按键的原功能尚未确认。请确认当前连接的是原来那把键盘，再检查并恢复。')}</p><div><Button kind="secondary" disabled={modeBusy||Boolean(serviceError)||state?.device.connected!==true} onClick={event=>{recoveryTrigger.current=event.currentTarget;setRecoveryOpen(true);}}>{t('检查并恢复按键')}</Button><Button kind="ghost" onClick={()=>window.dispatchEvent(new CustomEvent('nuphylab:navigate',{detail:'device'}))}>{t('查看设备')}</Button></div></div>}
    {restoreError&&!recoveryUnconfirmed&&<p className="agent-warning" role="alert">{t('原有按键尚未恢复，请重试。')}<Button kind="ghost" onClick={()=>run(command({op:'agentMode',source,enabled:false}))}>{t('重试恢复')}</Button></p>}
    {enabled&&adaptation.status==='error'&&<div className="agent-feedback-v6" role="alert"><p>{t('设置已保存，键盘同步尚未完成。请重新检查。')}</p><Button kind="ghost" onClick={()=>changeTab('setup')}>{t('接入设置')}</Button></div>}
    {enabled&&keys.enabled===false&&state?.device.connected&&['game','trigger'].includes(state.playback.mode)&&<p className="agent-note" role="status">{t(claude?'游戏与按键触发期间，Claude Code 快捷控制暂停。':'游戏与按键触发期间，Codex 快捷控制暂停。')}</p>}
    {enabled&&(keys.capturing===true||Boolean(commandDraft)||Boolean(recording))&&<p className="agent-note" role="status">{t('正在录入按键，快捷控制暂时暂停。')}</p>}
    {tab==='tasks'&&<section className="agent-tasks-page">
      <div className="agent-connection-row"><span className={`agent-live-status ${integrationReady?'connected':''}`}><i/>{t(integrationReady?`${name} 已接入`:claude?'尚未接入 Claude Code':'Codex 暂不可用')}</span><Button kind="ghost" onClick={()=>setAllOperations(true)}>{t('额度与全部操作')}</Button></div>
      {failedKeys.length>0&&<p className="agent-warning" role="alert">{t('这些按键被系统占用，请更换绑定：')}{failedKeys.map(code=>bindings.find(key=>key.code===code)?.label??code).join('、')}</p>}
      <div className="agent-task-heading"><h2>{t('任务键')}</h2><span>{t(taskSource==='custom'?'手动绑定任务':taskSource==='recent'?'按最近顺序自动分配':taskSource==='pinned'?'显示固定任务':taskSource==='active'?'仅显示进行中会话':'按关注程度自动分配')}</span><label>{t('任务列表')}<select aria-label={t(claude?'会话来源':'任务来源')} value={taskSource} onChange={e=>set({[`${source}TaskSource`]:e.target.value})}>{sources.map(([id,label])=><option key={id} value={id}>{t(label)}</option>)}</select></label></div>
      <div className="agent-task-table" role="table" aria-label={t('任务键')}><div className="agent-task-columns" role="row"><span role="columnheader">{t('按键')}</span><span role="columnheader">{t('绑定任务')}</span><span role="columnheader">{t('当前状态')}</span><span/></div>
        {Array.from({length:6},(_,index)=>{const task=slots[index]??null,selected=Boolean(task&&lighting.selectedId===taskId(task));return <div className="agent-task-row" role="row" key={index}>
          <div role="cell"><button className={`agent-key ${selected?'selected':''}`} aria-label={t(`打开任务 ${index+1}`)} aria-current={selected?'true':undefined} disabled={!task} onClick={()=>task&&openTask(task)}>{t(bindings[index].label)}</button></div>
          <div className="agent-task-name" role="cell">{taskSource==='custom'?<select aria-label={t(`绑定任务 ${index+1}`)} value={bound?.[index]??''} onChange={e=>{const next=Array.from({length:6},(_,i)=>bound?.[i]??'');const duplicate=e.target.value?next.indexOf(e.target.value):-1;if(duplicate>=0&&duplicate!==index)next[duplicate]=next[index];next[index]=e.target.value;set({[claude?'claudeSlotIds':'slotIds']:next});}}><option value="">{t('未绑定任务')}</option>{tasks.map(task=><option key={taskId(task)} value={taskId(task)}>{String(task.title??task.name??t('未命名任务'))}</option>)}{bound?.[index]&&!task&&<option value={bound[index]}>{t('已绑定任务（当前不可用）')}</option>}</select>:<button className={!task?'muted':''} disabled={!task} title={String(task?.title??task?.name??'')} translate="no" onClick={()=>task&&openTask(task)}>{String(task?.title??task?.name??t('未绑定任务'))}</button>}</div>
          <span role="cell" className={`agent-task-status ${task?statusClass(String(task.status)):'idle'}`} title={selected?t('控制中'):undefined}><i/>{t(statusLabel(task))}</span><div role="cell"><Button kind="ghost" aria-label={t(`更改任务键 ${index+1}`)} onClick={()=>setRecording({group:'task',index,keys:bindings.map(item=>item.code)})}>{t('更改按键')}</Button></div>
        </div>;})}</div>
      <div className="agent-command-heading"><h2>{t('命令键')}</h2><Button kind="ghost" disabled={!state} onClick={openEditor}>{t('编辑命令键')}</Button></div>
      <div className="agent-command-strip">{Array.from({length:6},(_,index)=>{const id=commandIds[index]??'none',item=commands.find(item=>item.id===id);return <button key={index} disabled={!item||operationDisabled(item)} title={releasingDictation(id)?t('结束听写'):item&&operationUnavailable(item)?t(operationReason(item)):!claude&&!canSend?t('需要辅助功能权限'):id==='dictation'?t(dictation.mode==='toggle'?'听写时按一次开始，再按一次结束。':'听写时按住对应按键，松开结束。'):t(item?.label??'未绑定')} onClick={()=>execute(id)}><kbd>{t(bindings[index+6].label)}</kbd><span>{t(releasingDictation(id)?'结束听写':(!claude&&commandShortLabels[id])||item?.label||'未绑定')}</span></button>;})}</div>
      {dictationError&&!keys.held&&commandIds.includes('dictation')&&<p className="agent-warning" role="status">{t('听写')}: {t(dictationError)}</p>}
      {ordinaryKeys.length>0&&<p className="agent-note">{t('这些绑定是普通按键，开启本模式时会被全局接管，期间无法用它们正常输入：')}{ordinaryKeys.map(key=>t(key.label)).join('、')}</p>}
      {statusMessage&&<div className="agent-feedback-v6" role="status"><p>{t(statusMessage)}</p>{Boolean(serviceError||dataUnavailable)&&<small>{t('保留上次内容与绑定；恢复读取后自动更新。')}</small>}<div>{claude&&hookState.installed===false?<Button kind="ghost" onClick={()=>changeTab('setup')}>{t('接入设置')}</Button>:<Button kind="ghost" busy={operationBusy==='refreshState'} onClick={refresh}>{t('刷新状态')}</Button>}{emptySlots&&tasks.length>0&&<Button kind="ghost" onClick={()=>document.querySelector<HTMLSelectElement>('.agent-task-heading select')?.focus()}>{t('选择其他来源')}</Button>}</div></div>}
      {(!permissions.inputMonitoring||!canSend)&&<div className="agent-feedback-v6"><p>{t('完成输入监控与辅助功能授权后即可使用全局快捷控制。')}</p><Button kind="ghost" onClick={()=>window.dispatchEvent(new CustomEvent('nuphylab:navigate',{detail:'permissions'}))}>{t('管理权限')}</Button></div>}
      {feedback&&<div className="agent-feedback-v6" role="alert"><p>{t(feedback)}</p><div><Button kind="ghost" onClick={refresh}>{t('重新检查')}</Button>{claude&&currentTask&&<><Button kind="ghost" disabled={!currentTask.cwd||Boolean(operationBusy)} onClick={()=>execute('revealProject')}>{t('打开项目')}</Button><Button kind="ghost" disabled={Boolean(operationBusy)} onClick={()=>execute('copyResume')}>{t('复制恢复命令')}</Button></>}</div></div>}

    </section>}
    {tab==='lights'&&(claude?<ClaudeLightMode state={state} command={command} focusColors={focusColors} serviceUnknown={Boolean(serviceError)} onSelectTasks={()=>setTab('tasks')} onSetup={()=>setTab('setup')}/>:<CodexLightMode state={state} command={command} focusColors={focusColors} serviceUnknown={Boolean(serviceError)} onSelectTasks={()=>setTab('tasks')} onSetup={()=>setTab('setup')}/>)}
    {tab==='setup'&&<div className="agent-setup-page"><section className="agent-setup-group">
      <CodexSetup state={state} command={command} source={source}/>
      <div className="agent-setup-setting"><div><h2>{t('关闭模式后')}</h2><p>{t('恢复按键使用的默认功能。')}</p></div><select aria-label={t('关闭模式后的功能')} value={settings.codexKeycapFallback?'keycaps':'device'} onChange={e=>set({codexKeycapFallback:e.target.value==='keycaps'})}><option value="device">{t('键盘当前配置')}</option><option value="keycaps">{t('键帽上的原厂功能')}</option></select></div>
      {claude?<ClaudeSetup state={state} command={command}/>:<div className="agent-setup-setting"><div><h2>{t('本机接入')}</h2><p className={`agent-live-status ${integrationReady?'connected':''}`}><i/>{t(integrationReady?'Codex 已接入':'Codex 暂不可用')}</p></div><Button kind="ghost" icon={<ChevronRight size={15}/>} onClick={()=>setAllOperations(true)}>{t('接入详情')}</Button></div>}
      <div className="agent-setup-setting"><div><h2>{t('按键与权限')}</h2><div className="agent-permission-status"><span className={permissions.inputMonitoring?'connected':''}><i/>{t(permissions.inputMonitoring?'输入监控已允许':'输入监控未允许')}</span><span className={canSend?'connected':''}><i/>{t(canSend?'辅助功能已允许':'辅助功能未允许')}</span></div></div><Button kind="ghost" icon={<ChevronRight size={15}/>} onClick={()=>window.dispatchEvent(new CustomEvent('nuphylab:navigate',{detail:'permissions'}))}>{t('管理权限')}</Button></div>
    </section><details className="agent-setup-details agent-setup-details-v6" data-source={source}><summary>{t('更多按键选项')}</summary><div className="agent-more-options-v6"><Button className="agent-reset-keys-v6" kind="secondary" icon={<RefreshCw size={14}/>} onClick={()=>set({[`${source}TaskKeys`]:['F1','F2','F3','F4','F5','F6'],[`${source}CommandKeys`]:['F7','F8','F9','F10','F11','F12']})}>{t('恢复默认按键')}</Button>
      {claude&&<label>{t('任务键跳转')}<select value={String(settings.claudeTaskAction??'openSession')} onChange={e=>set({claudeTaskAction:e.target.value})}>{[['openSession','打开对应会话'],['focusApp','切换到 Claude 应用'],['revealProject','打开项目文件夹'],['copyResume','复制恢复命令'],['selectOnly','仅选中会话']].map(([id,label])=><option key={id} value={id}>{t(label)}</option>)}</select></label>}
      <p>{t('恢复当前 AI 的任务键与命令键，不重置动作与颜色。')}</p>
      {claude&&object(state?.claude?.app).installed!==true&&<p>{t('这台电脑上没有找到 Claude 桌面应用，「切换到 Claude 应用」不可用。')}</p>}<p>{t('键帽功能兼容用于 F13–F24 扩展层，需要保持 NuPhy Lab 运行；退出应用后使用键盘自身配置。')}</p></div></details></div>}
    {recoveryOpen&&!enabled&&state?.device.connected&&<FunctionKeyRecoveryDialog state={state} command={command} serviceError={serviceError} returnFocus={recoveryTrigger.current} onClose={()=>setRecoveryOpen(false)}/>}
    {recording&&<CodexKeyRecorder key={`${source}:${recording.group}:${recording.index}`} title={t(recording.group==='task'?'更改任务键':'更改命令键')} command={command} source={source} group={recording.group} index={recording.index} draft={Boolean(commandDraft)} capture={commandDraft?capture:undefined} bindings={(commandDraft?.keys??recording.keys).map(code=>({code}))} onSave={saveRecorded} onClose={()=>{if(commandDraft)returnKey.current=recording.index;setRecording(null);}}/>}
    {commandDraft&&!recording&&<Modal title={t('编辑命令键')} width={560} className="agent-overlay-v6" busy={editorBusy} initialFocus="title" returnFocus={editorTrigger.current} onClose={closeEditor} footer={<><Button kind="ghost" onClick={closeEditor} disabled={editorBusy}>{t(savedPending?'完成':'取消')}</Button>{savedPending?<Button kind="primary" busy={editorBusy} onClick={()=>{void (async()=>{if(editorLock.current)return;editorLock.current=true;setEditorBusy(true);try{await capture.release();await command({op:'codexAdaptCheck',source},{silent:true});setEditorError('键盘设置已重新检查。');}catch(error){setEditorError(error instanceof Error?error.message:'键盘同步尚未完成，请重试。');}finally{editorLock.current=false;setEditorBusy(false);}})();}}>{t('重新检查')}</Button>:<Button kind="primary" busy={editorBusy} disabled={!capture.ready} onClick={()=>{void saveEditor();}}>{t('保存设置')}</Button>}</>}>
      <div ref={editorScroll} className="agent-editor-v6" data-codex-recording onScrollCapture={e=>{scrollTop.current=(e.target as HTMLElement).scrollTop;}}>
        <p className="agent-overlay-intro">{t(savedPending?'设置已经保存；重新检查键盘同步。':'更改后点击「保存设置」统一生效。取消将放弃本次修改。')}</p>
        {(editorError||capture.error)&&<p className="agent-inline-error" role="alert">{t(editorError||capture.error)}</p>}
        {!savedPending&&!capture.ready&&!capture.error&&<p className="agent-overlay-hint" role="status">{t('正在暂停快捷控制，请稍候。')}</p>}
        {!savedPending&&capture.error&&<Button onClick={capture.retry}>{t('重新准备')}</Button>}
        <div className="agent-editor-columns"><span>{t('绑定按键')}</span><span>{t('执行动作')}</span></div>
        {Array.from({length:6},(_,index)=>{const current=commands.find(item=>item.id===commandDraft.ids[index]);return <div className="agent-editor-row" key={index}>
          <button className="agent-editor-key" data-command-index={index} aria-label={t(`更改命令键 ${index+1}`)} disabled={editorBusy||savedPending||!capture.ready} onClick={()=>{scrollTop.current=editorScroll.current?.closest<HTMLElement>('.modal-body')?.scrollTop??0;setRecording({group:'command',index,keys:commandDraft.keys});}}>{t(CODE_LABEL(commandDraft.keys[index+6]))}</button>
          <div><select aria-label={t(`命令键 ${index+1} 的动作`)} disabled={editorBusy||savedPending} value={commandDraft.ids[index]??''} onChange={e=>{const ids=[...commandDraft.ids];ids[index]=e.target.value;setCommandDraft({...commandDraft,ids});setEditorError('');}}>{!current&&<option value={commandDraft.ids[index]} disabled>{t('当前动作不可用')}</option>}{commands.map(item=><option key={item.id} value={item.id} disabled={item.available===false}>{t(item.label)}{item.available===false?` (${t('不可用')})`:''}</option>)}</select>{current?.available===false&&<small>{t(operationReason(current))}</small>}</div>
        </div>;})}
        {!same(commandDraft.keys,commandDraft.baseKeys)&&<div className="agent-swap-plan">{commandDraft.keys.map((code,index)=>code!==commandDraft.baseKeys[index]&&<p key={index}>{t(index<6?`${claude?'会话':'任务'} ${index+1}`:`命令 ${index-5}`)}<span>{t(CODE_LABEL(commandDraft.baseKeys[index]))} → {t(CODE_LABEL(code))}</span></p>)}</div>}
        <p className="agent-overlay-hint">{t(savedPending?'设置已经保存；重新检查键盘同步。':'点击按键可重新录入。修改后保存才会生效。')}</p>
      </div>
    </Modal>}
    {allOperations&&<Modal title={t('额度与全部操作')} width={640} className="agent-overlay-v6" initialFocus="title" onClose={()=>setAllOperations(false)} footer={<Button kind="ghost" onClick={()=>setAllOperations(false)}>{t('完成')}</Button>}>
      <div className="agent-directory-v6"><AgentQuota state={state} source={source}/><div className="agent-directory-heading"><h3>{t('全部操作')}</h3><Button kind="ghost" busy={operationBusy==='refreshState'} icon={<RefreshCw size={14}/>} onClick={refresh}>{t('刷新状态')}</Button></div>
      <input type="search" aria-label={t('搜索操作')} placeholder={t('搜索操作')} value={search} onChange={e=>setSearch(e.target.value)}/>
      {feedback&&<p className="agent-inline-error" role="alert">{t(feedback)}</p>}
      <div className="agent-directory-list">{matchingCommands.map(item=><div className="agent-directory-row" key={item.id}><div><strong>{t(releasingDictation(item.id)?'结束听写':item.label)}</strong><p>{t(operationReason(item))}</p></div><Button kind="ghost" disabled={operationDisabled(item)} busy={operationBusy===item.id} onClick={()=>execute(item.id)}>{t(operationUnavailable(item)?'不可用':'执行')}</Button></div>)}</div>
      {!matchingCommands.length&&<div className="agent-directory-empty"><p>{t('没有匹配的操作。')}</p><Button kind="ghost" onClick={()=>setSearch('')}>{t('清除搜索')}</Button></div>}
      <details className="agent-details-v6"><summary>{t('支持范围与限制')}</summary><p>{t(String(integration?.reason??currentSource.reason??'任务状态自动更新；未确认的状态会单独标明。'))}</p>{claude?<><p>{t('Claude 停止本轮响应只表示这一轮结束，不代表整个项目完成；单次工具失败也不会把会话标成失败。')}</p><p>{t('NuPhy Lab 不会代替你批准或拒绝权限请求，也不会向会话发送输入。账户剩余额度没有可供第三方应用读取的官方接口，因此显示为暂不支持。')}</p></>:<><p>{t('“控制中”表示在 NuPhy Lab 选择的任务；直接在 Codex 切换页面时，当前无法同步真实焦点。状态依据本机任务事件和进程记录，尚不包含云端任务及部分桌面审批、语音状态。')}</p><p>{t('Fast、批准／拒绝、直接分叉、按住说话、发送输入、旋钮／摇杆导航和技能直达仍需要 Codex 的界面接口，当前未接入。快捷操作使用已确认的默认键位，Codex 内自定义键位可能影响执行。')}</p></>}<p>{t(claude?'命令键只在 NuPhy Lab 内部切换会话、跳转或刷新状态，不会向 Claude Code 发送按键或输入。':'听写方式跟随 Codex 的快捷键设置；长按模式最长 2 分钟。语音对话需要当前页面支持，终端需要本地项目。')}</p><p>{t('快捷控制暂停时，等待录键、按键触发或游戏结束后恢复。绑定位置与 RGB 索引分别处理。')}</p><div className="agent-support-notice-v6" role="note"><Info size={14} strokeWidth={1.5} aria-hidden="true"/><p>{t('能力、状态和额度未知时明确显示原因；不估算、不把过期数据当成最新结果。')}</p></div></details>
      </div>
    </Modal>}
  </div>;
}
