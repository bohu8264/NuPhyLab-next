import {mkdtemp,readFile,writeFile,mkdir,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import lock from '../../shared/contracts/windows-runtime-lock.json' with {type:'json'};
import {binaries,target,requireWindows} from './common.mjs';
const run=promisify(execFile),digest=(bytes,kind='sha256')=>createHash(kind).update(bytes).digest('hex');
export async function extractWindowsSQLite(zip,expanded,{execute=run}={}){
  // Avoid the Archive module inherited from pwsh 7: Windows PowerShell 5
  // cannot use its newer ExtractToDirectory(string,string,bool) overload.
  const script="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive=[System.IO.Compression.ZipFile]::OpenRead($env:NUPHYLAB_SQLITE_ZIP); try { $entry=$archive.GetEntry('sqlite3.exe'); if($null -eq $entry){throw 'SQLite archive is missing sqlite3.exe'}; [System.IO.Directory]::CreateDirectory($env:NUPHYLAB_SQLITE_DEST) | Out-Null; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry,[System.IO.Path]::Combine($env:NUPHYLAB_SQLITE_DEST,'sqlite3.exe')) } finally { $archive.Dispose() }";
  const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  try{
    await execute(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,env:{...process.env,NUPHYLAB_SQLITE_ZIP:zip,NUPHYLAB_SQLITE_DEST:expanded}});
  }catch(cause){
    const timedOut=cause.killed===true&&cause.code==null;
    const detail=String(cause.stderr||cause.message||'').trim().slice(-4096);
    throw new Error(timedOut?'SQLite 解压超时（30 秒）':'SQLite 解压失败（退出码 '+(cause.code??'unknown')+'）：'+detail,{cause});
  }
}
export async function fetchWindowsSQLite(){
  requireWindows();const rule=lock.sqlite,output=path.join(binaries,`nuphylab-sqlite-${target}.exe`);
  const existing=await readFile(output).catch(()=>null);
  if(existing&&digest(existing)===rule.executableSha256)return output;
  const response=await fetch(rule.url,{redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('无法下载 SQLite 官方工具');
  const chunks=[];let size=0;const reader=response.body?.getReader();if(!reader)throw Error('SQLite 下载没有内容');
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>40*1024*1024){await reader.cancel();throw Error('SQLite 下载超过大小限制');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=Buffer.concat(chunks,size);
  if(bytes.length>40*1024*1024||digest(bytes)!==rule.archiveSha256||digest(bytes,'sha3-256')!==rule.archiveSha3)throw Error('SQLite 官方工具校验失败');
  const directory=await mkdtemp(path.join(tmpdir(),'NuPhy SQLite '));
  try{
    const zip=path.join(directory,'sqlite.zip'),expanded=path.join(directory,'tools');await writeFile(zip,bytes);
    await extractWindowsSQLite(zip,expanded);
    const executable=path.join(expanded,'sqlite3.exe'),binary=await readFile(executable);
    if(digest(binary)!==rule.executableSha256)throw Error('SQLite 可执行文件校验失败');
    await mkdir(binaries,{recursive:true});await copyFile(executable,output);return output;
  }finally{await rm(directory,{recursive:true,force:true});}
}
