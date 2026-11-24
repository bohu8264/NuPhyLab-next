import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,rename,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {redactToolText} from './common.mjs';
const executeFile=promisify(execFile);
export function githubRepository(origin){
 const match=origin.trim().match(/^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
 if(!match||match[1].split('/').some(x=>x==='.'||x==='..'))throw Error('origin 必须是 GitHub 仓库的 SSH/HTTPS 地址');
 return match[1];
}
export async function fileSha256(file){
 const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');
}
export async function writeAtomicJson(file,value){
 const temporary=file+'.'+process.pid+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2)+'\n');await rename(temporary,file);
}
const input=name=>name==='THIRD_PARTY_NOTICES.md'||!['docs/','tests/','.github/'].some(prefix=>name.startsWith(prefix))&&!(name.indexOf('/')<0&&name.endsWith('.md'));
export async function captureBuildSource(root,{execute=executeFile}={}){
 const git=async args=>(await execute('git',args,{cwd:root,timeout:30000,maxBuffer:8*1024*1024})).stdout.trimEnd();
 try{
  const top=await git(['rev-parse','--show-toplevel']);if(path.relative(await realpath(root),await realpath(top))!=='')throw Error('源码目录不是独立 Git 仓库根目录');
  const commit=await git(['rev-parse','HEAD']);if(!/^[a-f0-9]{40}$/.test(commit))throw Error('无法取得源码提交');
  const repository=githubRepository(await git(['remote','get-url','origin']));
  const listed=(await git(['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0').filter(Boolean).filter(input);
  const files={};for(const name of [...new Set(listed)].sort()){
   const file=path.resolve(root,name);if(path.relative(root,file).startsWith('..'))throw Error('源码路径越界');
   const info=await lstat(file).catch(()=>null);if(info?.isSymbolicLink())throw Error('来源记录不接受源码链接：'+name);
   files[name]=info?.isFile()?await fileSha256(file):'missing';
  }
  const changed=(await git(['diff','--name-only','HEAD','-z'])).split('\0').filter(Boolean).filter(input);
  const untracked=(await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean).filter(input);
  const uploadable=changed.length===0&&untracked.length===0;
  return {format:'nuphylab-build-source',version:1,mode:'git',commit,repository,files,inputsSha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),uploadable,reason:uploadable?null:'构建源码有未提交的实现变更；本地包可保留，自动上传需要已提交的源码'};
 }catch(error){return {format:'nuphylab-build-source',version:1,mode:'unavailable',uploadable:false,reason:redactToolText('无法记录可发布的 Git 来源：'+error.message)};}
}
export async function finishBuildSource(root,before,options){
 const after=await captureBuildSource(root,options);
 const unchanged=before.mode==='git'&&after.mode==='git'&&before.commit===after.commit&&before.repository===after.repository&&before.inputsSha256===after.inputsSha256;
 const uploadable=before.uploadable&&after.uploadable&&unchanged;
 return {mode:before.mode,commit:before.commit??null,repository:before.repository??null,inputsSha256:before.inputsSha256??null,uploadable:Boolean(uploadable),reason:uploadable?null:((before.mode!=='git'||after.mode!=='git')?before.reason||after.reason:(!unchanged?'构建期间源码提交、仓库或输入发生变化，不能自动上传':before.reason||after.reason))};
}

export async function rememberSuccessfulBuild(root,directory){
 const base=path.join(root,'.build/windows/code-sign'),buildId=path.basename(directory);
 if(!/^[a-f0-9]{32}$/.test(buildId)||path.relative(await realpath(base),await realpath(directory))!==buildId)throw Error('成功构建目录无效');
 const file=path.join(directory,'artifacts/build-manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));
 if(manifest.format!=='nuphylab-windows-code-sign'||manifest.version!==2||manifest.stage!=='complete'||manifest.buildId!==buildId)throw Error('成功构建记录无效');
 await writeAtomicJson(path.join(base,'latest-success.json'),{format:'nuphylab-latest-signed-build',version:1,buildId,manifestSha256:await fileSha256(file)});
}
