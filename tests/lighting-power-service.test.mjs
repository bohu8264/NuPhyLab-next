import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fakeService,until} from './helpers/fake-service.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const art=Array(84).fill('#123456');
test('successful Codex task keys, task buttons and command keys wake the global timer without resetting it while awake',async t=>{
 const s=await fakeService(t,{tasks:[{id:'a',status:'running'}]});
 await s.command({op:'settings',settings:{codexEnabled:true,codexSelectedPulse:false,brightness:100,lightDurationMs:1000,lightIdleMs:0}});
 await s.command({op:'settings',settings:{codexEnabled:true}});
 for(const request of [{op:'codexKey',code:'F1',phase:'down'},{op:'codexAction',action:'task',threadId:'a'},{op:'codexKey',code:'F12',phase:'down'}]) {
  const asleep=await until(s.state,v=>v.lightPower.sleeping&&v.colors[1]==='#304ffe','background timer did not expire with persistent AI status');
  assert.equal(asleep.codex.lighting.sleeping,false);assert.equal(asleep.codex.lighting.backgroundSleeping,true);
  assert.equal((await s.command(request)).ok,true);
  const awake=await until(s.state,v=>!v.lightPower.sleeping&&v.colors[1]==='#304ffe','Codex interaction left keyboard asleep');
  assert.equal(awake.colors[1],'#304ffe');
  assert.equal(awake.settings.lightDurationMs,1000);
  if(request.code)await s.command({op:'codexKey',code:request.code,phase:'up'});
  await wait(180);
  const before=(await s.state()).lightPower.remainingMs;
  await s.command({op:'codexAction',action:'task',threadId:'a'});
  assert.ok((await s.state()).lightPower.remainingMs<=before,'an awake interaction restarted the duration');
 }
 await until(s.state,v=>v.lightPower.sleeping,'timer did not expire again');
 await s.command({op:'codexKey',code:'F1',phase:'up'});
 assert.equal((await s.command({op:'codexAction',action:'task',threadId:'missing'})).ok,false);
 await s.configure({shortcutPermissionError:true});
 assert.equal((await s.command({op:'codexKey',code:'F12'})).ok,false);
 assert.equal((await s.state()).lightPower.sleeping,true,'failed or release actions woke the timer');
});
test('enabling, switching and editing AI mode preserves an ordinary background timer',async t=>{
 const s=await fakeService(t,{tasks:[{id:'a',status:'running'}]});
 await s.command({op:'settings',settings:{lightDurationMs:2000,lightIdleMs:0}});
 await s.command({op:'preview',colors:art});
 await wait(1100);
 const before=(await s.state()).lightPower.remainingMs;
 await s.command({op:'settings',settings:{codexEnabled:true}});
 assert.ok((await s.state()).lightPower.remainingMs<=before,'mode On must not restart the running work timer');
 await wait(1100);
 await s.command({op:'settings',settings:{codexBrightness:90,language:'en'}});
 const lit=await s.state();
 assert.equal(lit.lightPower.sleeping,true);assert.equal(lit.lightPower.remainingMs,0);
 assert.notEqual(lit.colors[1],'#000000');
 await until(s.state,v=>v.lightPower.sleeping&&v.colors[20]==='#000000'&&v.colors[1]!=='#000000','background did not sleep independently of AI status');
 await s.command({op:'settings',settings:{codexEnabled:false}});
 await s.command({op:'settings',settings:{codexEnabled:true}});
 const resumed=await until(s.state,v=>v.lightPower.sleeping&&v.colors[1]!=='#000000','re-enabling Codex did not resume its persistent overlay');
 assert.equal(resumed.lightPower.remainingMs,0);assert.equal(resumed.codex.lighting.sleeping,false);
 // Source handoff changes only the overlay, not the ordinary work timer.
 await wait(300);
 await s.command({op:'settings',settings:{agentSource:'claude',claudeEnabled:true}});
 const switched=await s.state();assert.equal(switched.lightPower.sleeping,true);assert.equal(switched.lightPower.remainingMs,0);assert.equal(switched.claude.lighting.ownsOutput,true);
});
test('whole keyboard duration blacks main and side lights, survives language changes, and wakes back to artwork',async t=>{
 const s=await fakeService(t);
 await s.command({op:'settings',settings:{brightness:100,lightDurationMs:1000}});
 await s.command({op:'preview',colors:art});
 // Sleeping is published before the asynchronous black frame finishes.
 // Verify the observable result instead of racing that intermediate state.
 const asleep=await until(s.state,v=>v.lightPower.sleeping&&v.colors.every(c=>c==='#000000'),'duration did not switch off');
 assert.ok(asleep.colors.every(c=>c==='#000000'));
 assert.equal((await s.operations()).filter(o=>o.op==='side').at(-1).brightness,0);
 await s.command({op:'settings',settings:{language:'en'}});
 assert.equal((await s.state()).lightPower.sleeping,true);
 await s.command({op:'lightActivity'});assert.equal((await s.state()).lightPower.sleeping,true);
 await s.command({op:'lightWake'});
 const awake=await until(s.state,v=>v.colors[0]==='#123456','wake did not restore artwork');
 assert.equal(awake.lightPower.sleeping,false);
 assert.equal((await s.operations()).filter(o=>o.op==='side').at(-1).restore,true);
 const saved=JSON.parse(await readFile(s.dataDir+'/library.json','utf8'));
 assert.equal(saved.settings.language,'en');assert.equal(saved.settings.lightDurationMs,1000);
});
test('global idle timer sleeps only the background, preserving Codex status and ignoring legacy timeout',async t=>{
 const s=await fakeService(t,{tasks:[{id:'a',status:'running'}]});
 await s.command({op:'settings',settings:{brightness:100,codexEnabled:true,codexAutoOffMs:1000,lightIdleMs:2200}});
 await s.command({op:'settings',settings:{codexEnabled:true}});
 await wait(1200);
 const lit=await s.state();assert.equal(lit.colors[0],'#000000');assert.equal(lit.colors[1],'#304ffe');assert.equal(lit.codex.lighting.sleeping,false);
 const asleep=await until(s.state,v=>v.lightPower.sleeping&&v.colors[1]==='#304ffe','background did not reach its idle state');
 assert.equal(asleep.codex.lighting.sleeping,false);assert.equal(asleep.codex.lighting.backgroundSleeping,true);
 await s.configure({systemIdleMs:0});
 const awake=await until(s.state,v=>!v.lightPower.sleeping&&v.colors[1]==='#304ffe','system activity did not wake the background');
 assert.equal(awake.colors[1],'#304ffe');assert.equal(awake.codex.lighting.sleeping,false);
});
test('global duration leaves persistent Codex status visible; explicit wake still wakes the background',async t=>{
 const s=await fakeService(t,{tasks:[{id:'a',status:'completed'}]});
 await s.command({op:'settings',settings:{brightness:100,codexEnabled:true,codexAutoOffMs:0,lightDurationMs:1000}});
 await s.command({op:'settings',settings:{codexEnabled:true}});
 const asleep=await until(s.state,v=>v.lightPower.sleeping&&v.colors[1]==='#00ff4c','background duration did not expire');
 assert.equal(asleep.codex.lighting.sleeping,false);assert.equal(asleep.codex.lighting.backgroundSleeping,true);
 await s.configure({tasks:[{id:'a',status:'running'}]});await wait(100);
 assert.equal((await s.state()).lightPower.sleeping,true);
 await s.command({op:'codexWake'});
 const awake=await until(s.state,v=>!v.lightPower.sleeping&&v.colors[1]==='#304ffe','explicit wake did not restore the background');
 assert.equal(awake.colors[1],'#304ffe');assert.equal(awake.codex.lighting.sleeping,false);
});
test('animation and game clocks pause during whole-keyboard sleep',async t=>{
 const s=await fakeService(t);
 await s.command({op:'settings',settings:{brightness:100,lightDurationMs:1000}});
 const frames=[{colors:art,duration:1800},{colors:Array(84).fill('#aabbcc'),duration:1800}];
 await s.command({op:'play',colors:art,animation:{effect:'frames',frames,loop:false}});
 await until(s.state,v=>v.lightPower.sleeping,'animation did not sleep');await wait(1900);
 await s.command({op:'lightWake'});
 await until(s.state,v=>v.colors[0]==='#123456','animation advanced while asleep');
 await s.command({op:'gameStart',gameType:'whack',speed:3});
 const asleep=await until(s.state,v=>v.lightPower.sleeping,'game did not sleep');await wait(500);
 await s.command({op:'gameInput',code:asleep.game.targetCode,pressed:true});
 const later=await s.state();assert.deepEqual(later.game,asleep.game);
 await s.command({op:'lightWake'});await until(s.state,v=>v.colors.some(c=>c!=='#000000'),'game did not resume');
});

test('manual pause and resume during timer sleep preserve animation position',async t=>{
 const s=await fakeService(t);
 await s.command({op:'settings',settings:{brightness:100,lightDurationMs:1000}});
 await s.command({op:'play',colors:art,animation:{effect:'frames',loop:false,frames:[{colors:art,duration:2000},{colors:Array(84).fill('#aabbcc'),duration:2000}]}});
 await until(s.state,v=>v.lightPower.sleeping,'animation did not sleep');await wait(1400);
 await s.command({op:'pause'});assert.ok((await s.state()).playback.elapsed<1300);
 await s.command({op:'pause'});
 await until(s.state,v=>v.colors[0]==='#123456'&&!v.lightPower.sleeping,'resume lost the paused frame');
});

test('an occupied preferred origin falls back without blocking startup',async t=>{
 const {createServer}=await import('node:net');const server=createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const port=server.address().port;const s=await fakeService(t,{preferredPort:port});
 assert.notEqual(new URL(s.url).port,String(port));assert.equal((await s.state()).device.connected,true);
});
