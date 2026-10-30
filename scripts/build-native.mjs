import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {ensureSparkle} from './fetch-sparkle.mjs';
if(process.platform!=='darwin')throw new Error('Native macOS build requires macOS');
const framework=await ensureSparkle();
await mkdir('bin',{recursive:true});
const target=`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx13.0`;
execFileSync('swiftc',['-target',target,'native/HIDBridge.swift','-O','-o','bin/HIDBridge','-framework','IOKit','-framework','AppKit','-framework','ApplicationServices'],{stdio:'inherit'});
execFileSync('swiftc',['-target',target,'native/main.swift','native/AppInstance.swift','native/AppHost.swift','native/AudioCapture.swift','-O','-o','bin/AirStudio',
  '-F',framework,'-framework','Sparkle','-Xlinker','-rpath','-Xlinker','@executable_path/../Frameworks',
  ...['AppKit','WebKit','Carbon','AVFoundation','CoreAudio','Accelerate'].flatMap(name=>['-framework',name])],{stdio:'inherit'});
