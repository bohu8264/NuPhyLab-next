// Real production UI + isolated HTTP service. Fake HID and generated works only.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {fakeService} from '../tests/helpers/fake-service.mjs';
import {initialSession,demoEvents} from '../ui/src/music/model.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=process.argv[2]??await mkdtemp(path.join(os.tmpdir(),'nuphylab-feature-browser-'));
await mkdir(output,{recursive:true});
const dir=await mkdtemp(path.join(os.tmpdir(),'nuphylab-feature-isolated-'));
const cleanup=[],checks=[],exceptions=[];let chrome,ws,send;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,check,label){for(let n=0;n<160;n++){const value=await read();if(check(value))return value;await delay(50);}throw Error('Timed out: '+label);}
try {
 const service=await fakeService({after:fn=>cleanup.push(fn)},{freshLibrary:true,storedSettings:{language:'zh-CN',sidebarFeatures:['studio','library','codex']},firmwareVersion:'1.0.23.6',latestFirmware:'1.0.23.6',firmwareOffline:true},{environment:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:dir,TMPDIR:dir},uiDir:path.join(root,'ui/dist')});
 const musicRequest=async(suffix,method='GET',value)=>{const response=await fetch(new URL('/api/music/'+suffix,service.url),{method,headers:{'X-Air-Token':service.token,'Content-Type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});const data=await response.json();assert(data.ok,JSON.stringify(data));return data;};
 const original={...initialSession(),projectId:randomUUID(),name:'Morning Notes',events:demoEvents()};
 await musicRequest('session','POST',original);
 await musicRequest('works','POST',{...initialSession(),projectId:randomUUID(),name:'Quiet Rhythm',drumEnabled:true});
 assert((await service.command({op:'saveScene',scene:{name:'Evening Glow',colors:Array(84).fill('#88aacc'),animation:{effect:'static',direction:'right',speed:4,loop:true}}})).ok);
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
 await send('Page.enable');await send('Runtime.enable');const downloads=path.join(dir,'downloads');await mkdir(downloads);await send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await send('Emulation.setDeviceMetricsOverride',{width:1120,height:820,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:service.url});await page('studio');await click('稍后');
 await until(()=>evaluate(`document.querySelectorAll('.feature-sidebar-nav button').length`),n=>n===3,'default three');checks.push('fresh sidebar has only three features');
 await click('功能中心');await page('features');await until(()=>evaluate(`document.querySelectorAll('.feature-card').length`),n=>n===9,'feature cards');await shot('feature-center-zh');
 await click('添加键盘口袋');await until(()=>service.state(),s=>s.settings.sidebarFeatures.includes('keyboard-pocket'),'add pocket');
 await click('移除灯光创作');await until(()=>service.state(),s=>!s.settings.sidebarFeatures.includes('studio'),'remove default');await send('Page.reload');await page('features');await settle();if(await evaluate(`Array.from(document.querySelectorAll('[role=dialog] button')).some(b=>b.textContent.trim()==='稍后')`))await click('稍后');
 assert(!(await service.state()).settings.sidebarFeatures.includes('studio'));checks.push('add/remove and restart persistence');
 for(const id of [...(await service.state()).settings.sidebarFeatures]){await evaluate(`document.querySelector('[data-feature="${id}"] .feature-remove').click()`);await until(()=>service.state(),s=>!s.settings.sidebarFeatures.includes(id),'remove '+id);await settle();}
 assert.equal(await evaluate(`document.querySelectorAll('.feature-sidebar-nav button').length`),0);checks.push('empty personalized sidebar retains Feature Center, Devices and Settings');
 await click('添加作品库');await until(()=>service.state(),s=>s.settings.sidebarFeatures.includes('library'),'library add');await settle();await click('作品库');await page('library');await until(()=>evaluate(`document.querySelectorAll('.unified-work-grid article').length`),n=>n===3,'all works mixed');await shot('unified-library-zh');
 checks.push('existing lighting + music visible without adding their editors');
 await click('演奏');await until(()=>evaluate(`document.querySelectorAll('.unified-work-grid article').length`),n=>n===2,'music filter');await click('添加演奏模式并编辑');await page('music');await until(()=>evaluate(`document.querySelector('input[aria-label="演奏名称"]')?.disabled`),v=>v===false,'editor read');
 const chosenName=await evaluate(`document.querySelector('input[aria-label="演奏名称"]').value`);assert(['Morning Notes','Quiet Rhythm'].includes(chosenName));
 const all=(await musicRequest('works')).works,chosen=all.find(w=>w.name===chosenName);const before=(await musicRequest('works/'+chosen.id)).work.session;
 await evaluate(`(()=>{const field=document.querySelector('input[aria-label="演奏名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'Edited in unified library');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await until(()=>musicRequest('works/'+chosen.id),x=>x.work.session.name==='Edited in unified library','autosave existing');await click('作品库',`document.querySelector('.ml-tabs')`);await page('library');
 assert.equal(await evaluate(`document.querySelector('.unified-filter button[aria-pressed="true"]').textContent.trim()`),'演奏');const after=(await musicRequest('works/'+chosen.id)).work.session;assert.equal(after.projectId,before.projectId);assert.deepEqual(after.events,before.events);assert.equal((await musicRequest('works')).works.length,2);checks.push('add editor + reopen + save updates original ID/events and returns to music filter');
 await click('查看作品Edited in unified library');await click('导出工程');const exported=await until(()=>readFile(path.join(downloads,'Edited in unified library.nuphy-music'),'utf8').catch(()=>''),Boolean,'project export');assert.deepEqual(JSON.parse(exported).events,before.events);assert.deepEqual(JSON.parse(exported).clips,before.clips);checks.push('project export preserves notes and imported-clip configuration');await click('复制作品');await until(()=>musicRequest('works'),x=>x.works.length===3,'duplicate');
 await click('重命名');await evaluate(`(()=>{const field=document.querySelector('input[aria-label="新的作品名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'Renamed music');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('保存名称');await until(()=>musicRequest('works/'+chosen.id),x=>x.work.session.name==='Renamed music','rename');
 await click('查看作品Renamed music');await click('移到最近删除');await click('移到最近删除',`document.querySelector('[role="dialog"]')`);await until(()=>musicRequest('works?deleted=1'),x=>x.works.some(w=>w.id===chosen.id),'delete');await click('最近删除');await click('恢复作品');await until(()=>musicRequest('works'),x=>x.works.some(w=>w.id===chosen.id),'restore');
 await click('我的作品');await settle();await click('继续编辑');await page('music');await until(()=>evaluate(`document.querySelector('input[aria-label="演奏名称"]')?.disabled`),v=>v===false,'restored editor');checks.push('duplicate/rename/delete/restore keep full project and subsequent editor works');
 await click('作品库',`document.querySelector('.ml-tabs')`);await page('library');await service.command({op:'settings',settings:{language:'en'}});await until(()=>evaluate(`document.documentElement.lang`),value=>value==='en','English');await click('All');await shot('unified-library-en');
 const libraryText=await evaluate(`(()=>{const copy=document.querySelector('.unified-library').cloneNode(true);copy.querySelectorAll('[translate=no]').forEach(n=>n.remove());return copy.textContent;})()`);assert.doesNotMatch(libraryText,/[\u3400-\u9fff]/);await click('Feature Center');await page('features');assert.doesNotMatch(await evaluate(`document.querySelector('.feature-center').innerText`),/[\u3400-\u9fff]/);await shot('feature-center-en');
 await send('Emulation.setDeviceMetricsOverride',{width:900,height:660,deviceScaleFactor:1,mobile:false});await shot('feature-center-small-en');assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);checks.push('Chinese/English + 900px viewport without horizontal overflow');
 assert.deepEqual(exceptions,[]);await writeFile(path.join(output,'RESULT.json'),JSON.stringify({ok:true,checks,scope:'headless Chrome, production dist and isolated real HTTP service with fake HID; no native or physical-input claim'},null,2));console.log(JSON.stringify({ok:true,checks,output}));
} catch(error) {
 if(send){try{const result=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,'failure.png'),Buffer.from(result.data,'base64'));}catch{}}
 await writeFile(path.join(output,'FAILURE.json'),JSON.stringify({error:String(error.stack??error),checks,exceptions},null,2));throw error;
} finally {ws?.close();if(chrome){chrome.kill('SIGTERM');await new Promise(resolve=>{chrome.once('exit',resolve);setTimeout(resolve,1500);});}for(const stop of cleanup.reverse())await stop();await rm(dir,{recursive:true,force:true});}
