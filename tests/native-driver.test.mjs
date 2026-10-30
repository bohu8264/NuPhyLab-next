import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('official driver safely opens once and reconnects only once after the app returns to the foreground',{skip:process.platform!=='darwin'},async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'nuphylab-driver-unit-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const source=await readFile(new URL('../native/AppHost.swift',import.meta.url),'utf8');
 const assertions=await readFile(new URL('./fixtures/native-driver-checks.swift',import.meta.url),'utf8');
 const main=path.join(directory,'main.swift'),binary=path.join(directory,'check');
 await writeFile(main,source+'\n'+assertions);
 const run=promisify(execFile);
 await run('swiftc',['-module-cache-path',path.join(directory,'module-cache'),main,fileURLToPath(new URL('../native/AppInstance.swift',import.meta.url)),fileURLToPath(new URL('../native/AudioCapture.swift',import.meta.url)),'-o',binary,'-framework','AppKit','-framework','WebKit','-framework','Carbon','-framework','AVFoundation','-framework','CoreAudio','-framework','Accelerate']);
 const result=JSON.parse((await run(binary)).stdout.trim());
 assert.equal(result.passed,true);assert.equal(result.checks,55);
 assert.equal(result.browserOpened,false);assert.equal(result.GUIOpened,false);
});
