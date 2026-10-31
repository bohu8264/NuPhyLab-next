import {AgentDashboard} from './AgentDashboard';
import type {AppState,Command} from './types';
export function Codex(props:{state:AppState|null;command:Command;focusColors?:boolean;readState?:()=>Promise<AppState>;serviceError?:string}) {return <AgentDashboard {...props} source="codex"/>;}
