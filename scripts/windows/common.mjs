import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root=fileURLToPath(new URL('../../',import.meta.url));
export const desktop=path.join(root,'desktop/windows');
export const target='x86_64-pc-windows-msvc';
export const binaries=path.join(desktop,'src-tauri/binaries');
export const resources=path.join(desktop,'resources');
export function redactToolText(text,env=process.env){
 let result=String(text);
 for(const [key,value] of Object.entries(env))if(value&&value.length>=4&&/(?:^|_)(?:TOKEN|PASSWORD|SECRET|PIN|PRIVATE_KEY|API_KEY)$|^NPM_CONFIG_.*AUTH(?:TOKEN)?$/i.test(key))result=result.split(value).join('[REDACTED]');
 return result.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@').replace(/((?:_authToken|password|access_token)\s*[=:]\s*)[^\s&]+/gi,'$1[REDACTED]');
}
// Cargo owns output-directory resolution, including environment and .cargo
// configuration. Never fall back to a possibly stale project/target binary.
export async function cargoOutputDirectory({cwd=root,env=process.env,execute=promisify(execFile)}={}){
  let metadata;
  try{
    const {stdout}=await execute('cargo',['metadata','--locked','--offline','--no-deps','--format-version','1'],
      {cwd,env,windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
    metadata=JSON.parse(stdout);
  }catch(error){
    const reason=error.killed?'查询超时（30 秒）；请先完成 Rust 工具链准备':String(error.code??error.name??'查询失败');
    const detail=redactToolText([error.stderr,error.stdout,error.message].filter(Boolean).join('\n')).slice(-8192);
    throw Error('无法取得 Cargo 构建产物目录，未使用旧构建\n命令：cargo metadata --locked --offline --no-deps --format-version 1\n'+reason+'\n'+detail);
  }
  if(metadata?.version!==1||typeof metadata.workspace_root!=='string'||!path.isAbsolute(metadata.workspace_root)||path.relative(cwd,metadata.workspace_root)!==''||
    typeof metadata.target_directory!=='string'||!path.isAbsolute(metadata.target_directory)||/[\x00-\x1f\x7f]/.test(metadata.target_directory))
    throw Error('Cargo 构建目录或工作区不匹配，未使用旧构建');
  return metadata.target_directory;
}
export function requireWindows(){if(process.platform!=='win32'||process.arch!=='x64')throw new Error('请在 Windows x64 电脑上运行此命令。');}
export function run(command,args,{cwd=root,env=process.env,interactive=false}={}){
  return new Promise((resolve,reject)=>{
    const display=redactToolText([command,...args].map(x=>JSON.stringify(x)).join(' '),env),started=Date.now();
    console.error('[执行] '+display);
    // Headless tools must not depend on the caller's Windows input handle.
    const child=spawn(command,args,{cwd,env,stdio:[interactive?'inherit':'ignore','inherit','inherit'],windowsHide:true});
    const heartbeat=setInterval(()=>console.error('['+path.basename(command)+'] 仍在执行（'+Math.floor((Date.now()-started)/1000)+' 秒）'),15000);
    child.once('error',error=>{clearInterval(heartbeat);reject(Error(redactToolText('无法启动 '+display+'\n'+error.code+' '+error.message,env)));});
    child.once('exit',(code,signal)=>{clearInterval(heartbeat);code===0?resolve():reject(Error(display+' 执行失败：'+(code??signal)));});
  });
}
