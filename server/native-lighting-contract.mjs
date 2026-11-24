import contract from '../shared/contracts/native-lighting-v5.json' with {type:'json'};
import {getKeyboardProfile,isKeyboardModel} from '../shared/keyboard-models.mjs';
import {windowsLightingPolicy,windowsBoardSleepSupported} from '../shared/windows-lighting-firmware.mjs';
import {readJsonLines} from './native-jsonl.mjs';

export const NATIVE_LIGHTING=Object.freeze({...contract,operations:Object.freeze([...contract.operations]),capabilities:Object.freeze({...contract.capabilities})});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>Number.isSafeInteger(v)&&v>0;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export const lightingError=(code,message)=>Object.assign(new Error(message),{code});
const invalid=message=>lightingError('LIGHTING_PROTOCOL_ERROR',message);
const byte=v=>Number.isInteger(v)&&v>=0&&v<=255;
export function selection(modelId,lightingProfile) {
  if(!isKeyboardModel(modelId)||![0,1].includes(lightingProfile))
    throw lightingError('LIGHTING_SELECTION_INVALID','请选择已识别的键盘及实际 Mac/Win 档位');
  return Object.freeze({modelId,lightingProfile});
}
export function encodeLightingRequest(number,sessionId,op,args={}) {
  const fields={hello:['protocolVersion'],arm:['modelId','lightingProfile'],armNative:['modelId','lightingProfile'],armConnectionWake:['modelId','lightingProfile'],paint:['leaseId','colors','verify'],
    nativeLighting:['leaseId','mode','brightness','speed','color'],nativeSnapshot:['leaseId'],
    recoveryStatus:['modelId','lightingProfile'],recoverExisting:['modelId','lightingProfile'],
    side:['leaseId','color','brightness'],restore:['leaseId'],heartbeat:[],quit:[]}[op];
  if(!id(number)||!uuid(sessionId)||!fields||!exact(args,fields))
    throw lightingError('LIGHTING_REQUEST_INVALID','灯光命令字段或会话无效');
  if(op==='hello'&&args.protocolVersion!==NATIVE_LIGHTING.protocolVersion||
    ['arm','armNative','armConnectionWake','recoveryStatus','recoverExisting'].includes(op)&&(!isKeyboardModel(args.modelId)||![0,1].includes(args.lightingProfile))||
    ['paint','side','restore','nativeLighting','nativeSnapshot'].includes(op)&&!id(args.leaseId)||
    op==='armNative'&&args.modelId!=='kick75'||
    op==='nativeLighting'&&(!Number.isInteger(args.mode)||args.mode<1||args.mode>20||!Number.isInteger(args.brightness)||args.brightness<0||args.brightness>100||!Number.isInteger(args.speed)||args.speed<0||args.speed>4||!(args.color===null||Array.isArray(args.color)&&args.color.length===3&&args.color.every(byte)))||
    op==='paint'&&(!Array.isArray(args.colors)||!args.colors.length||args.colors.length%3||args.colors.some(v=>!byte(v))||typeof args.verify!=='boolean')||
    op==='side'&&(!Array.isArray(args.color)||args.color.length!==3||args.color.some(v=>!byte(v))||!Number.isInteger(args.brightness)||args.brightness<0||args.brightness>100))
    throw lightingError('LIGHTING_REQUEST_INVALID','灯光命令参数无效');
  const line=JSON.stringify({id:number,op,sessionId,...args})+'\n';
  if(Buffer.byteLength(line)>NATIVE_LIGHTING.maxLineBytes)throw lightingError('LIGHTING_REQUEST_INVALID','灯光命令超过 32 KiB 限制');
  return line;
}
export function validateLightingMessage(v) {
  if(!object(v))throw invalid('灯光回复不是对象');
  if(Object.hasOwn(v,'event')){
    if(!exact(v,['event','sessionId','eventSequence','lightingRestored','recoveryPending','noMutation','reasonCode'])||
      v.event!=='shutdownComplete'||!uuid(v.sessionId)||!id(v.eventSequence)||
      ['lightingRestored','recoveryPending','noMutation'].some(k=>typeof v[k]!=='boolean')||
      v.recoveryPending===v.lightingRestored||v.noMutation&&!v.lightingRestored||
      !(v.reasonCode===null||typeof v.reasonCode==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(v.reasonCode)))
      throw invalid('灯光清理事件格式或状态无效');
  }else if(!id(v.id)||typeof v.ok!=='boolean'||
    !(v.ok?exact(v,['id','ok','result'])&&object(v.result):
      exact(v,['id','ok','error'])&&exact(v.error,['code','message'])&&typeof v.error.code==='string'&&
      /^[A-Z][A-Z0-9_]{0,127}$/.test(v.error.code)&&typeof v.error.message==='string'&&v.error.message.length<=4096))
    throw invalid('灯光回复编号或内容无效');
  return v;
}
export function validateLightingHello(v,sessionId,backend) {
  if(!exact(v,['profile','protocolVersion','implementation','implementationVersion','sessionId','backend','readOnly','maxLineBytes','capabilities'])||
    v.profile!==NATIVE_LIGHTING.profile||v.protocolVersion!==NATIVE_LIGHTING.protocolVersion||
    v.implementation!==NATIVE_LIGHTING.implementation||v.sessionId!==sessionId||v.backend!==backend||
    !['simulated','windows-hid'].includes(backend)||v.readOnly!==false||v.maxLineBytes!==NATIVE_LIGHTING.maxLineBytes||
    typeof v.implementationVersion!=='string'||!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(v.implementationVersion)||
    !exact(v.capabilities,Object.keys(NATIVE_LIGHTING.capabilities))||
    Object.entries(NATIVE_LIGHTING.capabilities).some(([key,value])=>v.capabilities[key]!==value))
    throw lightingError('LIGHTING_PROTOCOL_MISMATCH','灯光控制器版本、后端或能力不匹配');
  return structuredClone(v);
}
export function validateLightingResult(op,v,expected) {
  if(op==='recoveryStatus'){
    if(!exact(v,['modelId','firmwareVersion','lightingProfile','pending','canRestore','noMutation'])||
      v.modelId!==expected.modelId||v.lightingProfile!==expected.lightingProfile||
      typeof v.firmwareVersion!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(v.firmwareVersion)||!validPending(v.pending)||
      typeof v.canRestore!=='boolean'||v.canRestore!==(windowsLightingPolicy(expected.modelId,v.firmwareVersion)!==null)||v.noMutation!==true)
      throw invalid('待恢复记录检查与本次键盘或固件不一致');
  }else if(op==='recoverExisting'){
    if(!exact(v,['modelId','lightingProfile','lighting','boardSleep','functionKeys','deferredProfiles','remaining','complete','completedCleanup'])||
      v.modelId!==expected.modelId||v.lightingProfile!==expected.lightingProfile||!validPart(v.lighting)||!validPart(v.boardSleep,true)||!validKeyPart(v.functionKeys)||
      !validPending(v.remaining)||!validPending(v.completedCleanup)||!validProfiles(v.deferredProfiles)||v.deferredProfiles.includes(expected.lightingProfile)||
      v.functionKeys.status==='restored'&&(expected.modelId!=='air75-v3'||expected.lightingProfile!==1||v.remaining.keymapProfiles.includes(expected.lightingProfile))||
      typeof v.complete!=='boolean'||v.complete&&(v.remaining.lightingProfiles.length||v.remaining.boardSleep||v.remaining.keymapProfiles.length||v.deferredProfiles.length||v.lighting.status==='failed'||v.boardSleep.status==='failed'||v.functionKeys.status==='failed'))
      throw invalid('原设置恢复结果缺少完整或独立的验证');
  }else if(['arm','armNative','armConnectionWake'].includes(op)){
    const p=getKeyboardProfile(expected.modelId),d=v.device,s=v.boardSleepLease;
    if(!exact(v,['armed','leaseId','device','boardSleepLease',...(op==='armConnectionWake'?['connectionWake']:[])])||v.armed!==true||!id(v.leaseId)||
      !exact(d,['modelId','firmwareVersion','lightingProfile','vendorId','productId','keyLedCount','ledCount','canvasCount','connectionToken'])||
      d.modelId!==expected.modelId||d.lightingProfile!==expected.lightingProfile||d.firmwareVersion!==(expected.firmwareVersion??p.windowsQualifiedFirmware??p.qualifiedFirmware)||windowsLightingPolicy(expected.modelId,d.firmwareVersion)===null||
      d.vendorId!==p.vendorId||!p.productIds.includes(d.productId)||d.keyLedCount!==p.keyCount||
      d.ledCount!==p.keyCount+p.sideCount||d.canvasCount!==p.canvasCount||
      typeof d.connectionToken!=='string'||!d.connectionToken||d.connectionToken.length>256||/[\x00-\x1f\x7f]/.test(d.connectionToken)||
      !exact(s,['supported','active','pending'])||Object.values(s).some(v=>typeof v!=='boolean')||
      s.supported!==windowsBoardSleepSupported(d.modelId,d.firmwareVersion)||s.active&&(!s.supported||!s.pending)||!s.supported&&(s.active||s.pending))
      throw invalid('接管回复与所选键盘、固件或档位不匹配');
    if(op==='armConnectionWake'){
      const w=v.connectionWake;
      if(!exact(w,['mainBlackVerified','sideMuted','sideIndicatorObserved','allLightsBlack','paletteExposureRequired'])||Object.values(w).some(v=>typeof v!=='boolean')||
        !w.mainBlackVerified||!w.sideMuted||!w.allLightsBlack&&!w.sideIndicatorObserved)throw invalid('迎宾准备未确认完整黑色键灯和侧灯设置');
    }
  }else if(op==='nativeLighting'||op==='nativeSnapshot'){
    const p=getKeyboardProfile(expected.modelId);
    if(expected.modelId!=='kick75'||!exact(v,['verified','changed','state','colors'])||v.verified!==true||typeof v.changed!=='boolean'||op==='nativeSnapshot'&&v.changed!==false||
      !Array.isArray(v.state)||v.state.length!==17||!v.state.every(byte)||v.state[0]<1||v.state[0]>20||v.state[1]>100||v.state[2]>4||
      !Array.isArray(v.colors)||v.colors.length!==(p.keyCount+p.sideCount)*3||!v.colors.every(byte))throw invalid('内置灯效独立读回无效');
  }else if(op==='paint'){
    if(!exact(v,['painted','skipped','readback'])||v.painted!==getKeyboardProfile(expected.modelId).keyCount||
      typeof v.skipped!=='boolean'||typeof v.readback!=='boolean')throw invalid('绘图确认无效');
  }else if(op==='side'){
    if(!exact(v,['updated'])||v.updated!==true)throw invalid('侧灯确认无效');
  }else if(op==='restore'){
    if(!exact(v,['verified','noMutation','archived'])||typeof v.verified!=='boolean'||typeof v.noMutation!=='boolean'||
      v.verified===v.noMutation||v.archived!==true)throw invalid('恢复未取得有效完成证明');
  }else if(op==='heartbeat'){
    if(!exact(v,['alive'])||v.alive!==true)throw invalid('心跳确认无效');
  }else if(op==='quit'){
    if(!exact(v,['quitting','lightingRestored','noMutation'])||v.quitting!==true||v.lightingRestored!==true||
      typeof v.noMutation!=='boolean')throw invalid('退出未确认恢复完成');
  }
  return structuredClone(v);
}
const validProfiles=v=>Array.isArray(v)&&v.length<=2&&v.every((p,i)=>[0,1].includes(p)&&(i===0||v[i-1]<p));
const validPending=v=>exact(v,['lightingProfiles','boardSleep','keymapProfiles'])&&validProfiles(v.lightingProfiles)&&validProfiles(v.keymapProfiles)&&typeof v.boardSleep==='boolean';
function validKeyPart(v){
  if(!object(v))return false;
  if(v.status!=='restored')return validPart(v);
  const c=v.completion;
  return exact(v,['status','completion'])&&exact(c,['verified','noMutation','archived','restoredKeys','externalChangesPreserved'])&&
    c.verified===true&&c.archived===true&&typeof c.noMutation==='boolean'&&typeof c.externalChangesPreserved==='boolean'&&
    Number.isInteger(c.restoredKeys)&&c.restoredKeys>=0&&c.restoredKeys<=12&&(!c.noMutation||c.restoredKeys===0);
}
function validPart(v,sleep=false){
  if(!object(v))return false;
  if(v.status==='notNeeded')return exact(v,['status']);
  if(v.status==='restored')return exact(v,['status','completion'])&&(sleep
    ?exact(v.completion,['supported','restored','noMutation','archived','preservedExternalChange'])&&Object.values(v.completion).every(x=>typeof x==='boolean')&&v.completion.supported&&v.completion.restored&&v.completion.archived
    :exact(v.completion,['verified','noMutation','archived'])&&typeof v.completion.verified==='boolean'&&typeof v.completion.noMutation==='boolean'&&v.completion.verified!==v.completion.noMutation&&v.completion.archived===true);
  return v.status==='failed'&&exact(v,['status','error'])&&exact(v.error,['code','message'])&&typeof v.error.code==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(v.error.code)&&typeof v.error.message==='string'&&v.error.message.length<=4096;
}
export function readLightingLines(input,onMessage,onError) {
  return readJsonLines(input,onMessage,onError,{maxLineBytes:NATIVE_LIGHTING.maxLineBytes,validate:validateLightingMessage,invalid});
}
