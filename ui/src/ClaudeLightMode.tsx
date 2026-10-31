import {AgentLighting} from './AgentLighting';
import type {AppState,Command} from './types';
export function ClaudeLightMode(props:{state:AppState|null;command:Command;focusColors?:boolean;serviceUnknown?:boolean;onSelectTasks?:()=>void;onSetup?:()=>void}) {return <AgentLighting {...props} source="claude"/>;}
