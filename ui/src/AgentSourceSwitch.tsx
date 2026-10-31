import {t} from './i18n';
import {run} from './primitives';
import type {AppState,Command} from './types';
export const AGENT_LABELS={codex:'Codex',claude:'Claude Code'} as const;
export type AgentSource=keyof typeof AGENT_LABELS;
export function agentSource(state:AppState|null):AgentSource{return state?.settings.agentSource==='claude'?'claude':'codex';}
export function AgentSourceSwitch({state,command,disabled=false}:{state:AppState|null;command:Command;disabled?:boolean}) {
  const source=agentSource(state);
  const enabled=state?.settings[`${source}Enabled`]===true;
  return <div className="agent-source-switch" role="group" aria-label={t('任务来源应用')}>
    {(Object.keys(AGENT_LABELS) as AgentSource[]).map(id=><button key={id} aria-pressed={source===id} disabled={!state||disabled}
      onClick={()=>{if(state&&!disabled&&id!==source)run(command(enabled?{op:'agentMode',source:id,enabled:true}:{op:'settings',settings:{agentSource:id}}));}}>{AGENT_LABELS[id]}</button>)}
  </div>;
}
