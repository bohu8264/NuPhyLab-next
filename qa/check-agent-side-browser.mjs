// Real production UI + isolated HTTP service. Fake HID and generated works only.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {fakeService} from '../tests/helpers/fake-service.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=process.argv[2]??await mkdtemp(path.join(os.tmpdir(),'nuphylab-feature-browser-'));
await mkdir(output,{recursive:true});
const dir=await mkdtemp(path.join(os.tmpdir(),'nuphylab-feature-isolated-'));
const cleanup=[],checks=[],exceptions=[];let chrome,ws,send;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,check,label){for(let n=0;n<160;n++){const value=await read();if(check(value))return value;await delay(50);}throw Error('Timed out: '+label);}
try {
 const service=await fakeService({after:fn=>cleanup.push(fn)},{freshLibrary:true,sideWholeZone:true,aggregate:{status:'running',complete:true,fresh:true,count:9,succeeded:0},permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true},storedSettings:{language:'zh-CN',sidebarFeatures:['studio','library','codex']},firmwareVersion:'1.0.23.6',latestFirmware:'2.0.0.7'},{environment:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:dir,TMPDIR:dir},uiDir:path.join(root,'ui/dist')});
 const profile=path.join(dir,'chrome');await mkdir(profile);
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-gpu','--mute-audio','about:blank'],{stdio:'ignore'});
 const port=await until(()=>readFile(path.join(profile,'DevToolsActivePort'),'utf8').catch(()=>''),text=>text.includes('\n'),'Chrome port');
 const target=await(await fetch('http://127.0.0.1:'+port.split('\n')[0]+'/json/new?about:blank',{method:'PUT'})).json();
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});let seq=0;const pending=new Map();
 ws.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.id){const job=pending.get(msg.id);pending.delete(msg.id);msg.error?job.reject(Error(JSON.stringify(msg.error))):job.resolve(msg.result);}else if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params.exceptionDetails);};
 send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);return result.result?.value;};
 const click=async(label,scope='document')=>{await until(()=>evaluate(`Array.from(${scope}.querySelectorAll('button')).some(b=>b.getClientRects().length && !b.disabled && (b.textContent.trim()===${JSON.stringify(label)} || b.getAttribute('aria-label')===${JSON.stringify(label)}))`),Boolean,'button '+label);const point=await until(()=>evaluate(`(()=>{const b=Array.from(${scope}.querySelectorAll('button')).find(b=>b.getClientRects().length && !b.disabled && (b.textContent.trim()===${JSON.stringify(label)} || b.getAttribute('aria-label')===${JSON.stringify(label)}));b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!b.contains(document.elementFromPoint(x,y)))return null;return {x,y};})()`),Boolean,'uncovered '+label);await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});};
 const page=expected=>until(()=>evaluate(`document.querySelector('.app-shell')?.dataset.page`),v=>v===expected,'page '+expected);
 const settle=()=>delay(180);
 const shot=async name=>{await settle();const value=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,name+'.png'),Buffer.from(value.data,'base64'));};

 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1120,height:900,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:service.url});await page('studio');await click('稍后');
 await click('AI 助手');await click('状态灯');await click('侧灯模式');
 await until(()=>service.state(),s=>s.settings.codexLightZone==='side','side setting');await click('Codex 模式');
 await until(()=>service.state(),s=>s.codex.lighting.side.ownsOutput===true,'side ownership');await settle();
 assert.equal(await evaluate(`document.querySelectorAll('.agent-side-page .model-side-led').length`),20);
 assert.equal(await evaluate(`Array.from(document.querySelectorAll('.agent-side-page .model-side-led')).every(e=>{const r=e.getBoundingClientRect();return Math.abs(r.width-r.height)<.1&&getComputedStyle(e).borderRadius==='0px'})`),true);
 await shot('side-mode-zh');checks.push('Chinese side mode: 20 square LEDs and USB output receipt');
 await click('任务与快捷键');assert.equal(await evaluate(`document.querySelectorAll('.agent-task-row').length`),0);
 await click('启用命令键（默认 F7–F12）');await until(()=>service.state(),s=>s.codex.keys.enabled===false,'commands off');
 assert.equal(await evaluate(`Array.from(document.querySelectorAll('.agent-command-strip button')).every(b=>b.disabled)`),true);checks.push('side mode removes task-key table and command switch releases keys');
 await service.command({op:'settings',settings:{language:'en'}});await until(()=>evaluate(`document.documentElement.lang`),v=>v==='en','English');
 await click('Status lights');await shot('side-mode-en');await send('Emulation.setDeviceMetricsOverride',{width:820,height:740,deviceScaleFactor:1,mobile:false});await shot('side-mode-en-compact');assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true);await send('Emulation.setDeviceMetricsOverride',{width:1120,height:900,deviceScaleFactor:1,mobile:false});
 assert.equal(await evaluate(`document.querySelector('.agent-side-legend')?.textContent.includes('Idle')`),true);
 await click('Firmware management');await until(()=>evaluate(`document.querySelector('[role=dialog]')?.textContent`),s=>s?.includes('Official firmware & recovery'),'official firmware management');
 assert.equal(await evaluate(`document.querySelector('[role=dialog]')?.textContent.includes('Experimental firmware')`),false);
 await evaluate(`document.querySelector('[role=dialog] summary').click()`);
 assert.equal(await evaluate(`document.querySelector('[role=dialog] details').open`),true);
 assert.equal(await evaluate(`Array.from(document.querySelectorAll('[role=dialog] button')).some(b=>b.textContent.includes('NuPhyIO')&&!b.disabled)`),true);await shot('firmware-recovery-en');checks.push('English official firmware recovery entry without experimental firmware');
 await evaluate(`document.querySelector('[role=dialog] .modal-close')?.click()`);
 if(await evaluate(`!!document.querySelector('[role=dialog]')`))await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await click('Backlight');await until(()=>service.state(),s=>s.settings.codexLightZone==='backlight','backlight restored');assert.deepEqual((await service.state()).codex.keys.bindings.map(k=>k.index),[0,1,2,3,4,5]);checks.push('backlight restores six task keys while command switch stays off');
 assert.equal(exceptions.length,0,JSON.stringify(exceptions));await writeFile(path.join(output,'RESULT.json'),JSON.stringify({allPass:true,checks,exceptions,realHardware:false,realBLE:false},null,2));console.log(JSON.stringify({allPass:true,checks}));
} catch(error) {
 if(send){try{const result=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,'failure.png'),Buffer.from(result.data,'base64'));}catch{}}
 await writeFile(path.join(output,'FAILURE.json'),JSON.stringify({error:String(error.stack??error),checks,exceptions},null,2));throw error;
} finally {ws?.close();if(chrome){chrome.kill('SIGTERM');await new Promise(resolve=>{chrome.once('exit',resolve);setTimeout(resolve,1500);});}for(const stop of cleanup.reverse())await stop();await rm(dir,{recursive:true,force:true});}
