import {AgentDashboard} from './AgentDashboard';
import type {AppState,Command,Notify} from './types';
export function ClaudeCode(props:{state:AppState|null;command:Command;notify:Notify;focusColors?:boolean;readState?:()=>Promise<AppState>;serviceError?:string}) {return <AgentDashboard {...props} source="claude"/>;}
