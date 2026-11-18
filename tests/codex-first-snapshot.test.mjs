import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAdapter } from '../server/codex.mjs';

const boundary = Date.parse('2026-09-10T13:00:00Z');
const q = value => "'" + value.replaceAll("'", "''") + "'";
const event = (type, time) => JSON.stringify({
  timestamp: new Date(time).toISOString(),
  type: 'event_msg',
  payload: { type },
}) + '\n';

for (const {name, terminalAt, active, reconnect, expected} of [
  {name:'verified historical failure remains outside new cohort',terminalAt:boundary-1000,expected:'idle'},
  {name:'failure during first poll must not produce white idle',terminalAt:boundary+300,expected:'error'},
  {name:'cancellation during first poll must not green alongside another success',terminalAt:boundary+300,active:true,expected:'unknown'},
  {name:'cancellation during first poll after reconnect must not green',terminalAt:boundary+300,active:true,reconnect:true,expected:'unknown'},
]) test(name, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'nuphylab-r17-first-snapshot-'));
  const database = path.join(home, 'state_12.sqlite');
  const other = path.join(home, 'other.jsonl');
  const long = path.join(home, 'long.jsonl');
  const sql = statement => execFileSync('/usr/bin/sqlite3', [database, statement]);
  const insert = (id, file) => sql(`INSERT INTO threads VALUES (${q(id)}, ${q(file)}, ${boundary});`);
  const writers = new Map();
  let now = reconnect ? boundary-3000 : boundary;
  const adapter = new CodexAdapter({ codexHome: home, now: () => now, enableQuota: false, liveWriters: async () => writers });
  t.after(async () => { await adapter.stop(); await rm(home, {recursive:true, force:true}); });
  sql('CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at_ms INTEGER);');

  // Enabling observation captures the exact connection boundary. Delay the
  // first read until files are written, as can happen during async polling.
  if (reconnect) {
    adapter.observeAggregate(true);
    await adapter.start();
    assert.equal(adapter.snapshot().aggregate.status, 'idle');
    adapter.observeAggregate(false);
    now = boundary;
  }
  adapter.observeAggregate(true);
  await writeFile(other, event('turn_started', terminalAt-100) + event(active ? 'turn_aborted' : 'turn_failed', terminalAt));
  insert('other', other);
  if (active) {
    await writeFile(long, event('turn_started', boundary+100));
    insert('long', long);
    writers.set('long', { startedAt: boundary-100 });
  }
  now = boundary+500;
  if (reconnect) await adapter.pollTasks();
  else await adapter.start();
  const first = adapter.snapshot();
  if (active) {
    assert.equal(first.aggregate.status, 'running');
    now = boundary+1500;
    await appendFile(long, event('turn_complete', now));
    await adapter.pollTasks();
    now = boundary+2500;
    await adapter.pollTasks();
  }
  const actual = adapter.snapshot().aggregate;
  console.log(JSON.stringify({name, boundary, terminalAt, first:first.aggregate, firstTaskStatuses:first.tasks.map(x=>[x.id,x.status]), actual, expected}));
  assert.equal(actual.status, expected);
});
