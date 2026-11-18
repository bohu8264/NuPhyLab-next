export type CohortState={status:string;count:number;complete:boolean;fresh:boolean;observedAt:number|null;succeeded:number};
export const AGENT_COHORT_COLORS:Record<string,string>;
export function agentLightZone(settings:Record<string,unknown>,source:string,modelId?:string):'side'|'backlight';
export function enabledAgentBindings<T extends {index:number}>(settings:Record<string,unknown>,source:string,bindings:T[],modelId?:string):T[];
export class AgentCohort {constructor(options?:{now?:()=>number;freshMs?:number;settleMs?:number});reset():void;snapshot():CohortState;observe(value:unknown):CohortState;}
