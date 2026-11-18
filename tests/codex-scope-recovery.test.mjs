import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm,rename,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const revision='current';
import {CodexAdapter} from '../server/codex.mjs';
const epoch=Date.parse('2026-09-10T13:00:00.000Z');
const event=(type,at=epoch)=>JSON.stringify({
  timestamp:new Date(at).toISOString(),type:'event_msg',payload:{type}
})+'\n';
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const execSql=(db,sql)=>execFileSync('/usr/bin/sqlite3',[db,sql]);

async function fixture(t,{history=false}={}) {
  const home=await mkdtemp(path.join(tmpdir(),'nuphylab-r17-transient-evidence-'));
  const otherDir=path.join(home,'other');
  t.after(async()=>{
    await chmod(otherDir,0o700).catch(()=>{});
    await rm(home,{recursive:true,force:true});
  });
  const database=path.join(home,'state_12.sqlite');
  await mkdir(otherDir);
  const live=path.join(home,'live.jsonl'),other=path.join(otherDir,'other.jsonl');
  await writeFile(live,event('turn_started'));
  if(!history)await writeFile(other,event('turn_started'));
  execSql(database,'CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at_ms INTEGER);');
  execSql(database,'INSERT INTO threads VALUES ('+q('live')+','+q(live)+','+epoch+
    '),('+q('other')+','+q(other)+','+(history?epoch-86_400_000:epoch)+');');

  let now=epoch+1000, writerReadable=true;
  const writers=new Map([['live',{startedAt:epoch-1000}]]);
  if(!history)writers.set('other',{startedAt:epoch-1000});
  const app=new CodexAdapter({
    codexHome:home,now:()=>now,enableQuota:false,
    liveWriters:async()=>writerReadable?writers:null
  });
  t.after(()=>app.stop());
  app.observeAggregate(true);
  return {
    app,live,other,otherDir,
    setNow(value){now=epoch+value;},
    setWriterReadable(value){writerReadable=value;},
    updateOther(value){execSql(database,'UPDATE threads SET updated_at_ms='+(epoch+value)+" WHERE id='other';");}
  };
}

test('a valid writer inventory recovers after cold-start inventory failure',async t=>{
  const f=await fixture(t,{history:true});
  f.setWriterReadable(false);
  await f.app.start();
  assert.equal(f.app.snapshot().aggregate.complete,false);
  assert.equal(f.app.cohort.seen.has('other'),true);
  assert.equal(f.app.cohort.members.has('other'),false);
  f.setWriterReadable(true);
  f.setNow(2000);await appendFile(f.live,event('turn_complete',epoch+2000));
  await f.app.pollTasks();f.setNow(3000);await f.app.pollTasks();
  const result=f.app.snapshot().aggregate;
  console.log(JSON.stringify({revision,scenario:'writer inventory recovered',result}));
  assert.equal(result.status,'completed');
  assert.equal(result.complete,true);
});

test('a recovered rollout with real terminal evidence becomes complete after permission repair',async t=>{
  const f=await fixture(t);
  await f.app.start();
  f.setNow(2000);await appendFile(f.other,event('turn_complete',epoch+2000));
  await f.app.pollTasks();
  await chmod(f.otherDir,0o000);
  f.setNow(3000);await appendFile(f.live,event('turn_complete',epoch+3000));
  await f.app.pollTasks();
  assert.equal(f.app.snapshot().aggregate.complete,false);
  assert.notEqual(f.app.snapshot().aggregate.status,'completed');
  await chmod(f.otherDir,0o700);
  f.setNow(4000);await f.app.pollTasks();f.setNow(5000);await f.app.pollTasks();
  const result=f.app.snapshot().aggregate;
  console.log(JSON.stringify({revision,scenario:'log permissions recovered',result}));
  assert.equal(result.status,'completed');
  assert.equal(result.count,2);
});

test('restored rollout should displace the synthetic missing timestamp',async t=>{
  const f=await fixture(t);
  await f.app.start();
  await appendFile(f.other,event('turn_complete',epoch+2500));
  await rename(f.other,f.other+'.detached');
  f.updateOther(6000);
  f.setNow(7000);await f.app.pollTasks();
  assert.equal(f.app.snapshot().aggregate.complete,false);
  const missing=f.app.cohort.seen.get('other');
  assert.equal(missing.signature,'unreadable:other');
  assert.equal(missing.eventAt,epoch);
  await rename(f.other+'.detached',f.other);
  f.setNow(8000);await appendFile(f.live,event('turn_complete',epoch+8000));
  await f.app.pollTasks();f.setNow(9000);await f.app.pollTasks();
  const result=f.app.snapshot().aggregate;
  console.log(JSON.stringify({revision,scenario:'restored rollout older than missing timestamp',result,seen:f.app.cohort.seen.get('other')}));
  assert.equal(result.status,'completed');
  assert.equal(result.count,2);
});
