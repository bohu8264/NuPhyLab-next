import {runtimePaths} from './runtime.mjs';
import {CodexAdapter,SHORTCUTS} from '../codex.mjs';
import {ClaudeCodeAdapter} from '../claude-code.mjs';
import {CLAUDE_COMMANDS} from '../claude-actions.mjs';
import {createWindowsAgents} from './windows-agents.mjs';
import {homedir} from 'node:os';

// A disabled adapter never scans a home directory, starts a process, installs
// hooks or substitutes Mac shortcuts for unverified Windows actions.
class UnavailableAgent {
  constructor(source) {
    const reason='Windows 预览版尚未接入 AI 工具，当前不会读取会话或执行快捷操作';
    const actions=(source==='codex'?SHORTCUTS:CLAUDE_COMMANDS).map(action=>({
      id:action.id,label:action.label,available:false,keys:[],shortcut:'',reason,
    }));
    this.state={available:false,reason,reasonCode:'WINDOWS_AGENT_UNAVAILABLE',updatedAt:null,
      taskSource:{available:false,reason,source:'unavailable'},tasks:[],slots:[],
      quota:{available:false,supported:false,reason,stale:false,buckets:[],updatedAt:null},
      ...(source==='codex'?{shortcuts:actions}:{commands:actions,
        hooks:{status:'unavailable',installed:false,reason},app:{installed:false,available:false,reason}})};
  }
  track() {}
  snapshot() { return structuredClone(this.state); }
  async start() { return this.snapshot(); }
  async stop() {}
  async refresh() { return this.snapshot(); }
  action() { return {available:false,reason:this.state.reason}; }
  hookStatus() { return structuredClone(this.state.hooks); }
  async execute() { this.reject(); }
  async install() { this.reject(); }
  async remove() { this.reject(); }
  reject() { throw Object.assign(new Error(this.state.reason),{code:this.state.reasonCode}); }
}

export function createPlatformServices(root,{
  platform=process.platform,env=process.env,home,
  createCodex=()=>new CodexAdapter(),createClaude=options=>new ClaudeCodeAdapter(options),
}={}) {
  const paths=runtimePaths(root,{platform,env,...(home===undefined?{}:{home})});
  const preview=platform==='win32'||env.AIR_STUDIO_DESKTOP_HOST==='tauri';
  const windows=platform==='win32'?createWindowsAgents({paths,home:home??homedir(),env}):null;
  return {paths,preview,agentControl:!preview,agentStatus:!preview||!!windows,
    windowsAgentActions:windows?.actions??null,
    windowsResumePlanner:windows?.resumePlanner??null,
    windowsFocusPlanner:windows?.focusPlanner??null,
    agents:windows?{codex:windows.codex,claude:windows.claude}:preview?{codex:new UnavailableAgent('codex'),claude:new UnavailableAgent('claude')}
      :{codex:createCodex(),claude:createClaude({dataDir:paths.dataDir})}};
}
