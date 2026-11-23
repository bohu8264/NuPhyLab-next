import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,copyFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';import {once} from 'node:events';import {promisify} from 'node:util';
import {installerDefinitions} from '../scripts/windows/installer.mjs';
import contract from '../shared/contracts/windows-installation.json' with {type:'json'};
import config from '../desktop/windows/src-tauri/tauri.windows.conf.json' with {type:'json'};
test('installer guard derives its encoded command and namespace from the versioned source',async()=>{
  const definitions=await installerDefinitions(),encoded=definitions.match(/!define NUPHYLAB_PROCESS_CHECK "([^"]+)"/)[1];
  assert(encoded.length<=850);assert(definitions.includes(contract.mutex));
  const decoded=Buffer.from(encoded,'base64').toString('utf16le');assert.match(decoded,/Get-Process/);assert.match(decoded,/Start-Sleep -Milliseconds 200/);
  assert.doesNotMatch(decoded,/Stop-Process|taskkill|RmShutdown|Remove-Item|Invoke-Expression/);
  assert.equal(config.bundle.windows.nsis.installerHooks,'installer-hooks.nsh');
  const hooks=await readFile(new URL('../desktop/windows/src-tauri/installer-hooks.nsh',import.meta.url),'utf8');
  assert.match(hooks,/!macroundef CheckIfAppIsRunning/);assert.match(hooks,/!macro NSIS_HOOK_PREINSTALL/);assert.match(hooks,/!macro NSIS_HOOK_PREUNINSTALL/);
});
test('Windows process guard distinguishes an owned running test process absent process and unknown query',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'NuPhy installer guard 0 '));let child,exited;
  t.after(async()=>{if(child){if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}await rm(directory,{recursive:true,force:true});});
  const name='NuPhyLab-Guard-QA-'+process.pid,exe=path.join(directory,name+'.exe');await copyFile(process.execPath,exe);
  child=spawn(exe,['-e',"process.stdout.write('ready\\n');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore'],windowsHide:true});exited=once(child,'close');await once(child.stdout,'data');
  let source=await readFile(new URL('../desktop/windows/src-tauri/installer-process-check.ps1',import.meta.url),'utf8');
  source=source.replace(/'\^nuphylab-[^']+'/g,JSON.stringify('^'+name+'$')).replace('$i-lt 100','$i-lt 1');
  const file=path.join(directory,'guard.ps1');await writeFile(file,source);
  const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),run=promisify(execFile);
  const check=()=>run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{windowsHide:true,timeout:5000,maxBuffer:2048});
  await assert.rejects(check(),e=>e.code===1);child.kill();await exited;await check();
  await writeFile(file,"function Get-Process { throw 'fixture query denied' };\n"+source);await assert.rejects(check(),e=>e.code===2);
});
