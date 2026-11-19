import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
test('production music host fails closed, respects every capture owner and rolls back an unstarted permission relaunch',{skip:process.platform!=='darwin',timeout:120000},async t=>{
 const d=await mkdtemp(path.join(tmpdir(),'ml-host-'));t.after(()=>rm(d,{recursive:true,force:true}));const host=await readFile(new URL('../native/AppHost.swift',import.meta.url),'utf8');const main=path.join(d,'main.swift'),bin=path.join(d,'check');
 await writeFile(main,host+`\nextension AppDelegate { func addFixtureMusic(){addedFeatures.insert("music")} }
let app=AppDelegate()
precondition(!app.musicPlayAllowed())
app.addFixtureMusic()
precondition(app.musicPlayAllowed())
app.setMusicCapture("voiceControl",active:true)
precondition(!app.musicPlayAllowed())
app.setMusicCapture("voiceControl",active:false)
precondition(!app.musicPlayAllowed(requireForeground:true))
app.setMusicCapture("microphone",active:true)
app.setMusicCapture("selectionVoice",active:true)
precondition(!app.musicPlayAllowed())
app.setMusicCapture("microphone",active:false)
precondition(!app.musicPlayAllowed())
app.setMusicCapture("selectionVoice",active:false)
precondition(app.musicPlayAllowed())
app.setMusicCapture("dictationUnconfirmed",active:true)
precondition(!app.musicPlayAllowed())
app.setMusicCapture("dictation:held",active:true)
precondition(!app.musicPlayAllowed(recoverDictation:true))
app.setMusicCapture("dictation:held",active:false)
precondition(app.musicPlayAllowed())
app.preparingUpdate=true;precondition(!app.musicPlayAllowed());app.preparingUpdate=false
app.terminating=true;precondition(!app.musicPlayAllowed());app.terminating=false
app.musicEverUsed=true;app.permissionRelaunchPending=true;app.permissionRecovery.attempted=true
var failed=false;app.flushMusicForTransition{saved in failed = !saved}
precondition(failed && app.musicSaveFailed && !app.musicFlushInProgress)
precondition(!app.permissionRecovery.attempted && !app.permissionRelaunchPending)
precondition(!app.terminating && app.worker == nil)
app.musicDocumentID="old-document"
precondition(!app.musicSaveReceiptIsValid(["saved":true,"documentId":"new-document"]))
precondition(!app.musicSaveReceiptIsValid(true))
precondition(app.musicSaveReceiptIsValid(["saved":true,"documentId":"old-document"]))
app.musicDocumentLost=true;precondition(!app.musicSaveReceiptIsValid(["saved":true,"documentId":"old-document"]))
app.retireMusicDocumentForReload()
precondition(!app.registerMusicDocument(["documentId":"old-document","saveHealthy":true]))
precondition(!app.registerMusicDocument(["documentId":"old-document","present":true,"active":false]))
precondition(!app.registerMusicDocument(["documentId":"new-document","saveHealthy":true]))
precondition(app.musicDocumentID == nil && !app.musicEverUsed)
precondition(app.registerMusicDocument(["documentId":"new-document","present":true,"active":false]))
precondition(app.musicEverUsed && app.musicDocumentID == "new-document")
precondition(app.musicSaveReceiptIsValid(["saved":true,"documentId":"new-document"]))
print("music-host: 25 checks; no UI/network/HID")
`);
 const root=fileURLToPath(new URL('../',import.meta.url)),framework=path.join(root,'vendor/sparkle'),run=promisify(execFile);await run('swiftc',[main,path.join(root,'tests/fixtures/selection-host-boundary.swift'),...['AppInstance','UpdateUserDriver','AudioCapture','KeyGestureGate'].map(x=>path.join(root,'native/'+x+'.swift')),'-o',bin,'-F',framework,'-framework','Sparkle','-Xlinker','-rpath','-Xlinker',framework,...['AppKit','WebKit','Carbon','AVFoundation','CoreAudio','Accelerate'].flatMap(x=>['-framework',x])]);assert.match((await run(bin)).stdout,/25 checks; no UI\/network\/HID/);
});
