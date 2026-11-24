import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,copyFile,mkdtemp,rm,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {root as projectRoot,requireWindows,redactToolText} from './common.mjs';
import {githubRepository,fileSha256,writeAtomicJson} from './build-source.mjs';
import {assertSigningNode} from './signing-dependencies.mjs';
const executeFile=promisify(execFile),hash=/^[a-f0-9]{64}$/i;
const payloadNames=['nuphylab-desktop.exe',...['node','hid','desktop-io','agent-probe','sqlite'].map(x=>'nuphylab-'+x+'-x86_64-pc-windows-msvc.exe')];
const parse=async file=>JSON.parse(await readFile(file,'utf8'));
export async function readUploadBuild(root){
 const base=path.join(root,'.build/windows/code-sign');let latest;
 try{latest=await parse(path.join(base,'latest-success.json'));}catch{throw Error('没有可关联来源的成功构建，请使用新入口重新签名打包');}
 if(latest.format!=='nuphylab-latest-signed-build'||latest.version!==1||!/^[a-f0-9]{32}$/.test(latest.buildId)||!hash.test(latest.manifestSha256))throw Error('最近成功构建记录无效，请重新签名打包');
 const directory=path.join(base,latest.buildId),actual=await realpath(directory),actualBase=await realpath(base);
 if(path.relative(actualBase,actual)!==latest.buildId)throw Error('构建目录越界或通过链接指向其他位置');
 const artifacts=path.join(directory,'artifacts'),manifestFile=path.join(artifacts,'build-manifest.json');
 if(await fileSha256(manifestFile)!==latest.manifestSha256)throw Error('构建清单摘要不匹配');
 const manifest=await parse(manifestFile),source=manifest.source;
 if(manifest.format!=='nuphylab-windows-code-sign'||manifest.version!==2||manifest.stage!=='complete'||manifest.buildId!==latest.buildId||manifest.updaterArtifacts!==false)throw Error('需要新版入口产生的完整签名构建；旧包请重新打包');
 if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.productVersion))throw Error('构建版本无效');
 if(source?.mode!=='git'||source.uploadable!==true||!/^[a-f0-9]{40}$/.test(source.commit??'')||!hash.test(source.inputsSha256??''))throw Error('构建来源不可自动上传：'+(source?.reason||'缺少来源记录，请重新签名打包'));
 githubRepository('https://github.com/'+source.repository);
 if(!/^[a-f0-9]{40}$/i.test(manifest.certificateThumbprint??''))throw Error('签名证书记录无效');
 const expectedInstaller='NuPhyLab-'+manifest.productVersion+'-windows-x64-signed-setup.exe';
 if(manifest.installer?.file!==expectedInstaller||!hash.test(manifest.installer.sha256??'')||!Number.isSafeInteger(manifest.installer.bytes))throw Error('安装器记录无效');
 if(manifest.payload?.length!==6||new Set(manifest.payload.map(x=>x.file)).size!==6||manifest.payload.some(x=>!payloadNames.includes(x.file)||!hash.test(x.sha256??'')))throw Error('签名载荷清单必须包含六个指定程序');
 async function check(file,expected,size){
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('附件不是普通文件：'+path.basename(file));
  const relative=path.relative(actual,await realpath(file));if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('附件路径越界');
  if(size!==undefined&&info.size!==size)throw Error('安装器大小与构建清单不符');
  if(await fileSha256(file)!==expected.toLowerCase())throw Error('文件摘要与构建清单不符：'+path.basename(file));
  return {path:file,name:path.basename(file),sha256:expected.toLowerCase(),bytes:info.size};
 }
 const installer=await check(path.join(artifacts,expectedInstaller),manifest.installer.sha256,manifest.installer.bytes);
 for(const item of manifest.payload)await check(path.join(directory,'payload',item.file),item.sha256);
 const checksumFile=path.join(artifacts,'checksums.txt');
 if((await readFile(checksumFile,'utf8')).trim()!==manifest.installer.sha256+'  '+expectedInstaller)throw Error('安装器校验文件内容冲突');
 const assets=[installer];for(const file of [checksumFile,manifestFile])assets.push(await check(file,await fileSha256(file)));
 return {directory,manifest,assets,repository:source.repository,tag:'v'+manifest.productVersion+'-windows.'+manifest.buildId};
}
export async function uploadRelease({root=projectRoot,publish=false,execute=executeFile,verifySignatures,log=console.log}={}){
 const build=await readUploadBuild(root),{manifest,repository,tag}=build,ghRepository='github.com/'+repository;
 async function command(program,args){
  if(program==='gh'&&args[0]==='api')args=[...args,'--hostname','github.com'];
  const display=redactToolText(program+' '+args.map(x=>JSON.stringify(x)).join(' '));log('[发布] '+display);
  const timer=setInterval(()=>log('[发布] 仍在执行：'+program+' '+args[0]),15000);
  try{return await execute(program,args,{cwd:root,timeout:args[1]==='upload'||args[1]==='download'?600000:30000,maxBuffer:4*1024*1024,windowsHide:true});}
  catch(error){const detail=redactToolText(error.stderr||error.message);throw Object.assign(Error(display+' 失败（'+(error.killed?'超时':error.code??'未知退出码')+'）\n'+detail),{code:error.code,stderr:detail});}
  finally{clearInterval(timer);}
 }
 const json=async args=>{const result=await command('gh',args);try{return JSON.parse(result.stdout);}catch{throw Error('GitHub 返回无效 JSON：'+args.join(' '));}};
 const optional=async endpoint=>{try{return await json(['api',endpoint]);}catch(error){if(/HTTP 404\b/.test(error.stderr??''))return null;throw error;}};
 async function releaseInfo(){
  let value;
  try{value=await json(['release','view',tag,'--repo',ghRepository,'--json','isDraft,isPrerelease,tagName,targetCommitish,assets,url']);}
  catch(error){if(/^release not found\s*$/im.test(error.stderr??''))return null;throw error;}
  return {draft:value.isDraft,prerelease:value.isPrerelease,tag_name:value.tagName,target_commitish:value.targetCommitish,assets:value.assets,html_url:value.url};
 }
 const origin=githubRepository((await command('git',['remote','get-url','origin'])).stdout);
 if(origin!==repository)throw Error('当前 origin 与构建记录仓库不同，停止上传');
 log('版本 '+manifest.productVersion+'；构建 '+manifest.buildId+'；源码 '+manifest.source.commit+'；仓库 '+repository);
 await command('gh',['auth','status','--hostname','github.com']);
 if(typeof verifySignatures!=='function')throw Error('缺少 Windows 原生签名复核');await verifySignatures(build);
 const endpoint='repos/'+repository;
 let sourceCommit,sourceError;try{sourceCommit=await json(['api',endpoint+'/commits/'+manifest.source.commit]);}catch(error){if(!/HTTP (404|422)\b/.test(error.stderr??''))throw error;sourceError=error;}
 if(sourceCommit?.sha!==manifest.source.commit)throw Error('GitHub 无法确认来源提交（可能未推送或权限不足）；脚本不会自动推送\n'+(sourceError?.message||'返回的提交与构建记录不一致'));
 async function tagCommit(){
  const ref=await optional(endpoint+'/git/ref/tags/'+tag);if(!ref)return null;
  if(ref.object?.type==='commit'&&/^[a-f0-9]{40}$/.test(ref.object.sha))return {sha:ref.object.sha};
  if(ref.object?.type==='tag')return json(['api',endpoint+'/commits/'+tag]);
  throw Error('远端标签记录无效');
 }
 const remoteTag=await tagCommit();
 if(remoteTag&&remoteTag.sha!==manifest.source.commit)throw Error('已有标签指向其他源码提交，停止上传');
 let release=await releaseInfo();
 function validateRelease(value){
  if(!value||typeof value.draft!=='boolean'||typeof value.html_url!=='string'||!value.html_url.startsWith('https://github.com/'+repository+'/releases/')||!Array.isArray(value.assets)||value.assets.some(x=>!build.assets.some(a=>a.name===x.name))||value.tag_name!==tag||(!remoteTag&&value.target_commitish!==manifest.source.commit)||value.prerelease!==true)throw Error('现有 Release 与构建来源或预发布类型冲突');
 }
 if(release)validateRelease(release);
 const temporary=await mkdtemp(path.join(tmpdir(),'NuPhy release upload '));
 try{
  const frozen=[];for(const asset of build.assets){const file=path.join(temporary,asset.name);await copyFile(asset.path,file);if(await fileSha256(file)!==asset.sha256)throw Error('准备上传时本地附件摘要变化：'+asset.name);frozen.push({...asset,path:file});}
  if(!release){
   const notes=path.join(temporary,'release-notes.txt');await writeFile(notes,'Windows x64 签名预览包 '+manifest.productVersion+'。\n源码：'+manifest.source.commit+'\n构建：'+manifest.buildId+'\n自动更新保持关闭。\n');
   await command('gh',['release','create',tag,'--repo',ghRepository,'--target',manifest.source.commit,'--draft','--prerelease','--latest=false','--title','NuPhy Lab '+manifest.productVersion+' Windows 预览包','--notes-file',notes]);
   release=await releaseInfo();validateRelease(release);
  }
  async function sameAsset(remote,asset){
   if(remote.state!=='uploaded'||remote.size!==asset.bytes)throw Error('远端附件大小或状态冲突：'+asset.name);
   if(remote.digest?.startsWith('sha256:')){if(remote.digest.slice(7).toLowerCase()!==asset.sha256)throw Error('远端同名附件摘要冲突：'+asset.name);return;}
   const download=await mkdtemp(path.join(temporary,'download-'));
   await command('gh',['release','download',tag,'--repo',ghRepository,'--pattern',asset.name,'--dir',download]);
   if(await fileSha256(path.join(download,asset.name))!==asset.sha256)throw Error('远端同名附件内容冲突：'+asset.name);
  }
  for(const asset of frozen){
   const matches=release.assets.filter(x=>x.name===asset.name);if(matches.length>1)throw Error('远端同名附件重复：'+asset.name);
   if(matches.length){await sameAsset(matches[0],asset);log('[发布] 附件摘要相同，跳过：'+asset.name);continue;}
   if(!release.draft)throw Error('已发布 Release 缺少附件；不自动修改已公开版本：'+asset.name);
   await command('gh',['release','upload',tag,asset.path,'--repo',ghRepository]);
   release=await releaseInfo();validateRelease(release);
   const uploaded=release.assets.find(x=>x.name===asset.name);if(!uploaded)throw Error('上传后无法找到附件：'+asset.name);await sameAsset(uploaded,asset);
  }
  const finalTag=await tagCommit();
  if(finalTag&&finalTag.sha!==manifest.source.commit)throw Error('上传期间标签源码发生变化，停止发布');
  if(publish&&release.draft){
   await command('gh',['release','edit',tag,'--repo',ghRepository,'--draft=false','--prerelease','--latest=false']);
   release=await releaseInfo();validateRelease(release);if(release.draft)throw Error('GitHub 仍返回草稿状态，未确认发布成功');
   if((await tagCommit())?.sha!==manifest.source.commit)throw Error('公开后标签来源复核失败，请检查 Release；未自动删除或改写');
  }
  const result={repository,tag,url:release.html_url,published:!release.draft,buildId:manifest.buildId,verifiedAssets:frozen.map(x=>({name:x.name,sha256:x.sha256}))};
  await writeAtomicJson(path.join(build.directory,'github-upload.json'),result);log((result.published?'预发布链接：':'草稿链接：')+result.url);return result;
 }finally{await rm(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  requireWindows();assertSigningNode(process.versions.node,process.arch,process.platform);const args=process.argv.slice(2);if(args.length>1||(args.length===1&&args[0]!=='--publish'))throw Error('用法：upload [--publish]');
  await uploadRelease({publish:args.includes('--publish'),verifySignatures:async build=>{
   try{await executeFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(projectRoot,'scripts/windows/upload.ps1'),'-VerifyDirectory',build.directory],{timeout:120000,windowsHide:true});}
   catch(error){throw Error(redactToolText('Windows 签名复核失败：'+(error.stderr||error.message)));}
  }});
 }catch(error){console.error(error.message);process.exitCode=1;}
}
