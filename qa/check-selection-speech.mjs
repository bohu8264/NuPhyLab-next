import {copyFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import path from 'node:path';
const directory=await mkdtemp(path.join(tmpdir(),'nsl-speech-'));
try {
 const commandMode=process.argv.includes('--voice-control');
 const checks=commandMode?['qa/VoiceControlChecks.swift','qa/VoiceControlWebKitCheck.swift','native/LabVoiceControl.swift','native/LabCommandShortcut.swift',
  ...(await readdir('native/voice-input')).filter(x=>x.endsWith('.swift')).map(x=>'native/voice-input/'+x),
  ...['PocketSettings','PocketL10n','PocketConflictPolicy'].map(x=>'native/pocket/'+x+'.swift')]:['qa/SelectionSpeechChecks.swift'];
 const sources=(await readdir('native/selection')).filter(x=>x.endsWith('.swift')).map(x=>'native/selection/'+x);
 const output=path.join(directory,'checks');
 const audio=path.join(directory,'audio.o');
 await copyFile('bin/SelectionAudioBoundary.o',audio);
 execFileSync('swiftc',['-D','DEBUG','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx14.0`,'-swift-version','5','-import-objc-header','native/selection-audio/include/ChordAudioBoundary.h',...checks,audio,...sources,'-O','-o',output,...['AppKit','SwiftUI','Carbon','Security','AVFoundation','ScreenCaptureKit','Vision','Speech',...(commandMode?['WebKit','LocalAuthentication','AudioToolbox','CoreAudio']:[])].flatMap(x=>['-framework',x])],{stdio:'inherit'});
 execFileSync(output,[],{stdio:'inherit'});
 if(commandMode){
  const {fakeService}=await import('../tests/helpers/fake-service.mjs');
  const teardown=[];
  try{
   const service=await fakeService({after:fn=>teardown.push(fn)},{freshLibrary:true,firmwareOffline:true},{
    uiDir:path.resolve('ui/dist'),environment:{PATH:process.env.PATH,HOME:directory,TMPDIR:directory}});
   await service.command({op:'settings',settings:{sidebarFeatures:['studio','library','codex','voice-input']}});
   const result=await promisify(execFile)(output,[service.url],{timeout:40000});
   assert((await service.state()).settings.sidebarFeatures.includes('keyboard-pocket'));
   process.stdout.write(result.stdout);
  }finally{for(const fn of teardown.reverse())await fn();}
 }
}finally{await rm(directory,{recursive:true,force:true});}
