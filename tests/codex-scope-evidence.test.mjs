import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm,symlink,chmod,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {CodexAdapter} from '../server/codex.mjs';
import {readLiveWriters} from '../server/codex-writers.mjs';

const epoch = Date.parse('2026-09-10T13:00:00Z');
const oldMs = epoch - 86_400_000;
const oldSeconds = oldMs / 1000;
const event = (type, at=epoch) => JSON.stringify({
  timestamp:new Date(at).toISOString(),type:'event_msg',payload:{type}
})+'\n';
const q = value => "'"+String(value).replaceAll("'", "''")+"'";
const sql = (db,stmt) => execFileSync('/usr/bin/sqlite3',[db,stmt]);

const cases = [
  ['all-time-null','null','null'],
  ['no-time-columns'],
  ['old-display-recency-newer-update',oldMs,epoch/1000],
  ['seen-recent-then-backdated',epoch-1000,oldSeconds],
  ['dangling-outside-symlink',oldMs,oldSeconds],
  ['recent-control',epoch-1000,epoch/1000],
  ['known-live-control',oldMs,oldSeconds],
  ['log-permission-error-control',oldMs,oldSeconds],
  ['verified-aged-absence-control',oldMs,oldSeconds],
];

for (const [scenario,recency,updated] of cases) test(scenario,async t=>{
  const home = await mkdtemp(path.join(tmpdir(),'nuphylab-r16-aged-audit-'));
  const opaque = path.join(home,'opaque');
  t.after(async()=>{
    await chmod(opaque,0o700).catch(()=>{});
    await rm(home,{recursive:true,force:true});
  });

  const database = path.join(home,'state_12.sqlite');
  await mkdir(path.join(home,'sessions'));
  const existing = path.join(home,'sessions/live.jsonl');
  await writeFile(existing,event('turn_started'));
  let unavailable = path.join(home,'sessions/other.jsonl');
  if (scenario==='dangling-outside-symlink')
    await symlink(path.join(home+'.outside','missing.jsonl'),unavailable);
  if (scenario==='log-permission-error-control') {
    await mkdir(opaque);
    unavailable=path.join(opaque,'other.jsonl');
    await writeFile(unavailable,event('turn_started'));
    await chmod(opaque,0o000);
    await assert.rejects(access(unavailable),{code:'EACCES'});
  }

  const minimal = scenario==='no-time-columns';
  sql(database,'CREATE TABLE threads (id TEXT,rollout_path TEXT'+(minimal?'':',recency_at_ms INTEGER,updated_at INTEGER')+');');
  sql(database,'INSERT INTO threads VALUES ('+q('live')+','+q(existing)+(minimal?'':','+epoch+','+epoch/1000)+
    '),('+q('other')+','+q(unavailable)+(minimal?'':','+recency+','+updated)+');');
  let now=epoch+1000;
  const writers = new Map([['live',{startedAt:epoch-1000}]]);
  if (scenario==='known-live-control') writers.set('other',{startedAt:epoch-1000});
  const app = new CodexAdapter({codexHome:home,now:()=>now,enableQuota:false,liveWriters:async()=>writers});
  app.observeAggregate(true);
  t.after(()=>app.stop());
  await app.start();
  const before = app.snapshot().aggregate;
  const seen = app.cohort.seen.has('other');

  if (scenario==='seen-recent-then-backdated') {
    assert.equal(seen,true);
    assert.equal(app.cohort.members.has('other'),false);
    assert.equal(app.cache.has('other'),false);
    sql(database,'UPDATE threads SET recency_at_ms='+oldMs+" WHERE id='other';");
  }

  now+=1000;
  await appendFile(existing,event('turn_complete',now));
  await app.pollTasks();
  now+=1000;
  await app.pollTasks();
  const outcome = app.snapshot().aggregate;
  console.log(JSON.stringify({scenario,before,seen,after:outcome}));
  if (scenario==='verified-aged-absence-control') {
    assert.equal(outcome.complete,true);
    assert.equal(outcome.status,'completed');
  } else {
    assert.equal(outcome.complete,false,'unavailable task must prevent complete');
    assert.notEqual(outcome.status,'completed');
  }
});

test('writer access errors are not a verified absence',async t=>{
  const home = await mkdtemp(path.join(tmpdir(),'nuphylab-r16-writer-access-'));
  const writerDir = path.join(home,'thread-writer-locks');
  t.after(async()=>{
    await chmod(writerDir,0o700).catch(()=>{});
    await rm(home,{recursive:true,force:true});
  });
  await mkdir(writerDir);
  const lock = path.join(writerDir,'other.lock');
  await writeFile(lock,'isolated');
  await chmod(writerDir,0o000);
  await assert.rejects(access(lock),{code:'EACCES'});
  const result = await readLiveWriters(home,['other']);
  console.log(JSON.stringify({writerAccess:'EACCES',reportedInventory:result===null?'unknown':'map size '+result.size}));
  assert.equal(result,null);
});
