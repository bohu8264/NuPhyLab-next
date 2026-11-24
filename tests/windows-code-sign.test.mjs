import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {tmpdir} from 'node:os';
const execute=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const helper=()=>import('../scripts/windows/code-sign.mjs');
test('code signing accepts disabled OTA and never produces updater configuration',async()=>{
  const {bundleConfiguration}=await helper();
  const config=bundleConfiguration(path.join(root,'.build','fixture 空格'));
  assert.equal(JSON.parse(await readFile(path.join(root,'shared/contracts/windows-release.json'))).enabled,false);
  assert.equal(config.bundle.createUpdaterArtifacts,false);
  assert.equal(config.bundle.windows.certificateThumbprint,null);
  assert.equal(config.bundle.windows.signCommand,null);
  assert.equal(config.bundle.externalBin.length,5);
  const configRoot=path.join(root,'desktop/windows/src-tauri'),payload=path.join(root,'.build','fixture 空格','payload');
  for(const [index,name] of ['node','hid','desktop-io','agent-probe','sqlite'].entries())assert.equal(path.resolve(configRoot,config.bundle.externalBin[index]),path.join(payload,'nuphylab-'+name),'Tauri resolves paths beside its config');
  assert.equal(path.resolve(configRoot,Object.keys(config.bundle.resources)[0]),path.join(payload,'runtime'));
});
test('NSIS marker preparation changes only one marker and rejects ambiguous or missing inputs',async()=>{
  const {prepareNsisMain}=await helper();
  const input=Buffer.from('prefix __TAURI_BUNDLE_TYPE_VAR_UNK middle __TAURI_BUNDLE_TYPE_VAR_NSS suffix');
  const output=prepareNsisMain(input);
  assert.equal(output.toString(),'prefix __TAURI_BUNDLE_TYPE_VAR_NSS middle __TAURI_BUNDLE_TYPE_VAR_NSS suffix');
  assert.match(input.toString(),/VAR_UNK/,'the unsigned source must remain unchanged');
  assert.throws(()=>prepareNsisMain(Buffer.from('no marker')),/标记/);
  assert.throws(()=>prepareNsisMain(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK __TAURI_BUNDLE_TYPE_VAR_UNK')),/标记/);
  assert.deepEqual(prepareNsisMain(output),output);
});
test('Bash entry exposes only the approved Windows signing command',async()=>{
  const script=path.join(root,'nuphylab');
  const help=await execute('bash',[script,'--help']);assert.match(help.stdout,/release --sign/);
  for(const args of [['release'],['release','--signed'],['release','--sign','--sign'],['dev']]){
    await assert.rejects(execute('bash',[script,...args]),error=>error.code!==0);
  }
});
test('Bash hands a spaced repository path to PowerShell without passing OTA keys',async t=>{
  if(process.platform==='win32'){t.skip('Mac fixture; the real Windows entry is checked separately');return;}
  const dir=await mkdtemp(path.join(tmpdir(),'NuPhy 签名 entry '));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'nuphylab'),await readFile(path.join(root,'nuphylab')));
  await mkdir(path.join(dir,'tools'));
  await writeFile(path.join(dir,'tools','uname'),'#!/bin/sh\nprintf "MINGW64_NT\\n"\n',{mode:0o755});
  await writeFile(path.join(dir,'tools','cygpath'),'#!/bin/sh\nprintf "%s\\n" "$2"\n',{mode:0o755});
  await writeFile(path.join(dir,'tools','powershell.exe'),`#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),key:!!process.env.TAURI_SIGNING_PRIVATE_KEY,password:!!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD}));\n`,{mode:0o755});
  const {stdout}=await execute('bash',[path.join(dir,'nuphylab'),'release','--sign'],{env:{...process.env,PATH:path.join(dir,'tools')+path.delimiter+process.env.PATH,TAURI_SIGNING_PRIVATE_KEY:'fixture-update-key',TAURI_SIGNING_PRIVATE_KEY_PASSWORD:'fixture-update-password'}});
  const got=JSON.parse(stdout);assert.equal(got.key,false);assert.equal(got.password,false);
  assert.equal(got.args.at(-1),path.join(dir,'scripts/windows/code-sign.ps1'));
});

test('Windows PowerShell signing contracts run without a certificate or UKey',async t=>{
  if(process.platform!=='win32'){t.skip('Windows PowerShell 5.1 only');return;}
  const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tests/windows-code-sign.ps1')],{timeout:30000,windowsHide:true});
  assert(Number(stdout.match(/Passed: (\d+)/)?.[1])>=10,'PowerShell contracts must all execute');
});
