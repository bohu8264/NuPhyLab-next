import {mkdir,copyFile,readFile,writeFile,rename,rm,chmod,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {ClaudeHookInstaller} from '../claude-hooks.mjs';
import {HOOK_EVENTS} from '../claude-events.mjs';
// Exec-form hooks pass an argv array. No Bash/cmd/PowerShell tokenization.
export class WindowsClaudeHookInstaller extends ClaudeHookInstaller {
  constructor({runtime=process.execPath,...options}={}){super(options);this.runtime=runtime;this.hookRuntime=path.join(this.hookDir,'nuphylab-claude-hook.exe');}
  get command(){return this.hookRuntime;}
  get entry(){return {type:'command',command:this.command,args:[path.join(this.hookDir,'nuphylab-claude-hook.mjs'),this.spoolDir,'--portable'],timeout:5,onFailure:'continue'};}
  async writeScripts(){
    await mkdir(this.hookDir,{recursive:true});await mkdir(this.spoolDir,{recursive:true});
    const temp=this.hookRuntime+'.'+randomUUID()+'.tmp';
    try{await copyFile(this.runtime,temp);await rename(temp,this.hookRuntime);}finally{await rm(temp,{force:true});}
    if(process.platform!=='win32')await chmod(this.hookRuntime,0o755);
    const script=path.join(this.hookDir,'nuphylab-claude-hook.mjs');
    await copyFile(path.join(this.sourceDir,'nuphylab-claude-hook.mjs'),script);
    const digest=createHash('sha256').update(await readFile(script)).digest('hex');
    const runtimeDigest=createHash('sha256').update(await readFile(this.hookRuntime)).digest('hex');
    await writeFile(path.join(this.hookDir,'manifest.json'),JSON.stringify({app:'NuPhyLab',version:2,platform:'win32',spoolDir:this.spoolDir,events:HOOK_EVENTS,scriptSha256:digest,runtimeSha256:runtimeDigest},null,2)+'\n');
  }
  async status(){
    const value=await super.status();value.version=2;value.platform='win32';
    if(value.installed){
      try{const manifest=JSON.parse(await readFile(path.join(this.hookDir,'manifest.json'),'utf8'));
        const scriptFile=path.join(this.hookDir,'nuphylab-claude-hook.mjs');
        const stamp=async()=>{const files=await Promise.all([stat(this.hookRuntime,{bigint:true}),stat(scriptFile,{bigint:true})]);
          if(files[0].size>150n*1024n*1024n||files[1].size>1024n*1024n)throw Error('oversized hook');
          return files.map(f=>[f.dev,f.ino,f.size,f.mtimeNs,f.ctimeNs].join(':')).join('|');};
        const key=await stamp();
        if(this.verifiedFiles?.key!==key){
          const script=createHash('sha256').update(await readFile(scriptFile)).digest('hex');
          const runtime=createHash('sha256').update(await readFile(this.hookRuntime)).digest('hex');
          if(key!==await stamp())throw Error('hook changed during verification');
          this.verifiedFiles={key,script,runtime};
        }
        if(manifest.version!==2||manifest.platform!=='win32'||manifest.runtimeSha256!==this.verifiedFiles.runtime||manifest.scriptSha256!==this.verifiedFiles.script)throw Error('unmatched runtime');
      }catch{value.installed=false;value.status='needsRepair';value.reason='Windows 钩子程序缺失或与安装记录不一致，请修复接入';}
    }
    return value;
  }
}
