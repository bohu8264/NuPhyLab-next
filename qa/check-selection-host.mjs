import {readdir,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const sources=(await readdir('native/selection')).filter(x=>x.endsWith('.swift')).map(x=>'native/selection/'+x);
const temporary=await mkdtemp(path.join(tmpdir(),'nuphylab-selection-checks-'));
const object=path.join(temporary,'audio.o'),binary=path.join(temporary,'check');
try {
await copyFile('bin/SelectionAudioBoundary.o',object);
execFileSync('swiftc',['-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx14.0`,'-swift-version','5','-DDEBUG','-import-objc-header','native/selection-audio/include/ChordAudioBoundary.h','qa/SelectionChecks.swift','qa/SelectionSideButtonChecks.swift','qa/SelectionReplyChecks.swift','native/SelectionIntegration.swift','native/SelectionLab.swift','native/drag/DragTrigger.swift','native/SelectionInteraction.swift','native/LabNotchGeometry.swift','native/SelectionNotch.swift','native/SelectionAnswerView.swift','native/SelectionMarkdown.swift',object,...sources,process.env.NUPHY_SELECTION_QA_DEBUG === '1' ? '-Onone' : '-O','-o',binary,...['AppKit','SwiftUI','Carbon','Security','AVFoundation','ScreenCaptureKit','Vision','Speech'].flatMap(x=>['-framework',x])],{stdio:'inherit'});
execFileSync(binary,[],{stdio:'inherit'});
} finally {await rm(temporary,{recursive:true,force:true});}
