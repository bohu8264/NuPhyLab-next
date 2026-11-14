export const musicDocumentID=crypto.randomUUID();
// One queue survives navigation so native Quit can await writes after MusicLab unmounts.
let tail:Promise<unknown>=Promise.resolve();
// A lifecycle conflict is not a transient disk failure. Keep the document
// blocked across remounts and Quit; only an explicit saved-page reload creates
// a new module/document. The current editor remains available for export.
let writeConflict:Error|null=null;
export function markMusicWriteConflict():never{
 writeConflict??=Object.assign(Error('作品已删除或恢复，已暂停保存。请先导出工程备份，再从「窗口 → 恢复演奏页面」打开已保存作品。'),{code:'MUSIC_WORK_CHANGED'});
 throw writeConflict;
}
function assertMusicWriteSafe(){if(writeConflict)throw writeConflict;}
export function musicWriteConflict(){return writeConflict;}
const pendingEdits=new Set<Promise<unknown>>();
export function trackMusicEdit<T>(operation:()=>Promise<T>):Promise<T>{const promise=Promise.resolve().then(operation);pendingEdits.add(promise);void promise.then(()=>pendingEdits.delete(promise),()=>pendingEdits.delete(promise));return promise;}
let flushCurrent:(()=>Promise<void>)|null=null;
let readCurrent:(()=>unknown)|null=null;
export async function readMusicConflictDraft(){
 if(!writeConflict)return null;
 // A late audio import may still finish after the editor unmounts. Wait for
 // all edits, including failures, before reading its retained live snapshot.
 while(pendingEdits.size)await Promise.allSettled([...pendingEdits]);
 return readCurrent?.()??null;
}
export function queueMusicWrite<T>(operation:()=>Promise<T>):Promise<T>{const next=tail.catch(()=>{}).then(()=>{assertMusicWriteSafe();return operation();});tail=next;return next;}
export function registerMusicFlush(flush:()=>Promise<void>,readDraft:(()=>unknown)|null=null){flushCurrent=flush;readCurrent=readDraft;return()=>{if(flushCurrent===flush){flushCurrent=null;readCurrent=null;}};}
export async function waitForMusicEdits(){while(pendingEdits.size)await Promise.all([...pendingEdits]);}
// A failed library mutation has already been reported and may be retried. Never
// clear a retained editor flush or a lifecycle conflict while admitting it.
export async function prepareMusicLibraryAction(){
 assertMusicWriteSafe();await waitForMusicEdits();assertMusicWriteSafe();
 if(!flushCurrent)tail=tail.catch(()=>{});
 return flushMusic();
}
export async function flushMusic(){assertMusicWriteSafe();await waitForMusicEdits();assertMusicWriteSafe();if(flushCurrent)await flushCurrent();await tail;assertMusicWriteSafe();return {saved:true,documentId:musicDocumentID};}
if(typeof window!=='undefined')(window as any).__MUSIC_FLUSH__=flushMusic;
