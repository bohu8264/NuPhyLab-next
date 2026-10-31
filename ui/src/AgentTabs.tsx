import {AgentSourceSwitch} from './AgentSourceSwitch';
import {t} from './i18n';
import type {AppState,Command} from './types';
import './agent-v5.css';
export type AgentTab='tasks'|'lights'|'setup';
export function AgentTabs({tab,onChange,state,command,sourceDisabled=false}:{tab:AgentTab;onChange:(tab:AgentTab)=>void;state:AppState|null;command:Command;sourceDisabled?:boolean}) {
  return <div className="agent-tabbar"><div className="agent-tabs" role="tablist" aria-label={t('AI 助手')}>
    {([['tasks','任务与快捷键'],['lights','状态灯'],['setup','接入设置']] as const).map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>onChange(id)}>{t(label)}</button>)}
  </div><AgentSourceSwitch state={state} command={command} disabled={sourceDisabled}/></div>;
}
