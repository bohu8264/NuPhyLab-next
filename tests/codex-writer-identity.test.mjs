import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {appendFile,mkdir,mkdtemp,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readLiveWriters} from '../server/codex-writers.mjs';
import {CodexAdapter} from '../server/codex.mjs';

test('canonical lsof result for the same writer lock cannot become absent',async t=>{
  const scratch=await realpath(await mkdtemp(path.join(tmpdir(),'nuphylab-r18-lsof-')));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const home=path.join(scratch,'home'),actualDir=path.join(scratch,'thread-writer-locks');
  await mkdir(home);await mkdir(actualDir);
  const aliasDir=path.join(home,'thread-writer-locks');
  await symlink(actualDir,aliasDir);
  const actualLock=path.join(actualDir,'isolated.lock'),aliasLock=path.join(aliasDir,'isolated.lock');
  await writeFile(actualLock,'test fixture');
  const helper=path.join(scratch,'codex');
  execFileSync('/usr/bin/xcrun',['clang','-x','c','-','-o',helper],{input:`
#include <fcntl.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    if (open(argv[1], O_WRONLY) < 0) return 3;
    if (write(STDOUT_FILENO, "ready\\n", 6) < 0) return 4;
    for (;;) pause();
}
`});
  const fixture=spawn(helper,[actualLock],{stdio:['ignore','pipe','pipe']});
  const exited=once(fixture,'exit');
  t.after(async()=>{fixture.kill();await exited;});
  const [ready]=await once(fixture.stdout,'data');
  assert.equal(String(ready),'ready\n');
  const output=execFileSync('/usr/sbin/lsof',['-nP','-Fpcn',aliasLock],{encoding:'utf8'});
  assert.ok(output.includes('p'+fixture.pid+'\n'),'lsof returned the isolated process');
  assert.ok(output.includes('ccodex\n'),'lsof identified the isolated executable name');
  const fields=output.trim().split('\n');
  const control=await readLiveWriters(scratch,['isolated']);
  assert.ok(Number.isFinite(control?.get('isolated')?.startedAt),'canonical request detects the same process and obtains its start time from ps');
  const writers=await readLiveWriters(home,['isolated']);
  const encode=(type,at)=>JSON.stringify({timestamp:new Date(at).toISOString(),type:'event_msg',payload:{type}})+'\n';
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  let now=Date.now();
  const aged=now-86_400_000;
  const finished=path.join(home,'quick-success.jsonl'),missing=path.join(home,'aged-missing.jsonl');
  await writeFile(finished,encode('turn_started',now));
  const database=path.join(home,'state_12.sqlite');
  execFileSync('/usr/bin/sqlite3',[database,
    `CREATE TABLE threads (id TEXT, rollout_path TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER);
     INSERT INTO threads VALUES ('quick',${quote(finished)},${now},${now}),
       ('isolated',${quote(missing)},${aged},${aged});`]);
  const app=new CodexAdapter({codexHome:home,now:()=>now,enableQuota:false});
  t.after(()=>app.stop());
  app.observeAggregate(true);
  await app.start();
  now+=1000;
  await appendFile(finished,encode('turn_complete',now));
  await app.pollTasks();
  now+=1000;
  await app.pollTasks();
  const result=app.snapshot().aggregate;
  console.log(JSON.stringify({fields,requested:aliasLock,canonical:actualLock,control:[...control],
    aliasedInventory:writers===null?null:[...writers],liveProcess:fixture.exitCode===null,result}));
  assert.equal(fixture.exitCode,null,'the isolated writer still owns the open lock');
  assert.equal(result.complete,false,'an aged missing rollout with a live writer must prevent green');
  assert.ok(writers===null||writers.has('isolated'),'positive named writer evidence must not become a verified absence');
});

test('a dangling writer directory does not confirm lock absence',async t=>{
  const scratch=await realpath(await mkdtemp(path.join(tmpdir(),'nuphylab-r18-lock-parent-')));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const home=path.join(scratch,'home');
  await mkdir(home);
  const missingDirectoryControl=await readLiveWriters(home,['isolated']);
  assert.equal(missingDirectoryControl?.size,0);
  await symlink(path.join(scratch,'unavailable'),path.join(home,'thread-writer-locks'));
  const danglingDirectory=await readLiveWriters(home,['isolated']);
  console.log(JSON.stringify({missingDirectoryControl:missingDirectoryControl?.size,
    danglingDirectory:danglingDirectory===null?null:[...danglingDirectory]}));
  assert.equal(danglingDirectory,null,'an unresolved directory alias makes inventory uncertain');
});
