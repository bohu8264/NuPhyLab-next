export type AgentLightingTask = {id?: string; status?: string; [key: string]: unknown};
export type AgentLightingView = {
  tasks: AgentLightingTask[]; slots: (AgentLightingTask | null)[];
  settings: Record<string, unknown>; selectedId: string;
  selectedTask: AgentLightingTask | null; ambientTask: AgentLightingTask | null;
  wholeTask: AgentLightingTask | null; whole: boolean;
  activeSource: 'codex' | 'claude'; enabled: boolean; connected: boolean;
  capable: boolean; ready: boolean; sleeping: boolean;
  backgroundSleeping: boolean; pausedReason: string | null;
  ownsOutput: boolean; showing: boolean; animated: boolean;
  blockedReason: '' | 'serviceUnknown' | 'disconnected' | 'unsupported' | 'integrationUnavailable';
};
export function resolveAgentLightingView(source: 'codex' | 'claude', state: unknown, options?: {serviceUnknown?: boolean}): AgentLightingView;
export function renderAgentLightingPreview(source: 'codex' | 'claude', slots: (AgentLightingTask | null)[], settings: Record<string, unknown>, tasks: AgentLightingTask[], selectedId?: string, elapsed?: number): string[];
