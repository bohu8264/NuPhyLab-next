import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-pocket-controller-'));
try {
 const sources=(await readdir('native/pocket')).filter(x=>x.endsWith('.swift')&&x!=='PocketConflictPolicy.swift').map(x=>'native/pocket/'+x);
 const archiveSources=['DragConvertCore','DragTrigger','DragOutput','DragArchiveConverter','DragDocumentConverter','DragImageConverter','DragWebPEncoder'].map(x=>'native/drag/'+x+'.swift');
 const binary=path.join(dir,'checks');
 execFileSync('swiftc',['-swift-version','5','-import-objc-header','native/AppBridge.h',...sources,...archiveSources,'bin/libwebp.a','native/LabNotchGeometry.swift','qa/pocket/ControllerTests.swift','-o',binary,'-larchive.2',...['AppKit','WebKit','ApplicationServices','Carbon','ImageIO','QuartzCore','PDFKit','UniformTypeIdentifiers'].flatMap(x=>['-framework',x])],{stdio:'inherit'});
 execFileSync(binary,[],{stdio:'inherit'});
}finally{await rm(dir,{recursive:true,force:true});}
