import {FIRMWARE_URL} from '../server/firmware.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';
const wait=async (inspect,timeoutMs=5000)=>{const end=Date.now()+timeoutMs;while(!await inspect()){if(Date.now()>end)assert.fail('isolated desktop service timed out');await new Promise(r=>setTimeout(r,20));}};
async function ready(t,options={}){
  const f=await previewServiceFixture(t,{desktopIO:true,connected:true,identityQualification:{status:'qualified',source:'embeddedUsbSerial',reasonCode:null},...options}),s=await f.start();
  await s.command({op:'connect'});await wait(async()=>(await s.state()).desktop.capabilities.audio);return {f,s};
}
test('Windows application starts native feature capture only after explicit audio start and stops it on exit',async t=>{
  const {f,s}=await ready(t);assert(!(await f.ioOperations()).some(q=>q.op==='startAudio'));
  assert.equal((await s.command({op:'audioStart'})).ok,true);
  await wait(async()=>(await s.state()).audio.status==='listening');
  assert.equal((await s.command({op:'audioPacket',session:(await s.state()).audio.session,status:'listening',rms:1,bands:Array(8).fill(1)})).ok,false);
  await s.close();assert.equal(s.hostMessages.at(-1).success,true);
  assert.equal((await f.ioOperations()).filter(q=>q.op==='startAudio').length,1);assert.equal((await f.ioOperations()).at(-1).op,'quit');
});
test('Windows typing-cross binds supported logical keys and receives native events without remapping function keys',async t=>{
  const {f,s}=await ready(t);
  assert.equal((await s.command({op:'triggerArm',colors:Array(84).fill('#345678'),trigger:{effect:'cross',color:'#345678',speed:4}})).ok,true);
  await wait(async()=>(await s.state()).trigger.flashing===true);
  const monitor=(await f.ioOperations()).find(q=>q.op==='monitorKeys');assert(monitor.codes.includes('ShiftLeft'));assert(!monitor.codes.includes('Fn'));assert(monitor.codes.includes('Digit0'));
  await s.close();assert.equal(s.hostMessages.at(-1).success,true);
  assert(!(await f.operations()).some(q=>q.op==='shortcut'||q.op==='adaptKeys'));
});
test('lost input transitions stop the trigger, preserve the warning and still restore the keyboard on exit',async t=>{
  const {f,s}=await ready(t,{resetInput:true});
  assert.equal((await s.command({op:'triggerArm',colors:Array(84).fill('#345678'),trigger:{effect:'cross',color:'#345678',speed:4}})).ok,true);
  await wait(async()=>{const state=await s.state();return state.trigger.armed===false&&/按键事件未能完整接收/.test(state.trigger.warning??'');});
  const stopped=await s.state();assert.equal(stopped.device.armed,false);assert.equal(stopped.desktop.capabilities.agentControl,false);
  await s.close();assert.equal(s.hostMessages.at(-1).keyboardVerified,true);assert.equal(s.hostMessages.at(-1).success,true);
  assert((await f.operations()).some(q=>q.event==='lightingClosed'&&q.restored));
});
test('official driver handoff releases a live lighting session before offering the fixed destination',async t=>{
  const {f,s}=await ready(t);assert.equal((await s.command({op:'preview',colors:Array(84).fill('#345678')})).ok,true);
  assert.equal((await s.command({op:'prepareFirmwareUpdate',url:'https://other'})).ok,false);
  const handoff=await s.command({op:'prepareFirmwareUpdate'});assert.equal(handoff.ok,true);assert.equal(handoff.result.url,FIRMWARE_URL);
  assert.equal((await s.state()).device.connected,false);assert((await f.operations()).some(q=>q.event==='lightingClosed'&&q.restored));await s.close();
});
test('failed capture stops the effect while verified keyboard restoration still permits app exit',async t=>{
  const {f,s}=await ready(t,{failCapture:true});assert.equal((await s.command({op:'audioStart'})).ok,true);
  await wait(async()=>(await s.state()).audio.active===false);await s.close();
  assert.equal(s.hostMessages.at(-1).success,true);assert.equal(s.hostMessages.at(-1).keyboardVerified,true);
  assert((await f.operations()).some(q=>q.event==='lightingClosed'&&q.restored));
});
test('a device failure restores lighting without replay and allows a fresh explicit audio start',async t=>{
  const {f,s}=await ready(t,{audioDeviceFailure:true});assert.equal((await s.command({op:'audioStart'})).ok,true);
  await wait(async()=>{const state=await s.state();return !state.audio.active&&state.audio.error==='systemCapture'&&!state.device.armed;});
  const stopped=await s.state();assert.equal(stopped.playback.playing,false);assert.equal(stopped.desktop.capabilities.audio,true);
  await wait(async()=>(await f.ioOperations()).some(q=>q.op==='stopAudio'));
  assert.equal((await f.ioOperations()).filter(q=>q.op==='startAudio').length,1,'late queued samples cannot start capture again');
  const ops=(await f.operations()).map(q=>q.op);assert(ops.lastIndexOf('restore')>ops.lastIndexOf('arm'));
  assert.equal((await s.command({op:'audioStart'})).ok,true);await wait(async()=>(await s.state()).audio.status==='listening');
  assert.equal((await f.ioOperations()).filter(q=>q.op==='startAudio').length,2);
  await s.close();assert.equal(s.hostMessages.at(-1).success,true);assert.equal(s.hostMessages.at(-1).keyboardVerified,true);
});
test('Windows built-in effect commands use the native lease and can return to artwork and restore on exit',async t=>{
  const {f,s}=await ready(t,{modelId:'kick75'});
  assert.equal((await s.state()).device.capabilities.stockEffects,true);
  assert.equal((await s.command({op:'nativeLighting',mode:21,brightness:50,speed:2})).ok,false);
  assert(!(await f.operations()).some(q=>q.op==='armNative'));
  assert.equal((await s.command({op:'nativeLighting',mode:4,brightness:50,speed:2,color:'#123456'})).ok,true);
  const state=await s.state();assert.equal(state.playback.mode,'native');assert.equal(state.device.armed,false);
  assert.equal(state.device.windowsLighting.purpose,'native');assert.equal(state.device.state[0],4);assert.equal(state.colors[0],'#123456');
  assert.equal((await s.command({op:'preview',colors:Array(84).fill('#345678')})).ok,true);
  const ops=(await f.operations()).map(q=>q.op).filter(Boolean);assert(ops.lastIndexOf('restore')>ops.indexOf('nativeLighting'));assert(ops.indexOf('arm')>ops.lastIndexOf('restore'));
  await s.close();assert.equal(s.hostMessages.at(-1).success,true);
});
test('Windows connection wake runs once after qualification, survives repeated connect and returns idle ownership', {timeout:15000},async t=>{
  const {f,s}=await ready(t);assert.equal((await s.state()).connectionWake.active,true);
  assert.equal((await s.command({op:'armConnectionWake'})).ok,false,'the private native entry is not a frontend command');
  for(const op of ['inspectLighting','inspectSleep','inspectFunctionKeys']){
    assert.equal((await s.command({op})).ok,false);
    assert.equal((await s.state()).connectionWake.active,true,'a rejected observation must not cancel welcome or its owner');
  }
  assert(!(await f.operations()).some(q=>['lightingSnapshot','sleepSnapshot','keymapSnapshot'].includes(q.op)));
  await s.command({op:'connect'});
  assert.equal((await f.operations()).filter(q=>q.op==='armConnectionWake').length,1);
  await wait(async()=>{const state=await s.state();return state.connectionWake.status==='completed'&&!state.device.armed;},8000);
  assert.equal((await s.state()).device.recoveryPending,false);
  assert((await f.operations()).some(q=>q.op==='restore'));await s.command({op:'refresh'});
  assert.equal((await f.operations()).filter(q=>q.op==='armConnectionWake').length,1);
  await s.close();assert.equal(s.hostMessages.at(-1).success,true);
});
test('explicit artwork interrupts Windows wake and exit still restores the original once',async t=>{
  const {f,s}=await ready(t);assert.equal((await s.state()).connectionWake.active,true);
  assert.equal((await s.command({op:'preview',colors:Array(84).fill('#345678')})).ok,true);
  const state=await s.state();assert.equal(state.connectionWake.status,'cancelled');assert.equal(state.playback.mode,'static');assert.equal(state.device.armed,true);
  const ops=(await f.operations()).map(q=>q.op).filter(Boolean);
  // Returning the stock side zone uses the existing whole-session restoration
  // and rearm path, before the new artwork is sent.
  assert.equal(ops.filter(op=>op==='arm').length,1);assert(ops.indexOf('arm')>ops.indexOf('restore'));
  await s.close();assert.equal(s.hostMessages.at(-1).success,true);
});
test('unregistered Air firmware stays read-only and cannot schedule connection wake',async t=>{
  const {f,s}=await ready(t,{firmwareVersion:'2.0.0.8'});const state=await s.state();
  assert.equal(state.connectionWake.active,false);assert.equal(state.device.capabilities.connectionWake,false);
  assert.equal((await s.command({op:'preview',colors:Array(84).fill('#345678')})).ok,false);
  assert(!(await f.operations()).some(q=>['arm','armConnectionWake','paint'].includes(q.op)));await s.close();
});
