import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {desktop} from './common.mjs';
import contract from '../../shared/contracts/windows-installation.json' with {type:'json'};
import packageInfo from '../../package.json' with {type:'json'};
export async function installerDefinitions(){
  if(contract.version!==1||packageInfo.devDependencies['@tauri-apps/cli']!==contract.tauriCli||!/^Local\\NuPhyLab\.[A-Za-z0-9.]+$/.test(contract.mutex))throw Error('安装器契约或 Tauri CLI 版本发生变化，请重新审核安装保护');
  const source=await readFile(path.join(desktop,'src-tauri/installer-process-check.ps1'),'utf8');
  const script=source.split(/\r?\n/).map(row=>row.trim()).filter(row=>row&&!row.startsWith('#')).join('');
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  if(encoded.length>850)throw Error('安装器检查命令超出 NSIS 字符串预算');
  return `; Generated from the installation contract and process-check script.\n!define NUPHYLAB_INSTALL_MUTEX "${contract.mutex}"\n!define NUPHYLAB_PROCESS_CHECK "${encoded}"\n`;
}
export async function prepareInstaller(){await writeFile(path.join(desktop,'src-tauri/installer-guard.generated.nsh'),await installerDefinitions());}
