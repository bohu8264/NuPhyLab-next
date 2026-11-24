import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
const dependencies=()=>import('../scripts/windows/signing-dependencies.mjs');
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'NuPhy dependencies 中文 '));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'ui'),{recursive:true});
 await writeFile(path.join(root,'.nvmrc'),'22.23.5\n');
 await writeFile(path.join(root,'rust-toolchain.toml'),'[toolchain]\nchannel = "1.100.0"\nprofile = "minimal"\ncomponents = ["clippy", "rustfmt"]\n');
 for(const [folder,name] of [['','@tauri-apps/cli'],['ui','typescript']]){
  const cwd=path.join(root,folder),pkg={name:'fixture',version:'1.0.0',devDependencies:{[name]:'1.0.0'}};
  await writeFile(path.join(cwd,'package.json'),JSON.stringify(pkg));
  await writeFile(path.join(cwd,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':pkg,['node_modules/'+name]:{version:'1.0.0'}}}));
 }
 return root;
}
async function installFixture(cwd){
 const pkg=JSON.parse(await readFile(path.join(cwd,'package.json'),'utf8'));
 for(const [name,version] of Object.entries(pkg.devDependencies)){
  const dir=path.join(cwd,'node_modules',name);await mkdir(path.join(dir,'bin'),{recursive:true});
  const bin=name==='typescript'?'bin/tsc':'tauri.js';
  await writeFile(path.join(dir,'package.json'),JSON.stringify({name,version,bin:{fixture:bin}}));await writeFile(path.join(dir,bin),'fixture');
 }
}
test('one preparation installs root and UI dependencies before compilation and reuses verified installs',async t=>{
 const root=await fixture(t),{prepareSigningDependencies}=await dependencies(),calls=[],messages=[];
 const run=async(command,args,options)=>{calls.push({command,args,cwd:options.cwd});if(args.includes('ci'))await installFixture(options.cwd);};
 await prepareSigningDependencies({root,npm:{command:process.execPath,args:['fixture-npm']},run,log:x=>messages.push(x)});
 assert.deepEqual(calls.filter(x=>x.args.includes('ci')).map(x=>x.cwd),[root,path.join(root,'ui')]);
 assert(calls[0].args.includes('install'),'the pinned Rust toolchain is prepared before metadata or compilation');
 assert(calls[0].args.some(x=>x.startsWith('1.100.0-')));
 assert(calls.every(x=>!x.args.includes('build')));
 calls.length=0;await prepareSigningDependencies({root,npm:{command:process.execPath,args:['fixture-npm']},run,log:()=>{}});
 assert.equal(calls.filter(x=>x.args.includes('ci')).length,0);
 await rm(path.join(root,'ui/node_modules/typescript/bin/tsc'));
 calls.length=0;await prepareSigningDependencies({root,npm:{command:process.execPath,args:['fixture-npm']},run,log:()=>{}});
 assert.deepEqual(calls.filter(x=>x.args.includes('ci')).map(x=>x.cwd),[path.join(root,'ui')]);
 const lock=path.join(root,'package-lock.json');await writeFile(lock,(await readFile(lock,'utf8'))+'\n');
 calls.length=0;await prepareSigningDependencies({root,npm:{command:process.execPath,args:['fixture-npm']},run,log:()=>{}});
 assert.deepEqual(calls.filter(x=>x.args.includes('ci')).map(x=>x.cwd),[root]);
 await writeFile(path.join(root,'.build/windows/code-sign/dependencies/root.json'),'corrupt receipt');
 calls.length=0;await prepareSigningDependencies({root,npm:{command:process.execPath,args:['fixture-npm']},run,log:()=>{}});
 assert.deepEqual(calls.filter(x=>x.args.includes('ci')).map(x=>x.cwd),[root]);
 assert(messages.some(x=>x.includes('22.23.5')));
});
test('failed Rust repair or npm installation stops preparation and cannot mark dependencies ready',async t=>{
 const root=await fixture(t),{prepareSigningDependencies}=await dependencies();
 for(const stage of ['rustup','npm']){
  const calls=[];
  await assert.rejects(prepareSigningDependencies({root,npm:{command:'fixture-npm',args:[]},log:()=>{},run:async(command,args,options)=>{
   calls.push({command,args});if((stage==='rustup'&&command==='rustup')||(stage==='npm'&&args.includes('ci')))throw Error('fixture '+stage+' download denied');
   if(args.includes('ci'))await installFixture(options.cwd);
  }}),new RegExp(stage+' download denied'));
  assert(!calls.some(x=>x.args.includes('build')));if(stage==='rustup')assert.equal(calls.length,1);
 }
});
test('preparation reports a missing lockfile before any download and refuses unsupported Node',async t=>{
 const root=await fixture(t),{prepareSigningDependencies,assertSigningNode}=await dependencies();
 assert.throws(()=>assertSigningNode('20.19.0','x64','win32'),/22/);
 assert.doesNotThrow(()=>assertSigningNode('24.14.1','x64','win32'));
 assert.throws(()=>assertSigningNode('22.23.5','arm64','win32'),/x64/);
 await rm(path.join(root,'ui/package-lock.json'));let invoked=false;
 await assert.rejects(prepareSigningDependencies({root,npm:{command:'npm',args:[]},run:async()=>{invoked=true;},log:()=>{}}),/ui.*package-lock/);
 assert.equal(invoked,false);
});
test('installation output is live, failures identify the command and secrets are redacted',async t=>{
 const root=await fixture(t),{runPreparation}=await dependencies(),lines=[];
 const child=path.join(root,'slow tool.mjs');await writeFile(child,"console.error('fixture first output');setTimeout(()=>{console.error('download denied fixture-private-token');process.exitCode=23},120)");
 const pending=runPreparation(process.execPath,[child],{cwd:root,label:'fixture install',env:{...process.env,NPM_TOKEN:'fixture-private-token'},log:x=>lines.push(x),timeoutMs:2000,heartbeatMs:30});
 await assert.rejects(pending,error=>/23/.test(error.message)&&/download denied/.test(error.message)&&/slow tool.mjs/.test(error.message)&&!error.message.includes('fixture-private-token'));
 assert(lines.some(x=>x.includes('fixture first output')));assert(lines.some(x=>x.includes('仍在执行')));
 assert(!lines.join('\n').includes('fixture-private-token'));
});
test('slow preparation uses its own deadline and timeout explains the failed stage',async t=>{
 const root=await fixture(t),{runPreparation}=await dependencies();
 await runPreparation(process.execPath,['-e','setTimeout(()=>process.stdout.write("repaired"),100)'],{cwd:root,label:'Rust repair',timeoutMs:2000,heartbeatMs:30,log:()=>{}});
 await assert.rejects(runPreparation(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,label:'Rust repair',timeoutMs:150,heartbeatMs:30,log:()=>{}}),/Rust repair.*超时/);
});


test('missing executables and malformed locks show the exact cause without starting later stages',async t=>{
 const root=await fixture(t),{runPreparation,prepareSigningDependencies}=await dependencies();
 await assert.rejects(runPreparation(path.join(root,'missing executable'),[],{cwd:root,log:()=>{}}),/ENOENT/);
 await writeFile(path.join(root,'ui/package-lock.json'),'bad lock');let invoked=false;
 await assert.rejects(prepareSigningDependencies({root,npm:{command:'npm',args:[]},run:async()=>{invoked=true;},log:()=>{}}),/ui.*package-lock.json.*无法解析/);
 assert.equal(invoked,false);
});
