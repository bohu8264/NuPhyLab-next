import test from 'node:test';import assert from 'node:assert/strict';
import {queueMusicWrite,registerMusicFlush,flushMusic} from '../ui/src/music/persistence.ts';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('navigation read waits for the previous mount final save; failure keeps latest snapshot retryable',async()=>{
 let stored={events:[]},current={events:Array(12).fill('note')};const gate=defer();let release=registerMusicFlush(async()=>{await queueMusicWrite(async()=>{await gate.promise;stored=structuredClone(current);});});
 let read=false;const remount=(async()=>{await flushMusic();read=true;return structuredClone(stored);})();await new Promise(r=>setImmediate(r));assert.equal(read,false);gate.resolve();assert.equal((await remount).events.length,12);release();
 let fail=true;current={events:Array(24).fill('note')};release=registerMusicFlush(async()=>{await queueMusicWrite(async()=>{if(fail)throw Error('disk unavailable');stored=structuredClone(current);});});
 await assert.rejects(flushMusic(),/disk unavailable/);assert.equal(stored.events.length,12);fail=false;await flushMusic();assert.equal(stored.events.length,24);release();
});
test('completion of an old unmount cannot clear the newer mount flush',async()=>{const order=[];const old=registerMusicFlush(async()=>{order.push('old')});const latest=registerMusicFlush(async()=>{order.push('new')});old();await flushMusic();assert.deepEqual(order,['new']);latest();});
test('retrying a reported library failure is allowed while an unsaved editor remains protected',async()=>{
 const {prepareMusicLibraryAction}=await import('../ui/src/music/persistence.ts');await assert.rejects(queueMusicWrite(async()=>{throw Error('temporary library failure')}));await prepareMusicLibraryAction();let retried=false;await queueMusicWrite(async()=>{retried=true;});assert(retried);
 const release=registerMusicFlush(async()=>{throw Error('unsaved editor')});await assert.rejects(prepareMusicLibraryAction(),/unsaved editor/);release();
});
test('writes drain even after page unmount and a failed write is surfaced',async()=>{const gate=defer();const save=queueMusicWrite(()=>gate.promise);let finished=false;const quit=flushMusic().then(()=>{finished=true});await new Promise(r=>setImmediate(r));assert.equal(finished,false);gate.resolve();await save;await quit;assert(finished);const failed=queueMusicWrite(async()=>{throw Error('disk full')});await assert.rejects(failed);await assert.rejects(flushMusic(),/disk full/);await queueMusicWrite(async()=>{});await flushMusic();});
test('quit waits for delayed mutations to finish before saving the final snapshot',async()=>{const {trackMusicEdit}=await import('../ui/src/music/persistence.ts');const gate=defer();let value='before',stored='';const release=registerMusicFlush(async()=>{stored=value});const mutation=trackMusicEdit(async()=>{await gate.promise;value='after audio decode';});let done=false;const quit=flushMusic().then(receipt=>{done=true;assert.equal(receipt.saved,true)});await new Promise(r=>setImmediate(r));assert(!done);gate.resolve();await mutation;await quit;assert.equal(stored,'after audio decode');release();});
test('conflict cancels queued writes, stays blocked in the old document and clears only in a fresh document',async()=>{
 const {createVMEnvironment,deferred}=await import('./helpers/source-ui-vm.mjs');
 const url=new URL('../ui/src/music/persistence.ts',import.meta.url);
 const old=(await createVMEnvironment().load(url)).exports,gate=deferred();let writes=0;
 const first=old.queueMusicWrite(async()=>{await gate.promise;old.markMusicWriteConflict();});
 const queued=old.queueMusicWrite(async()=>{writes++;});
 const firstCheck=assert.rejects(first,e=>e.code==='MUSIC_WORK_CHANGED'),queuedCheck=assert.rejects(queued,e=>e.code==='MUSIC_WORK_CHANGED');
 gate.resolve();await Promise.all([firstCheck,queuedCheck]);assert.equal(writes,0);await assert.rejects(old.flushMusic(),e=>e.code==='MUSIC_WORK_CHANGED');
 const reopened=(await createVMEnvironment().load(url)).exports;await reopened.queueMusicWrite(async()=>{writes++;});assert.equal((await reopened.flushMusic()).saved,true);assert.equal(writes,1);
 await assert.rejects(old.flushMusic(),e=>e.code==='MUSIC_WORK_CHANGED');
});

test('conflicted remount reads the latest retained draft after all asynchronous edits finish',async()=>{
 const {createVMEnvironment,deferred}=await import('./helpers/source-ui-vm.mjs');const p=(await createVMEnvironment().load(new URL('../ui/src/music/persistence.ts',import.meta.url))).exports;
 let draft={name:'Before import',events:[1]};const old=p.registerMusicFlush(async()=>{},()=>draft),gate=deferred();const edit=p.trackMusicEdit(async()=>{await gate.promise;draft={name:'After import',events:[1,2]};});
 assert.throws(()=>p.markMusicWriteConflict());let read=false;const recovered=p.readMusicConflictDraft().then(value=>{read=true;return value;});await Promise.resolve();assert.equal(read,false);gate.resolve();await edit;assert.deepEqual(await recovered,draft);
 const latest={name:'New mount edit',events:[1,2,3]};p.registerMusicFlush(async()=>{},()=>latest);old();assert.deepEqual(await p.readMusicConflictDraft(),latest);await assert.rejects(p.flushMusic());
});
