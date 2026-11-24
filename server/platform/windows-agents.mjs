import path from 'node:path';
import {access,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CodexAdapter,SHORTCUTS} from '../codex.mjs';
import {ClaudeCodeAdapter} from '../claude-code.mjs';
import {describeClaudeAction} from '../claude-actions.mjs';
import {WindowsClaudeHookInstaller} from './windows-claude-hooks.mjs';
import {WindowsProcessProbe} from './windows-processes.mjs';
import {WindowsResumePlanner} from './windows-resume.mjs';
import {WindowsTaskFocusPlanner} from './windows-task-focus.mjs';
const exec=promisify(execFile),validId=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
export function windowsResumeCommand(source,id,cwd){
  if(!['codex','claude'].includes(source)||!validId(id))throw Error('恢复命令的来源或会话编号无效');
  const command=source==='codex'?`codex resume ${quote(id)}`:`claude --resume ${quote(id)}`;
  return cwd?`& { Set-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop; ${command} }`:command;
}
export async function discoverWindowsCodexCLI(explicit,{home,env=process.env}={}){
  const p=path.win32,candidates=explicit?[explicit]:[
    env.CODEX_CLI,
    env.LOCALAPPDATA&&p.join(env.LOCALAPPDATA,'Programs','Codex','resources','codex.exe'),
    home&&p.join(home,'.local','bin','codex.exe'),
    ...[env.APPDATA&&p.join(env.APPDATA,'npm','node_modules'),env.ProgramFiles&&p.join(env.ProgramFiles,'nodejs','node_modules')].filter(Boolean).flatMap(root=>[
      p.join(root,'@openai','codex','vendor','x86_64-pc-windows-msvc','codex','codex.exe'),
      p.join(root,'@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','codex','codex.exe')]),
    ...(env.Path??env.PATH??'').split(';').filter(Boolean).slice(0,128).map(dir=>p.join(dir,'codex.exe')),
  ];
  for(const candidate of candidates){if(typeof candidate!=='string'||!p.isAbsolute(candidate)||!candidate.toLowerCase().endsWith('.exe'))continue;
    try{if((await stat(candidate)).isFile()){await access(candidate);return candidate;}}catch{/* optional installed CLI */}
  }return null;
}
export class WindowsAgentActions {
  constructor({env=process.env,run=exec,inspect=stat,clipboard}={}){
    this.explorer=path.win32.join(env.SystemRoot??'C:\\Windows','explorer.exe');
    this.powershell=path.win32.join(env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    Object.assign(this,{run,inspect,env,clipboard});
  }
  async execute(action){
    if(action?.available!==true)throw Error(action?.reason??'这个 Windows 操作暂不可用');
    if(action.type==='revealProject'){
      if(typeof action.path!=='string'||!/^[A-Za-z]:[\\/]/.test(action.path)||action.path.length>4096||(await this.inspect(action.path)).isDirectory()!==true)throw Error('项目目录无效或不在本机磁盘');
      await this.run(this.explorer,[action.path],{windowsHide:true,timeout:8000});return {opened:action.path};
    }
    if(action.type==='copyResume'){
      if(typeof action.text!=='string'||action.text.length>8192||action.text.includes('\0'))throw Error('恢复命令无效');
      if(this.clipboard)await this.clipboard(action.text);
      else{
        const script='Set-Clipboard -Value $env:NUPHYLAB_RESUME_TEXT';
        await this.run(this.powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,env:{...this.env,NUPHYLAB_RESUME_TEXT:action.text}});
      }return {copied:true,text:action.text};
    }
    throw Error('此 Windows 操作尚未通过目标与上下文核对');
  }
}
export class WindowsCodexAdapter extends CodexAdapter {
  constructor({home,env,sqlitePath,probe,...options}){
    super({codexHome:env.CODEX_HOME||path.join(home,'.codex'),sqlitePath,sqliteArgs:['-batch','-init','NUL','-safe'],
      discoverCLI:explicit=>discoverWindowsCodexCLI(explicit,{home,env}),liveWriters:(root,ids)=>probe.writers(root,ids),...options});
  }
  snapshot(){
    const value=super.snapshot();value.platform='win32';value.shortcuts=SHORTCUTS.map(a=>({id:a.id,label:a.label,keys:[],shortcut:'',available:false,
      reason:'Windows 快捷操作需核对目标窗口和实体按键来源，当前仅提供状态与恢复命令'}));return value;
  }
  action(){return {available:false,reason:'Windows 快捷操作尚未通过目标窗口与实体按键核对'};}
}
export function createWindowsAgents({paths,home,env=process.env,actions=new WindowsAgentActions({env})}){
  if(!existsSync(paths.sqlite)||!existsSync(paths.agentProbe))return null;
  const probe=new WindowsProcessProbe(paths.agentProbe);
  const codex=new WindowsCodexAdapter({home,env,sqlitePath:paths.sqlite,probe});
  const claudeDir=env.CLAUDE_CONFIG_DIR||path.join(home,'.claude');
  const claude=new ClaudeCodeAdapter({dataDir:paths.dataDir,claudeDir,
    supportDir:env.CLAUDE_DESKTOP_SUPPORT||path.join(env.APPDATA||path.join(home,'AppData','Roaming'),'Claude'),
    installer:new WindowsClaudeHookInstaller({dataDir:paths.dataDir,claudeDir}),
    processStarts:pids=>probe.starts(pids),detectApp:async()=>false,runner:actions,
    describeAction:(id,options)=>{
      if(id==='copyResume'&&options.session)return {available:true,type:'copyResume',id,label:'复制恢复命令',text:windowsResumeCommand('claude',options.session.id,options.session.cwd)};
      return describeClaudeAction(id,{...options,appInstalled:false});
    },
  });
  claude.state.app={installed:false,platform:'win32'};
  const resumePlanner=new WindowsResumePlanner({codex,claude,probe,home,env,
    discoverCodex:()=>discoverWindowsCodexCLI(undefined,{home,env})});
  const focusPlanner=new WindowsTaskFocusPlanner({codex,probe,discoverCLI:()=>discoverWindowsCodexCLI(undefined,{home,env})});
  return {codex,claude,actions,resumePlanner,focusPlanner};
}
