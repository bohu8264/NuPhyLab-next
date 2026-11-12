import {mkdir,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {ensureSparkle} from './fetch-sparkle.mjs';
import {buildWebP} from './build-webp.mjs';
if(process.platform!=='darwin')throw new Error('Native macOS build requires macOS');
const framework=await ensureSparkle();
await mkdir('bin',{recursive:true});
const target=`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx13.0`;
const webp = await buildWebP(target);
if(!process.argv.includes('--host-only')) execFileSync('swiftc',['-target',target,'native/HIDBridge.swift','-O','-o','bin/HIDBridge','-framework','IOKit','-framework','AppKit','-framework','ApplicationServices'],{stdio:'inherit'});
execFileSync('clang',['-target',target,'-fobjc-arc','-c','native/selection-audio/ChordAudioBoundary.m','-I','native/selection-audio/include','-o','bin/SelectionAudioBoundary.o'],{stdio:'inherit'});
const selected=(await readdir('native/selection')).filter(x=>x.endsWith('.swift')).map(x=>'native/selection/'+x);
const typing=(await readdir('native/typing')).filter(x=>x.endsWith('.swift')).map(x=>'native/typing/'+x);
const drag=(await readdir('native/drag')).filter(x=>x.endsWith('.swift')).map(x=>'native/drag/'+x);
const integration=[...drag,...typing,'native/LabNotchGeometry.swift','native/SelectionIntegration.swift','native/SelectionLab.swift','native/SelectionInteraction.swift','native/SelectionNotch.swift','native/SelectionAnswerView.swift','native/SelectionMarkdown.swift','bin/SelectionAudioBoundary.o',webp,...selected];
execFileSync('swiftc',['-target',target,'-swift-version','5','-import-objc-header','native/AppBridge.h',...integration,'native/main.swift','native/AppInstance.swift','native/AmbientLight.swift','native/AppHost.swift','native/UpdateUserDriver.swift','native/AudioCapture.swift','native/KeyGestureGate.swift','-O','-o','bin/AirStudio','-larchive.2',
  '-F',framework,'-framework','Sparkle','-Xlinker','-rpath','-Xlinker','@executable_path/../Frameworks',
  ...['AppKit','WebKit','QuartzCore','Carbon','AVFoundation','CoreAudio','Accelerate','SwiftUI','ScreenCaptureKit','Vision','Security','Speech','ImageIO','UniformTypeIdentifiers','PDFKit'].flatMap(name=>['-framework',name])],{stdio:'inherit'});
