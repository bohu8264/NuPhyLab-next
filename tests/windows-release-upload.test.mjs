import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
const module=()=>import('../scripts/windows/release-upload.mjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'NuPhy upload 中文 '));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='0123456789abcdef0123456789abcdef',directory=path.join(root,'.build/windows/code-sign',id),artifacts=path.join(directory,'artifacts');
 await mkdir(artifacts,{recursive:true});await mkdir(path.join(directory,'payload'));
 const names=['nuphylab-desktop.exe',...['node','hid','desktop-io','agent-probe','sqlite'].map(x=>'nuphylab-'+x+'-x86_64-pc-windows-msvc.exe')];
 const payload=[];for(const file of names){const bytes=Buffer.from('signed fixture '+file);await writeFile(path.join(directory,'payload',file),bytes);payload.push({file,sha256:sha(bytes)});}
 const file='NuPhyLab-1.2.54-windows-x64-signed-setup.exe',bytes=Buffer.from('signed installer fixture');await writeFile(path.join(artifacts,file),bytes);
 const manifest={format:'nuphylab-windows-code-sign',version:2,productVersion:'1.2.54',buildId:id,completedAt:'2026-11-24T00:00:00Z',stage:'complete',updaterArtifacts:false,certificateThumbprint:'68B94B194F597BA6E2694113268FE3956A041FEF',source:{mode:'git',uploadable:true,commit:'a'.repeat(40),repository:'fixture/NuPhyLab-next',inputsSha256:'b'.repeat(64)},installer:{file,sha256:sha(bytes),bytes:bytes.length},payload};
 await writeFile(path.join(artifacts,'build-manifest.json'),JSON.stringify(manifest));await writeFile(path.join(artifacts,'checksums.txt'),manifest.installer.sha256+'  '+file+'\n');
 const {rememberSuccessfulBuild}=await import('../scripts/windows/build-source.mjs');await rememberSuccessfulBuild(root,directory);
 return {root,directory,artifacts,manifest};
}
function fakeGitHub(f){
 const calls=[],assets=new Map();let release=null,tagCommit=null,failUpload=0,tagKind='commit';
 const missing=()=>{throw Object.assign(Error('HTTP 404'),{stderr:'gh: Not Found (HTTP 404)',code:1});};
 const execute=async(command,args,options)=>{
  calls.push({command,args:[...args]});
  if(command==='git')return {stdout:'git@github.com:fixture/NuPhyLab-next.git\n'};
  assert.equal(command,'gh');
  if(args[0]==='api'||args[0]==='auth')assert.equal(args[args.indexOf('--hostname')+1],'github.com');
  if(args[0]==='release')assert.equal(args[args.indexOf('--repo')+1],'github.com/fixture/NuPhyLab-next');
  if(args[0]==='auth')return {stdout:'fixture authenticated'};
  if(args[0]==='api'){
   const endpoint=args[1];
   if(endpoint.endsWith('/commits/'+f.manifest.source.commit))return {stdout:JSON.stringify({sha:f.manifest.source.commit})};
   if(endpoint.includes('/git/ref/tags/')){if(!tagCommit)missing();return {stdout:JSON.stringify({object:{type:tagKind,sha:tagKind==='tag'?'d'.repeat(40):tagCommit}})};}
   if(endpoint.includes('/commits/')){if(!tagCommit)missing();return {stdout:JSON.stringify({sha:tagCommit})};}
   assert.fail(endpoint);
  }
  if(args[1]==='view'){
   if(!release)throw Object.assign(Error('release not found'),{stderr:'release not found',code:1});
   return {stdout:JSON.stringify({isDraft:release.draft,isPrerelease:release.prerelease,tagName:release.tag_name,targetCommitish:release.target_commitish,url:release.html_url,assets:[...assets.values()].map(x=>x.metadata)})};
  }else if(args[1]==='create'){
   assert(args.includes('--draft')&&args.includes('--prerelease')&&args.includes('--latest=false'));
   assert.equal(args[args.indexOf('--target')+1],f.manifest.source.commit);
   release={draft:true,prerelease:true,tag_name:args[2],target_commitish:f.manifest.source.commit,html_url:'https://github.com/fixture/NuPhyLab-next/releases/tag/'+args[2]};tagCommit=f.manifest.source.commit;
  }else if(args[1]==='upload'){
   if(failUpload&&--failUpload===0)throw Object.assign(Error('fixture upload disconnected'),{code:1,stderr:'fixture upload disconnected'});
   const file=args[3],data=await readFile(file),name=path.basename(file);assert(!args.includes('--clobber'));
   assets.set(name,{data,metadata:{name,state:'uploaded',size:data.length,digest:'sha256:'+sha(data)}});
  }else if(args[1]==='download'){
   const name=args[args.indexOf('--pattern')+1],dir=args[args.indexOf('--dir')+1];await writeFile(path.join(dir,name),assets.get(name).data);
  }else if(args[1]==='edit'){assert(args.includes('--draft=false'));release.draft=false;tagCommit=f.manifest.source.commit;}
  else assert.fail(args.join(' '));
  return {stdout:release?.html_url??''};
 };
 return {execute,calls,assets,setFailure:n=>{failUpload=n;},setTag:x=>{tagCommit=x;},setTagKind:x=>{tagKind=x;},get release(){return release;}};
}
test('upload auto-selects the successful build and creates a verified draft with all three assets',async t=>{
 const f=await fixture(t),gh=fakeGitHub(f),{uploadRelease}=await module();let verified=0;
 const result=await uploadRelease({root:f.root,execute:gh.execute,verifySignatures:async build=>{verified++;assert.equal(build.directory,f.directory);assert.equal(gh.calls.filter(x=>x.args[1]==='create').length,0);},log:()=>{}});
 assert.equal(verified,1);assert.equal(result.published,false);assert.match(result.tag,/^v1\.2\.54-windows\./);assert.equal(gh.assets.size,3);
 assert(!gh.calls.some(x=>x.command==='git'&&x.args.includes('push')));assert(!gh.calls.some(x=>x.args[1]==='edit'));
});
test('interrupted draft uploads resume, identical assets are skipped, publish is explicit and last',async t=>{
 const f=await fixture(t),gh=fakeGitHub(f),{uploadRelease}=await module(),options={root:f.root,execute:gh.execute,verifySignatures:async()=>{},log:()=>{}};
 gh.setFailure(2);await assert.rejects(uploadRelease(options),/disconnected/);assert.equal(gh.assets.size,1);assert.equal(gh.release.draft,true);
 gh.calls.length=0;await uploadRelease(options);assert.equal(gh.calls.filter(x=>x.args[1]==='upload').length,2);
 gh.setTag(null);gh.calls.length=0;await uploadRelease(options);assert(!gh.calls.some(x=>['create','upload','edit'].includes(x.args[1])));
 const first=gh.assets.values().next().value;delete first.metadata.digest;
 gh.calls.length=0;const published=await uploadRelease({...options,publish:true});assert.equal(published.published,true);
 assert(gh.calls.some(x=>x.args[1]==='download'));assert.equal(gh.calls.filter(x=>['create','upload','edit'].includes(x.args[1])).at(-1).args[1],'edit');
 gh.setTagKind('tag');gh.calls.length=0;await uploadRelease(options);assert(!gh.calls.some(x=>['create','upload','edit'].includes(x.args[1])));
});
test('conflicting remote content or a tag on another commit is never overwritten',async t=>{
 const f=await fixture(t),gh=fakeGitHub(f),{uploadRelease}=await module(),options={root:f.root,execute:gh.execute,verifySignatures:async()=>{},log:()=>{}};
 await uploadRelease(options);gh.assets.values().next().value.metadata.digest='sha256:'+'0'.repeat(64);gh.calls.length=0;
 await assert.rejects(uploadRelease({...options,publish:true}),/冲突/);assert(!gh.calls.some(x=>['upload','edit','delete'].includes(x.args[1])));
 gh.setTag('c'.repeat(40));gh.calls.length=0;await assert.rejects(uploadRelease(options),/标签.*源码/);assert(!gh.calls.some(x=>['create','upload','edit'].includes(x.args[1])));
});
test('missing provenance, corrupted local files, wrong origin and bad signatures stop before any remote write',async t=>{
 const f=await fixture(t),{uploadRelease,readUploadBuild}=await module(),gh=fakeGitHub(f),options={root:f.root,execute:gh.execute,verifySignatures:async()=>{throw Error('fixture signature invalid');},log:()=>{}};
 await assert.rejects(uploadRelease(options),/signature invalid/);assert(!gh.calls.some(x=>['create','upload','edit'].includes(x.args[1])));
 await writeFile(path.join(f.artifacts,f.manifest.installer.file),'corrupt');gh.calls.length=0;await assert.rejects(uploadRelease(options),/摘要|大小/);assert.equal(gh.calls.length,0);
 await rm(path.join(f.root,'.build/windows/code-sign/latest-success.json'));await assert.rejects(readUploadBuild(f.root),/重新.*打包|成功构建/);
});
test('only an already-remote source commit may be released and network failures remain visible',async t=>{
 const f=await fixture(t),gh=fakeGitHub(f),{uploadRelease}=await module();
 const execute=async(command,args,options)=>{if(command==='gh'&&args[0]==='api'&&args[1].endsWith('/commits/'+f.manifest.source.commit))throw Object.assign(Error('HTTP 422'),{stderr:'gh: No commit found for SHA (HTTP 422)',code:1});return gh.execute(command,args,options);};
 await assert.rejects(uploadRelease({root:f.root,execute,verifySignatures:async()=>{},log:()=>{}}),/源码提交.*GitHub|来源提交/);
 assert(!gh.calls.some(x=>['create','upload','edit'].includes(x.args[1])));
});


test('legacy receipts, repository mismatch and unauthorized GitHub errors stop without writes',async t=>{
 const {uploadRelease,readUploadBuild}=await module();
 {
  const f=await fixture(t);f.manifest.version=1;delete f.manifest.source;
  const bytes=JSON.stringify(f.manifest);await writeFile(path.join(f.artifacts,'build-manifest.json'),bytes);
  await writeFile(path.join(f.root,'.build/windows/code-sign/latest-success.json'),JSON.stringify({format:'nuphylab-latest-signed-build',version:1,buildId:f.manifest.buildId,manifestSha256:sha(bytes)}));
  await assert.rejects(readUploadBuild(f.root),/旧包|新版入口/);
 }
 {
  const f=await fixture(t),gh=fakeGitHub(f);
  await assert.rejects(uploadRelease({root:f.root,verifySignatures:async()=>{},log:()=>{},execute:async(command,args,options)=>command==='git'?{stdout:'git@github.com:another/repo.git'}:gh.execute(command,args,options)}),/origin.*仓库/);
  assert.equal(gh.calls.length,0);
  await assert.rejects(uploadRelease({root:f.root,verifySignatures:async()=>{},log:()=>{},execute:async(command,args,options)=>{
   if(command==='gh'&&args[0]==='auth')throw Object.assign(Error('authentication failed'),{code:1,stderr:'fixture credentials denied'});return gh.execute(command,args,options);
  }}),/credentials denied/);
  assert(!gh.calls.some(x=>['create','upload','edit'].includes(x.args[1])));
 }
});
test('unverified extra assets and incomplete published releases are not changed',async t=>{
 const f=await fixture(t),gh=fakeGitHub(f),{uploadRelease}=await module(),options={root:f.root,execute:gh.execute,verifySignatures:async()=>{},log:()=>{}};
 await uploadRelease({...options,publish:true});const name=gh.assets.keys().next().value,saved=gh.assets.get(name);gh.assets.delete(name);gh.calls.length=0;
 await assert.rejects(uploadRelease(options),/已发布.*缺少附件/);assert(!gh.calls.some(x=>['create','upload','edit'].includes(x.args[1])));gh.assets.set(name,saved);
 gh.assets.set('unknown.zip',{metadata:{name:'unknown.zip',state:'uploaded',size:1,digest:'sha256:'+'0'.repeat(64)}});gh.calls.length=0;
 await assert.rejects(uploadRelease(options),/冲突/);assert(!gh.calls.some(x=>['create','upload','edit'].includes(x.args[1])));
});


test('only a complete build updates the latest-success index',async t=>{
 const f=await fixture(t),{rememberSuccessfulBuild}=await import('../scripts/windows/build-source.mjs');
 const pointer=path.join(f.root,'.build/windows/code-sign/latest-success.json'),before=await readFile(pointer,'utf8');
 f.manifest.stage='failed';await writeFile(path.join(f.artifacts,'build-manifest.json'),JSON.stringify(f.manifest));
 await assert.rejects(rememberSuccessfulBuild(f.root,f.directory),/成功构建记录无效/);assert.equal(await readFile(pointer,'utf8'),before);
});
