import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {root,binaries,target,cargoOutputDirectory} from './common.mjs';
const execute=promisify(execFile);
export const sidecarNames=['node','hid','desktop-io','agent-probe','sqlite'].map(name=>`nuphylab-${name}-${target}.exe`);
const secure=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&(!u.port||u.port==='443')?u:null;}catch{return null;}};
export function validateRelease(config,env=process.env){
  if(config?.version!==1||config.enabled!==true||!['beta','stable'].includes(config.channel))throw Error('请先配置独立的 Windows 发布通道');
  if(typeof config.pubkey!=='string'||config.pubkey.length>2048)throw Error('Windows 更新公钥无效');
  const key=Buffer.from(config.pubkey,'base64').toString('utf8');
  const raw=Buffer.from(key.trim().split(/\r?\n/).at(-1)??'','base64');
  if(config.pubkey.length>2048||!key.startsWith('untrusted comment:')||raw.length!==42||raw.subarray(0,2).toString()!=='Ed')throw Error('Windows 更新公钥无效');
  if(!Array.isArray(config.endpoints)||!config.endpoints.length||config.endpoints.length>3||config.endpoints.some(v=>!secure(v)))throw Error('更新检查地址必须使用 HTTPS');
  if(!Array.isArray(config.allowedDownloadHosts)||!config.allowedDownloadHosts.length||config.allowedDownloadHosts.length>16||config.allowedDownloadHosts.some(v=>typeof v!=='string'||v.length>253||!/^[-a-z0-9.]+$/.test(v)))throw Error('请配置准确的安装包下载域名');
  if(!Array.isArray(config.trustedSignerThumbprints)||!config.trustedSignerThumbprints.length||config.trustedSignerThumbprints.length>4||config.trustedSignerThumbprints.some(v=>!/^[a-fA-F0-9]{40}$/.test(v)))throw Error('请配置可信的 Windows 代码签名证书');
  const thumbprint=env.NUPHYLAB_CERT_THUMBPRINT;
  if(!thumbprint||!config.trustedSignerThumbprints.some(v=>v.toUpperCase()===thumbprint.toUpperCase()))throw Error('构建证书不在已配置的发布者范围内');
  if(!env.TAURI_SIGNING_PRIVATE_KEY)throw Error('缺少 Tauri 更新签名密钥');
  if(!secure(env.NUPHYLAB_TIMESTAMP_URL))throw Error('请配置 HTTPS 代码签名时间戳地址');
  const download=secure(env.NUPHYLAB_DOWNLOAD_BASE);
  if(!download||!config.allowedDownloadHosts.includes(download.hostname)||download.search)throw Error('发布下载目录不在已配置的下载域名内');
  return {thumbprint,timestampUrl:env.NUPHYLAB_TIMESTAMP_URL,downloadBase:download.href.replace(/\/$/,'')};
}
async function powershell(script,env,run=execute){
  const exe=path.win32.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  try{return await run(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:180000,maxBuffer:1024*1024,env});}
  catch{throw Error('Windows 代码签名或发布者检查失败；未生成发布清单');}
}
export async function signSidecars(release,{env=process.env,run=execute}={}){
  const files=sidecarNames.map(name=>path.join(binaries,name));
  for(const file of files)if(!(await stat(file)).isFile())throw Error('Windows 配套程序缺失');
  const script="$ErrorActionPreference='Stop';$tool=$env:NUPHYLAB_SIGNTOOL;if(-not $tool){$base=Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\\10\\bin';$tool=(Get-ChildItem -LiteralPath $base -Directory|Sort-Object Name -Descending|ForEach-Object {Join-Path $_.FullName 'x64\\signtool.exe'}|Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1)};if(-not $tool){throw 'signtool missing'};foreach($file in ($env:NUPHYLAB_SIGN_FILES|ConvertFrom-Json)){& $tool sign /sha1 $env:NUPHYLAB_CERT_THUMBPRINT /fd SHA256 /tr $env:NUPHYLAB_TIMESTAMP_URL /td SHA256 $file;if($LASTEXITCODE -ne 0){throw 'signing failed'}}";
  await powershell(script,{...env,NUPHYLAB_CERT_THUMBPRINT:release.thumbprint,NUPHYLAB_TIMESTAMP_URL:release.timestampUrl,NUPHYLAB_SIGN_FILES:JSON.stringify(files)},run);
}
export async function writeReleaseArtifacts(config,release,{env=process.env,run=execute}={}){
  const output=path.join(await cargoOutputDirectory({env}),target,'release');
  const directory=path.join(output,'bundle','nsis');
  const installers=(await readdir(directory)).filter(name=>name.endsWith('.exe'));
  // Old installers must not silently become this release's update payload.
  if(installers.length!==1)throw Error('发布目录须仅有本次生成的一个安装包，请先移走旧构建');
  const installer=path.join(directory,installers[0]),files=[installer,path.join(output,'nuphylab-desktop.exe'),...sidecarNames.map(name=>path.join(binaries,name))];
  const script="$ErrorActionPreference='Stop';$expected=$env:NUPHYLAB_CERT_THUMBPRINT;foreach($file in ($env:NUPHYLAB_SIGN_FILES|ConvertFrom-Json)){$s=Get-AuthenticodeSignature -LiteralPath $file;if($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne $expected -or $null -eq $s.TimeStamperCertificate){throw 'untrusted artifact'}}";
  await powershell(script,{...env,NUPHYLAB_CERT_THUMBPRINT:release.thumbprint,NUPHYLAB_SIGN_FILES:JSON.stringify(files)},run);
  const packageInfo=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const signature=(await readFile(installer+'.sig','utf8')).trim();if(!/^[A-Za-z0-9+/=]+$/.test(signature)||signature.length>4096)throw Error('安装包缺少 Tauri 更新签名');
  const artifacts=[];for(const file of files){const bytes=await readFile(file);artifacts.push({file:path.basename(file),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  const metadata={version:packageInfo.version,notes:'Windows 版本更新。安装前将核对签名并恢复键盘。',pub_date:new Date().toISOString(),platforms:{'windows-x86_64':{url:release.downloadBase+'/'+encodeURIComponent(path.basename(installer)),signature}}};
  await writeFile(path.join(directory,`${config.channel}.json`),JSON.stringify(metadata,null,2)+'\n');
  await writeFile(path.join(directory,'verified-artifacts.json'),JSON.stringify({format:'nuphylab-windows-release',version:1,productVersion:packageInfo.version,channel:config.channel,artifacts},null,2)+'\n');
}
