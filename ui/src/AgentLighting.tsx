import {useEffect,useState,type CSSProperties} from 'react';
import {Moon,ArrowUp} from 'lucide-react';
import {resolveAgentLightingView,renderAgentLightingPreview} from '../../shared/agent-lighting-view.mjs';
import {codexBindings} from '../../shared/codex-keys.mjs';
import {claudeBindings} from '../../shared/claude-keys.mjs';
import {lightingUnavailableMessage} from '../../shared/device-status.mjs';
import {Keyboard} from './Keyboard';
import {airLayout,kickLayout} from '../../shared/layout.mjs';
import {useStartupCopy} from './StartupGuide';
import {CodexStatusColors} from './CodexStatusColors';
import {ClaudeStatusColors} from './ClaudeStatusColors';
import {Button,Switch,run} from './primitives';
import {t} from './i18n';
import type {AppState,Command} from './types';
import type {AgentSource} from './AgentSourceSwitch';
import './creation-experience-v7.css';
import {useWorkspaceLayout} from './useWorkspaceLayout';
import './agent-audio-workspace.css';
export function AgentLighting({source,state,command,focusColors,serviceUnknown=false,onSelectTasks,onSetup}:{source:AgentSource;state:AppState|null;command:Command;focusColors?:boolean;serviceUnknown?:boolean;onSelectTasks?:()=>void;onSetup?:()=>void}) {
  const copy=useStartupCopy();
  const view=resolveAgentLightingView(source,state,{serviceUnknown});
  const {settings,tasks,slots,whole,ownsOutput,showing,selectedId:controlId,wholeTask,ambientTask}=view;
  const claude=source==='claude',name=claude?'Claude Code':'Codex';
  const keyLayout=state?.layout??(state?.device.modelId==='kick75'?kickLayout:airLayout);
  const workspace=useWorkspaceLayout({aspectRatio:keyLayout.length===80?1009/440:959/384});
  const bindings=claude?claudeBindings(settings):codexBindings(settings);
  const unavailable=!view.capable;
  const bluetooth=Boolean(state?.bluetooth?.connected&&!state.device.connected);
  const set=(patch:Record<string,unknown>)=>run(command({op:'settings',settings:patch}));
  const [elapsed,setElapsed]=useState(0),[reducedMotion,setReducedMotion]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{const media=window.matchMedia('(prefers-reduced-motion: reduce)');const update=()=>setReducedMotion(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  useEffect(()=>{
    setElapsed(0);
    if(ownsOutput||!view.animated||reducedMotion)return;
    const start=performance.now();
    const timer=window.setInterval(()=>{if(!document.hidden)setElapsed(performance.now()-start);},100);
    return()=>window.clearInterval(timer);
  },[source,controlId,ownsOutput,view.animated,reducedMotion]);
  const preview=ownsOutput&&state?.previewColors?state.previewColors
    :renderAgentLightingPreview(source,slots,settings,tasks,controlId,elapsed);
  const selectedId=String(settings[`${source}WholeTaskId`]??'');
  const ambient=settings[`${source}Ambient`]===true;
  const hasSlots=slots.some(Boolean);
  const hasZeroBrightness=Number(settings.brightness??100)===0||Number(settings[`${source}Brightness`]??100)===0;
  const status=serviceUnknown?copy('状态暂未确认；当前仅页面预览。','Status is not confirmed. This is an on-screen preview.')
    :ownsOutput?hasZeroBrightness?copy('当前亮度为 0%，键盘保持熄灭。','Brightness is 0%. Keyboard lights stay off.')
      :whole&&!wholeTask?copy('已开始监听，等待跟随任务。','Listening for the followed task.')
      :!whole&&!hasSlots?copy('已开始监听，等待任务键绑定。','Listening; waiting for bound task keys.')
      :t(`正在显示 ${name} 任务状态`)
    :!view.connected?copy('仅页面预览 · 连接 USB 后可开始显示','On-screen preview · Connect USB to start')
      :!view.capable?copy('当前键盘暂不支持状态灯，仅显示页面预览。','This keyboard does not currently support status lights. On-screen preview only.')
      :view.enabled&&['game','trigger','recording'].includes(view.pausedReason??'')?copy('当前操作期间暂时暂停，结束后恢复模式。','Paused for the current activity. The mode resumes when it ends.')
      :view.enabled&&view.pausedReason==='handoff'?copy('键盘正在交给官方驱动；模式显示暂时暂停。','The official configurator is using the keyboard. Mode lighting is paused.')
      :view.enabled?copy('正在同步对话状态灯…','Synchronizing conversation status lights…')
      :copy('模式未开启 · 当前仅页面预览','Mode is off · On-screen preview only');
  const selectControl=(id:string)=>run(command(claude?{op:'claudeSelect',sessionId:id}:{op:'codexSelect',threadId:id}));
  return <section className="agent-light-page" data-workspace-layout={workspace.mode} style={workspace.style}>
    <header ref={workspace.headerRef} className="agent-light-heading"><h2>{name} {t('状态灯')}</h2>{workspace.previewAway&&<Button kind="ghost" className="agent-workspace-return" data-workspace-navigation onClick={workspace.returnToKeyboard}><ArrowUp size={14}/>{t('回到键盘')}</Button>}</header>
    <div ref={workspace.gridRef} className="agent-light-grid"><div className="agent-light-canvas">
      <div ref={workspace.stageRef} className="agent-workspace-core" tabIndex={-1}>
      <p className={`agent-live-status ${showing?'connected':''}`}><i/>{status}</p>
      <div ref={workspace.keyboardRef} className="agent-workspace-keyboard">{state&&<Keyboard layout={keyLayout} colors={preview}/>}</div>
      </div><div ref={workspace.auxiliaryRef} className="agent-workspace-aux">
      <div className="agent-brightness v7-agent-brightness"><label htmlFor={`${source}-brightness`}>{t('状态灯亮度')}</label><input id={`${source}-brightness`} aria-label={`${name} ${t('状态灯亮度')}`} aria-describedby={`${source}-brightness-help`} type="range" min="0" max="100" style={{'--range-progress':`${Number(settings[`${source}Brightness`]??100)}%`} as CSSProperties} value={Number(settings[`${source}Brightness`]??100)} disabled={!state||unavailable||serviceUnknown} onChange={e=>set({[`${source}Brightness`]:Number(e.target.value)})}/><output>{Number(settings[`${source}Brightness`]??100)}%</output>
        <Button kind="ghost" icon={<Moon size={16}/>} onClick={()=>window.dispatchEvent(new CustomEvent('nuphylab:navigate',{detail:'lighting'}))}>{t('普通作品休眠设置')}</Button><p id={`${source}-brightness-help`} className="v7-agent-brightness-help">{t('状态灯亮度还会叠加全局逐键输出亮度。')}</p><p className="v7-agent-brightness-help">{t('页面预览不受全局亮度影响。')}</p><p className="v7-agent-brightness-help">{t('对话状态灯持续显示，关闭模式后停止。')}</p></div>
      {!ownsOutput&&hasZeroBrightness&&<p className="agent-note" role="status">{copy('此来源的状态灯或全局亮度为 0%，开始显示后也会保持熄灭。','This source or global brightness is 0%. Starting display will keep its lights off.')}</p>}
      {(unavailable||bluetooth)&&<p className="agent-note" role="status">{t(bluetooth?'实时灯光需要 USB 连接。':lightingUnavailableMessage(state))}</p>}
      {bindings.some(binding=>binding.ledIndex===null)&&<p className="agent-note">{t('Del 可执行按键动作，但该位置没有可独立控制的灯。')}</p>}
      </div>
    </div><fieldset className="agent-light-inspector" disabled={!state||unavailable||serviceUnknown}>
      <h3>{t('状态显示')}</h3><select aria-label={t('状态显示')} value={whole?'whole':'keys'} onChange={e=>set({[`${source}LightMode`]:e.target.value})}><option value="keys">{t('分别显示多个任务')}</option><option value="whole">{t('单任务全键盘')}</option></select>
      {whole&&<label className="agent-whole-picker">{t(claude?'跟随会话':'跟随任务')}<select value={selectedId} aria-label={t(claude?'跟随会话':'跟随任务')} onChange={e=>set({[`${source}WholeTaskId`]:e.target.value})}><option value="">{t(claude?'自动跟随控制会话':'自动跟随控制任务')}</option>{tasks.map(task=><option key={String(task.id)} value={String(task.id)}>{String(task.title??task.name??t('未命名任务'))}</option>)}{selectedId&&!tasks.some(task=>task.id===selectedId)&&<option value={selectedId}>{t('已选任务暂不可用')}</option>}</select></label>}
      {!view.ready&&<div className="agent-note" role="status"><p>{copy('尚未接入可读的任务来源；设置可以预先配置。','A readable task source is not connected. You can configure settings in advance.')}</p>{onSetup&&<Button kind="ghost" onClick={onSetup}>{copy('查看接入说明','View setup')}</Button>}</div>}
      {view.ready&&!tasks.length&&<p className="agent-note" role="status">{copy('当前没有可显示的任务，任务出现后才会有状态灯。','No tasks are available. Status lights appear when tasks are available.')}</p>}
      {whole&&tasks.length>0&&!wholeTask&&<p className="agent-note" role="status">{copy(selectedId?'已选任务暂不可用，灯光保持熄灭；不会自动切换到其他任务。':'有多个任务时，请选择跟随任务；自动跟随仅使用控制任务。',selectedId?'The followed task is unavailable. Lights stay off; another task will not be chosen automatically.':'With multiple tasks, choose a task to follow. Automatic mode follows the control task only.')}</p>}
      {!whole&&ambient&&<>
        <label className="agent-whole-picker">{copy('控制任务','Control task')}<select aria-label={`${name} ${copy('控制任务','control task')}`} value={slots.some(task=>task?.id===controlId)?controlId:''} disabled={!hasSlots} onChange={event=>selectControl(event.target.value)}>
          <option value="" disabled>{copy(controlId?'控制任务不在当前任务键中':'请选择控制任务',controlId?'Control task is not bound to a task key':'Choose a control task')}</option>
          {slots.filter(Boolean).map(task=><option key={String(task?.id)} value={String(task?.id)}>{String(task?.title??task?.name??t('未命名任务'))}</option>)}
        </select></label>
        <p className="agent-note" role="status">{copy(!hasSlots?'先在任务键中选择或绑定任务，再选择流光的控制任务。':!ambientTask?'选择控制任务后，命令键才会显示它的状态。':ambientTask.status==='running'?'控制任务运行时，命令键显示流光。':'控制任务当前未运行；命令键保持该任务状态色。',!hasSlots?'Choose or bind task keys, then choose the task for command-key lights.':!ambientTask?'Choose a control task to show its state on command keys.':ambientTask.status==='running'?'Command keys animate while the control task is running.':'The control task is not running. Command keys keep its status color.')}</p>
        {!hasSlots&&onSelectTasks&&<Button kind="ghost" onClick={onSelectTasks}>{copy('选择或绑定任务','Choose or bind tasks')}</Button>}
      </>}
      {claude?<ClaudeStatusColors settings={settings} command={command} focusOnMount={focusColors}/>:<CodexStatusColors settings={settings} command={command} focusOnMount={focusColors}/>}
      <div className="agent-light-switches"><Switch label={t('当前任务灯光呼吸')} checked={settings[`${source}SelectedPulse`]!==false} onChange={value=>set({[`${source}SelectedPulse`]:value})}/>{!whole&&<Switch label={t('命令键运行流光')} checked={settings[`${source}Ambient`]===true} onChange={value=>set({[`${source}Ambient`]:value})}/>}</div>
    </fieldset></div>
  </section>;
}
