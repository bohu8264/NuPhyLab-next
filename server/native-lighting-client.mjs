import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {getKeyboardProfile} from '../shared/keyboard-models.mjs';
import {helperProcessEnvironment} from './native-hold-env.mjs';
import {NATIVE_LIGHTING as C,selection,lightingError as error,encodeLightingRequest,
  validateLightingHello,validateLightingResult,readLightingLines} from './native-lighting-contract.mjs';

const deferred=()=>{
  let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  promise.catch(()=>{});return {promise,resolve,reject};
};
const clock={now:()=>Date.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)};
const color=value=>{
  if(typeof value!=='string'||!/^#[0-9a-f]{6}$/i.test(value))throw error('INVALID_COLORS','颜色必须使用六位十六进制格式');
  return [1,3,5].map(i=>parseInt(value.slice(i,i+2),16));
};
const armOperations=['arm','armNative','armConnectionWake'];
// Explicitly constructed by trusted backend code; discovery stays read-only.
export class NativeLightingClient extends EventEmitter {
  constructor(launch,{spawnProcess=spawn,scheduler=clock}={}) {
    super();
    const {command,args=[],backend,modelId,lightingProfile}=launch;
    if(typeof command!=='string'||!path.isAbsolute(command)||command.includes('\0')||
      !Array.isArray(args)||args.some(v=>typeof v!=='string'||v.includes('\0'))||
      !['simulated','windows-hid'].includes(backend))throw new TypeError('Invalid lighting controller launch');
    this.launch={command,args:[...args],backend};this.expected=selection(modelId,lightingProfile);
    this.expectedFirmwareVersion=launch.firmwareVersion??(getKeyboardProfile(modelId).windowsQualifiedFirmware??getKeyboardProfile(modelId).qualifiedFirmware);
    if(typeof this.expectedFirmwareVersion!=='string'||!/^\d{1,3}(?:\.\d{1,5}){3}$/.test(this.expectedFirmwareVersion))throw new TypeError('Invalid lighting firmware expectation');
    this.spawnProcess=spawnProcess;this.clock=scheduler;this.sessionId=randomUUID();
    this.phase='created';this.child=null;this.serial=0;this.epoch=0;this.lease=null;this.lastLease=null;this.maxLease=0;
    this.device=null;this.sleep=null;this.leasePurpose=null;this.connectionWakePreparation=null;this.pending=new Map();this.queue=[];this.current=null;
    this.ready=deferred();this.finished=deferred();this.handshake=null;this.shutdown=null;this.eventSequence=0;
    this.closeRequested=false;this.quitSent=false;this.quitAck=null;this.ended=false;
    this.fatal=null;this.operationFailure=null;this.heartbeatTimer=null;this.closeTimer=null;this.heartbeatPending=false;
    this.heartbeat={sent:0,acknowledged:0,lastAck:null};this.restoration=null;this.diagnostics='';this.exitStatus=null;
  }
  status() {
    return structuredClone({phase:this.phase,backend:this.launch.backend,sessionId:this.sessionId,leaseId:this.lease,
      device:this.device,boardSleepLease:this.sleep,leasePurpose:this.leasePurpose,connectionWakePreparation:this.connectionWakePreparation,pending:this.pending.size+this.queue.length,
      heartbeat:this.heartbeat,restoration:this.restoration,error:this.fatal||this.operationFailure
        ?{code:(this.fatal||this.operationFailure).code,message:(this.fatal||this.operationFailure).message}:null});
  }
  shutdownEvidence() {
    if(this.ended&&!this.child&&this.phase==='closed')return {verified:true,recoveryPending:false,noMutation:true};
    // An action may fail while its independently verified rollback succeeds.
    // Keep rejecting that action; application exit can still use the bound
    // cleanup receipt after the process and its pipes have fully closed.
    const verified=this.ended&&this.exitStatus?.signal===null&&!this.fatal&&
      !!this.handshake&&!!this.shutdown&&this.shutdown.lightingRestored&&!this.shutdown.recoveryPending&&
      (this.exitStatus.code===0||this.exitStatus.code===1&&!!this.operationFailure);
    return {verified:!!verified,recoveryPending:!verified,noMutation:!!verified&&this.shutdown.noMutation===true};
  }
  notify() {this.emit('state',this.status());}
  start() {
    if(['closing','closed','failed'].includes(this.phase))return Promise.reject(error('LIGHTING_CLIENT_CLOSED','灯光客户端已停止，请检查恢复状态'));
    const epoch=this.epoch;
    if(!this.child){
      this.phase='starting';
      let child;
      try{child=this.spawnProcess(this.launch.command,this.launch.args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env:helperProcessEnvironment()});}
      catch{this.abort(error('LIGHTING_START_FAILED','无法启动灯光控制器'));this.finish(null,null);return this.ready.promise;}
      this.child=child;
      readLightingLines(child.stdout,value=>this.receive(value),failure=>this.abort(failure));
      child.stderr.on('data',bytes=>{this.diagnostics=(this.diagnostics+bytes.toString()).slice(-4096);this.emit('diagnostic',bytes.toString());});
      child.stdin.on('error',()=>{if(!this.ended)this.abort(error('LIGHTING_PIPE_CLOSED','灯光控制输入已关闭'));});
      child.once('error',()=>this.abort(error('LIGHTING_START_FAILED','无法启动灯光控制器')));
      child.once('close',(code,signal)=>this.finish(code,signal));
      this.send('hello',{protocolVersion:C.protocolVersion},{kind:'hello'},C.handshakeTimeoutMs);
      this.notify();
    }
    return this.ready.promise.then(value=>{
      if(epoch!==this.epoch||['closing','closed','failed'].includes(this.phase))throw error('SESSION_CHANGED','灯光控制会话已经停止');
      return value;
    });
  }
  arm() { return this.armKind('arm'); }
  armConnectionWake() { return this.armKind('armConnectionWake'); }
  armNative() {
    if(this.expected.modelId!=='kick75')return Promise.reject(error('NATIVE_LIGHTING_UNSUPPORTED','此型号尚未开放内置灯效事务'));
    return this.armKind('armNative');
  }
  armKind(op) {
    return this.start().then(()=>{
      if(this.phase!=='ready')throw error('LIGHTING_ALREADY_ACTIVE','当前灯光事务尚未结束');
      this.phase='arming';this.notify();
      return this.enqueue(op,{...this.expected});
    });
  }
  recoveryStatus() { return this.maintenance('recoveryStatus'); }
  recoverExisting() { return this.maintenance('recoverExisting'); }
  maintenance(op) {
    return this.start().then(()=>{
      if(this.phase!=='ready')throw error('LIGHTING_ALREADY_ACTIVE','请先停止播放，再检查或恢复原设置');
      this.phase=op==='recoveryStatus'?'checkingRecovery':'recoveringExisting';this.notify();
      return this.enqueue(op,{...this.expected});
    });
  }
  paint(colors,{verify=false,...extra}={}) {
    try{
      if(this.phase!=='armed'||this.leasePurpose!=='perKey')throw error('NOT_ARMED','请先开启逐键灯光事务');
      const model=getKeyboardProfile(this.expected.modelId);
      if(!Array.isArray(colors)||![model.keyCount,model.canvasCount].includes(colors.length)||typeof verify!=='boolean'||Object.keys(extra).length)
        throw error('INVALID_COLORS','颜色数量或绘图选项无效');
      return this.enqueue('paint',{leaseId:this.lease,colors:colors.flatMap(color),verify});
    }catch(failure){return Promise.reject(failure);}
  }
  side(value,brightness=100) {
    try{
      if(this.phase!=='armed'||this.leasePurpose!=='perKey')throw error('NOT_ARMED','请先开启逐键灯光事务');
      if(!Number.isInteger(brightness)||brightness<0||brightness>100)throw error('INVALID_SIDE','侧灯亮度必须在 0 到 100 之间');
      return this.enqueue('side',{leaseId:this.lease,color:color(value),brightness});
    }catch(failure){return Promise.reject(failure);}
  }
  nativeLighting(config) {
    try {
      if(this.phase!=='armed'||this.leasePurpose!=='native')throw error('NOT_ARMED','请先开启内置灯效事务');
      if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(k=>!['mode','brightness','speed','color'].includes(k)))throw error('INVALID_NATIVE_LIGHTING','内置灯效参数无效');
      const args={leaseId:this.lease,mode:config.mode,brightness:config.brightness,speed:config.speed,color:config.color==null?null:color(config.color)};
      encodeLightingRequest(1,this.sessionId,'nativeLighting',args);
      return this.enqueue('nativeLighting',args);
    }catch(failure){return Promise.reject(failure);}
  }
  nativeSnapshot() {
    if(this.phase!=='armed'||this.leasePurpose!=='native')return Promise.reject(error('NOT_ARMED','当前没有内置灯效事务'));
    return this.enqueue('nativeSnapshot',{leaseId:this.lease});
  }
  restore() {
    if(this.phase!=='armed')return Promise.reject(error('NOT_ARMED','当前没有活动灯光事务'));
    this.phase='restoring';this.rejectQueue(error('SESSION_CHANGED','旧颜色已取消，正在恢复原灯光'));this.notify();
    return this.enqueue('restore',{leaseId:this.lease});
  }
  enqueue(op,args) {
    if(this.queue.length+(this.current?1:0)>=C.maxPending-1)
      return Promise.reject(error('LIGHTING_QUEUE_FULL','灯光请求过多，请等待当前操作完成'));
    const item={op,args,epoch:this.epoch,queued:this.clock.now(),done:deferred()};
    this.queue.push(item);this.pump();
    return item.done.promise.then(value=>{
      if(item.epoch!==this.epoch)throw error('SESSION_CHANGED','灯光控制会话已经停止，旧回复已丢弃');
      return value;
    });
  }
  pump() {
    if(this.current||this.closeRequested||this.fatal||this.operationFailure||this.shutdown||this.ended)return;
    while(this.queue.length){
      const item=this.queue.shift();
      if(item.epoch!==this.epoch||['paint','side','restore','nativeLighting','nativeSnapshot'].includes(item.op)&&item.args.leaseId!==this.lease){
        item.done.reject(error('SESSION_CHANGED','旧灯光事务已失效'));continue;
      }
      if(['paint','side','nativeLighting'].includes(item.op)&&this.clock.now()-item.queued>C.maxFrameAgeMs){
        item.done.reject(error('FRAME_EXPIRED','过期颜色已丢弃'));continue;
      }
      this.current=item;
      if(armOperations.includes(item.op))this.restoration={scope:'currentProcess',sessionId:this.sessionId,verified:false,pending:true};
      this.send(item.op,item.args,{kind:'normal',item},C.requestTimeoutMs);break;
    }
  }
  send(op,args,record,timeout) {
    if(this.ended||!this.child)return;
    const id=++this.serial;
    let line;
    try{line=encodeLightingRequest(id,this.sessionId,op,args);}catch(failure){record.item?.done.reject(failure);this.abort(failure);return;}
    record.op=op;
    record.timer=this.clock.setTimeout(()=>{
      const code=record.kind==='heartbeat'?'LIGHTING_HEARTBEAT_TIMEOUT':record.kind==='hello'?'LIGHTING_HANDSHAKE_TIMEOUT':'LIGHTING_REQUEST_TIMEOUT';
      this.abort(error(code,'灯光控制器未及时确认，已停止发送并请求恢复'));
    },timeout);
    this.pending.set(id,record);
    try{this.child.stdin.write(line,failure=>{if(failure&&!this.ended)this.abort(error('LIGHTING_PIPE_CLOSED','灯光控制输入已关闭'));});}
    catch{this.abort(error('LIGHTING_PIPE_CLOSED','灯光控制输入已关闭'));}
  }
  scheduleHeartbeat() {
    if(this.closeRequested||this.fatal||this.operationFailure||this.shutdown||this.ended)return;
    this.heartbeatTimer=this.clock.setTimeout(()=>{
      this.heartbeatTimer=null;
      if(this.closeRequested||this.fatal||this.operationFailure||this.shutdown||this.ended)return;
      if(!this.heartbeatPending){
        this.heartbeatPending=true;this.heartbeat.sent++;
        this.send('heartbeat',{}, {kind:'heartbeat'},C.heartbeatReplyTimeoutMs);
      }
    },C.heartbeatIntervalMs);
  }
  stopHeartbeat() {
    if(this.heartbeatTimer!==null)this.clock.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer=null;
  }
  receive(value) {
    if(this.ended)return;
    let handling=null;
    try{
      if(value.event){this.receiveShutdown(value);return;}
      if(this.shutdown)throw error('LIGHTING_PROTOCOL_ERROR','最终清理事件之后仍收到回复');
      if(this.fatal)return;
      const record=this.pending.get(value.id);
      if(!record)throw error('LIGHTING_PROTOCOL_ERROR','灯光回复编号不属于当前请求');
      handling=record;
      this.pending.delete(value.id);this.clock.clearTimeout(record.timer);
      if(!value.ok){
        const failure=error(value.error.code,value.error.message);
        if(record.kind==='normal'){
          this.current=null;record.item.done.reject(failure);
          if(value.error.code==='FRAME_EXPIRED'&&['paint','side','nativeLighting'].includes(record.op)){this.pump();return;}
          if(this.closeRequested&&value.error.code==='CONTROLLER_QUIT')return;
          this.operationFailure=failure;this.stop(failure);return;
        }
        throw failure;
      }
      if(record.kind==='hello'){
        this.handshake=validateLightingHello(value.result,this.sessionId,this.launch.backend);
        this.ready.resolve(structuredClone(this.handshake));
        if(this.closeRequested)this.sendQuit();
        else {this.phase='ready';this.scheduleHeartbeat();}
      }else{
        const result=validateLightingResult(record.op,value.result,{...this.expected,firmwareVersion:this.expectedFirmwareVersion});
        if(record.kind==='heartbeat'){
          this.heartbeatPending=false;this.heartbeat.acknowledged++;this.heartbeat.lastAck=this.clock.now();this.scheduleHeartbeat();
        }else if(record.kind==='quit')this.quitAck=result;
        else{
          const item=record.item;this.current=null;
          if(armOperations.includes(record.op)){
            if(result.leaseId<=this.maxLease)throw error('LIGHTING_PROTOCOL_ERROR','灯光控制器重复使用了旧租约');
            this.maxLease=this.lease=this.lastLease=result.leaseId;this.device=result.device;this.sleep=result.boardSleepLease;
            this.leasePurpose=record.op==='armNative'?'native':'perKey';
            this.connectionWakePreparation=record.op==='armConnectionWake'?result.connectionWake:null;
            if(!this.closeRequested)this.phase='armed';
            this.restoration={scope:'currentProcess',sessionId:this.sessionId,leaseId:this.lease,verified:false,pending:true};
          }else if(record.op==='restore'){
            this.restoration={scope:'currentProcess',sessionId:this.sessionId,leaseId:this.lease,verified:true,pending:false,noMutation:result.noMutation,source:'restore'};
            this.lease=null;this.device=null;this.sleep=null;this.leasePurpose=null;this.connectionWakePreparation=null;if(!this.closeRequested)this.phase='ready';
          }else if(['recoveryStatus','recoverExisting'].includes(record.op)){
            const pending=record.op==='recoveryStatus'?!!(result.pending.lightingProfiles.length||result.pending.boardSleep||result.pending.keymapProfiles.length):!result.complete;
            // A status read is never a restoration receipt.
            this.restoration={scope:'existingRecords',sessionId:this.sessionId,verified:record.op==='recoverExisting'&&result.complete,
              pending,noMutation:record.op==='recoveryStatus',source:record.op};
            if(!this.closeRequested)this.phase='ready';
          }
          item.done.resolve(result);this.pump();
        }
      }
      this.notify();
    }catch(failure){handling?.item?.done.reject(failure);this.abort(failure);}
  }
  receiveShutdown(value) {
    if(!this.handshake||value.sessionId!==this.sessionId||value.eventSequence!==this.eventSequence+1||this.shutdown)
      throw error('LIGHTING_PROTOCOL_ERROR','清理事件不属于当前已确认会话');
    if(this.quitSent&&!this.quitAck&&!this.fatal)throw error('LIGHTING_PROTOCOL_ERROR','最终清理事件缺少本次退出确认');
    this.shutdown=structuredClone(value);this.eventSequence=value.eventSequence;this.epoch++;
    this.stopHeartbeat();this.phase=this.fatal||this.operationFailure?'failed':'closing';
    this.restoration={scope:'currentProcess',sessionId:this.sessionId,leaseId:this.lastLease,
      verified:!this.fatal&&value.lightingRestored,pending:!!this.fatal||value.recoveryPending,
      noMutation:value.noMutation,reportedRestored:value.lightingRestored,source:'shutdown'};
    this.lease=null;this.device=null;this.sleep=null;this.leasePurpose=null;this.connectionWakePreparation=null;
    this.rejectQueue(error('LIGHTING_CLIENT_CLOSED','控制器已完成退出，未执行的旧请求已取消'));
    this.rejectPending(error('LIGHTING_CLIENT_CLOSED','控制器已结束本次会话'));
    this.notify();
  }
  rejectQueue(failure) {for(const item of this.queue.splice(0))item.done.reject(failure);}
  rejectPending(failure) {
    for(const record of this.pending.values()){
      this.clock.clearTimeout(record.timer);
      if(record.kind==='normal')record.item.done.reject(failure);
    }
    this.pending.clear();this.current=null;this.heartbeatPending=false;
  }
  stop(failure) {
    if(this.ended)return;
    this.epoch++;this.phase='failed';this.stopHeartbeat();this.rejectQueue(failure);this.rejectPending(failure);
    this.ready.reject(failure);
    // Never kill a possibly mutating helper. EOF leaves its independent
    // recovery owner alive; callers must inspect close failure/evidence.
    this.child?.stdin.end();this.notify();
  }
  abort(failure) {
    if(this.ended||this.fatal)return;
    this.fatal=failure;
    if(this.restoration)this.restoration={...this.restoration,verified:false,pending:true};
    this.stop(failure);
  }
  close() {
    if(this.ended)return this.finished.promise;
    if(!this.child&&this.phase==='created'){
      this.phase='closed';this.ended=true;this.epoch++;
      this.ready.reject(error('LIGHTING_CLIENT_CLOSED','客户端未启动即已关闭'));
      this.finished.resolve({closed:true,noLeaseRequested:true});return this.finished.promise;
    }
    if(this.closeRequested)return this.finished.promise;
    this.closeRequested=true;this.epoch++;this.stopHeartbeat();
    this.rejectQueue(error('LIGHTING_CLIENT_CLOSED','正在退出，未发送的旧颜色已取消'));
    this.closeTimer=this.clock.setTimeout(()=>{
      const failure=error('LIGHTING_CLOSE_TIMEOUT','恢复退出未及时完成，请保留原记录');
      this.abort(failure);this.finished.reject(failure);
    },C.requestTimeoutMs);
    if(!this.fatal&&!this.operationFailure){this.phase='closing';if(this.handshake)this.sendQuit();}
    else this.child?.stdin.end();
    this.notify();return this.finished.promise;
  }
  sendQuit() {
    if(this.quitSent||this.fatal||this.operationFailure||this.ended)return;
    this.quitSent=true;this.send('quit',{}, {kind:'quit'},C.requestTimeoutMs);
  }
  finish(code,signal) {
    if(this.ended)return;
    this.exitStatus={code,signal};
    this.ended=true;this.epoch++;this.stopHeartbeat();
    if(this.closeTimer!==null)this.clock.clearTimeout(this.closeTimer);
    const failure=this.fatal||this.operationFailure||
      (code!==0||signal?error('LIGHTING_EXIT_FAILED','灯光控制器异常退出'):
        !this.closeRequested?error('LIGHTING_UNEXPECTED_EXIT','灯光控制器意外结束'):
        !this.handshake||!this.quitAck||!this.shutdown?error('LIGHTING_CLEANUP_UNCONFIRMED','退出缺少有效确认'):
        !this.shutdown.lightingRestored||this.shutdown.recoveryPending?error('RESTORE_REQUIRED','退出前恢复未完成'):null);
    this.rejectPending(failure||error('LIGHTING_CLIENT_CLOSED','控制器已关闭'));this.rejectQueue(failure||error('LIGHTING_CLIENT_CLOSED','控制器已关闭'));
    if(failure){if(!this.fatal&&!this.operationFailure)this.fatal=failure;this.phase='failed';this.ready.reject(failure);this.finished.reject(failure);}
    else {this.phase='closed';this.finished.resolve({closed:true,sessionId:this.sessionId,restoration:structuredClone(this.restoration)});}
    this.notify();this.emit('closed',{code,signal,...this.status()});
  }
}
