import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from '../ui/node_modules/typescript/lib/typescript.js';
import {createVMEnvironment,textOf,walkAll,deferred} from './helpers/source-ui-vm.mjs';
import {AUDIO_EFFECTS} from '../shared/audio-effects.mjs';
import {fakeService} from './helpers/fake-service.mjs';

const audio={source:'system',deviceId:'',effect:'pulse',colorMode:'single',color:'#6f9e85',sensitivity:1.5,noiseFloor:-55};
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function clock(){let id=0;const timers=new Map();return {timers,schedule:fn=>{timers.set(++id,fn);return id;},cancel:key=>timers.delete(key)};}
async function loadStore(){
  const source=await readFile(new URL('../ui/src/audioPending.ts',import.meta.url),'utf8'),module={exports:{}};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Error,Promise,setTimeout,clearTimeout},{filename:'actual-audioPending.ts'});
  return module.exports;
}
async function fixture(command){
  const exports=await loadStore(),time=clock(),store=exports.createAudioPendingStore(time),saved={audio:{...audio},brightness:27},calls=[];
  const apply=body=>{if(body.settings.audio)Object.assign(saved.audio,body.settings.audio);if(Object.hasOwn(body.settings,'brightness'))saved.brightness=body.settings.brightness;};
  store.setClient({command:async(body,options)=>{calls.push(structuredClone(body));assert.equal(options?.silent,true);if(command)return command({body,saved,apply,calls});apply(body);},readState:async()=>({settings:structuredClone(saved)})});
  return {exports,time,store,saved,calls,apply};
}

test('pending parameter and brightness lanes preserve zero and send settings only',async()=>{
  const f=await fixture();f.store.changeAudio({effect:'wave',noiseFloor:-60});f.store.changeBrightness(0);
  assert.equal(f.store.getSnapshot().brightness,0);assert.equal(f.store.getSnapshot().audio.effect,'wave');
  await f.store.flushAll();assert.equal(f.store.getSnapshot().dirty,false);assert.equal(f.saved.brightness,0);assert.equal(f.saved.audio.effect,'wave');
  assert.deepEqual(f.calls.map(call=>Object.keys(call.settings)[0]).sort(),['audio','brightness']);assert.ok(f.calls.every(call=>call.op==='settings'));
});

test('failed debounce survives detach/remount with pending values and a persistent failure source',async()=>{
  const f=await fixture(async()=>{throw Error('/private/should-not-be-shown');}),detach=f.store.attach();f.store.changeAudio({sensitivity:2.5});detach();
  await assert.rejects(f.store.flushAll(),/尚未保存/);assert.equal(f.store.getSnapshot().attached,false);assert.equal(f.store.getSnapshot().audioError,true);assert.equal(f.store.getSnapshot().audio.sensitivity,2.5);
  f.store.observeSaved({audio:{...audio},brightness:27},true);f.store.attach();assert.equal(f.store.getSnapshot().audio.sensitivity,2.5);assert.equal(f.store.getSnapshot().audioError,true);
  assert.doesNotMatch(JSON.stringify(f.store.getSnapshot()),/private/);
});

test('write failure confirmed by readback clears only the confirmed pending fields',async()=>{
  const f=await fixture(async({body,apply})=>{apply(body);throw Error('reply lost');});f.store.changeAudio({effect:'rain'});f.store.changeBrightness(0);
  await f.store.flushAll();assert.equal(f.store.getSnapshot().dirty,false);assert.equal(f.store.getSnapshot().audioError,false);assert.equal(f.store.getSnapshot().brightnessError,false);
});

test('old success cannot remove or display-overwrite a newer value',async()=>{
  const wait=deferred();let requests=0;
  const f=await fixture(async({body,apply})=>{if(++requests===1)await wait.promise;apply(body);});
  f.store.changeAudio({effect:'wave'});const first=f.store.flushAudio();await tick();f.store.changeAudio({effect:'rain',color:'#ff0000'});wait.resolve();await first;
  assert.equal(f.store.getSnapshot().audio.effect,'rain');assert.equal(f.store.getSnapshot().audioPending,false,'explicit flush drains the replacement before resolving');
  await f.store.flushAudio();assert.equal(f.saved.audio.effect,'rain');assert.equal(f.saved.audio.color,'#ff0000');assert.equal(f.calls.length,2);
  f.store.observeSaved({audio:f.saved.audio,brightness:f.saved.brightness});assert.deepEqual(Object.keys(f.store.getSnapshot().audio),[]);
});

test('old failure after a replacement edit does not label the replacement as failed',async()=>{
  const wait=deferred();let requests=0;
  const f=await fixture(async({body,apply})=>{if(++requests===1){await wait.promise;throw Error('old write failed');}apply(body);});
  f.store.changeBrightness(10);const first=f.store.flushBrightness();await tick();f.store.changeBrightness(80);wait.resolve();await first;
  assert.equal(f.store.getSnapshot().brightness,80);assert.equal(f.store.getSnapshot().brightnessError,false);assert.equal(f.store.getSnapshot().brightnessPending,false);
  await f.store.flushBrightness();assert.equal(f.saved.brightness,80);assert.equal(f.calls.length,2);
});

test('one lane failing preserves its own retry without replaying the successful other lane or capture',async()=>{
  let broken=true;const f=await fixture(async({body,apply})=>{if(body.settings.audio&&broken)throw Error('audio storage unavailable');apply(body);});
  f.store.changeAudio({noiseFloor:-72});f.store.changeBrightness(55);await assert.rejects(f.store.flushAll());
  assert.equal(f.store.getSnapshot().audioError,true);assert.equal(f.store.getSnapshot().brightnessError,false);assert.equal(f.saved.brightness,55);
  broken=false;await f.store.flushAll();assert.equal(f.calls.filter(call=>'brightness' in call.settings).length,1);assert.equal(f.saved.audio.noiseFloor,-72);assert.ok(f.calls.every(call=>call.op==='settings'));
});

test('concurrent explicit flush/detach calls serialize each lane without duplicate writes',async()=>{
  const wait=deferred();const f=await fixture(async({body,apply})=>{await wait.promise;apply(body);}),detach=f.store.attach();
  f.store.changeAudio({effect:'spectrum'});const a=f.store.flushAudio();await tick();const b=f.store.flushAll();detach();wait.resolve();await Promise.all([a,b]);await tick();assert.equal(f.calls.length,1);assert.equal(f.store.getSnapshot().dirty,false);
});

test('readback cannot clear a newer same-field revision; remount may follow confirmed external settings',async()=>{
  const wait=deferred();let requests=0;
  const f=await fixture(async({body,apply})=>{if(++requests===1){await wait.promise;apply(body);throw Error('old reply failed');}apply(body);});
  f.store.changeAudio({effect:'rain'});const first=f.store.flushAudio();await tick();f.store.changeAudio({effect:'comet'});wait.resolve();await first;
  assert.equal(f.store.getSnapshot().audio.effect,'comet');assert.equal(f.store.getSnapshot().audioPending,false,'old readback cannot replace the latest revision, which is drained separately');assert.equal(f.saved.audio.effect,'comet');await f.store.flushAudio();
  f.store.observeSaved({audio:{...audio,effect:'heartbeat'},brightness:27},true);assert.equal(f.store.getSnapshot().audio.effect,undefined,'confirmed overlay does not override later external changes on return');
});

test('flushAll also drains an audio edit arriving while its other brightness lane is finishing',async()=>{
  const wait=deferred();const f=await fixture(async({body,apply})=>{if('brightness' in body.settings)await wait.promise;apply(body);});
  f.store.changeAudio({effect:'rain'});f.store.changeBrightness(50);const all=f.store.flushAll();await tick();
  assert.equal(f.saved.audio.effect,'rain');f.store.changeAudio({effect:'comet'});wait.resolve();await all;
  assert.equal(f.saved.audio.effect,'comet');assert.equal(f.saved.brightness,50);assert.equal(f.store.getSnapshot().dirty,false);assert.equal(f.calls.length,3);
});

test('actual main + fake HID retains a failed lane, readbacks lost replies and retries settings only',async t=>{
  const service=await fakeService(t),exports=await loadStore(),time=clock(),store=exports.createAudioPendingStore(time),calls=[];let failAudio=true,loseBrightnessReply=true;
  store.setClient({command:async body=>{
    calls.push(structuredClone(body));if(body.settings.audio&&failAudio)throw Error('simulated transport failure before write');
    const result=await service.command(body);if(!result.ok)throw Error(result.error);
    if(Object.hasOwn(body.settings,'brightness')&&loseBrightnessReply){loseBrightnessReply=false;throw Error('simulated reply loss after real fake-service commit');}
    return result.result;
  },readState:service.state});
  store.changeAudio({effect:'wave',sensitivity:2.25});store.changeBrightness(0);await assert.rejects(store.flushAll());
  assert.equal(store.getSnapshot().audioError,true);assert.equal(store.getSnapshot().brightnessError,false);assert.equal((await service.state()).settings.brightness,0);
  failAudio=false;await store.flushAll();const state=await service.state();assert.equal(state.settings.audio.effect,'wave');assert.equal(state.settings.audio.sensitivity,2.25);assert.equal(state.settings.brightness,0);
  assert.equal(store.getSnapshot().dirty,false);assert.equal(calls.filter(call=>'brightness' in call.settings).length,1);assert.ok(calls.every(call=>call.op==='settings'));
  assert.ok(!(await service.operations()).some(call=>['audioStart','audioStop','audioCaptureStart'].includes(call.op)));
});

const stub=name=>Object.defineProperty(()=>null,'name',{value:name});
async function uiFixture(command){
  const f=await fixture(command),storeModule={...f.exports,audioPending:f.store};let returned=0;
  const state={settings:{audio:{...audio},brightness:27},device:{connected:true,capabilities:{perKey:true}},audio:{active:false,available:true,systemSupported:true,status:'idle',error:null,level:0,bands:[],devices:[]},colors:[]};
  const ui=createVMEnvironment({
    'lucide-react':Object.fromEntries(['AudioLines','Play','Square','SlidersHorizontal','ArrowUpRight','ShieldCheck','Moon','ArrowUp'].map(name=>[name,stub(name)])),
    './rangeStyle':{rangeStyle:()=>({})},'../../shared/device-status.mjs':{lightingUnavailableMessage:()=>''},'../../shared/audio-effects.mjs':{AUDIO_EFFECTS},
    './Keyboard':{Keyboard:stub('Keyboard')},'./primitives':{Button:stub('Button'),run:value=>{ui.track(value);}},'./api':{readAppState:async()=>({settings:structuredClone(f.saved),audio:state.audio})},
    './audioPending':storeModule,'./connection-copy-v7':{connectionCopy:value=>value.zh},'./i18n':{t:value=>value},
    './useWorkspaceLayout':{useWorkspaceLayout:()=>({mode:'flow',style:{},previewAway:false,returnToKeyboard(){},gridRef:{current:null},stageRef:{current:null},keyboardRef:{current:null},auxiliaryRef:{current:null},headerRef:{current:null}})},
  });
  const Panel=(await ui.load(new URL('../ui/src/AudioPanel.tsx',import.meta.url))).exports.AudioPanel,Notice=(await ui.load(new URL('../ui/src/AudioPendingNotice.tsx',import.meta.url))).exports.AudioPendingNotice;
  const panel=()=>ui.mount(Panel,{state,layout:[],command:async(body,options)=>{f.calls.push(structuredClone(body));assert.equal(options?.silent,true);if(command)return command({body,saved:f.saved,apply:f.apply,calls:f.calls});f.apply(body);}});
  const notice=()=>ui.mount(Notice,{onReturn:()=>{returned++;}});
  return {...f,ui,state,panel,notice,getReturned:()=>returned};
}
const node=(instance,predicate)=>{const result=walkAll(instance.tree,predicate)[0];assert.ok(result,'missing actual TSX control');return result;};
const control=(instance,label)=>node(instance,entry=>entry.props?.['aria-label']===label);

test('actual AudioPanel pending edit and failure remain visible in global Notice after leaving',async()=>{
  const f=await uiFixture(async()=>{throw Error('/private/internal error');}),panel=f.panel();
  control(panel,'律动效果').props.onChange({target:{value:'rain'}});panel.render();panel.unmount();await assert.rejects(f.store.flushAll());
  const notice=f.notice();assert.match(textOf(notice.tree),/声音设置的保存结果尚未确认/);assert.doesNotMatch(textOf(notice.tree),/private|作品亮度/);
  node(notice,entry=>entry.type?.name==='Button').props.onClick();assert.equal(f.getReturned(),1);assert.equal(f.store.getSnapshot().focusGroup,'audio');
  const target={scrollIntoView(){this.scrolled=true;},focus(){this.focused=true;}};f.ui.document.getElementById=id=>id==='audio-settings-group'?target:null;
  const returned=f.panel();assert.equal(control(returned,'律动效果').props.value,'rain');assert.equal(target.focused,true);assert.equal(target.scrolled,true);assert.match(textOf(returned.tree),/重试保存/);
  assert.ok(f.calls.every(call=>call.op==='settings'));notice.unmount();
});

test('actual brightness-only failure returns to brightness and retry never starts/stops capture',async()=>{
  let broken=true;const f=await uiFixture(async({body,apply})=>{if(broken)throw Error('fail');apply(body);}),panel=f.panel();
  control(panel,'逐键输出亮度').props.onChange({target:{value:'0'}});panel.render();panel.unmount();await assert.rejects(f.store.flushAll());
  const notice=f.notice();assert.match(textOf(notice.tree),/输出亮度的保存结果尚未确认/);assert.doesNotMatch(textOf(notice.tree),/声音设置|作品亮度/);
  node(notice,entry=>entry.type?.name==='Button').props.onClick();const target={focus(){this.focused=true;},scrollIntoView(){}};f.ui.document.getElementById=id=>id==='audio-output-brightness-group'?target:null;
  const returned=f.panel();assert.equal(control(returned,'逐键输出亮度').props.value,0);assert.equal(target.focused,true);broken=false;
  node(returned,entry=>entry.type?.name==='Button'&&textOf(entry)==='重试保存').props.onClick();await f.ui.settle(returned);notice.render();assert.equal(f.store.getSnapshot().dirty,false);assert.equal(notice.tree,null);
  assert.ok(f.calls.every(call=>call.op==='settings'));notice.unmount();
});

test('actual AudioPanel preserves deliberate Start after settings flush; failed save cannot issue Start',async()=>{
  let broken=true;const f=await uiFixture(async({body,apply})=>{if(body.op==='settings'&&broken)throw Error('settings unavailable');if(body.op==='settings')apply(body);}),panel=f.panel();
  control(panel,'律动效果').props.onChange({target:{value:'mirror'}});panel.render();
  node(panel,entry=>entry.type?.name==='Button'&&textOf(entry)==='开始律动').props.onClick();await f.ui.settle(panel);assert.equal(f.calls.some(call=>call.op==='audioStart'),false);assert.match(textOf(panel.tree),/声音设置的保存结果尚未确认/);
  broken=false;node(panel,entry=>entry.type?.name==='Button'&&textOf(entry)==='开始律动').props.onClick();await f.ui.settle(panel);assert.equal(f.calls.at(-1).op,'audioStart');assert.equal(f.calls.filter(call=>call.op==='audioStart').length,1);
});

test('actual AudioPanel Start waits for continuous edits through the latest settings flight',async()=>{
  const wait=deferred();let settingsCalls=0,startEffect=null;
  const f=await uiFixture(async({body,saved,apply})=>{if(body.op==='settings'){if(++settingsCalls===1)await wait.promise;apply(body);}else if(body.op==='audioStart')startEffect=saved.audio.effect;}),panel=f.panel();
  control(panel,'律动效果').props.onChange({target:{value:'rain'}});panel.render();node(panel,entry=>entry.type?.name==='Button'&&textOf(entry)==='开始律动').props.onClick();await tick();
  control(panel,'律动效果').props.onChange({target:{value:'comet'}});panel.render();assert.equal(f.calls.some(call=>call.op==='audioStart'),false);
  wait.resolve();await f.ui.settle(panel);assert.equal(startEffect,'comet');assert.deepEqual(f.calls.map(call=>call.op),['settings','settings','audioStart']);assert.equal(f.store.getSnapshot().dirty,false);
});

test('actual AudioPanel Stop bypasses failed pending settings and leaves them available for retry',async()=>{
  const f=await uiFixture(async({body,apply})=>{if(body.op==='settings')throw Error('settings 503');if(body.op==='audioStop')return;apply(body);});
  f.state.audio.active=true;f.state.audio.status='listening';const panel=f.panel();
  control(panel,'律动效果').props.onChange({target:{value:'rain'}});await assert.rejects(f.store.flushAll());panel.render();assert.equal(f.store.getSnapshot().audioError,true);
  node(panel,entry=>entry.type?.name==='Button'&&textOf(entry)==='停止律动').props.onClick();await f.ui.settle(panel);
  assert.equal(f.calls.filter(call=>call.op==='audioStop').length,1);assert.equal(f.calls.some(call=>call.op==='audioStart'),false);assert.equal(f.store.getSnapshot().audioPending,true);assert.equal(f.store.getSnapshot().audio.effect,'rain');assert.match(textOf(panel.tree),/声音设置的保存结果尚未确认/);
});
