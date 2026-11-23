import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root=fileURLToPath(new URL('../../',import.meta.url));
export const desktop=path.join(root,'desktop/windows');
export const target='x86_64-pc-windows-msvc';
export const binaries=path.join(desktop,'src-tauri/binaries');
export const resources=path.join(desktop,'resources');
// Cargo owns output-directory resolution, including environment and .cargo
// configuration. Never fall back to a possibly stale project/target binary.
export async function cargoOutputDirectory({cwd=root,env=process.env,execute=promisify(execFile)}={}){
  let metadata;
  try{
    const {stdout}=await execute('cargo',['metadata','--locked','--offline','--no-deps','--format-version','1'],
      {cwd,env,windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
    metadata=JSON.parse(stdout);
  }catch{throw Error('无法取得 Cargo 构建产物目录，未使用旧构建');}
  if(metadata?.version!==1||typeof metadata.workspace_root!=='string'||!path.isAbsolute(metadata.workspace_root)||path.relative(cwd,metadata.workspace_root)!==''||
    typeof metadata.target_directory!=='string'||!path.isAbsolute(metadata.target_directory)||/[\x00-\x1f\x7f]/.test(metadata.target_directory))
    throw Error('Cargo 构建目录或工作区不匹配，未使用旧构建');
  return metadata.target_directory;
}
export function requireWindows(){if(process.platform!=='win32'||process.arch!=='x64')throw new Error('请在 Windows x64 电脑上运行此命令。');}
export function run(command,args,{cwd=root,env=process.env}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:'inherit',windowsHide:true});
    child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${path.basename(command)} 执行失败：${code??signal}`)));
  });
}
