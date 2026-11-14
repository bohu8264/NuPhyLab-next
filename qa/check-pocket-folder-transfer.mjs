import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-pocket-folder-transfer-'));
try {
 const archiveSources=['DragConvertCore','DragTrigger','DragOutput','DragArchiveConverter','DragDocumentConverter','DragImageConverter','DragWebPEncoder'].map(x=>'native/drag/'+x+'.swift');
 const binary=path.join(dir,'checks');
 // Instrument only a disposable source copy at two boundaries. Deterministic
 // barriers verify cancellation/cleanup and source mutation without UI timing.
 let helper=await readFile('native/pocket/PocketFolderTransfer.swift','utf8');
 for(const [needle,hook] of [
  ['        defer { workLock.unlock() }\n        do {','        defer { workLock.unlock() }\n        PocketFolderTransferTestHooks.runLocked()\n        do {'],
  ['            let after = try snapshot(urls, limits: limits, check: check)','            PocketFolderTransferTestHooks.runPacked()\n            let after = try snapshot(urls, limits: limits, check: check)']]) {
  if(helper.split(needle).length!==2) throw new Error('Test hook boundary changed');
  helper=helper.replace(needle,hook);
 }
 const instrumented=path.join(dir,'PocketFolderTransfer.swift');await writeFile(instrumented,helper);
 execFileSync('swiftc',['-swift-version','5','-import-objc-header','native/AppBridge.h','native/pocket/PocketL10n.swift',instrumented,...archiveSources,'bin/libwebp.a','qa/pocket/FolderTransferTests.swift','-o',binary,'-larchive.2',...['AppKit','Carbon','ImageIO','PDFKit','UniformTypeIdentifiers'].flatMap(x=>['-framework',x])],{stdio:'inherit'});
 execFileSync(binary,[],{stdio:'inherit'});
}finally{await rm(dir,{recursive:true,force:true});}
