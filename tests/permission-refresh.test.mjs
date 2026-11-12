import test from 'node:test';
import assert from 'node:assert/strict';
import {coalescePermissionRefresh,refreshPermissionSession,watchPermissionRefresh} from '../shared/permission-refresh.mjs';
import {createVMEnvironment,textOf,walkAll} from './helpers/source-ui-vm.mjs';

const flush = async () => { for (let i=0;i<6;i++) await Promise.resolve(); };

test('native grant is carried into the helper refresh, never raced against a separate host report',async()=>{
  const operations=[];let resolveHost;
  const granted={inputMonitoring:true,accessibility:true,canPostEvents:true};
  const command=async req=>{operations.push(req);return 'ready';};
  const readNative=()=>new Promise(resolve=>{resolveHost=resolve;});
  const first=refreshPermissionSession(command,readNative);
  assert.equal(first,refreshPermissionSession(command,readNative));
  await flush();assert.deepEqual(operations,[]);
  resolveHost({available:true,result:granted});
  assert.equal(await first,'ready');
  assert.deepEqual(operations,[{op:'refreshPermissions',hostPermissions:granted}]);
});

test('browser refresh works without a host while failed native reads never present an old grant as fresh',async()=>{
  const operations=[],command=async req=>{operations.push(req);};
  await refreshPermissionSession(command,async()=>({available:false,result:null}));
  assert.deepEqual(operations,[{op:'refreshPermissions'}]);
  await assert.rejects(refreshPermissionSession(command,async()=>{throw new Error('native unavailable');}),/native unavailable/);
  assert.equal(operations.length,1);
  const denied={inputMonitoring:false,accessibility:false,canPostEvents:false};
  await refreshPermissionSession(command,async()=>({available:true,result:denied}));
  assert.deepEqual(operations[1],{op:'refreshPermissions',hostPermissions:denied});
});
function fixture(refresh) {
  let visible=true,next=0;
  const timers=new Map(),windowTarget=new EventTarget(),documentTarget=new EventTarget();
  const stop=watchPermissionRefresh({refresh,isVisible:()=>visible,windowTarget,documentTarget,
    setTimer:(callback,delay)=>{assert.equal(delay,2000);timers.set(++next,callback);return next;},
    clearTimer:id=>timers.delete(id)});
  return {stop,timers,windowTarget,documentTarget,setVisible:value=>{visible=value;},
    tick:async()=>{const callbacks=[...timers.values()];timers.clear();for(const callback of callbacks)callback();await flush();}};
}

test('pending permission setup detects a later grant without requiring a focus event, then cleanup stops polling',async()=>{
  let allowed=false,calls=0,observed=false;
  const f=fixture(async()=>{calls++;observed=allowed;});
  await flush();assert.equal(calls,1);assert.equal(observed,false);
  allowed=true;await f.tick();assert.equal(observed,true);assert.equal(calls,2);
  // React effect cleanup when permissionsReady becomes true (or disabled / unmounted).
  f.stop();assert.equal(f.timers.size,0);
  await f.tick();f.windowTarget.dispatchEvent(new Event('focus'));await flush();assert.equal(calls,2);
});

test('hidden setup does not query permissions and becomes current immediately when visible again',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;});await flush();
  f.setVisible(false);await f.tick();assert.equal(calls,1);
  f.windowTarget.dispatchEvent(new Event('focus'));await flush();assert.equal(calls,1);
  f.setVisible(true);f.documentTarget.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(calls,2);
  assert.equal(f.timers.size,1);f.stop();
});

test('focus, visibility and timer checks never overlap a pending request and stop remains final while it settles',async()=>{
  let calls=0,resolve;
  const f=fixture(()=>{calls++;return new Promise(done=>{resolve=done;});});
  f.windowTarget.dispatchEvent(new Event('focus'));f.documentTarget.dispatchEvent(new Event('visibilitychange'));
  await f.tick();assert.equal(calls,1);assert.equal(f.timers.size,0);
  f.stop();resolve();await flush();assert.equal(f.timers.size,0);
  f.windowTarget.dispatchEvent(new Event('focus'));await flush();assert.equal(calls,1);
});

test('a transient permission query failure retries quietly and does not permanently retain its failed result',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;if(calls===1)throw new Error('temporarily unavailable');});
  await flush();assert.equal(calls,1);assert.equal(f.timers.size,1);
  await f.tick();assert.equal(calls,2);f.stop();
});

test('manual, focus and device checks share only in-flight work for the same command',async()=>{
  const command=()=>{},other=()=>{};let calls=0,resolve;
  const request=()=>{calls++;return new Promise(done=>{resolve=done;});};
  const first=coalescePermissionRefresh(command,request),second=coalescePermissionRefresh(command,request);
  assert.equal(first,second);await flush();assert.equal(calls,1);
  resolve('granted');assert.equal(await first,'granted');await flush();
  assert.equal(await coalescePermissionRefresh(command,async()=>{calls++;return 'revoked';}),'revoked');
  assert.equal(await coalescePermissionRefresh(other,async()=>{calls++;return 'other';}),'other');assert.equal(calls,3);
});

test('first-run guide distinguishes an allowed Accessibility grant from active shortcuts',async()=>{
  const Modal=()=>null,Button=()=>null;
  const ui=createVMEnvironment({
    'lucide-react':{},
    './primitives':{Modal,Button,run:promise=>promise},
    './codexKeys':{nativeCodexRequest:async()=>({available:false})},
    '../../shared/permission-refresh.mjs':{coalescePermissionRefresh,refreshPermissionSession,watchPermissionRefresh:()=>()=>{}},
    '../../shared/firmware-onboarding.mjs':{firmwarePrompt:()=>null,firmwareUpdateSatisfied:()=>false},
  });
  ui.document.documentElement.lang='en';
  const {StartupGuide}=(await ui.load(new URL('../ui/src/StartupGuide.tsx',import.meta.url))).exports;
  const command=async()=>({});
  const granted={inputMonitoring:true,accessibility:true,canPostEvents:true};
  const props=native=>({state:{native,device:{}},command});
  const instance=ui.mount(StartupGuide,props({}));
  const modal=()=>walkAll(instance.tree,node=>node.type===Modal)[0];
  assert.equal(modal(),undefined,'unknown initial permission state must not show an authorization prompt');
  instance.update(props({...granted,accessibility:false,canPostEvents:false,systemPermissions:granted,permissionRecoveryPending:true}));
  assert.match(textOf(modal()),/Allowed, activation pending/);
  assert.match(textOf(modal()),/If needed, it will reopen after the current operation finishes/);
  assert.equal(walkAll(modal(),node=>node.type===Button&&textOf(node)==='Allow').length,0);
  instance.update(props({...granted,permissionRecoveryPending:true}));
  assert.ok(modal(),'successful trust checks do not imply the listener has recovered');
  assert.match(textOf(modal()),/applying permissions/);
  instance.update(props(granted));
  assert.equal(modal(),undefined);
  instance.unmount();
});
