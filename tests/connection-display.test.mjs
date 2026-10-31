import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deriveConnectionDisplay} from '../shared/connection-display.mjs';

const spec=JSON.parse(readFileSync(new URL('../docs/design/ui-redesign-2026-10-30/v7-experience/spec/connection-display.json',import.meta.url),'utf8'));
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};
const merge=(base,patch)=>Object.fromEntries([...new Set([...Object.keys(base),...Object.keys(patch)])].map(key=>[
  key,patch[key]&&typeof patch[key]==='object'&&!Array.isArray(patch[key])
    ?merge(base[key]??{},patch[key]):Object.hasOwn(patch,key)?patch[key]:base[key],
]));
const BASE=deepFreeze({
  device:{connected:false,identified:false,armed:false,readOnly:false,modelId:'air75-v3',model:'Air75 V3 ANSI',
    connectionSessionId:'fixture:1',connectionPaused:false,connection:{status:'waiting',attempts:0},
    errorCode:null,recoveryPending:false,needsRestore:false,unsafeWritesNeeded:false},
  bluetooth:{connected:false,status:'disconnected',count:0,error:null},
  playback:{mode:'idle',playing:false},lightPower:{sleeping:false},
  firmware:{compatible:false,checking:false,error:null,stale:false,latestConfirmed:false,status:'disconnected'},
  settings:{agentSource:'codex'},game:{type:'snake',status:'idle'},
  scenes:[{id:'kept',name:'Kept artwork'}],
});
const USB={device:{connected:true,identified:true,readOnly:false,connection:{status:'ready'},capabilities:{perKey:true,stockEffects:true}},firmware:{compatible:true}};
const state=(patch={})=>deepFreeze(merge(BASE,patch));
const usb=(patch={})=>state(merge(USB,patch));
function derive(snapshot,options={}) {
  const before=JSON.stringify(snapshot);
  let sideEffects=0;
  const effect=()=>{sideEffects++;throw new Error('display attempted an effect');};
  const input=deepFreeze({state:snapshot,canvasModelId:'air75-v3',command:effect,refresh:effect,native:effect,...options});
  const result=deriveConnectionDisplay(input);
  assert.equal(sideEffects,0,'derivation never calls effect callbacks');
  assert.equal(JSON.stringify(snapshot),before,'display derivation retains the input snapshot');
  assert(Object.isFrozen(result));
  return result;
}
const assertNoRestore=display=>assert.notEqual(display.sidebar.zh,spec.commonCopy.restored.zh);

test('F01 first read stays loading; a service error still wins when there is no snapshot',()=>{
  const result=derive(null);
  assert.equal(result.stateId,'loading');assert.equal(result.identity.transport,null);
  assert.deepEqual(result.header,spec.stateMatrix.find(row=>row.stateId==='loading').header);
  assert.equal(result.primaryAction,null);assertNoRestore(result);
  assert.equal(derive(null,{serviceError:'offline'}).stateId,'serviceUnknown');
});

test('F02 service failure invalidates cached connected/armed/playing/sleeping facts',()=>{
  const result=derive(usb({device:{armed:true},playback:{mode:'animation',playing:true},lightPower:{sleeping:true}}),{serviceError:'fixture outage'});
  assert.equal(result.stateId,'serviceUnknown');assert.equal(result.freshUsb,false);
  assert.equal(result.identity.modelName,null);assert.equal(result.identity.transport,null);
  assert.deepEqual(result.sidebar,spec.commonCopy.outputUnconfirmed);
  assert.equal(result.primaryAction,'refreshService');assert.equal(result.tone,'neutral');
  assert.match(result.deviceBody.en,/Saving may need verification or a retry/);assertNoRestore(result);
});

test('F03 healthy USB-offline state describes local work without dispatching hardware or adding a save gate',()=>{
  const log=[];
  const result=derive(state(),{command:op=>log.push(op),canvasModelId:'kick75'});
  assert.equal(result.stateId,'disconnected');assert.deepEqual(result.sidebar,{zh:'离线创作',en:'Creating offline'});
  assert.match(result.workBody.en,/edit, preview on screen and save/);
  assert.deepEqual(result.canvasIdentity,{zh:'当前画布 · Kick75',en:'Canvas · Kick75'});
  assert.equal(result.identity.modelName,null);assert.equal(result.primaryAction,'navigateDevice');
  assert.equal('canSave' in result,false);assert.equal('disabled' in result,false);assert.deepEqual(log,[]);
});

test('F04 multiple USB is specific attention even in early reconnect, with one offline sentence',()=>{
  for(const status of ['reconnecting','attention']) {
    const result=derive(state({device:{errorCode:'DEVICE_AMBIGUOUS',connection:{status}}}));
    assert.equal(result.stateId,'attention');assert.equal(result.reasonId,'multipleUsb');
    assert.equal(result.deviceTitle.zh,'检测到多把USB键盘');
    assert.equal(result.devicePrimaryAction,'connect');assert.equal(result.devicePrimaryCopy.en,'Check again');
    assert.equal(result.primaryAction,'navigateDevice');assert.equal(result.tone,'attention');
    assert.equal(result.workBody.zh.split(spec.commonCopy.offlineCapabilities.zh).length-1,1);
    assert.doesNotMatch(result.workBody.zh,/有线模式|其他键盘设置/);
  }
});

test('F05 explicit disconnected pause wins over a retained error and does not create USB identity',()=>{
  const result=derive(state({device:{connectionPaused:true,modelId:'kick75',errorCode:'DEVICE_AMBIGUOUS',connection:{status:'attention'}}}));
  assert.equal(result.stateId,'paused');assert.equal(result.reasonId,null);assert.equal(result.reason,null);
  assert.equal(result.identity.transport,null);assert.equal(result.primaryAction,'connect');assertNoRestore(result);
});

test('F06 generic reconnect is pending confirmation, distinct from waiting and policy pause',()=>{
  const result=derive(state({device:{connection:{status:'reconnecting'}},playback:{mode:'animation',playing:true}}));
  assert.equal(result.stateId,'reconnecting');assert.equal(result.primaryAction,null);
  assert.equal(result.sidebar.en,'Awaiting output confirmation');assertNoRestore(result);
  assert.equal(derive(state({device:{connection:{status:'paused'}}})).stateId,'paused');
  assert.equal(derive(state({device:{connection:{status:'paused'}},bluetooth:{connected:true}})).stateId,'bluetoothOnly');
});

test('F07 read-only attention is not firmware age, and remains more specific than generic attention',()=>{
  const result=derive(usb({device:{readOnly:true,connection:{status:'attention'},capabilities:{perKey:false,stockEffects:false}},firmware:{compatible:false,error:'probe failed',stale:true}}));
  assert.equal(result.stateId,'attention');assert.equal(result.reasonId,'readOnly');
  assert.equal(result.tone,'attention');assert.equal(result.capability.kind,'readOnly');
  assert.equal(result.devicePrimaryAction,'connect');assert.doesNotMatch(result.workBody.zh,/NuPhyIO|升级|过旧/);
});

test('F08 static output with playing=false is still a current armed session, with exact mode/source copies',()=>{
  const result=derive(usb({device:{armed:true},playback:{mode:'static',playing:false}}));
  assert.equal(result.stateId,'usbReady');assert.equal(result.tone,'ready');
  assert.deepEqual(result.sidebar,{zh:'当前会话 · 静态灯光',en:'Current session · Static lighting'});
  assert.equal(result.header.zh,'Air75 V3 · USB已连接');
  assert.equal(result.capability.kind,'perKey');
  for(const [mode,en] of [['animation','Animation'],['paused','Paused'],['audio','Audio reactive'],['trigger','Key trigger'],['native','Built-in lighting']]) {
    assert.equal(derive(usb({device:{armed:true},playback:{mode}})).sidebar.en,`Current session · ${en}`);
  }
  assert.equal(derive(usb({device:{armed:true},playback:{mode:'agent'},settings:{agentSource:'claude'}})).sidebar.en,'Current session · Claude Code status lights');
  assert.equal(derive(usb({device:{armed:true},playback:{mode:'agent'}})).sidebar.zh,'当前会话 · Codex状态灯');
  assert.equal(derive(usb({device:{armed:true},playback:{mode:'toString'}})).sidebar.en,'Output unconfirmed');
});

test('F09 an armed session can hold normal lighting and active key journals without attention',()=>{
  const result=derive(usb({device:{armed:true,recoveryPending:true,needsRestore:true,unsafeWritesNeeded:true,
    keyRecovery:{status:'active',pending:true,blocking:false}},playback:{mode:'static'}}),{keyRecoveryProblem:null});
  assert.equal(result.stateId,'usbReady');assert.equal(result.reasonId,null);
  assert.equal(result.sidebar.en,'Current session · Static lighting');assertNoRestore(result);
  assert.equal(derive(usb({device:{armed:true,recoveryPending:true},lightPower:{sleeping:true}})).sidebar.en,'Current session · Lighting asleep');
});

test('F10 a confirmed lighting-recovery block overrides ready but pending alone does not',()=>{
  for(const errorCode of ['RESTORE_REQUIRED','RECOVERY_REQUIRED','PRESET_RECOVERY_CONFLICT']) {
    const result=derive(usb({device:{armed:false,recoveryPending:true,errorCode}}));
    assert.equal(result.stateId,'attention');assert.equal(result.reasonId,'lightingRecoveryBlocked');
    assert.equal(result.devicePrimaryAction,'connect');assertNoRestore(result);
  }
  assert.equal(derive(usb({device:{recoveryPending:true}})).stateId,'usbReady');
  assert.equal(derive(state({device:{recoveryPending:true,errorCode:'RESTORE_DEFERRED'}})).stateId,'disconnected');
});

test('F11 idle/unarmed/no pending and bare cached verified/restored never prove recovery',()=>{
  for(const patch of [{},{verified:true,restored:true},{verified:true,restored:false},{connectionSessionId:'fixture:2',verified:true,restored:true}]) {
    const result=derive(usb({device:patch}));
    assert.equal(result.sidebar.en,'No artwork playing');assert.equal(result.restoreEvidenceAccepted,false);assertNoRestore(result);
  }
});

test('F12 only an explicit same-session restored receipt is accepted; lifecycle invalidation remains caller-owned',()=>{
  const evidence=deepFreeze({operation:'restore',verified:true,restored:true,connectionSessionId:'fixture:1'});
  const current=usb();
  const accepted=derive(current,{verifiedRestoreEvidence:evidence});
  assert.equal(accepted.restoreEvidenceAccepted,true);assert.deepEqual(accepted.sidebar,spec.commonCopy.restored);
  const rejected=[
    [usb({device:{connectionSessionId:'fixture:2'}}),{}],
    [state(),{}],[current,{serviceError:'outage'}],
    [usb({device:{armed:true},playback:{mode:'static'}}),{}],
    [usb({device:{recoveryPending:true,errorCode:'RESTORE_REQUIRED'}}),{}],
    [usb({playback:{mode:'animation'}}),{}],
    [current,{verifiedRestoreEvidence:{...evidence,invalidated:true}}],
    [current,{verifiedRestoreEvidence:{...evidence,restored:false}}],
    [current,{verifiedRestoreEvidence:{...evidence,verified:false}}],
    [current,{verifiedRestoreEvidence:{...evidence,operation:'arm'}}],
  ];
  for(const [snapshot,options] of rejected) {
    const result=derive(snapshot,{verifiedRestoreEvidence:evidence,...options});
    assert.equal(result.restoreEvidenceAccepted,false);assertNoRestore(result);
  }
  // After any new session/output/failure, an external owner drops the receipt;
  // returning to idle cannot resurrect it from cached device fields.
  assertNoRestore(derive(current,{verifiedRestoreEvidence:null}));
});

test('F13 confirmed old Kick stock-only is connected capability, not read-only or claimed restore',()=>{
  const result=derive(usb({device:{modelId:'kick75',capabilities:{perKey:false,stockEffects:true}},firmware:{compatible:false}}),{canvasModelId:'kick75'});
  assert.equal(result.stateId,'usbReady');assert.equal(result.capability.kind,'stockOnly');assert.equal(result.tone,'ready');
  assert.equal(result.sidebar.en,'Built-in lighting available');assert.equal(result.identity.modelName,'Kick75');assertNoRestore(result);
});

test('F14 Bluetooth Air and retained Kick canvas have separate identities, without inventing history ownership',()=>{
  const result=derive(state({device:{modelId:'kick75',model:'Kick75 ANSI',identified:true,readOnly:true},bluetooth:{connected:true}}),{canvasModelId:'kick75'});
  assert.equal(result.stateId,'bluetoothOnly');assert.equal(result.header.zh,'Air75 V3 · 蓝牙已连接');
  assert.equal(result.identity.modelName,'Air75 V3');assert.equal(result.identity.transport,'bluetooth');
  assert.equal(result.canvasIdentity.en,'Canvas · Kick75');assert.equal(result.capability.kind,'unavailable');
  assert.equal(result.sidebar.en,'No USB lighting output');
  // The spec's literal explicit error-code priority is retained, pending a
  // separate product ruling for historical errors; no guessed Bluetooth override.
  assert.equal(derive(state({device:{errorCode:'UNSUPPORTED_FIRMWARE'},bluetooth:{connected:true}})).reasonId,'appUpdateRequired');
});

test('F15 unknown USB capability and failed official query stay neutral, without a fabricated upgrade',()=>{
  const result=derive(state({device:{connected:true,capabilities:{}},firmware:{error:'query failed',stale:true}}));
  assert.equal(result.stateId,'usbReady');assert.equal(result.capability.kind,'unknown');assert.equal(result.tone,'neutral');
  assert.equal(result.sidebar.en,'Reading lighting capabilities');assert.equal(result.reasonId,null);
  const compatible=derive(usb({firmware:{error:'query failed',stale:true,updateAvailable:true}}));
  assert.equal(compatible.capability.kind,'perKey');assert.equal(compatible.reasonId,null);
});

test('F16 unsupported firmware means app update, ahead of key and generic recovery',()=>{
  for(const patch of [{errorCode:'UNSUPPORTED_FIRMWARE'},{connection:{status:'updateRequired'}}]) {
    const result=derive(state({device:patch}),{keyRecoveryProblem:{blocking:true}});
    assert.equal(result.stateId,'attention');assert.equal(result.reasonId,'appUpdateRequired');
    assert.equal(result.devicePrimaryAction,'checkAppUpdates');assert.equal(result.devicePrimaryCopy.en,'Check app updates');
    assert.doesNotMatch(result.deviceBody.zh,/NuPhyIO/);
  }
});

test('F17 draft name and page-only preview changes never relabel current hardware output',()=>{
  const snapshot=usb({device:{armed:true},playback:{mode:'animation'}});
  const before=derive(snapshot);
  for(const pagePreview of [true,false]) {
    const next=derive(snapshot,{draft:{name:'A completely different draft'},pagePreview,previewColors:['#abcdef']});
    assert.deepEqual(next.sidebar,before.sidebar);assert.equal(next.sidebar.en,'Current session · Animation');
  }
});

test('F18 save uncertainty stays an explanation, preserving frozen local data and existing transaction ownership',()=>{
  const snapshot=state({scenes:[{id:'stable-id',name:'Kept name',colors:['#102030']}]});
  const result=derive(snapshot,{serviceError:'lost receipt'});
  assert.equal(snapshot.scenes[0].id,'stable-id');assert.equal(snapshot.scenes[0].name,'Kept name');
  assert.match(result.workBody.en,/Saving may need verification or a retry/);
  assert.equal('saveDisabled' in result,false);assert.equal('canSave' in result,false);
  assert.equal(result.primaryAction,'refreshService');
  // This test covers display only; actual saveScene id/read-back/retry remains
  // App's existing transaction, not a new shared display responsibility.
});

test('F19 the caller supplies filtered key recovery; raw active/unowned records are not independently reinterpreted',()=>{
  for(const device of [
    {keyRecovery:{status:'active',pending:true,blocking:false}},
    {keyRecovery:{status:'blocked',unownedHistory:true,blocking:true}},
    {unownedFunctionKeyHistory:true,keyRecovery:{status:'blocked',blocking:true}},
  ]) {
    const result=derive(usb({device}),{keyRecoveryProblem:null});
    assert.equal(result.stateId,'usbReady');assert.equal(result.reasonId,null);
  }
  const blocked=derive(usb({device:{readOnly:true}}),{keyRecoveryProblem:{blocking:true,status:'blocked'}});
  assert.equal(blocked.reasonId,'keyRecoveryBlocked');assert.equal(blocked.devicePrimaryAction,'connect');
  const generic=derive(state({device:{connection:{status:'attention'}}}));
  assert.equal(generic.reasonId,'genericConnection');
});

test('F20 every finished game keeps its session until End, with paused/unknown handling',()=>{
  const names={snake:'Snake',whack:'Whack-a-mole',memory:'Memory sequence',pong:'Two-player Pong'};
  for(const [type,name] of Object.entries(names))for(const status of ['over','won']) {
    const result=derive(usb({device:{armed:true},playback:{mode:'game',playing:false},game:{type,status}}));
    assert.equal(result.sidebar.en,`Current session · ${name} · Finished`);assertNoRestore(result);
  }
  assert.equal(derive(usb({device:{armed:true},playback:{mode:'game'},game:{type:'snake',status:'paused'}})).sidebar.en,'Current session · Snake · Paused');
  assert.equal(derive(usb({device:{armed:true},playback:{mode:'game'},game:{type:'toString'}})).sidebar.en,'Output unconfirmed');
});

test('F21 both languages expose complete surface copy independently of viewport; layout still needs browser QA',()=>{
  for(const options of [
    {state:state({device:{errorCode:'DEVICE_AMBIGUOUS'}})},
    {state:usb(),serviceError:'outage'},
  ])for(const viewport of [[1080,720],[720,520],[390,844]]) {
    const result=derive(options.state,{...options,viewport});
    for(const language of ['zh','en'])for(const key of ['header','sidebar','workTitle','workBody','deviceTitle','deviceBody','devicePrimaryCopy']) {
      assert.equal(typeof result[key][language],'string');assert(result[key][language].length>0);
      assert.doesNotMatch(result[key][language],/\{\w+\}/,'no unresolved template becomes an accessible name');
    }
    if(result.stateId==='attention')assert.equal(result.deviceTitle,result.workTitle,'attention surfaces share the same primary reason/title');
    else assert.deepEqual(result.deviceTitle,result.header,'service failure is shared across connection surfaces');
  }
  assert.equal(spec.acceptanceFixtures.length,21);assert.equal(spec.stateMatrix.length,8);
});
