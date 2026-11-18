import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter } from '../server/codex.mjs';

const epoch = Date.parse('2026-09-10T13:00:00Z');

for (const overlapsReset of [false, true]) test(`old scope exceeds capacity ${overlapsReset ? 'after' : 'before'} reset`, async t => {
  let now = epoch;
  let ids = [];
  let firstEntered;
  let finishOld;
  const started = new Promise(resolve => { firstEntered = resolve; });
  const resume = new Promise(resolve => { finishOld = resolve; });
  const adapter = new CodexAdapter({ codexHome:'/fixture', now:()=>now, enableQuota:false, liveWriters:async()=>new Map() });
  adapter.discoverDatabase = async () => '/fixture/state_12.sqlite';
  adapter.metadata = async () => ({ unread:null, pinned:[] });
  adapter.sql = async (_database, query) => query.startsWith('PRAGMA')
    ? ['id','rollout_path','updated_at_ms'].map(name=>({name}))
    : ids.map(id=>({id, total_count:ids.length, updated_ms:now, scope_updated_at_ms:now}));
  adapter.readTaskEvent = async row => {
    if (row.id==='overflow') { firstEntered(); await resume; }
    return {kind:'completed',status:'completed',explicitSuccess:true,eventAt:epoch-1000,signature:row.id,scopeComplete:true};
  };
  t.after(()=>adapter.stop());
  const batch = (offset,length) => Array.from({length},(_,index)=>`thread-${offset+index}`);
  adapter.observeAggregate(true);
  ids=batch(0,2000); now+=1000; await adapter.start();
  ids=batch(2000,2000); now+=1000; await adapter.pollTasks();
  ids=batch(4000,96); now+=1000; await adapter.pollTasks();
  assert.equal(adapter.aggregateScopeEvidence.size,4096);
  assert.equal(adapter.aggregateScopeOverflow,false);

  ids=['overflow']; now+=1000;
  const oldPoll=adapter.pollTasks();
  await started;
  const reset = () => {adapter.observeAggregate(false);adapter.observeAggregate(true);};
  if (overlapsReset) reset();
  finishOld();
  await oldPoll;
  if (!overlapsReset) reset();

  ids=[]; now+=1000; await adapter.pollTasks();
  const result=adapter.snapshot().aggregate;
  console.log(JSON.stringify({overlapsReset,actual:result,trackedInNewScope:adapter.aggregateScopeEvidence.size,overflowInNewScope:adapter.aggregateScopeOverflow}));
  assert.equal(result.complete,true,'the empty new scope must be independently verifiable');
  assert.equal(result.status,'idle');
});
