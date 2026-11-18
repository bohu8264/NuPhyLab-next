import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import {createHmac,randomBytes} from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  readFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEGACY_COMMAND_IDS } from '../../shared/codex-keys.mjs';

const modelsURL = new URL('../../shared/keyboard-models.mjs',import.meta.url).href;
const mainURL = new URL("../../server/main.mjs", import.meta.url);
const codexURL = new URL("../../server/codex.mjs", import.meta.url).href;
const firmwareURL = new URL("../../server/firmware.mjs", import.meta.url).href;
const claudeActionsURL = new URL("../../server/claude-actions.mjs", import.meta.url).href;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(read, predicate, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(20);
  }
  assert.fail(message);
}

// Run the real HTTP service and Hardware adapter, but replace all external
// integrations. The helper below is only a JSONL state machine; the import
// loader replaces CodexAdapter so no desktop tasks, credentials, or quota are read.
export async function fakeService(t, initialControl = {}, options = {}) {
  const dir = options.directory ?? await mkdtemp(path.join(tmpdir(), "air-studio-main-recovery-"));
  if(options.directory)await mkdir(dir);
  const nativeKeySecret=options.nativeKeySecret??randomBytes(32);
  assert.equal(nativeKeySecret.length,32);
  let nativeKeySequence=0;
  let nativeRotarySequence=0;
  const dataDir = path.join(dir, "data");
  await mkdir(dataDir);
  // Existing scenarios exercise saved pre-recommendation bindings. Fresh
  // profile tests opt in explicitly rather than silently changing their intent.
  const storedSettings=initialControl.freshLibrary===true?initialControl.storedSettings
    :{codexCommandIds:[...LEGACY_COMMAND_IDS],...initialControl.storedSettings};
  if (storedSettings !== undefined) {
    await writeFile(path.join(dataDir, 'library.json'), JSON.stringify({version:1, scenes:[],
      settings:storedSettings, bestScore:0}));
  }
  if(initialControl.codexKeybindings) {
    await mkdir(path.join(dir,'codex-home'));
    await writeFile(path.join(dir,'codex-home/keybindings.json'),JSON.stringify(initialControl.codexKeybindings));
  }
  const helper = path.join(dir, "fake-hid.mjs");
  const controlFile = path.join(dir, "control.json");
  const logFile = path.join(dir, "operations.jsonl");
  let control = { ...initialControl };
  await writeFile(controlFile, JSON.stringify(control));
  await writeFile(logFile, "");
  await writeFile(
    helper,
    `#!${process.execPath}
import {createInterface} from 'node:readline';
import {readFileSync,appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {getKeyboardProfile} from ${JSON.stringify(modelsURL)};
const controlFile=${JSON.stringify(controlFile)}, logFile=${JSON.stringify(logFile)};
const configuration=()=>{try{return JSON.parse(readFileSync(controlFile,'utf8'));}catch{return {};}};
const profile=()=>getKeyboardProfile(configuration().modelId??'air75-v3');
const initial=configuration();
let lightingModel=initial.modelId??'air75-v3';
let connected=false,armed=false,pending=false,failedGeneration=0,disconnectGeneration=0,triggerGeneration=0,triggerCode=null;
let recoveryConfirmed=false,recoveryPreviewSequence=0,recoveryPreviewToken=null;
let simulatedDictating=initial.dictationInitiallyRecording===true,simulatedDictationOwner=null,simulatedFast=false;
const original=initial.originalLightingState??[1,100,0,0,0,0,0,0,0,2,65,0,0,0,19,51,68];
let originalColors=initial.originalColors??Array(profile().keyCount+profile().sideCount).fill('#000000');
// Service-level transaction double only: this does not simulate electrical
// visibility between native D6/D8 packets or prove flash-free first capture.
const modelVisibleLighting=initial.connectionWake===true||initial.recordVisibleWrites===true||Object.hasOwn(initial,'originalColors')||Object.hasOwn(initial,'initialColors');
let lighting=[...(initial.initialLightingState??original)];let functionKeyLease=false,rotaryLease=false;
const rotaryProof=()=>{
 const c=configuration();if(c.rotaryProof)return structuredClone(c.rotaryProof);
 const air=c.modelId!=='kick75',count=air?98:92,positions=air?[60,96,97]:[74,91,90];
 return {vendorId:0x19f5,productId:c.outputIdentity?.productId??(air?0x1028:0x1026),locationId:c.outputIdentity?.locationId??123,
  sessionId:c.rotarySessionId??(air?'b6202652-3310-4cd8-9e74-d5f7246a9ac2':'371517d1-9552-4fd8-8ee7-d28d2aff63ea'),leaseToken:'a'.repeat(64),
  modelId:air?'air75-v3':'kick75',matrixKeyCount:air?96:90,keymapKeyCount:count,mode:0,readbackVerified:true,
  macLayers:Array.from({length:4},()=>{const layer=Array(count).fill(0);positions.forEach((index,i)=>layer[index]=109+i);return layer;})};
};
let lightingProfile=0,profileRecoveryPending=false;const pendingProfiles=new Set(),sideOnlyProfiles=new Set();let sideOwned=false;
let normalizedRow=false,consumerPlan=null,consumerOwner=null,consumerSuppression=false;
const consumerSession='b6202652-3310-4cd8-9e74-d5f7246a9ac2';
const consumerConnection=()=>({kind:'consumer-connection-v1',sessionId:consumerSession,sourceFingerprint:'f'.repeat(64),source:{syntheticSource:true},inputAuthorityGranted:false});
const consumerKeymap=()=>{
 const map=structuredClone(configuration().keymap);
 if(!map)throw Error('consumer fixture requires an explicit keymap');
 if(normalizedRow)for(const [index,value] of [[4,61],[10,67],[11,68],[12,69]])map.active[index]=value;
 return map;
};
const consumerRow=()=>({kind:'consumer-function-row-v1',verified:true,active:normalizedRow,restored:!normalizedRow,
 ownerId:'a'.repeat(64),sessionId:consumerSession,modelId:'air75-v3',productId:0x1028,locationId:123,mode:0,
 keys:['F4','F10','F11','F12'],matrixKeyCount:96,keymapKeyCount:98,activeLayer:consumerKeymap().active,keymap:consumerKeymap(),
 rawEligible:normalizedRow,rawEligibilityPolicy:'materialized-function-row-v1',inputAuthorityGranted:false});
pending=initial.initialRecoveryPending===true;if(pending)pendingProfiles.add(lightingProfile);
let colors=[...(initial.initialColors??originalColors)];
const log=(entry)=>appendFileSync(logFile,JSON.stringify(entry)+'\\n');
const send=(entry)=>process.stdout.write(JSON.stringify(entry)+'\\n');
const visible=(operation,extra={})=>{if(configuration().recordVisibleWrites)log({event:'simulatedVisibleWrite',operation,colors:[...colors],state:[...lighting],...extra});};
const sideColors=(color,brightness)=>Array(profile().sideCount).fill('#'+[1,3,5].map(start=>Math.round(parseInt(color.slice(start,start+2),16)*brightness/100).toString(16).padStart(2,'0')).join(''));
const codexLaunchedAt=Date.now();
const permissions=()=>({inputMonitoring:false,accessibility:false,canPostEvents:false,...configuration().permissions,promptsRequested:false});
const keyRecovery=()=>recoveryConfirmed?{status:'none',pending:false,blocking:false}:configuration().keyRecovery??{status:functionKeyLease?'active':'none',pending:functionKeyLease,blocking:false};
const selectProfile=()=>{const next=configuration().lightingProfile??0;if(next!==lightingProfile){lightingProfile=next;armed=false;sideOwned=false;pending=pendingProfiles.has(next);profileRecoveryPending=pending;lighting=[...original];}};
const state=()=>({...configuration().outputIdentity,keyRecovery:keyRecovery(),functionKeyRecoveryPending:keyRecovery().pending,connected,identified:configuration().outputIdentity?.identified??connected,firmwareDetectionAvailable:connected,readOnly:configuration().readOnly===true,error:configuration().readOnly?'灯位数量校验失败：应为 85，实际为 218。已停止灯效写入。':null,errorCode:configuration().readOnly?'WRONG_LED_COUNT':null,armed,recoveryPending:pending,sideRecoveryPending:sideOnlyProfiles.has(lightingProfile)&&!sideOwned,lightingRecoveryPending:profileRecoveryPending&&pending&&!armed&&!sideOwned,needsRestore:pending,deferredProfiles:[...pendingProfiles].filter(p=>p!==lightingProfile),lightingProfile,state:[...lighting],firmwareVersion:configuration().firmwareVersion??'1.0.16.6',functionRowSessionId:configuration().consumerBridge?consumerSession:undefined,modelId:configuration().modelId??'air75-v3',model:profile().name+' ANSI',keyLedCount:configuration().outputIdentity?.keyLedCount??profile().keyCount,capabilities:{...(configuration().consumerBridge?{consumerControlVersion:1}:{}),...(Object.hasOwn(configuration(),'readProbeVerified')?{readProbeVerified:configuration().readProbeVerified}:{}),...(Object.hasOwn(configuration(),'connectionWake')?{connectionWake:configuration().connectionWake}:{}),sideWholeZone:configuration().sideWholeZone===true,perKey:configuration().readOnly?false:configuration().compatible??true,mainWholeZone:configuration().readOnly?false:configuration().mainWholeZone??false,functionKeyAdaptation:configuration().readOnly?false:configuration().functionKeyAdaptation??true},permissions:permissions()});
if(configuration().recordHelperPid)log({event:'simulatedHelperStarted',pid:process.pid});
const answer=(request,result)=>{
 const delay=configuration().operationDelays?.[request.op];
 const reply=()=>send({id:request.id,ok:true,result});
 if(Number.isSafeInteger(delay)&&delay>0&&delay<=2000)setTimeout(reply,delay);else reply();
};
const reject=(request,message,code)=>send({id:request.id,ok:false,error:{message,code}});
const rejectRotary=(request,value,code)=>send({id:request.id,ok:false,error:
 typeof value==='object'&&value!==null?{message:'synthetic private rotary failure',code,...value}:{message:'synthetic rotary failure',code}});
const restore=()=>{log({event:'simulatedRestore',lightingProfile});armed=false;pending=false;profileRecoveryPending=false;pendingProfiles.delete(lightingProfile);sideOnlyProfiles.delete(lightingProfile);sideOwned=false;lighting=[...original];if(modelVisibleLighting)colors=[...originalColors];visible('restore');};
setInterval(()=>{
 const generation=configuration().disconnect??0;
 if(generation>disconnectGeneration){disconnectGeneration=generation;connected=false;armed=false;log({event:'simulatedDisconnect'});send({event:'disconnected',needsRestore:pending});}
 const trigger=configuration().trigger??0;
 if(trigger>triggerGeneration){triggerGeneration=trigger;if(triggerCode!==null)send({event:'triggerKey',keyCode:configuration().triggerKeyCode??triggerCode});}
},10);
const input=createInterface({input:process.stdin});
input.on('close',()=>process.exit(0));
input.on('line',line=>{
 const request=JSON.parse(line);log(request);
 if(!connected&&!['connect','status','quit','disconnect','restore','restoreKeys','restoreFunctionKey','triggerMonitor','permissions','openPermissionSettings','bluetoothDevices','shortcut','codexControl','codexProcess','codexPrepare'].includes(request.op)&&!(['adaptKeys','keyMappingStatus'].includes(request.op)&&request.transport==='bluetooth'&&configuration().bluetoothDevices?.length===1)){reject(request,'simulated not connected');return;}
 switch(request.op){
  case 'connect':if(lightingModel!==(configuration().modelId??'air75-v3')){lightingModel=configuration().modelId??'air75-v3';originalColors=Array(profile().keyCount+profile().sideCount).fill('#000000');colors=[...originalColors];}if(configuration().present===false){reject(request,'not present','DEVICE_NOT_FOUND');break;}selectProfile();connected=true;answer(request,state());break;
  case 'status':{selectProfile();const snapshot=state();if(configuration().connectionWakeFailure)log({event:'simulatedWakeFailureStatus',connected:snapshot.connected,armed:snapshot.armed,recoveryPending:snapshot.recoveryPending,needsRestore:snapshot.needsRestore});answer(request,snapshot);break;}
  case 'permissions':answer(request,permissions());break;
  case 'readInputConnection':answer(request,consumerConnection());break;
  case 'prepareInputConnection':answer(request,{...consumerConnection(),stopped:true,suppressionReleased:true});break;
  case 'prepareFunctionRow':normalizedRow=true;answer(request,consumerRow());break;
  case 'auditFunctionRow':answer(request,consumerRow());break;
  case 'releaseFunctionRow':normalizedRow=false;answer(request,consumerRow());break;
  case 'stopConsumerMappings':consumerOwner=null;answer(request,{stopped:true,suppressionReleased:true});break;
  case 'readConsumerMappings':answer(request,consumerOwner??{active:false});break;
  case 'prepareConsumerMappings':
   consumerSuppression=request.suppressRotary;
   consumerPlan={kind:'consumer-input-plan-v1',epoch:request.epoch,ticketNonce:randomUUID(),sourceFingerprint:'f'.repeat(64),
    sessionId:consumerSession,matrixOwnerId:'a'.repeat(64),transactionPlanSHA256:(consumerSuppression?'b':'c').repeat(64),expiresAtMs:Date.now()+3000};
   answer(request,{plan:consumerPlan,source:consumerConnection().source});break;
  case 'commitConsumerMappings':
   consumerOwner={...consumerPlan,kind:'consumer-input-owner-v2',rotarySuppressed:consumerSuppression,producerGeneration:'1',
    proofToken:'d'.repeat(64),expiresAtMs:Date.now()+1500,verified:true,active:true,inputAuthorityGranted:false};answer(request,consumerOwner);break;
  case 'refreshConsumerMappings':answer(request,consumerOwner??{active:false});break;
  case 'renewConsumerMappings':if(consumerOwner){consumerOwner.expiresAtMs=request.expiresAtMs;answer(request,consumerOwner);}else reject(request,'synthetic owner unavailable');break;
  case 'bluetoothDevices':answer(request,{devices:configuration().bluetoothDevices??[]});break;
  case 'restoreKeys':answer(request,{restored:true});break;
  case 'restoreFunctionKey':functionKeyLease=false;answer(request,{restored:true});break;
  case 'previewFunctionKeyRecovery':{
   recoveryPreviewToken='fixture-recovery-'+(++recoveryPreviewSequence);
   answer(request,{token:recoveryPreviewToken,canConfirm:configuration().recoveryCanConfirm!==false,action:'restore',alreadyRestored:false,original:{model:'Kick75',firmware:'4.0.18.6',port:'0x00100000'},current:{model:'Kick75',firmware:'4.0.18.6',port:'0x02100000'},checks:[{id:'model',label:'型号与键位结构一致',passed:true}],status:'confirmationRequired'});break;
  }
  case 'confirmFunctionKeyRecovery':{
   if(request.sameKeyboard!==true||request.token!==recoveryPreviewToken||!recoveryPreviewToken||configuration().recoveryCanConfirm===false){reject(request,'恢复预览已失效，请重新检查。','KEY_RECOVERY_STALE');break;}
   recoveryPreviewToken=null;recoveryConfirmed=true;functionKeyLease=false;answer(request,{restored:true,verified:true,archived:true});break;
  }
  case 'prepareFunctionKey':functionKeyLease=true;answer(request,{leased:true,verified:true});break;
  case 'prepareRotaryKeys':
   if(configuration().rotaryPrepareError){rejectRotary(request,configuration().rotaryPrepareError,'ROTARY_LEASE_FAILED');break;}
   rotaryLease=true;answer(request,{active:true,verified:true,proof:rotaryProof()});break;
  case 'readRotaryKeys':
   if(configuration().rotaryReadError){rejectRotary(request,configuration().rotaryReadError,'ROTARY_READ_FAILED');break;}
   answer(request,{active:rotaryLease,verified:true,proof:rotaryProof()});break;
  case 'restoreRotaryKeys':{
   const proof=rotaryProof();
   if(configuration().rotaryRestoreError){rejectRotary(request,configuration().rotaryRestoreError,'ROTARY_RECOVERY_DEVICE');break;}
   if(['vendorId','productId','locationId','sessionId','leaseToken'].some(key=>request[key]!==undefined&&request[key]!==proof[key])){
    reject(request,'synthetic rotary recovery belongs to another device','ROTARY_RECOVERY_DEVICE');break;
   }
   rotaryLease=false;answer(request,{active:false,verified:true,restored:true});break;
  }
  case 'reasoningPower':
   if(configuration().rotaryTargetError)reject(request,'synthetic reasoning control failed','CONTROL_NOT_FOUND');
   else answer(request,configuration().rotaryAtLimit?{atLimit:true}:{performed:true});break;
  case 'adaptKeys':if(configuration().denyAdapt){reject(request,'mapping denied');break;}answer(request,{verified:true,applied:true});break;
  case 'keyMappingStatus':answer(request,{verified:!configuration().mappingLost});break;
  case 'readKeymap':{
   if(configuration().consumerBridge){answer(request,consumerKeymap());break;}
   const standard=Array(profile().rows*profile().columns+profile().extraKeys).fill(0);for(let i=1;i<=12;i++)standard[i]=57+i;
   const map=structuredClone(configuration().keymap??{mode:0,locationId:1,firmwareVersion:configuration().firmwareVersion??'1.0.16.6',active:standard,defaults:[standard,standard]});
   if(functionKeyLease){map.active[map.defaults[1].indexOf(61)]=61;map.functionKeyLease=true;}if(keyRecovery().blocking){map.functionKeyLeaseSupported=false;map.functionKeyLease=false;map.keyRecovery=keyRecovery();}
   const keymapDelayMs=configuration().keymapDelayMs;
   if(Number.isFinite(keymapDelayMs)&&keymapDelayMs>0){
    log({event:'simulatedKeymapPending',id:request.id,at:Date.now()});
    setTimeout(()=>{log({event:'simulatedKeymapAck',id:request.id,at:Date.now()});answer(request,map);},keymapDelayMs);
   }else answer(request,map);
   break;
  }
  case 'systemIdle':answer(request,{idleMs:configuration().systemIdleMs??100000,recordsKeys:false});break;
  case 'codexPrepare':answer(request,{status:configuration().codexProcess?.installed===false||configuration().codexProcess?.running===false?'open-app':configuration().codexPrepareStatus??'prepared'});break;
  case 'codexProcess':answer(request,{installed:true,running:true,processCount:1,pid:12345,launchedAtMs:codexLaunchedAt,version:'26.1027.61615',...configuration().codexProcess});break;
  case 'codexControl':{
   const c=configuration();
   if(!['toggleFastMode','dictation','approve','decline','sendPrompt'].includes(request.action)){reject(request,'unsupported simulated control','INVALID_SHORTCUT');break;}
   if(c.codexControlError){if(request.phase==='up'&&request.owner===simulatedDictationOwner)simulatedDictationOwner=null;send({id:request.id,ok:false,error:{message:c.codexControlError.message??'simulated control unavailable',code:c.codexControlError.code??'CONTROL_NOT_FOUND',controlDiagnostic:c.codexControlError.controlDiagnostic}});break;}
   if(request.action==='dictation'){
    if(!['down','up'].includes(request.phase)||typeof request.owner!=='string'||!/^[a-f0-9-]{36}$/i.test(request.owner)){reject(request,'invalid simulated dictation hold','INVALID_CONTROL');break;}
    if(request.phase==='down'&&c.codexControlResult){
     if(c.codexControlResult.performed===true){simulatedDictationOwner=request.owner;simulatedDictating=true;}
     answer(request,c.codexControlResult);break;
    }
    if(request.phase==='down'){
     if(simulatedDictating){answer(request,{performed:false,confirmation:'not-performed',observedState:'recording'});break;}
     simulatedDictating=true;simulatedDictationOwner=request.owner;
     answer(request,{performed:true,confirmation:'observed',observedState:'recording'});break;
    }
    if(simulatedDictationOwner!==request.owner){answer(request,{released:false,performed:false,confirmation:'not-performed',observedState:'unknown'});break;}
    simulatedDictationOwner=null;simulatedDictating=false;
    answer(request,c.codexControlReleaseResult??{released:true,performed:true,confirmation:'observed',observedState:'idle'});break;
   }
   if(c.codexControlResult){answer(request,c.codexControlResult);break;}
   if(['approve','decline','sendPrompt'].includes(request.action)){answer(request,{performed:true,confirmation:'delivered',observedState:'unknown'});break;}
   simulatedFast=!simulatedFast;
   answer(request,{performed:true,confirmation:'observed',observedState:simulatedFast?'fast':'standard'});break;
  }
  case 'shortcut':{
   const c=configuration();
   if(c.shortcutPermissionError&&request.action!=='task'){reject(request,'Enable Accessibility for the parent application to send shortcuts.','ACCESSIBILITY_REQUIRED');break;}
   if(request.action==='task'&&c.taskOpenDiagnostics){
    const event={event:'taskOpenResult',diagnosticId:request.diagnosticId,threadId:request.threadId,uri:'codex://threads/'+request.threadId,at:Date.now(),
     handler:{available:true,bundleId:'com.openai.codex',version:'26.1021.31345',build:'21828'},osAccepted:!c.taskOpenFail,...c.taskOpenEventOverrides};
    const finish=()=>{
     for(const extra of c.taskOpenExtraEvents??[])send({...extra,...(extra.diagnosticId==='$current'?{diagnosticId:request.diagnosticId}:{})});
     if(c.taskOpenReport!==false)send(event);
     if(c.taskOpenFail)reject(request,'macOS could not open the Codex task URL.',c.taskOpenFailureCode??'TASK_OPEN_FAILED');
     else answer(request,{opened:true,threadId:request.threadId});
    };
    if(c.taskOpenDelayMs)setTimeout(finish,c.taskOpenDelayMs);else finish();
   }else answer(request,{sent:true});
   break;
  }
  case 'readColors':answer(request,{customColorScale:configuration().customColorScale??255,colors:colors.map((color,index)=>configuration().mismatchIndex===index?'#010203':configuration().customColorScale===200?'#'+[1,3,5].map((start,c)=>{let v=Math.floor(parseInt(color.slice(start,start+2),16)*200/255);if(index===83&&c>0)v=Math.floor(v*150/255);return v.toString(16).padStart(2,'0')}).join(''):color)});break;
  case 'openPermissionSettings':
   if(!['inputMonitoring','accessibility'].includes(request.permission)){reject(request,'unsupported permission');break;}
   answer(request,{opened:true,permission:request.permission,permissions:permissions()});break;
  case 'triggerMonitor':
   triggerCode=null;
   if(request.enabled&&configuration().denyMonitor){reject(request,'macOS denied the key monitor','INPUT_MONITORING_REQUIRED');break;}
   if(request.enabled)triggerCode=request.keyCode;
   answer(request,{enabled:!!request.enabled,ordinaryTypingRecorded:false});break;
  case 'nativeLighting':pending=true;pendingProfiles.add(lightingProfile);lighting[0]=request.mode;lighting[1]=request.brightness;lighting[2]=request.speed;lighting[4]=1;if(request.color)lighting.splice(6,3,...[1,3,5].map(i=>parseInt(request.color.slice(i,i+2),16)));answer(request,{verified:true,state:[...lighting]});break;
  case 'arm':if(pending&&!armed){reject(request,'A previous lighting backup exists.','RECOVERY_REQUIRED');break;}armed=true;pending=true;pendingProfiles.add(lightingProfile);lighting[0]=21;visible('arm');answer(request,state());break;
  case 'armConnectionWake':{
   selectProfile();if(Object.hasOwn(request,'expectedProfile')&&request.expectedProfile!==lightingProfile){reject(request,'synthetic profile changed before wake','LIGHTING_PROFILE_CHANGED');break;}
   if(configuration().connectionWake!==true){reject(request,'Connection wake takeover is unavailable.','CONNECTION_WAKE_UNSUPPORTED');break;}
   const reusedJournal=pending,previousColors=[...colors];
   const custom=configuration().originalCustomColors,quietPreparation=reusedJournal&&Array.isArray(custom)&&custom.length===profile().keyCount*3&&custom.every(value=>Number.isInteger(value)&&value>=0&&value<=255);
   // Log the completed transaction, not the transient capture path. Native
   // first capture can expose the old palette and reports quietPreparation=false.
   armed=true;pending=true;pendingProfiles.add(lightingProfile);lighting[0]=21;lighting[1]=100;lighting[4]=1;if(lighting.length===22)lighting.splice(6,3,255,255,255);lighting[10]=0;colors=Array(profile().keyCount+profile().sideCount).fill('#000000');
   const wakeFailure=configuration().connectionWakeFailure;
   if(wakeFailure){
    armed=false;colors[0]='#010203';
    const verified=wakeFailure!=='unverifiedRollback';
    if(verified)restore();
    // The pending-after-verified case models a recovery record still visible
    // in the following status; the verified error phrase alone is insufficient.
    if(!verified||wakeFailure==='pendingAfterVerifiedRollback'){pending=true;pendingProfiles.add(lightingProfile);}
    log({event:'simulatedWakeRollback',verified,connected,armed,recoveryPending:pending,needsRestore:pending});
    reject(request,verified?'simulated connection-wake black verification failure. Original lighting was restored and verified.':'simulated connection-wake failure; original restoration could not be verified. Backup retained.',verified?'COLOR_VERIFY_FAILED':'RESTORE_REQUIRED');break;
   }
   visible('armConnectionWake',{reusedJournal,previousColors,quietPreparation});answer(request,{...state(),verified:true,quietPreparation});break;
  }
  case 'side':
   selectProfile();if(Object.hasOwn(request,'expectedProfile')&&request.expectedProfile!==lightingProfile){reject(request,'synthetic profile changed before side write','LIGHTING_PROFILE_CHANGED');break;}
   if(configuration().failSide){if(configuration().sideRollback!==false)restore();reject(request,'simulated side write failure','SIDE_FAILED');break;}
   if(request.restore){if(sideOnlyProfiles.has(lightingProfile)){pending=false;pendingProfiles.delete(lightingProfile);sideOnlyProfiles.delete(lightingProfile);sideOwned=false;}lighting.splice(9,8,...original.slice(9,17));if(modelVisibleLighting)colors=[...colors.slice(0,profile().keyCount),...originalColors.slice(profile().keyCount)];}
   else{if(!pending)sideOnlyProfiles.add(lightingProfile);sideOwned=true;pending=true;pendingProfiles.add(lightingProfile);lighting[9]=2;lighting[10]=request.brightness;lighting.splice(14,3,...[1,3,5].map(i=>parseInt(request.color.slice(i,i+2),16)));if(modelVisibleLighting)colors=[...colors.slice(0,profile().keyCount),...sideColors(request.color,request.brightness)];}
   visible('side');answer(request,{state:[...lighting],verified:true});break;
  case 'paint':{
   if(!armed){reject(request,'simulated NOT_ARMED');break;}
   const generation=configuration().failPaint??0;
   if(generation>failedGeneration){failedGeneration=generation;restore();log({event:'simulatedRollback'});reject(request,'simulated paint failure; original lighting restored');}
   else {const commit=()=>{const keyCount=profile().keyCount;colors=[...request.colors.slice(0,keyCount),...(modelVisibleLighting?colors.slice(keyCount):Array(profile().sideCount).fill('#000000'))];visible('paint');answer(request,{painted:keyCount});};if(configuration().paintDelayMs)setTimeout(commit,configuration().paintDelayMs);else commit();}break;
  }
  case 'restore':selectProfile();if(Object.hasOwn(request,'expectedProfile')&&request.expectedProfile!==lightingProfile){reject(request,'synthetic profile changed before whole restore','LIGHTING_PROFILE_CHANGED');break;}if(configuration().failWholeRestore){reject(request,'simulated whole restoration timeout','RESTORE_REQUIRED');break;}if(!connected&&configuration().present===false){reject(request,'simulated not connected','DEVICE_NOT_FOUND');break;}connected=true;restore();answer(request,{...state(),restored:true,verified:true});break;
  case 'disconnect':if(configuration().failDisconnect){reject(request,'原设置尚未恢复，模拟释放失败','RESTORE_REQUIRED');break;}if(!configuration().deferRestore)restore();connected=false;armed=false;answer(request,{...state(),unownedFunctionKeyHistory:configuration().unownedFunctionKeyHistory===true,unsafeWritesNeeded:configuration().unsafeWritesNeeded===true,historicalRecoveryLost:configuration().historicalRecoveryLost===true});break;
  case 'quit':restore();answer(request,{quitting:true});setTimeout(()=>process.exit(0),10);break;
  default:reject(request,'unsupported fake operation');
 }
});
`,
  );
  await chmod(helper, 0o700);
  const fakeCodex = path.join(dir, "fake-codex.mjs");
  await writeFile(
    fakeCodex,
    `import {readFileSync} from 'node:fs';
    import {SHORTCUTS,describeAction} from ${JSON.stringify(codexURL+"?real")};
    export {describeAction};
    export class CodexAdapter {
    observeAggregate(enabled){this.aggregateEnabled=enabled;}
    async start(){} async stop(){} async refresh(){return this.snapshot();}
    action(id,args){return describeAction(id,{...args,tasks:this.snapshot().tasks});}
    snapshot(){const c=JSON.parse(readFileSync(${JSON.stringify(controlFile)},'utf8'));return {aggregate:this.aggregateEnabled&&c.aggregate?{observedAt:Date.now(),...c.aggregate}:undefined,available:true,tasks:c.tasks??[],slots:[],shortcuts:SHORTCUTS,taskSource:{available:true},quota:{available:true,stale:false,buckets:[{id:'codex',windows:[{remainingPercent:80}]}]}};}
  }`,
  );
  const loader = path.join(dir, "loader.mjs");
  // Keep real action validation, but never open a fabricated Claude session,
  // launch an application, or change the developer's clipboard during tests.
  const fakeClaudeActions = path.join(dir, "fake-claude-actions.mjs");
  await writeFile(fakeClaudeActions, `
import {appendFileSync} from 'node:fs';
import {ClaudeActionRunner as RealRunner} from ${JSON.stringify(claudeActionsURL + "?real")};
export * from ${JSON.stringify(claudeActionsURL + "?real")};
export const claudeAppInstalled=async()=>true;
const log=entry=>appendFileSync(${JSON.stringify(logFile)},JSON.stringify(entry)+'\\n');
export class ClaudeActionRunner extends RealRunner {
 constructor(){super({exec:async(file,args)=>{log({op:'claudeExternalAction',file,args});return {stdout:'',stderr:''};}});}
 async execute(action){
  if(action?.available && action.type==='copyResume'){
   log({op:'claudeExternalAction',file:'/usr/bin/pbcopy',text:action.text});
   return {copied:true,text:action.text};
  }
  return super.execute(action);
 }
}
`);
  const fakeFirmware = path.join(dir, "fake-firmware.mjs");
  await writeFile(fakeFirmware, `
import {readFileSync} from 'node:fs';
import {getKeyboardProfile} from ${JSON.stringify(modelsURL)};
import {FirmwareChecker as RealChecker} from ${JSON.stringify(firmwareURL + "?real")};
export * from ${JSON.stringify(firmwareURL + "?real")};
export class FirmwareChecker extends RealChecker {
 constructor(){super({fetchImpl:async(_url,{signal})=>{
  const c=JSON.parse(readFileSync(${JSON.stringify(controlFile)},'utf8'));
  if(c.firmwareDelay) await new Promise((resolve,reject)=>{
   const t=setTimeout(resolve,c.firmwareDelay);
   signal.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('aborted'));},{once:true});
  });
  if(c.firmwareOffline) throw new Error('offline');
  return new Response(JSON.stringify({code:200,data:{businessId:getKeyboardProfile(c.modelId??'air75-v3').businessId,environment:'prod',type:'1',status:'0',versionNumber:c.latestFirmware??(c.modelId&&c.modelId!=='air75-v3'?getKeyboardProfile(c.modelId).qualifiedFirmware:'1.0.16.6')}}));
 }});}
}
`);
  await writeFile(
    loader,
    `export async function resolve(specifier,context,nextResolve){
    const resolved=await nextResolve(specifier,context);
    if(resolved.url===${JSON.stringify(codexURL)}) return {url:${JSON.stringify(pathToFileURL(fakeCodex).href)},shortCircuit:true};
    if(resolved.url===${JSON.stringify(firmwareURL)}) return {url:${JSON.stringify(pathToFileURL(fakeFirmware).href)},shortCircuit:true};
    if(resolved.url===${JSON.stringify(claudeActionsURL)}) return {url:${JSON.stringify(pathToFileURL(fakeClaudeActions).href)},shortCircuit:true};
    return resolved;
  }`,
  );
  const preload = path.join(dir, "preload.mjs");
  await writeFile(
    preload,
    `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`,
  );
  const token = options.token ?? "isolated-main-recovery-test";
  const child = spawn(
    process.execPath,
    ["--import", preload, fileURLToPath(mainURL)],
    {
      cwd: dir,
      env: {
        ...(options.environment ?? process.env),
        AIR_STUDIO_HID: helper,
        AIR_STUDIO_DATA: dataDir,
        AIR_STUDIO_TOKEN: token,
        ...(options.uiDir ? {AIR_STUDIO_UI:options.uiDir} : {}),
        CODEX_HOME: options.defaultCodexHome ? undefined : path.join(dir,'codex-home'),
        ...(options.defaultCodexHome ? {HOME:dir,CFFIXED_USER_HOME:dir} : {}),
        AIR_STUDIO_CODEX_DESKTOP_VERSION:initialControl.codexDesktopVersion??'',
        AIR_STUDIO_NATIVE_KEY_SECRET:nativeKeySecret.toString('base64'),
        // Claude Code reads and writes are confined to the temporary directory;
        // tests must never touch the developer's real ~/.claude configuration.
        CLAUDE_CONFIG_DIR: path.join(dir,'claude-home'),
        CLAUDE_DESKTOP_SUPPORT: path.join(dir,'claude-support'),
        ...(initialControl.preferredPort ? {AIR_STUDIO_PREFERRED_PORT:String(initialControl.preferredPort),AIR_STUDIO_PORT:""} : {AIR_STUDIO_PORT:"0"}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-8192);
  });
  const exited = once(child, "exit");
  exited.catch(() => {});
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      const [code, signal] = await exited;
      assert.equal(
        code,
        0,
        `fake service must restore and exit cleanly: ${stderr}`,
      );
      assert.equal(signal, null);
    } finally {
      if(options.keepData!==true)await rm(dir, { recursive: true, force: true });
    }
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Service did not start: ${stderr}`)),
      5000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Service exited before ready: ${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.event === "ready") {
          clearTimeout(timer);
          resolve(message.url);
        }
      } catch {}
    });
  });
  const url = await ready;
  const command = async (body) => {
    const response = await fetch(new URL("/api/command", url), {
      method: "POST",
      headers: { "X-Air-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, ...(await response.json()) };
  };
  const physicalTestHolds=new Map();let physicalTestSerial=0;
  const nativeKey=async body=>{
    body={phase:'down',eventSource:'eventTap',...body};
    if(!body.gestureId) {
      if(body.phase==='down'&&!physicalTestHolds.has(body.code))physicalTestHolds.set(body.code,'fixture:physical:'+ ++physicalTestSerial);
      body.gestureId=physicalTestHolds.get(body.code)??'fixture:unmatched-release';
      if(body.phase==='up')physicalTestHolds.delete(body.code);
    }
    const bindingEpoch=Object.hasOwn(body,'nativeKeyBindingEpoch')?body.nativeKeyBindingEpoch:(await state()).codex.keys.bindingEpoch;
    const packet={...body,nativeKeySequence:++nativeKeySequence,nativeKeyBindingEpoch:bindingEpoch};
    const canonical=JSON.stringify(['nuphylab-native-key-v2',packet.nativeKeySequence,packet.code,packet.phase,packet.gestureId,packet.eventSource,packet.nativeKeyBindingEpoch]);
    packet.nativeKeySignature=createHmac('sha256',nativeKeySecret).update(canonical).digest('hex');
    return command(packet);
  };
  const nativeRotary=async body=>{
    const current=(await state()).codex.rotary;
    const packet={op:'codexRotary',epoch:current.epoch,sessionId:current.inputProof?.sessionId,atMs:Date.now(),...body,nativeRotarySequence:++nativeRotarySequence};
    const canonical=JSON.stringify(['nuphylab-native-rotary-v1',packet.nativeRotarySequence,packet.action,packet.epoch,packet.sessionId,packet.atMs]);
    packet.nativeRotarySignature=createHmac('sha256',nativeKeySecret).update(canonical).digest('hex');
    return command(packet);
  };
  const state = async () => {
    const response = await fetch(new URL("/api/state", url), {
      headers: { "X-Air-Token": token },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const operations = async () =>
    (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const configure = async (changes) => {
    control = { ...control, ...changes };
    // The helper polls concurrently. Never expose a truncated configuration,
    // which would make a deliberately absent keyboard appear present.
    await writeFile(controlFile + '.next', JSON.stringify(control));
    await rename(controlFile + '.next', controlFile);
  };
  if (!initialControl.skipInitialConnect) {
    const connected = await command({ op: "connect" });
    assert.equal(connected.ok, true, JSON.stringify(connected));
  }
  // Legacy tests explicitly select a custom old profile after migration.
  // Fresh-library tests exercise the shipping defaults and provisioning.
  if(!initialControl.freshLibrary&&!initialControl.storedSettings?.codexCommandIds) {
    const selected=await command({op:'settings',settings:{codexCommandIds:[...LEGACY_COMMAND_IDS]}});
    assert.equal(selected.ok,true,JSON.stringify(selected));
  }
  return { command, nativeKey, nativeRotary, state, operations, configure, child, exited, url, token, dataDir,
    claudeDir: path.join(dir, "claude-home"), claudeSpool: path.join(dataDir, "claude-sessions"),
    claudeHookDir: path.join(dataDir, "claude-hook"),
    claudeSupportDir: path.join(dir, "claude-support") };
}
