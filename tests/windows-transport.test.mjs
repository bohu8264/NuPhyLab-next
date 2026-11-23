import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopRequest,isTauriDesktop,isNativeDesktop,nativeDesktopRequest,usesDesktopKeyRouting} from '../shared/desktop-transport.mjs';
test('Windows audio settings use only the two fixed native destinations',async()=>{
  const calls=[],window={__TAURI__:{core:{invoke:async(...args)=>{calls.push(args);return null;}}}};
  for(const permission of ['microphone','system'])assert.equal((await nativeDesktopRequest('audioControl',{permission},window)).available,true);
  assert.equal((await nativeDesktopRequest('audioControl',{permission:'shell',command:'arbitrary'},window)).available,false);
  assert.deepEqual(calls,[['audio_settings',{permission:'microphone'}],['audio_settings',{permission:'system'}]]);
});

test('desktop transport preserves the browser path and restricts native request routes',async()=>{
  assert.equal(isTauriDesktop({}),false);assert.equal(await desktopRequest('/api/state',undefined,{}),null);
  const calls=[],window={__TAURI__:{core:{invoke:async(...args)=>{calls.push(args);return {ok:true,result:1};}}}};
  assert.equal(isTauriDesktop(window),true);
  assert.deepEqual(await desktopRequest('/api/state',undefined,window),{ok:true,result:1});
  assert.deepEqual(calls[0],['service_request',{route:'/api/state',body:null}]);
  await assert.rejects(desktopRequest('http://external.test',undefined,window),/不支持/);
  assert.equal(calls.length,1);
});
test('native request failures propagate instead of falling back to browser HTTP',async()=>{
  const window={__TAURI__:{core:{invoke:async()=>{throw new Error('service unavailable');}}}};
  await assert.rejects(desktopRequest('/api/state',undefined,window),/service unavailable/);
  await assert.rejects(desktopRequest('/api/state',undefined,{__TAURI__:{core:{invoke:async()=>null}}}),/回复格式无效/);
});
test('Mac desktop channels preserve their receiver and propagate native failures',async()=>{
  const calls=[],handler={postMessage(value){assert.equal(this,handler);calls.push(value);return Promise.resolve({accepted:true});}};
  const window={webkit:{messageHandlers:{codexKeys:handler,audioControl:handler}}};
  assert.equal(isNativeDesktop(window),true);assert.equal(usesDesktopKeyRouting(window),true);
  for(const channel of ['codexKeys','audioControl'])assert.deepEqual(await nativeDesktopRequest(channel,{kind:'test'},window),{available:true,result:{accepted:true}});
  assert.equal(calls.length,2);
  handler.postMessage=async()=>{throw new Error('permission denied');};
  await assert.rejects(nativeDesktopRequest('audioControl',{},window),/permission denied/);
  await assert.rejects(nativeDesktopRequest('arbitraryShell',{},window),/不支持/);
});
test('Tauri never falls back to Mac handlers or browser key capture when a capability is unavailable',async()=>{
  const window={__TAURI__:{core:{invoke:()=>{throw new Error('not allowed');}}},
    webkit:{messageHandlers:{codexKeys:{postMessage:()=>{throw new Error('Mac fallback');}}}}};
  assert.equal(usesDesktopKeyRouting(window),true);
  for(const channel of ['codexKeys','audioControl']){
    const value=await nativeDesktopRequest(channel,{},window);
    assert.equal(value.available,false);assert.match(value.reason,/尚未开放/);
  }
  assert.equal(usesDesktopKeyRouting({}),false);
  assert.deepEqual(await nativeDesktopRequest('audioControl',{},{}),{available:false,result:null});
});
