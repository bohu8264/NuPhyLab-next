import {execFileSync} from 'node:child_process';
import {mkdir,cp,rm,readFile,readdir,writeFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {signingIdentity,requireDistributionIdentity,signApp} from './signing.mjs';

// Repackage a verified release without rebuilding or changing its runtime
// version. The source app is never modified and the output must be new.
const [sourceArg,targetArg,reportArg] = process.argv.slice(2);
if (!sourceArg || !targetArg || !reportArg) throw new Error('Usage: node scripts/compact-app.mjs <source.app> <new-output.app> <report.json>');
const source=path.resolve(sourceArg), target=path.resolve(targetArg), reportFile=path.resolve(reportArg);
if(source===target || !source.endsWith('.app') || !target.endsWith('.app')) throw new Error('Source and output must be different app paths.');
async function canonical(file) {
  try {return await realpath(file);} catch(error) {
    if(error.code!=='ENOENT') throw error;
    return path.join(await canonical(path.dirname(file)),path.basename(file));
  }
}
const sourceReal=await canonical(source),targetReal=await canonical(target),reportReal=await canonical(reportFile);
const inside=(file,directory)=>file===directory || file.startsWith(directory+path.sep);
if(inside(targetReal,sourceReal)) throw new Error('Output cannot be inside the source app.');
if(inside(reportReal,sourceReal) || inside(reportReal,targetReal)) throw new Error('Report must be outside both apps.');
async function rejectLinks(file) {
  const entry=await lstat(file);
  if(entry.isSymbolicLink()) throw new Error('Source app must not contain symbolic links: '+file);
  if(entry.isDirectory()) for(const name of await readdir(file)) await rejectLinks(path.join(file,name));
}
await rejectLinks(source);
try {await lstat(target);throw new Error('Output app already exists.');} catch(error) {if(error.code!=='ENOENT') throw error;}
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const identity=signingIdentity();
requireDistributionIdentity(identity,run('/usr/bin/security',['find-identity','-v','-p','codesigning']));
run('/usr/bin/codesign',['--verify','--deep','--strict',source]);
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
async function sections(file) {
  const data=await readFile(file);
  if(data.readUInt32LE(0)!==0xfeedfacf) throw new Error('Expected a thin 64-bit Mach-O.');
  let offset=32;const result=[];
  for(let i=0;i<data.readUInt32LE(16);i++) {
    const command=data.readUInt32LE(offset),size=data.readUInt32LE(offset+4);
    if(command===0x19) {
      for(let j=0;j<data.readUInt32LE(offset+64);j++) {
        const at=offset+72+j*80;
        const name=data.subarray(at,at+16).toString().replace(/\0.*$/s,''), segment=data.subarray(at+16,at+32).toString().replace(/\0.*$/s,'');
        const bytes=Number(data.readBigUInt64LE(at+40)),start=data.readUInt32LE(at+48),type=data.readUInt32LE(at+64)&0xff;
        const zero=[1,12,18].includes(type);
        result.push({segment,name,bytes,flags:data.readUInt32LE(at+64),sha256:zero?null:hash(data.subarray(start,start+bytes))});
      }
    }
    offset+=size;
  }
  return result;
}
async function files(dir,prefix='') {
  const result=[];
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const relative=path.join(prefix,entry.name),full=path.join(dir,entry.name);
    if(entry.isDirectory()) result.push(...await files(full,relative));
    else if(entry.isFile()) result.push(relative);
    else throw new Error('Unexpected resource type: '+full);
  }
  return result.sort();
}
await mkdir(path.dirname(target),{recursive:true});
await cp(source,target,{recursive:true,errorOnExist:true,force:false});
const resources=path.join(target,'Contents/Resources');
const node=path.join(resources,'runtime/node');
const originalNode=path.join(source,'Contents/Resources/runtime/node');
const removedDocs=await files(path.join(resources,'docs')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
await rm(path.join(resources,'docs'),{recursive:true,force:true});
// This is the old staple ticket, not the new code-signature resource seal.
await rm(path.join(target,'Contents/CodeResources'),{force:true});
const originalNodeBytes=(await readFile(originalNode)).length;
run('/usr/bin/strip',['-x','-S',node]);
signApp(target,identity);
const executableSections=[];
for(const executable of ['Contents/MacOS/AirStudio','Contents/Resources/bin/HIDBridge','Contents/Resources/runtime/node']) {
  const before=await sections(path.join(source,executable)),after=await sections(path.join(target,executable));
  if(JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Executable sections changed: '+executable);
  executableSections.push({file:executable,sections:after});
}
const originalResources=path.join(source,'Contents/Resources');
const expected=(await files(originalResources)).filter(file=>!file.startsWith('docs/'));
const actual=await files(resources);
if(JSON.stringify(expected)!==JSON.stringify(actual)) throw new Error('Functional resource inventory changed.');
const preservedResources=[];
for(const file of actual) {
  // These binaries have new CMS signatures; all executable section bytes were
  // compared above instead of comparing their changing signature blobs.
  if(file==='runtime/node' || file==='bin/HIDBridge') continue;
  const before=await readFile(path.join(originalResources,file)),after=await readFile(path.join(resources,file));
  if(!before.equals(after)) throw new Error('Functional resource changed: '+file);
  preservedResources.push({file,sha256:hash(after)});
}
const sourceInfo=await readFile(path.join(source,'Contents/Info.plist')),targetInfo=await readFile(path.join(target,'Contents/Info.plist'));
if(!sourceInfo.equals(targetInfo)) throw new Error('App metadata changed.');
run('/usr/bin/codesign',['--verify','--deep','--strict',source]);
const report={date:new Date().toISOString(),source,target,identity:identity.name,originalNodeBytes,compactNodeBytes:(await readFile(node)).length,runtimeVersion:run(node,['--version']).trim(),removedDocs,metadataUnchanged:true,preservedResources,executableSections,strictSignaturesPassed:true};
await mkdir(path.dirname(reportFile),{recursive:true});
await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({target,runtimeVersion:report.runtimeVersion,originalNodeBytes,compactNodeBytes:report.compactNodeBytes,functionalResourcesPreserved:preservedResources.length,executableSectionsUnchanged:true}));
