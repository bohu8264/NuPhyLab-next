import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {cargoOutputDirectory,root} from '../scripts/windows/common.mjs';

test('Cargo metadata resolves an external output cache without creating or reading a default build',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'NuPhy build 输出 0 '));t.after(()=>rm(directory,{recursive:true,force:true}));
  const output=path.join(directory,'cache with 空格');
  assert.equal(await cargoOutputDirectory({env:{...process.env,CARGO_TARGET_DIR:output}}),output);
  assert.deepEqual(await readdir(directory),[],'metadata resolution must not build or create a cache');
});
test('invalid metadata or a failed Cargo command never falls back to old project binaries',async()=>{
  for(const metadata of [null,{}, {version:2,workspace_root:root,target_directory:root},
    {version:1,workspace_root:path.dirname(path.resolve(root)),target_directory:root},
    {version:1,workspace_root:root,target_directory:'relative/target'},
    {version:1,workspace_root:root,target_directory:root+'\nwrong'}]){
    await assert.rejects(cargoOutputDirectory({execute:async()=>({stdout:JSON.stringify(metadata)})}),/Cargo/);
  }
  await assert.rejects(cargoOutputDirectory({execute:async()=>({stdout:'not JSON'})}),/未使用旧构建/);
  await assert.rejects(cargoOutputDirectory({execute:async()=>{throw Error('fixture unavailable');}}),/未使用旧构建/);
});


test('noninteractive tooling ignores parent input and interactive tooling preserves it',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'NuPhy tool stdin 0 '));t.after(()=>rm(directory,{recursive:true,force:true}));
  const input=path.join(directory,'parent-input.txt'),reader=path.join(directory,'reader.cjs'),sentinel='owned fixture input';
  await writeFile(input,sentinel);
  await writeFile(reader,"const fs=require('node:fs');if(fs.readFileSync(0,'utf8')!==process.argv[2])process.exitCode=42;");
  const common=new URL('../scripts/windows/common.mjs',import.meta.url).href;
  for(const [interactive,expected,expectedCode] of [[false,'',0],[true,sentinel,0],[false,sentinel,1]]){
    const code=`import {run} from ${JSON.stringify(common)};await run(process.execPath,${JSON.stringify([reader,expected])},{interactive:${interactive}});`;
    const descriptor=openSync(input,'r');let child,stdout='',stderr='';
    try{
      child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:[descriptor,'pipe','pipe'],windowsHide:true});
      child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
      const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
      assert.equal(status,expectedCode,`interactive=${interactive}: ${stdout}${stderr}`);
      if(expectedCode!==0)assert.match(stderr,/42/,'tool failures must still reach the caller');
    }finally{closeSync(descriptor);}
  }
});
