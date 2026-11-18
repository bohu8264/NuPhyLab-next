import {AGENT_COHORT_COLORS,agentLightZone} from '../../shared/agent-cohort.mjs';
import {Keyboard} from './Keyboard';
import {getLayoutForModel} from '../../shared/layout.mjs';
import {Button,run} from './primitives';
import {useStartupCopy} from './StartupGuide';
import {FirmwareManagement} from './FirmwareManagement';
import type {AppState,Command} from './types';
import type {AgentSource} from './AgentSourceSwitch';
import './agent-side-lighting.css';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};
export function AgentLightingZone({source,state,command}:{source:AgentSource;state:AppState|null;command:Command}){
  const copy=useStartupCopy(),zone=agentLightZone(state?.settings??{},source,state?.device.modelId);
  return <section className="agent-zone-picker"><div><h3>{copy('状态灯区域','Status light zone')}</h3><p>{copy('选择用背光还是侧灯显示 AI 状态。','Choose backlighting or side LEDs for AI status.')}</p></div><div className="agent-zone-options" role="group" aria-label={copy('状态灯区域','Status light zone')}>{[['backlight',copy('背光模式','Backlight')],['side',copy('侧灯模式','Side LEDs')]].map(([id,label])=><button key={id} aria-pressed={zone===id} disabled={!state||(id==='side'&&state.device.modelId!=='air75-v3')} onClick={()=>run(command({op:'settings',settings:{[`${source}LightZone`]:id}}))}>{label}</button>)}</div></section>;
}
export function AgentSideLighting({source,state,command,serviceUnknown=false}:{source:AgentSource;state:AppState|null;command:Command;serviceUnknown?:boolean}){
  const copy=useStartupCopy(),integration=source==='claude'?state?.claude:state?.codex;
  const side=object(object(integration?.lighting).side),aggregate=object(side.aggregate);
  const enabled=state?.settings.agentSource===source&&state.settings[`${source}Enabled`]===true;
  const actual=!serviceUnknown&&side.ownsOutput===true;
  const labels:Record<string,string>={running:copy('正在处理','Working'),waiting:copy('等待你处理','Needs your attention'),completed:copy('本轮全部完成','All current work completed'),idle:copy('空闲','Idle'),error:copy('有任务出错','Task error')};
  const status=serviceUnknown?copy('状态暂未确认','Status not confirmed')
    :!enabled?copy('模式未开启','Mode is off')
    :side.pausedReason==='unsupported'?copy('当前键盘未确认支持侧灯控制','Side LED control is not confirmed for this keyboard')
    :!state?.device.connected?copy('连接 Air75 V3 USB 后可使用侧灯状态','Connect Air75 V3 by USB to use side status')
    :actual?labels[String(aggregate.status)]??copy('状态暂未确认','Status not confirmed')
    :['game','trigger','audio','connectionWake','handoff','paused'].includes(String(side.pausedReason))?copy('当前操作期间暂停侧灯状态','Side status is paused during the current activity')
    :aggregate.status==='idle'?copy('等待新任务','Waiting for new work'):copy('等待完整任务状态','Waiting for complete task status');
  const model=state?.device.modelId??'air75-v3',layout=getLayoutForModel(model);
  const brightness=Number(state?.settings[`${source}Brightness`]??100);
  return <section className="agent-side-page"><header><h2>{copy('整体任务状态','Overall task status')}</h2><FirmwareManagement state={state} serviceUnknown={serviceUnknown}/></header>
    <p className="agent-side-status" role="status"><i style={{background:actual?String(side.color):'#a0a0a0'}}/>{status}{actual&&brightness===0&&` · ${copy('亮度为 0%','Brightness is 0%')}`}</p>
    <div className="keyboard-viewport"><Keyboard modelId={model} layout={layout} colors={Array(layout.length).fill('#000000')} sideColor={actual?String(side.color):undefined}/></div>
    <div className="agent-side-legend">{Object.entries(AGENT_COHORT_COLORS).map(([id,color])=><span key={id}><i style={{background:color}}/>{labels[id]}</span>)}</div>
    <p>{copy('本轮任务全部完成后保持绿色；没有本轮任务时显示白色。新任务开始后立即更新状态。','Green stays on when all work in the current batch completes. White means there is no current batch. New work updates the status immediately.')}</p>
    <p>{copy('统计当前来源的全部进行中任务，包含未分配到任务键的任务。全部明确成功后才显示绿色；取消、状态缺失或连接中断都不会算作完成。','Tracks all ongoing work from this source, including tasks outside the task keys. Green requires explicit success for every current task. Cancellations, missing state, and disconnections do not count as completion.')}</p>
    {enabled&&aggregate.complete!==true&&<p role="status">{copy('任务范围暂未完整确认，不会显示“全部完成”。','The full task scope is not confirmed. All-complete status will not be shown.')}</p>}
    {source==='claude'&&<p>{copy('Claude Code 停止输出时可能仍在等待输入；没有明确成功事件时不会显示完成色。','Claude Code may be waiting for input when output stops. Without an explicit success event, the completion color is not shown.')}</p>}
    <div className="agent-side-brightness"><label htmlFor={`${source}-side-brightness`}>{copy('侧灯亮度','Side LED brightness')}</label><input id={`${source}-side-brightness`} type="range" min="0" max="100" value={brightness} disabled={!state||serviceUnknown} onChange={e=>run(command({op:'settings',settings:{[`${source}Brightness`]:Number(e.target.value)}}))}/><output>{brightness}%</output></div>
    <p>{copy('侧灯模式释放任务键绑定（默认为 F1–F6）。命令键（默认为 F7–F12）可在“任务与快捷键”中单独开启。侧灯控制需要 USB 连接。','Side mode releases task bindings (F1–F6 by default). Command keys (F7–F12 by default) can be enabled separately under Tasks & Shortcuts. Side lighting requires USB.')}</p>
  </section>;
}
