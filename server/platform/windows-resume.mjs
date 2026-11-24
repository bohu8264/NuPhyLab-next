import path from 'node:path';
import {stat} from 'node:fs/promises';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export const localWindowsPath=value=>typeof value==='string'&&value.length<=4096&&/^[A-Za-z]:[\\/]/.test(value)&&!/[\x00-\x1f\x7f]/.test(value);
export function validateResumeSelection(source,id){
  if(!['codex','claude'].includes(source)||!uuid(id))throw Error('请选择具有完整会话编号的本机任务');
}
export async function discoverWindowsClaudeCLI({home,env=process.env,inspect=stat}={}){
  const p=path.win32;
  const candidates=[env.CLAUDE_CLI,home&&p.join(home,'.local','bin','claude.exe'),
    ...(env.Path??env.PATH??'').split(';').filter(Boolean).slice(0,128).map(directory=>p.join(directory,'claude.exe'))];
  for(const candidate of candidates){
    if(!localWindowsPath(candidate)||!candidate.toLowerCase().endsWith('.exe'))continue;
    try{if((await inspect(candidate)).isFile())return candidate;}catch{/* optional native CLI */}
  }
  return null;
}

// Returns a bounded plan to the native host, never a shell command. The host
// launches only after an explicit click; this is not physical-key authority.
export class WindowsResumePlanner {
  constructor({codex,claude,probe,home,env=process.env,inspect=stat,now=Date.now,
    discoverCodex=async()=>null,
    discoverClaude=()=>discoverWindowsClaudeCLI({home,env})}={}){
    Object.assign(this,{codex,claude,probe,home,env,inspect,now,discoverCodex,discoverClaude});
  }
  async codexDirectory(id){
    validateResumeSelection('codex',id);
    const unavailable=()=>Error('无法核对会话的项目目录，请使用复制恢复命令');
    const database=await this.codex.discoverDatabase().catch(()=>{throw unavailable();});
    if(!database)throw Error('无法读取会话的项目目录，请使用复制恢复命令');
    const fields=await this.codex.sql(database,'PRAGMA table_info(threads);').catch(()=>{throw unavailable();});
    if(!Array.isArray(fields))throw unavailable();
    const columns=new Set(fields.map(column=>column?.name));
    if(!columns.has('cwd')||!columns.has('id'))throw Error('此任务索引没有可核对的项目目录，请使用复制恢复命令');
    const rows=await this.codex.sql(database,`SELECT id, cwd FROM threads WHERE id = '${id}'${columns.has('archived')?' AND COALESCE(archived, 0) = 0':''} LIMIT 2;`).catch(()=>{throw unavailable();});
    if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==id)throw Error('会话记录已变化，请刷新后重试');
    if(!localWindowsPath(rows[0].cwd))throw Error('会话没有可用的本机项目目录');
    return rows[0].cwd;
  }
  async prepare({source,id,requestId}){
    validateResumeSelection(source,id);
    if(typeof requestId!=='string'||!/^[a-f0-9]{64}$/.test(requestId))throw Error('恢复请求已失效，请重新点击');
    const adapter=source==='codex'?this.codex:this.claude;
    const task=adapter.snapshot().tasks.find(task=>task.id===id);
    if(!task)throw Error('任务已不在当前列表中，请刷新后重试');
    let cwd;
    if(source==='codex'){
      if(!['completed','idle'].includes(task.status))throw Error('请先结束原会话，再在新终端恢复');
      cwd=await this.codexDirectory(id);
    }else{
      if(task.status!=='ended'||task.live!==false||!Number.isInteger(task.pid)||task.pid<=0||task.pid>0xffffffff)throw Error('请先结束原会话，并刷新状态后再恢复');
      cwd=task.cwd;
    }
    if(!localWindowsPath(cwd)||(await this.inspect(cwd).catch(()=>null))?.isDirectory()!==true)throw Error('会话的本机项目目录不可用，请使用复制恢复命令');
    const executable=await (source==='codex'?this.discoverCodex():this.discoverClaude());
    if(!localWindowsPath(executable)||!executable.toLowerCase().endsWith('.exe')||(await this.inspect(executable).catch(()=>null))?.isFile()!==true)
      throw Error(`未找到本机 ${source==='codex'?'Codex':'Claude Code'} 原生命令行程序，请先安装或使用复制恢复命令`);
    // Recheck ownership after filesystem/CLI discovery. Unknown evidence is
    // not an absent writer. Absence never permits injection or approval.
    if(source==='codex'){
      const writers=await this.probe.writers(adapter.codexHome,[id]);
      if(!(writers instanceof Map)||writers.size)throw Error('未确认原会话已释放，请关闭原终端后刷新重试');
      if(await this.codexDirectory(id)!==cwd)throw Error('会话目录已变化，请刷新后重试');
    }else{
      const processes=await this.probe.starts([task.pid]);
      if(!(processes instanceof Map)||processes.size)throw Error('未确认原会话进程已退出，请关闭原终端后刷新重试');
    }
    const current=adapter.snapshot().tasks.find(task=>task.id===id);
    if(!current||current.status!==task.status||source==='claude'&&(current.cwd!==cwd||current.pid!==task.pid||current.live!==false))throw Error('会话状态已变化，请刷新后重试');
    return {version:1,source,id,requestId,executable,cwd,preparedAt:this.now()};
  }
}
