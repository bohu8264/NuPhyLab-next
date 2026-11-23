import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
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
