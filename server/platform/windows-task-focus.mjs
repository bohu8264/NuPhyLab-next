import path from 'node:path';
import {stat} from 'node:fs/promises';
import {localWindowsPath,validateResumeSelection} from './windows-resume.mjs';
const samePath=(a,b)=>localWindowsPath(a)&&localWindowsPath(b)&&path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase();
export class WindowsTaskFocusPlanner {
  constructor({codex,probe,discoverCLI,inspect=stat,now=Date.now}){
    Object.assign(this,{codex,probe,discoverCLI,inspect,now});
  }
  async prepare({source,id,requestId}){
    validateResumeSelection(source,id);
    if(source!=='codex')throw Error('当前仅能核对原生 Codex 任务窗口');
    if(typeof requestId!=='string'||!/^[a-f0-9]{64}$/.test(requestId))throw Error('窗口请求已失效，请重新点击');
    const present=()=>this.codex.snapshot().tasks.some(task=>task.id===id);
    if(!present())throw Error('任务已不在当前列表中，请刷新后重试');
    const first=await this.probe.codexTarget(this.codex.codexHome,id);
    if(!first)throw Error('未找到唯一的当前任务进程，请用任务栏切换');
    const executable=await this.discoverCLI();
    if(!samePath(executable,first.executable)||!['codex.exe','codex-x86_64-pc-windows-msvc.exe'].includes(path.win32.basename(first.executable).toLowerCase())||
      (await this.inspect(first.executable).catch(()=>null))?.isFile()!==true)
      throw Error('任务程序与本机工具位置不一致，请用任务栏切换');
    const current=await this.probe.codexTarget(this.codex.codexHome,id);
    if(!current||current.pid!==first.pid||current.createdTicks!==first.createdTicks||!samePath(current.executable,first.executable)||!present())
      throw Error('任务进程已变化，请刷新后重试');
    return {version:1,source,id,requestId,pid:current.pid,createdTicks:current.createdTicks,executable:current.executable,preparedAt:this.now()};
  }
}
