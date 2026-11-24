import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
const execute=promisify(execFile),module=()=>import('../scripts/windows/build-source.mjs');
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'NuPhy source 中文 '));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'server'));await mkdir(path.join(root,'docs'));await writeFile(path.join(root,'server/main.mjs'),'original');await writeFile(path.join(root,'docs/test.md'),'documentation');await writeFile(path.join(root,'.gitignore'),'.build/\n');
 const git=async args=>execute('git',args,{cwd:root});await git(['init','-q']);await git(['add','.']);
 await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','test: isolated fixture']);
 await git(['remote','add','origin','git@github.com:fixture/NuPhyLab-next.git']);return {root,git};
}
test('source records bind a clean commit and detect implementation changes without blocking local builds',async t=>{
 const {root}=await fixture(t),{captureBuildSource,finishBuildSource}=await module(),before=await captureBuildSource(root);
 assert.equal(before.uploadable,true);assert.match(before.commit,/^[a-f0-9]{40}$/);assert.equal(before.repository,'fixture/NuPhyLab-next');
 await writeFile(path.join(root,'docs/test.md'),'updated docs');assert.equal((await finishBuildSource(root,before)).uploadable,true);
 await writeFile(path.join(root,'server/main.mjs'),'changed source');const changed=await finishBuildSource(root,before);assert.equal(changed.uploadable,false);assert.match(changed.reason,/源码|输入/);
 assert.equal((await captureBuildSource(root)).uploadable,false);
});
test('untracked implementation, missing Git provenance and unsupported origins cannot be auto-uploaded',async t=>{
 const {root,git}=await fixture(t),{captureBuildSource}=await module();
 await writeFile(path.join(root,'server/new.mjs'),'untracked');assert.equal((await captureBuildSource(root)).uploadable,false);await rm(path.join(root,'server/new.mjs'));
 await git(['remote','set-url','origin','https://example.invalid/repo.git']);assert.equal((await captureBuildSource(root)).uploadable,false);
 await rm(path.join(root,'.git'),{recursive:true});const missing=await captureBuildSource(root);assert.equal(missing.uploadable,false);
 const {finishBuildSource}=await module();assert.match((await finishBuildSource(root,missing)).reason,/无法记录/);
});


test('a different commit is detected even when source bytes are unchanged',async t=>{
 const {root,git}=await fixture(t),{captureBuildSource,finishBuildSource}=await module(),before=await captureBuildSource(root);
 await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','test: another isolated fixture']);
 const after=await finishBuildSource(root,before);assert.equal(after.uploadable,false);assert.match(after.reason,/源码提交/);
});
