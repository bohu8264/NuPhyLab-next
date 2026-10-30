import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,symlink,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

test('native singleton survives competing copies and releases on normal exit, crash and exec',{skip:process.platform!=='darwin'},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nuphylab-instance-unit-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'main.swift'),binary=path.join(directory,'check');
  await writeFile(source,`
import Foundation
import Darwin
let directory=URL(fileURLWithPath:CommandLine.arguments[1])
let mode=CommandLine.arguments[2]
if mode == "policy" {
 let sample=AppUpdateHandoff(token:"good",sourcePID:42,targetVersion:"1.2.2",createdAt:100,acknowledgedPID:nil)
 precondition(sample.isCurrent(token:"good",version:"1.2.2",now:101))
 precondition(!sample.isCurrent(token:"bad",version:"1.2.2",now:101))
 precondition(!sample.isCurrent(token:"good",version:"1.2.1",now:101))
 precondition(!sample.isCurrent(token:"good",version:"1.2.2",now:99))
 precondition(!sample.isCurrent(token:"good",version:"1.2.2",now:160))
 print("policy-passed");exit(0)
}
do {
 switch try AppInstanceLock.acquire(directory:directory,bundleIdentifier:"local.airstudio.desktop",
                                    executableURL:URL(fileURLWithPath:CommandLine.arguments[0])) {
 case .existing(let owner):print("existing:"+String(owner?.pid ?? 0));fflush(stdout)
 case .acquired(let lock):
  if mode == "exec-child" {
   let child=Process();child.executableURL=URL(fileURLWithPath:"/bin/sleep");child.arguments=["30"]
   try child.run();print("child:"+String(child.processIdentifier));fflush(stdout)
  }
  if mode == "ack" {
   let file=directory.appendingPathComponent("handoff.json")
   var handoff=AppUpdateHandoff.read(from:file)!
   precondition(handoff.isCurrent(token:"unit-token",version:"1.2.2",now:Date().timeIntervalSince1970))
   handoff.acknowledgedPID=getpid();try handoff.write(to:file)
  }
  print("owner:"+String(getpid()));fflush(stdout)
  if mode != "once" {withExtendedLifetime(lock){_ = readLine()}}
 }
} catch {print("error");fflush(stdout);exit(2)}
`);
  const run=promisify(execFile);
  await run('swiftc',['-module-cache-path',path.join(directory,'module-cache'),fileURLToPath(new URL('../native/AppInstance.swift',import.meta.url)),source,'-o',binary]);
  const children=new Set();
  t.after(()=>{for(const child of children){try{child.kill('SIGKILL');}catch{}}});
  const launch=(data,mode)=>{
    const child=spawn(binary,[data,mode],{stdio:['pipe','pipe','pipe']});children.add(child);
    const lines=[];let pending='';const waiters=[];
    child.stdout.on('data',chunk=>{pending+=chunk;while(pending.includes('\n')){const at=pending.indexOf('\n'),line=pending.slice(0,at);pending=pending.slice(at+1);if(waiters.length)waiters.shift()(line);else lines.push(line);}});
    child.once('exit',()=>children.delete(child));
    return {child,line:()=>lines.length?Promise.resolve(lines.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Child output timeout')),5000);waiters.push(line=>{clearTimeout(timer);resolve(line);});})};
  };
  const data=path.join(directory,'user-data');
  const owner=launch(data,'hold');assert.equal(await owner.line(),'owner:'+owner.child.pid);
  const rival=await run(binary,[data,'once']);assert.equal(rival.stdout.trim(),'existing:'+owner.child.pid);
  const copied=path.join(directory,'copy');await writeFile(copied,await readFile(binary),{mode:0o700});
  assert.equal((await run(copied,[data,'once'])).stdout.trim(),'existing:'+owner.child.pid,'a second bundle copy must share the user lock');
  const lockMetadata=JSON.parse(await readFile(path.join(data,'app-instance.lock'),'utf8'));
  assert.equal(lockMetadata.pid,owner.child.pid);assert.equal(await realpath(lockMetadata.executablePath),await realpath(binary));
  const ownerExit=once(owner.child,'exit');owner.child.stdin.end();await ownerExit;
  assert.match((await run(binary,[data,'once'])).stdout,/^owner:/,'normal exit releases the lock');

  const crash=launch(data,'exec-child'),sleepLine=await crash.line();assert.match(sleepLine,/^child:/);
  const sleeperPID=Number(sleepLine.split(':')[1]);
  t.after(()=>{try{process.kill(sleeperPID,'SIGKILL');}catch{}});
  assert.equal(await crash.line(),'owner:'+crash.child.pid);
  const crashExit=once(crash.child,'exit');crash.child.kill('SIGKILL');await crashExit;
  process.kill(sleeperPID,0);
  assert.match((await run(binary,[data,'once'])).stdout,/^owner:/,'crash releases the lock and exec child does not inherit it');
  const one=launch(data,'hold'),two=launch(data,'hold');
  const results=await Promise.all([one.line(),two.line()]);
  assert.equal(results.filter(line=>line.startsWith('owner:')).length,1,'simultaneous cold starts elect exactly one owner');
  assert.equal(results.filter(line=>line.startsWith('existing:')).length,1);
  for(const candidate of [one,two])if(candidate.child.exitCode===null){const exited=once(candidate.child,'exit');candidate.child.stdin.end();await exited;}

  const handoff={token:'unit-token',sourcePID:process.pid,targetVersion:'1.2.2',createdAt:Date.now()/1000,acknowledgedPID:null};
  await writeFile(path.join(data,'handoff.json'),JSON.stringify(handoff),{mode:0o600});
  const ack=launch(data,'ack');assert.equal(await ack.line(),'owner:'+ack.child.pid);
  const receipt=JSON.parse(await readFile(path.join(data,'handoff.json'),'utf8'));
  assert.equal(receipt.acknowledgedPID,ack.child.pid);assert.equal(receipt.token,handoff.token);
  assert.equal((await run(binary,[data,'once'])).stdout.trim(),'existing:'+ack.child.pid,'handoff is acknowledged by the singleton owner');
  const ackExit=once(ack.child,'exit');ack.child.stdin.end();await ackExit;
  assert.match((await run(binary,[data,'policy'])).stdout,/policy-passed/);
  const unsafe=path.join(directory,'unsafe');await mkdir(unsafe);
  await symlink(path.join(data,'app-instance.lock'),path.join(unsafe,'app-instance.lock'));
  await assert.rejects(run(binary,[unsafe,'once']),error=>error.code===2&&error.stdout.trim()==='error','do not follow a substituted lock file');
});
