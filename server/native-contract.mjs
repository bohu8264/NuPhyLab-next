import {readJsonLines} from './native-jsonl.mjs';
import contract from '../shared/contracts/native-readonly-v1.json' with {type:'json'};
import {getKeyboardProfile,isKeyboardModel,getLightingReadLength,getSleepReadLength} from '../shared/keyboard-models.mjs';
import {validKeymapSnapshot} from '../shared/function-keymap.mjs';

export const NATIVE_READONLY=Object.freeze({...contract,operations:Object.freeze([...contract.operations]),capabilities:Object.freeze({...contract.capabilities})});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>Number.isSafeInteger(value)&&value>0;
export const bridgeError=(code,message)=>Object.assign(new Error(message),{code});
const invalid=message=>bridgeError('BRIDGE_PROTOCOL_ERROR',message);

export function encodeNativeRequest(id,op,args={}) {
  if(!validId(id)||!object(args)||Object.keys(args).some(key=>key==='id'||key==='op'))
    throw bridgeError('BRIDGE_REQUEST_INVALID','桥接命令格式无效');
  if(op!=='hello'&&!NATIVE_READONLY.operations.includes(op))
    throw bridgeError('WINDOWS_PROBE_ONLY','Windows 预览版尚未开放此键盘操作');
  if(op!=='hello'&&Object.keys(args).length)
    throw bridgeError('BRIDGE_REQUEST_INVALID','只读桥接命令不接受额外参数');
  const text=JSON.stringify({id,op,...args})+'\n';
  if(Buffer.byteLength(text,'utf8')>NATIVE_READONLY.maxLineBytes)
    throw bridgeError('BRIDGE_REQUEST_INVALID','桥接命令超过 32 KiB 限制');
  return text;
}

export function validateHello(value,sessionId) {
  if(!object(value)||value.protocolVersion!==NATIVE_READONLY.protocolVersion||
    value.implementation!==NATIVE_READONLY.implementation||value.platform!==NATIVE_READONLY.platform||
    typeof value.implementationVersion!=='string'||!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.implementationVersion)||
    value.sessionId!==sessionId||value.readOnly!==true||value.maxLineBytes!==NATIVE_READONLY.maxLineBytes||
    !object(value.capabilities)||Object.keys(value.capabilities).length!==Object.keys(NATIVE_READONLY.capabilities).length||
    Object.entries(NATIVE_READONLY.capabilities).some(([key,available])=>value.capabilities[key]!==available))
    throw bridgeError('BRIDGE_PROTOCOL_MISMATCH','键盘桥接版本或能力不匹配，请重新准备 Windows 应用文件');
  return {protocolVersion:value.protocolVersion,implementation:value.implementation,implementationVersion:value.implementationVersion,
    platform:value.platform,sessionId,readOnly:true,capabilities:{...value.capabilities}};
}

export function validateNativeMessage(value) {
  if(!object(value))throw invalid('桥接回复不是有效对象');
  if(Object.hasOwn(value,'event')){
    if(Object.hasOwn(value,'id')||!['disconnected','shutdownComplete'].includes(value.event)||
      !validId(value.eventSequence)||typeof value.sessionId!=='string')throw invalid('桥接事件格式无效');
    if(value.event==='disconnected'&&value.needsRestore!==false)throw invalid('只读桥接报告了未声明的恢复状态');
    if(value.event==='shutdownComplete'&&[value.noMutation,value.lightingRestored,value.keysRestored].some(flag=>flag!==true))
      throw invalid('只读桥接未确认正常清理');
  }else{
    if(!validId(value.id)||typeof value.ok!=='boolean')throw invalid('桥接回复编号或结果标记无效');
    if(value.ok?(!object(value.result)||Object.hasOwn(value,'error')):
      (!object(value.error)||typeof value.error.code!=='string'||!value.error.code||typeof value.error.message!=='string'||Object.hasOwn(value,'result')))
      throw invalid('桥接回复内容无效');
  }
  return value;
}

export function validateReadonlyResult(op,result) {
  if(op==='keymapSnapshot'&&!validKeymapSnapshot(result))throw invalid('功能键读取结果与型号、档位或只读范围不匹配');
  if(['connect','status'].includes(op)&&Object.hasOwn(result,'identityQualification')){
    const identity=result.identityQualification;
    if(!object(identity)||Object.keys(identity).length!==3||!['unverified','candidate','qualified'].includes(identity.status)||
      identity.source!==(identity.status==='unverified'?'none':'embeddedUsbSerial')||
      (identity.status==='qualified'?identity.reasonCode!==null:typeof identity.reasonCode!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(identity.reasonCode)))
      throw invalid('键盘唯一身份的原生证据格式无效');
  }
  if(['connect','status','disconnect'].includes(op)&&
    (result.readOnly!==true||typeof result.connected!=='boolean'||result.armed!==false||result.recoveryPending===true||result.needsRestore===true||
      (Object.hasOwn(result,'capabilities')&&!object(result.capabilities))||
      Object.entries(result.capabilities??{}).some(([key,value])=>typeof value!=='boolean'||value===true&&key!=='readOnlyProbe')||
      op==='connect'&&(result.connected!==true||result.identified!==true)||op==='disconnect'&&result.connected!==false))
    throw invalid('桥接回复包含未开放的键盘能力');
  if(['restore','restoreKeys','restoreFunctionKey'].includes(op)&&
    (result.noMutation!==true||result.restored!==true||result.verified!==true))
    throw invalid('只读桥接未确认没有修改键盘');
  if(op==='quit'&&(result.noMutation!==true||result.quitting!==true))throw invalid('只读桥接未确认退出');
  if(op==='lightingSnapshot'){
    const model=isKeyboardModel(result.modelId)?getKeyboardProfile(result.modelId):null;
    const length=getLightingReadLength(result.modelId,result.firmwareVersion);
    if(!model||length===null||![0,1].includes(result.lightingProfile)||
      result.ledCount!==model.keyCount+model.sideCount||result.readOnly!==true||result.noMutation!==true||result.restorationReady!==false||
      !Array.isArray(result.state)||result.state.length!==length||result.state.some(value=>!Number.isInteger(value)||value<0||value>255)||
      !Array.isArray(result.renderedColors)||result.renderedColors.length!==result.ledCount||result.renderedColors.some(color=>typeof color!=='string'||!/^#[a-f0-9]{6}$/i.test(color)))
      throw invalid('灯效读取结果与型号、固件或只读范围不匹配');
  }
  if(op==='sleepSnapshot'){
    const keys=['modelId','firmwareVersion','lightingProfile','enabled','state','readOnly','noMutation','restorationReady'];
    if(!object(result)||Object.keys(result).length!==keys.length||Object.keys(result).some(k=>!keys.includes(k))||
      getSleepReadLength(result.modelId,result.firmwareVersion)!==4||![0,1].includes(result.lightingProfile)||
      !Array.isArray(result.state)||result.state.length!==4||result.state.some(v=>!Number.isInteger(v)||v<0||v>255)||
      ![0,1].includes(result.state[0])||result.enabled!==(result.state[0]===1)||
      result.readOnly!==true||result.noMutation!==true||result.restorationReady!==false)
      throw invalid('休眠读取结果与型号、固件或只读范围不匹配');
  }
}

export function readNativeLines(input,onMessage,onError) {
  return readJsonLines(input,onMessage,onError,{maxLineBytes:NATIVE_READONLY.maxLineBytes,validate:validateNativeMessage,invalid});
}
