import {useState,useRef,useEffect} from 'react';
import {Button,Switch,run} from './primitives';
import {useStartupCopy} from './StartupGuide';
import {AgentQuota} from './AgentQuota';
import {CodexLightMode} from './CodexLightMode';
import {ClaudeLightMode} from './ClaudeLightMode';
import {STATUS_NAMES} from '../../shared/codex-lighting.mjs';
import {CLAUDE_STATUS_NAMES} from '../../shared/claude-lighting.mjs';
import {t} from './i18n';
import {AgentSourceSwitch} from './AgentSourceSwitch';
import './windows-agent.css';
import type {AppState,Command,Task} from './types';
export function WindowsAgentDashboard({state,source,command}:{state:AppState;source:'codex'|'claude';command:Command}){
  const copy=useStartupCopy(),claude=source==='claude',integration=state[source];
  const tasks=(integration?.tasks??[]) as Task[];
  const hooks=integration?.hooks as {installed?:boolean}|undefined;
  const [selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const pending=useRef(false),generation=useRef(0);
  useEffect(()=>{generation.current++;setSelected('');setMessage('');},[source]);
  useEffect(()=>()=>{generation.current++;},[]);
  const task=tasks.find(task=>task.id===selected)??tasks[0];
  const resumeReady=state.desktop?.capabilities.agentResume===true&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(task?.id??''))&&
    (claude?task?.status==='ended'&&task?.live===false&&Boolean(task?.cwd):['completed','idle'].includes(String(task?.status)));
  const focusReady=state.desktop?.capabilities.agentTerminalFocus===true&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(task?.id??''));
  const taskFocusReady=!claude&&state.desktop?.capabilities.codexTaskFocus===true&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(task?.id??''));
  const enabled=state.settings.agentSource===source&&(claude?state.settings.claudeEnabled:state.settings.codexEnabled)===true;
  const act=async(body:Record<string,unknown>)=>{
    if(pending.current)return;pending.current=true;const at=generation.current;setBusy(true);setMessage('');
    try{const result=await command(body,{silent:true});const alreadyOpened=result!==null&&typeof result==='object'&&'alreadyOpened'in result&&result.alreadyOpened===true;
      if(['focusTerminal','focusTask'].includes(String(body.action))&&!(result!==null&&typeof result==='object'&&'focused'in result&&result.focused===true))throw Error(copy('窗口切换未确认，请用任务栏切换。','Window switching was not confirmed. Use the taskbar.'));
      if(at===generation.current)setMessage(body.action==='focusTask'?copy('已切到核对的任务终端，不会自动发送按键。','Switched to the verified task terminal. No keys are sent automatically.'):body.action==='focusTerminal'?copy('已切回 Lab 打开的终端，不会自动发送按键。','Switched to the terminal opened by Lab. No keys are sent automatically.'):body.action==='resumeTerminal'
      ?alreadyOpened?copy('已为此会话打开终端，请切换到该终端。','A terminal was already opened for this session. Switch to that terminal.')
        :copy('已请求打开新终端，请在终端中确认会话；不会自动发送消息。','A new terminal was requested. Check the session there; no message is sent automatically.')
      :copy('操作已完成。','Action completed.'));}
    catch(e){if(at===generation.current)setMessage(e instanceof Error?e.message:copy('操作未完成，请重试。','The action did not finish. Try again.'));}finally{pending.current=false;setBusy(false);}
  };
  const names=claude?CLAUDE_STATUS_NAMES:STATUS_NAMES;
  return <section className="agent-v5 windows-agent-dashboard" aria-label={copy('Windows AI 状态','Windows AI status')}>
    <div className="windows-agent-heading"><h2>{claude?'Claude Code':'Codex'}</h2><AgentSourceSwitch state={state} command={command} disabled={busy}/></div>
    <p>{copy('读取本机任务状态，并用灯光提示进度。键盘普通按键保持原功能。','Read local task status and show progress with lighting. Regular keyboard functions are preserved.')}</p>
    <div className="agent-mode-control windows-agent-actions">
      <Switch label={copy('显示任务状态灯','Show task status lights')} checked={enabled} disabled={busy||!enabled&&state.device.capabilities?.perKey!==true} onChange={enabled=>run(act({op:'agentMode',source,enabled}))}/>
      <Button kind="ghost" busy={busy} onClick={()=>run(act({op:claude?'refreshClaude':'refreshCodex'}))}>{copy('刷新状态','Refresh status')}</Button>
    </div>
    {message&&<p role="status">{t(message)}</p>}
    <p role="status">{integration?.available?copy('本机状态来源已接入。','Local status is connected.'):t(String(integration?.reason??copy('正在读取本机状态。','Reading local status.')))}</p>
    {claude&&<section className="lab-setting-panel windows-agent-summary">
      <h3>{copy('Claude Code 事件接入','Claude Code events')}</h3>
      <p>{copy('安装后只记录会话和任务状态，不记录问题正文，也不会代替你批准请求。','Installation records session and task status, not prompt text. It never approves requests for you.')}</p>
      <Button kind="ghost" disabled={busy} onClick={()=>run(act({op:'claudeHookInstall'}))}>{hooks?.installed?copy('修复接入','Repair integration'):copy('安装接入','Install integration')}</Button>
      {hooks?.installed&&<Button kind="ghost" disabled={busy} onClick={()=>run(act({op:'claudeHookRemove',purgeSpool:false}))}>{copy('移除接入','Remove integration')}</Button>}
    </section>}
    <section className="lab-setting-panel windows-agent-summary">
      <h3>{copy('当前任务','Current tasks')}</h3>
      {!tasks.length?<p>{copy('还没有可显示的任务。请先在对应工具中打开会话，再刷新。','No tasks are available. Open a session in the tool, then refresh.')}</p>:<>
        <label>{copy('选择任务','Select task')}<select value={String(task?.id??'')} disabled={busy} onChange={e=>setSelected(e.target.value)}>{tasks.map(task=><option key={String(task.id)} value={String(task.id)}>{String(task.title??task.id)}</option>)}</select></label>
        <p>{copy('状态：','Status: ')}{t((names as Record<string,string>)[String(task?.status)]??copy('尚未确认','Unconfirmed'))}</p>
        {task?.evidence&&<p>{t(String(task.evidence))}</p>}
        <Button kind="ghost" disabled={busy||!task} onClick={()=>run(act({op:'windowsAgentAction',source,action:'copyResume',id:task?.id}))}>{copy('复制 PowerShell 恢复命令','Copy PowerShell resume command')}</Button>
        <Button kind="ghost" disabled={busy||!task||claude&&!task.cwd} onClick={()=>run(act({op:'windowsAgentAction',source,action:'revealProject',id:task?.id}))}>{copy('打开项目文件夹','Open project folder')}</Button>
        <Button kind="ghost" disabled={busy||!resumeReady} onClick={()=>run(act({op:'windowsAgentAction',source,action:'resumeTerminal',id:task?.id}))}>{copy('在新终端恢复会话','Resume in a new terminal')}</Button>
        <Button kind="ghost" disabled={busy||!focusReady} onClick={()=>run(act({op:'windowsAgentAction',source,action:'focusTerminal',id:task?.id}))}>{copy('切回 Lab 打开的终端','Switch to terminal opened by Lab')}</Button>
        {!claude&&<Button kind="ghost" disabled={busy||!taskFocusReady} onClick={()=>run(act({op:'windowsAgentAction',source,action:'focusTask',id:task?.id}))}>{copy('切到正在运行的任务窗口','Switch to running task window')}</Button>}
        <p>{copy('已完成或结束的会话可在新终端恢复，需要本机安装对应的原生命令行程序。终端由你操作，原来的窗口不会被接管。','Completed or ended sessions can resume in a new terminal when the native CLI is installed. You control that terminal; existing windows are not taken over.')}</p>
        <p>{copy('切回终端仅适用于本次 Lab 打开且能够核对的独立窗口。终端标签页或系统限制可能需要你用任务栏切换。','Switching applies only to a verifiable standalone window opened by this Lab instance. Terminal tabs or system restrictions may require the taskbar.')}</p>
        {!claude&&<p>{copy('其他方式打开的 Codex 任务会重新核对当前进程和独立窗口；没有唯一目标时，请用任务栏切换。','Codex tasks opened elsewhere require a fresh process and standalone window check. Use the taskbar when no unique target is confirmed.')}</p>}
      </>}
    </section>
    <p>{copy('实体任务键、审批和听写仍在开发，当前不会拦截按键或发送快捷键。','Physical task keys, approvals and dictation are still in development. Keys are not intercepted and shortcuts are not sent.')}</p>
    <AgentQuota state={state} source={source}/>
    {claude?<ClaudeLightMode state={state} command={command}/>:<CodexLightMode state={state} command={command}/>}
  </section>;
}
