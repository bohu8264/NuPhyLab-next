import {mkdir,cp,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {KEYBOARD_MODELS} from '../../shared/keyboard-models.mjs';
import {RUNTIME_VERSION} from '../fetch-node.mjs';
import {fetchWindowsSQLite} from './fetch-sqlite.mjs';
import {prepareInstaller} from './installer.mjs';
import {root,desktop,target,binaries,resources,requireWindows,run,cargoOutputDirectory} from './common.mjs';

export function deviceModels(){return Object.entries(KEYBOARD_MODELS).map(([id,p])=>({id,name:p.name,vendorId:p.vendorId,productIds:p.productIds,
  keyCount:p.keyCount,sideCount:p.sideCount,canvasCount:p.canvasCount,rows:p.rows,columns:p.columns,extraKeys:p.extraKeys,qualifiedFirmware:p.windowsQualifiedFirmware??p.qualifiedFirmware,lightingStateLength:p.lightingStateLength,lightingRecoveryPolicy:p.lightingRecoveryPolicy,
  rgbWriteIndices:p.rgbWriteIndices??Array.from({length:p.keyCount},(_,i)=>i)}));}

export async function prepareResources(){
  await prepareInstaller();
  await mkdir(resources,{recursive:true});
  for(const name of ['server','shared','hooks'])await cp(path.join(root,name),path.join(resources,name),{recursive:true,force:true});
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])await copyFile(path.join(root,name),path.join(resources,name));
  await copyFile(path.join(root,'assets/LICENSE.node'),path.join(resources,'LICENSE.node'));
  await copyFile(path.join(root,'assets/LICENSE.sqlite'),path.join(resources,'LICENSE.sqlite'));
  await writeFile(path.join(resources,'models.json'),JSON.stringify(deviceModels(),null,2)+'\n');
  // ICO supports a PNG image directly. Reuse the existing 256px RGBA logo.
  const png=await readFile(path.join(root,'ui/public/nuphy-studio.png'));
  if(png.readUInt32BE(16)!==256||png.readUInt32BE(20)!==256)throw new Error('Windows 图标需要 256×256 的现有 PNG');
  const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);
  await mkdir(path.join(desktop,'src-tauri/icons'),{recursive:true});
  await copyFile(path.join(root,'ui/public/nuphy-studio.png'),path.join(desktop,'src-tauri/icons/icon.png'));
  await writeFile(path.join(desktop,'src-tauri/icons/icon.ico'),Buffer.concat([ico,png]));
}

export async function fetchWindowsNode(){
  if(!/^v\d+\.\d+\.\d+$/.test(RUNTIME_VERSION))throw new Error('Node 版本格式无效');
  const base=`https://nodejs.org/dist/${RUNTIME_VERSION}`;
  const sums=await fetch(`${base}/SHASUMS256.txt`);if(!sums.ok)throw new Error('无法取得 Node 官方校验值');
  const expected=(await sums.text()).split('\n').map(row=>row.trim().split(/\s+/)).find(([,name])=>name==='win-x64/node.exe')?.[0];
  if(!expected||!/^[a-f0-9]{64}$/.test(expected))throw new Error('Node 官方校验值缺失');
  const output=path.join(binaries,`nuphylab-node-${target}.exe`);
  const existing=await readFile(output).catch(()=>null);
  if(existing&&createHash('sha256').update(existing).digest('hex')===expected)return output;
  const response=await fetch(`${base}/win-x64/node.exe`);if(!response.ok)throw new Error('无法下载 Windows Node 运行时');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>100*1024*1024||createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Windows Node 校验失败');
  await mkdir(binaries,{recursive:true});await writeFile(output,bytes);
  return output;
}
export async function prepare({resourcesOnly=false}={}){
  if(!resourcesOnly)requireWindows();
  await prepareResources();
  if(resourcesOnly)return;
  await fetchWindowsNode();
  await fetchWindowsSQLite();
  await run('cargo',['build','--locked','--release','--target',target,'-p','nuphylab-hid']);
  const release=path.join(await cargoOutputDirectory(),target,'release');
  await mkdir(binaries,{recursive:true});
  await copyFile(path.join(release,'nuphylab-hid.exe'),path.join(binaries,`nuphylab-hid-${target}.exe`));
  await copyFile(path.join(release,'nuphylab-desktop-io.exe'),path.join(binaries,`nuphylab-desktop-io-${target}.exe`));
  await copyFile(path.join(release,'nuphylab-agent-probe.exe'),path.join(binaries,`nuphylab-agent-probe-${target}.exe`));
  console.log('Windows 后台、采集与键盘资源已准备好；实际功能按设备资格启用。');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await prepare({resourcesOnly:process.argv.includes('--resources-only')});}catch(error){console.error(error.message);process.exitCode=1;}
}
