import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {target,redactToolText} from './common.mjs';

export function assertSigningNode(version,arch,platform){
 if(platform!=='win32'||arch!=='x64')throw Error('请使用 Windows x64 Node');
 if(Number(version.split('.')[0])<22)throw Error('Node 版本不支持：'+version+'；需要 Node >=22，项目验收版本见 .nvmrc');
}
export async function signingToolchain(root){
 const text=await readFile(path.join(root,'rust-toolchain.toml'),'utf8');
 const channel=text.match(/^channel\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
 const profile=text.match(/^profile\s*=\s*"(minimal|default|complete)"\s*$/m)?.[1];
 const components=text.match(/^components\s*=\s*(\[[^\n]*\])\s*$/m)?.[1];
 if(!channel||!profile||!components)throw Error('rust-toolchain.toml 必须声明固定版本、profile 和 components');
 const names=JSON.parse(components);if(!Array.isArray(names)||names.some(x=>typeof x!=='string'||!/^[-a-z0-9]+$/.test(x)))throw Error('Rust components 配置无效');
 return {name:channel+'-'+target,profile,components:names};
}
export function runPreparation(command,args,{cwd,env=process.env,label='依赖准备',timeoutMs=30*60*1000,heartbeatMs=15000,log=console.log}={}){
 return new Promise((resolve,reject)=>{
  const started=Date.now(),display=[command,...args].map(x=>JSON.stringify(x)).join(' '),tail=[];
  const safe=x=>redactToolText(x,env);log(safe('['+label+'] '+display));
  const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let timedOut=false,finished=false;
  const emit=line=>{const value=safe(line);tail.push(value);if(tail.length>30)tail.shift();log(value);};
  const readers=[child.stdout,child.stderr].map(stream=>createInterface({input:stream,crlfDelay:Infinity}));
  for(const reader of readers)reader.on('line',emit);
  const heartbeat=setInterval(()=>log('['+label+'] 仍在执行（'+Math.floor((Date.now()-started)/1000)+' 秒）'),heartbeatMs);
  const timeout=setTimeout(()=>{
   timedOut=true;
   if(process.platform==='win32'&&child.pid){
    const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    killer.on('error',()=>child.kill());killer.on('exit',code=>{if(code!==0)child.kill();});
   }else child.kill('SIGKILL');
  },timeoutMs);
  function finish(error){
   if(finished)return;finished=true;clearInterval(heartbeat);clearTimeout(timeout);for(const reader of readers)reader.close();
   if(error)reject(error);else{log('['+label+'] 完成（'+Math.ceil((Date.now()-started)/1000)+' 秒）');resolve();}
  }
  child.once('error',error=>finish(Error(safe(label+' 无法启动：'+display+'\n'+error.code+' '+error.message))));
  child.once('close',(code,signal)=>{
   if(code===0&&!timedOut){finish();return;}
   finish(Error(safe(label+(timedOut?' 超时（'+Math.ceil(timeoutMs/1000)+' 秒）':' 失败，退出码 '+(code??signal))+CommandSuffix(display,tail))));
  });
 });
}
function CommandSuffix(display,tail){return '\n命令：'+display+(tail.length?'\n'+tail.join('\n'):'');}
const exists=async file=>(await stat(file).catch(()=>null))?.isFile()===true;
const supported=(values,current)=>!values||(!values.includes('!'+current)&&(!values.some(x=>!x.startsWith('!'))||values.includes(current)));
async function dependencyProblem(project){
 const {cwd,lock}=project;
 for(const [relative,pkg] of Object.entries(lock.packages??{})){
  if(!relative.startsWith('node_modules/'))continue;
  if(!supported(pkg.os,process.platform)||!supported(pkg.cpu,process.arch))continue;
  const directory=path.resolve(cwd,relative);
  if(!directory.startsWith(path.join(cwd,'node_modules')+path.sep))throw Error('依赖路径越界：'+relative);
  let installed;try{installed=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));}catch{return relative+' 缺失或损坏';}
  if(installed.version!==pkg.version)return relative+' 版本与锁文件不一致';
  const bins=typeof installed.bin==='string'?[installed.bin]:Object.values(installed.bin??{});
  for(const bin of bins)if(!(await exists(path.join(directory,bin))))return relative+'/'+bin+' 缺失';
  if(installed.main?.endsWith('.node')&&!(await exists(path.join(directory,installed.main))))return relative+' 原生模块缺失';
 }
 return null;
}
export async function prepareSigningDependencies({root,npm,run=runPreparation,log=console.log,env=process.env}={}){
 const projects=[];
 // Validate both inputs before any network or node_modules mutation.
 for(const folder of ['','ui']){
  const cwd=path.join(root,folder);let pkg,lock;
  try{pkg=await readFile(path.join(cwd,'package.json'));lock=await readFile(path.join(cwd,'package-lock.json'));}
  catch(error){throw Error('依赖输入缺失：'+path.join(folder,'package-lock.json')+' / package.json\n'+error.message);}
  let parsed;try{parsed=JSON.parse(lock);}catch(error){throw Error(path.join(cwd,'package-lock.json')+' 无法解析：'+error.message);}
  if(parsed.lockfileVersion<2||!parsed.packages)throw Error('不支持的依赖锁文件：'+cwd);
  const fingerprint=createHash('sha256').update(pkg).update(lock).update(process.version+' '+process.platform+' '+process.arch).digest('hex');
  projects.push({cwd,lock:parsed,fingerprint,label:folder||'根目录',receipt:path.join(root,'.build/windows/code-sign/dependencies',folder||'root')+'.json'});
 }
 for(const project of projects){const problem=await dependencyProblem(project);if(problem)log('['+project.label+'依赖检查] '+problem+'；将在编译前自动安装');}
 const toolchain=await signingToolchain(root),rustEnv={...env,RUSTUP_TOOLCHAIN:toolchain.name};
 log('Node '+process.versions.node+'；项目已验收版本 '+(await readFile(path.join(root,'.nvmrc'),'utf8')).trim());
 await run('rustup',['toolchain','install',toolchain.name,'--profile',toolchain.profile,...toolchain.components.flatMap(x=>['--component',x]),'--target',target],{cwd:root,env:rustEnv,label:'Rust 工具链准备',log});
 await run('rustup',['run',toolchain.name,'rustc','--version'],{cwd:root,env:rustEnv,label:'Rust 工具链验证',log});
 for(const project of projects){
  let receipt;try{receipt=JSON.parse(await readFile(project.receipt,'utf8'));}catch{receipt=null;}
  const problem=await dependencyProblem(project);
  if(receipt?.fingerprint===project.fingerprint&&!problem){log('['+project.label+'依赖] 已完整校验，复用现有安装');continue;}
  log('['+project.label+'依赖] '+(problem||'尚未验证当前锁文件及 Node 环境')+'；按锁文件自动安装');
  await rm(project.receipt,{force:true});
  await run(npm.command,[...npm.args,'ci','--include=dev','--include=optional','--no-audit','--no-fund'],{cwd:project.cwd,env:rustEnv,label:project.label+' npm ci',log});
  const remaining=await dependencyProblem(project);if(remaining)throw Error(project.label+'依赖安装后仍不完整：'+remaining);
  await mkdir(path.dirname(project.receipt),{recursive:true});await writeFile(project.receipt,JSON.stringify({fingerprint:project.fingerprint})+'\n');
 }
 return toolchain;
}
