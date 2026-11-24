import {getLightingReadLength,getSleepReadLength,getKeymapReadCount} from '../shared/keyboard-models.mjs';
import {summarizeFunctionKeys} from '../shared/function-keymap.mjs';
import {inspectWindowsFunctionKeyPreparation} from '../shared/windows-function-key-preparation.mjs';
import {bridgeError,validateReadonlyResult} from './native-contract.mjs';

// Inspection is an in-memory observation, never a recovery journal or artwork.
class DeviceInspection {
  constructor(hardware,{now=Date.now,op,schema,errorCode,message,requireReadOnly=true}){
    this.hardware=hardware;this.now=now;this.receipt=null;
    this.op=op;this.schema=schema;this.errorCode=errorCode;this.message=message;
    this.requireReadOnly=requireReadOnly;
    hardware.on('disconnect',()=>{this.receipt=null;});
    hardware.on('disconnected',()=>{this.receipt=null;});
  }
  identity(){
    const h=this.hardware,state=h.state;
    if(state.connected!==true||state.identified!==true||this.requireReadOnly&&state.readOnly!==true||state.armed===true||
      typeof state.connectionSessionId!=='string'||![0,1].includes(state.lightingProfile))return null;
    return JSON.stringify([state.connectionSessionId,h.transportEpoch,h.inspectionEpoch??0,state.modelId,state.firmwareVersion??state.firmware,state.lightingProfile]);
  }
  snapshot(){
    if(!this.receipt||this.receipt.identity!==this.identity()){this.receipt=null;return null;}
    return structuredClone(this.receipt.value);
  }
  async read(){
    this.receipt=null;
    const identity=this.identity(),state=this.hardware.state;
    if(identity===null)throw bridgeError('DEVICE_NOT_FOUND','请先连接并识别要检查的键盘');
    const version=state.firmwareVersion??state.firmware;
    if(this.schema(state.modelId,version)===null)throw bridgeError(this.errorCode,this.message);
    const result=await this.hardware.request(this.op);
    validateReadonlyResult(this.op,result);
    if(identity!==this.identity()||result.modelId!==state.modelId||result.firmwareVersion!==version||result.lightingProfile!==state.lightingProfile)
      throw bridgeError('SNAPSHOT_SESSION_CHANGED','连接或档位已改变，本次读取结果已丢弃，请重新检查');
    const value={...result,capturedAt:this.now(),connectionSessionId:state.connectionSessionId};
    this.receipt={identity,value};return this.snapshot();
  }
}
export class KeymapInspection extends DeviceInspection {
  constructor(hardware,options={}){super(hardware,{...options,op:'keymapSnapshot',schema:getKeymapReadCount,requireReadOnly:false,
    errorCode:'KEYMAP_SCHEMA_UNVERIFIED',message:'此型号或固件的键位读取结构尚未核对，未读取或修改键位'});}
  identity(){
    const phase=this.hardware.lighting?.status().phase;
    if(phase&&!['ready','closed'].includes(phase))return null;
    const identity=super.identity();if(identity===null)return null;
    const h=this.hardware;
    return JSON.stringify([identity,h.state.identityQualification??null,h.recoveryNeedsAttention===true,h.recoveryView?.status??'unchecked',h.recoveryKey??null]);
  }
  snapshot(){
    const value=super.snapshot();if(!value)return null;
    const {capturedAt,connectionSessionId,...raw}=value;
    const h=this.hardware,q=h.state.identityQualification;
    // A completed recovery is not a fresh journal inspection. Only a clear
    // check still bound to this connection can describe checked originals.
    const recoveryStatus=h.recoveryNeedsAttention===true?'pending':h.recoveryView?.status==='failed'?'failed':
      h.recoveryView?.status==='pending'?'pending':h.recoveryView?.status==='clear'&&typeof h.recoveryKey==='string'&&
        h.recoveryKey===h.recoveryContext?.()?'clear':'unchecked';
    const preparation=inspectWindowsFunctionKeyPreparation(raw,{identityQualified:q?.status==='qualified'&&q.source==='embeddedUsbSerial',recoveryStatus});
    return {...summarizeFunctionKeys(raw),preparation,capturedAt,connectionSessionId};
  }
}
export class LightingInspection extends DeviceInspection {
  constructor(hardware,options={}){super(hardware,{...options,op:'lightingSnapshot',schema:getLightingReadLength,
    errorCode:'LIGHTING_SCHEMA_UNVERIFIED',message:'此固件的灯光结构尚未核对，未读取灯效，也未修改键盘'});}
}
export class SleepInspection extends DeviceInspection {
  constructor(hardware,options={}){super(hardware,{...options,op:'sleepSnapshot',schema:getSleepReadLength,
    errorCode:'SLEEP_SCHEMA_UNVERIFIED',message:'此型号或固件的休眠结构尚未核对，未读取休眠设置'});}
}
