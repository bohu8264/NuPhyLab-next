import {Hardware} from './hardware.mjs';
import {NativeLightingClient} from './native-lighting-client.mjs';
import {getKeyboardProfile,isKeyboardModel} from '../shared/keyboard-models.mjs';
import {supportsAirConnectionWake} from './connection-wake.mjs';
import {windowsLightingPolicy} from '../shared/windows-lighting-firmware.mjs';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const emptyEvidence=()=>({verified:true,recoveryPending:false,noMutation:true});
// The read-only process discovers devices. A separately supervised native
// process alone owns lighting and its journal; it is never killed or retried.
export class WindowsHardware extends Hardware {
  constructor(launch,backup,{createLightingClient=options=>new NativeLightingClient(options),...options}={}) {
    super(launch,backup,options);
    if(this.bridgeProfile!=='windows-readonly-v1')throw new TypeError('Windows discovery requires its read-only protocol');
    this.createLightingClient=createLightingClient;this.probeState=null;this.lighting=null;
    this.lightingFailure=null;this.lastLightingWire=null;this.lightingPurpose=null;this.shuttingDown=false;
    this.lightingClose=null;this.closePromise=null;this.evidence=emptyEvidence();
    this.recoveryView={status:'unchecked'};this.recoveryKey=null;this.recoveryViewKey=null;this.recoveryNeedsAttention=false;
    this.pendingProfiles=new Set();this.pendingSleep=false;this.pendingKeyProfiles=new Set();
    this.unconfirmedOwnership=false;
    this.inspectionEpoch=0;
  }
  lightingAvailable() {
    const p=this.probeState,m=isKeyboardModel(p?.modelId)?getKeyboardProfile(p.modelId):null;
    return !!(m&&p.connected===true&&p.identified===true&&windowsLightingPolicy(p.modelId,p.firmwareVersion)!==null&&
      p.identityQualification?.status==='qualified'&&p.identityQualification.source==='embeddedUsbSerial'&&
      [0,1].includes(p.lightingProfile)&&!this.lightingFailure&&!this.recoveryNeedsAttention&&!this.shuttingDown);
  }
  decorate() {
    // Displayed results outlive the one-shot restore authorization, but must
    // never outlive the connection/profile they describe. Pending obligations
    // are retained independently of this presentation scope.
    if(this.recoveryViewKey&&this.recoveryViewKey!==this.recoveryContext()){
      this.recoveryKey=null;this.recoveryViewKey=null;this.recoveryView={status:'unchecked'};
    }
    const available=this.lightingAvailable(),phase=this.lighting?.status();
    const pending=this.recoveryNeedsAttention||(phase?.restoration?.pending??this.lightingFailure!==null);
    const nativeAvailable=available&&this.probeState?.modelId==='kick75';
    this.state={...this.state,readOnly:!available,armed:phase?.phase==='armed'&&this.lightingPurpose!=='native',
      recoveryPending:pending,needsRestore:pending,
      ...(available?{errorCode:null,error:null}:{}),
      ...(this.lightingFailure?{errorCode:this.lightingFailure.code??'RESTORE_REQUIRED',error:this.lightingFailure.message}:{}),
      capabilities:{...(this.state.capabilities??{}),perKey:available,mainWholeZone:nativeAvailable,
        stockEffects:nativeAvailable,connectionWake:available,functionKeyAdaptation:false},
      windowsLighting:{available,connectionWakeReady:available,connectionWakePreparation:phase?.connectionWakePreparation??null,
        phase:phase?.phase??'not-started',purpose:this.lightingPurpose,restoration:phase?.restoration??null},
      windowsRecovery:structuredClone(this.recoveryView??{status:'unchecked'})};
  }
  updateState(value) {
    super.updateState(value);
    if(typeof value.connected==='boolean'&&value.readOnly===true){
      this.state.identityQualification=value.identityQualification??null;
      this.probeState=structuredClone(this.state);
    }
    this.decorate();
  }
  failed(error) {
    super.failed(error);this.probeState=null;
    this.state.identityQualification=null;
    this.recoveryKey=null;this.recoveryViewKey=null;this.recoveryView={status:'unchecked'};
    if(this.lighting&&!this.shuttingDown)this.retireLighting().catch(()=>{});
    this.decorate();
  }
  async connect(options) {
    if(this.lighting&&!['ready','closed'].includes(this.lighting.status().phase))await this.retireLighting();
    if(this.lighting?.status().phase==='closed'&&this.evidence.verified&&!this.evidence.recoveryPending)this.lighting=null;
    return super.connect(options);
  }
  async status() {
    const phase=this.lighting?.status().phase;
    if(this.lighting&&!['ready','closed'].includes(phase)&&!(phase==='failed'&&this.lightingExited)) {
      // Keep the probe off the owned USB handle. An unchanged frame checks
      // identity/settings/journals in core without replaying a color write.
      if(phase==='armed'&&!this.shuttingDown){
        if(this.lightingPurpose==='native')await this.readNative();
        else if(this.lastLightingWire)await this.lighting.paint(this.lastLightingWire);
      }
      this.decorate();return this.state;
    }
    const result=await super.status();this.decorate();return result;
  }
  async arm({connectionWake=false}={}) {
    return this.armKind('perKey',{connectionWake});
  }
  async armKind(purpose,{connectionWake=false}={}) {
    if(this.shuttingDown)throw failure('LIGHTING_CLIENT_CLOSED','应用正在恢复并退出');
    if(this.lighting?.status().phase==='armed'){
      if(connectionWake)throw failure('CONNECTION_WAKE_ALREADY_ACTIVE','当前灯光事务已开始，不重复播放迎宾灯效');
      if(this.lightingPurpose===purpose)return this.state;
      await this.restore();
    }
    await this.status();
    if(!this.lightingAvailable())throw failure('WINDOWS_LIGHTING_UNAVAILABLE','键盘唯一身份或固件尚未通过灯光检查');
    if(connectionWake&&!supportsAirConnectionWake(this.state))throw failure('CONNECTION_WAKE_UNSUPPORTED','此连接尚未通过迎宾灯效准备检查');
    if(purpose==='native'&&this.state.modelId!=='kick75')throw failure('NATIVE_LIGHTING_UNSUPPORTED','此型号尚未开放内置灯效事务');
    if(this.shuttingDown)throw failure('LIGHTING_CLIENT_CLOSED','应用正在恢复并退出');
    if(this.lighting?.status().phase==='ready'&&
      (this.lightingSelection.modelId!==this.state.modelId||this.lightingSelection.lightingProfile!==this.state.lightingProfile)) {
      await this.retireLighting();this.lighting=null;
    }
    if(!this.lighting)this.createOwner();
    this.lastLightingWire=null;this.evidence={verified:false,recoveryPending:true,noMutation:false};
    try {
      await (connectionWake?this.lighting.armConnectionWake():purpose==='native'?this.lighting.armNative():this.lighting.arm());
      this.lightingPurpose=purpose;
      if(connectionWake){
        this.lastLightingWire=Array(getKeyboardProfile(this.state.modelId).canvasCount).fill('#000000');
        this.lastPaintAcknowledgement={session:this.state.connectionSessionId,epoch:this.transportEpoch,signature:this.lastLightingWire.join(''),frameCommittedAt:Date.now()};
      }
      this.decorate();return this.state;
    }
    catch(error){this.lightingFailure=error;this.decorate();throw error;}
  }
  createOwner() {
      this.lightingPurpose=null;
      this.lightingSelection={modelId:this.state.modelId,lightingProfile:this.state.lightingProfile};
      this.lighting=this.createLightingClient({command:this.binary,args:[...this.binaryArgs,'--lighting'],
        backend:'windows-hid',modelId:this.state.modelId,lightingProfile:this.state.lightingProfile,firmwareVersion:this.state.firmwareVersion});
      // Remember ownership transitions even when no page polls the busy phase.
      this.inspectionEpoch++;let inspectionPhase=this.lighting.status().phase;
      this.lightingExited=false;
      this.lighting.on('closed',()=>{this.lightingExited=true;this.decorate();});
      this.lighting.on('diagnostic',detail=>this.emit('diagnostic',detail));
      this.lighting.on('state',state=>{
        if(state.phase!==inspectionPhase){this.inspectionEpoch++;inspectionPhase=state.phase;}
        if(state.phase==='failed'&&state.error)this.lightingFailure??=failure(state.error.code,state.error.message);
        this.decorate();
      });
  }
  recoveryContext() {
    const p=this.probeState;
    return p?.connected&&p.identified&&p.identityQualification?.status==='qualified'&&[0,1].includes(p.lightingProfile)
      ?JSON.stringify([p.connectionSessionId,this.transportEpoch,p.modelId,p.firmwareVersion??p.firmware,p.lightingProfile]):null;
  }
  async maintenanceOwner() {
    if(this.shuttingDown)throw failure('LIGHTING_CLIENT_CLOSED','应用正在退出');
    const phase=this.lighting?.status().phase;
    if(this.lighting&&!['created','ready','closed','failed'].includes(phase))throw failure('RECOVERY_BUSY','请先停止播放，再检查待恢复记录');
    if(this.lighting&&['closed','failed'].includes(phase)){
      await this.retireLighting().catch(()=>{});
      if(!this.lighting.ended)throw failure('RECOVERY_BUSY','原生进程仍在清理，请等待完成');
      if(this.evidence.recoveryPending){this.recoveryNeedsAttention=true;this.unconfirmedOwnership=true;}
      this.lighting=null;
    }
    await this.status();
    if(this.shuttingDown)throw failure('LIGHTING_CLIENT_CLOSED','应用正在退出');
    const key=this.recoveryContext();if(!key)throw failure('RECOVERY_IDENTITY_UNVERIFIED','请先连接并核对键盘的唯一身份');
    if(this.lighting&&(this.lightingSelection.modelId!==this.state.modelId||this.lightingSelection.lightingProfile!==this.state.lightingProfile)){
      await this.retireLighting().catch(()=>{});
      if(!this.lighting.ended)throw failure('RECOVERY_BUSY','原生进程仍在清理，请等待完成');
      this.lighting=null;
    }
    if(!this.lighting)this.createOwner();
    return key;
  }
  async checkRecovery() {
    const key=await this.maintenanceOwner();this.recoveryViewKey=key;this.recoveryView={status:'checking'};this.decorate();
    try{
      const result=await this.lighting.recoveryStatus();
      if(key!==this.recoveryContext())throw failure('RECOVERY_STATUS_CHANGED','连接已变化，请重新检查');
      const pending=result.pending.lightingProfiles.length>0||result.pending.boardSleep||result.pending.keymapProfiles.length>0;
      for(const p of result.pending.lightingProfiles)this.pendingProfiles.add(p);this.pendingSleep||=result.pending.boardSleep;
      for(const p of result.pending.keymapProfiles)this.pendingKeyProfiles.add(p);
      this.recoveryNeedsAttention=pending||this.pendingProfiles.size>0||this.pendingSleep||this.pendingKeyProfiles.size>0||this.unconfirmedOwnership;
      if(!pending&&this.recoveryNeedsAttention)throw failure('RECOVERY_EVIDENCE_MISSING','先前记录已不在，但尚未取得恢复证明，请保留现场');
      this.recoveryKey=key;this.recoveryViewKey=key;this.recoveryView={status:pending?'pending':'clear',...result};this.decorate();return result;
    }catch(error){this.recoveryViewKey=key;this.recoveryView={status:'failed',error:{code:error.code??'RECOVERY_FAILED',message:error.message}};this.decorate();throw error;}
  }
  async recoverExisting() {
    const previous=this.recoveryView,key=this.recoveryKey;
    if(this.shuttingDown||this.recoveryKey!==this.recoveryContext()||previous.status!=='pending'||!previous.canRestore||this.lighting?.status().phase!=='ready')
      throw failure('RECOVERY_CHECK_REQUIRED','请先重新检查当前键盘及档位的待恢复记录');
    this.recoveryView={...previous,status:'recovering'};this.decorate();
    try{
      const result=await this.lighting.recoverExisting();
      for(const p of result.completedCleanup.lightingProfiles)this.pendingProfiles.delete(p);
      if(result.lighting.status==='restored')this.pendingProfiles.delete(result.lightingProfile);
      if(result.functionKeys.status==='restored')this.pendingKeyProfiles.delete(result.lightingProfile);
      if(result.completedCleanup.boardSleep||result.boardSleep.status==='restored')this.pendingSleep=false;
      if(result.complete&&(this.pendingProfiles.size||this.pendingSleep||this.pendingKeyProfiles.size))throw failure('RECOVERY_EVIDENCE_MISSING','部分旧记录缺少恢复证明，不能报告全部完成');
      this.recoveryNeedsAttention=!result.complete;
      if(result.complete){this.lightingFailure=null;this.unconfirmedOwnership=false;}
      this.recoveryKey=null;this.recoveryViewKey=key;this.recoveryView={...previous,status:result.complete?'complete':'failed',pending:result.remaining,result};
      this.decorate();return result;
    }catch(error){this.recoveryKey=null;this.recoveryViewKey=key;this.recoveryNeedsAttention=true;this.recoveryView={...previous,status:'failed',error:{code:error.code??'RECOVERY_FAILED',message:error.message}};this.decorate();throw error;}
  }
  async paint(colors,options) {
    if(this.shuttingDown||this.lighting?.status().phase!=='armed'||this.lightingPurpose==='native')throw failure('NOT_ARMED','当前没有可用的逐键灯光事务');
    const wire=this.outputColors(colors,options),session=this.state.connectionSessionId,epoch=this.transportEpoch;
    try {
      const result=await this.lighting.paint(wire);
      this.lastLightingWire=[...wire];
      const old=this.lastPaintAcknowledgement,reused=result.skipped===true;
      const at=reused&&old?.session===session&&old.epoch===epoch&&old.signature===wire.join('')?old.frameCommittedAt:reused?null:Date.now();
      this.lastPaintAcknowledgement={session,epoch,signature:wire.join(''),frameCommittedAt:at};
      return {...result,frameCommittedAt:at,reusedCommittedFrame:reused};
    } catch(error){this.lightingFailure=error;this.decorate();throw error;}
  }
  request(op,args={}) {
    if(op==='nativeLighting')return (async()=>{
      // Validate before acquiring/restoring a lease. Invalid UI requests must
      // never disturb an existing work or create a recovery baseline.
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['mode','brightness','speed','color'].includes(k))||
        !Number.isInteger(args.mode)||args.mode<1||args.mode>20||!Number.isInteger(args.brightness)||args.brightness<0||args.brightness>100||
        !Number.isInteger(args.speed)||args.speed<0||args.speed>4||!(args.color===undefined||typeof args.color==='string'&&/^#[0-9a-f]{6}$/i.test(args.color)))
        throw failure('INVALID_NATIVE_LIGHTING','内置灯效参数无效');
      if(this.state.modelId!=='kick75')throw failure('NATIVE_LIGHTING_UNSUPPORTED','此型号尚未开放内置灯效事务');
      await this.armKind('native');
      try {return this.acceptNative(await this.lighting.nativeLighting(args));}
      catch(error){this.lightingFailure=error;this.decorate();throw error;}
    })();
    if(op==='readColors'&&this.lightingPurpose==='native')return this.readNative();
    if(['lightingSnapshot','sleepSnapshot','keymapSnapshot'].includes(op)&&
      (this.shuttingDown||this.lighting&&!['ready','closed'].includes(this.lighting.status().phase)))
      return Promise.reject(failure('INSPECTION_BUSY','请等待播放或恢复结束，再读取当前设置'));
    if(op==='side') {
      if(this.shuttingDown||this.lighting?.status().phase!=='armed'||this.lightingPurpose==='native')
        return Promise.reject(failure('WINDOWS_LIGHTING_OPERATION_UNAVAILABLE','此 Windows 灯光操作尚未开放'));
      if(args.restore===true)return (async()=>{
        // There is no unaudited partial restore command. Retire the complete
        // owned transaction, rearm from the verified original, then redraw
        // the last committed main frame without applying brightness twice.
        const wire=this.lastLightingWire?[...this.lastLightingWire]:null;
        await this.restore();await this.arm();
        if(wire){await this.lighting.paint(wire);this.lastLightingWire=wire;
          this.lastPaintAcknowledgement={session:this.state.connectionSessionId,epoch:this.transportEpoch,
            signature:wire.join(''),frameCommittedAt:Date.now()};}
        return {updated:true,wholeSessionRearmed:true};
      })();
      return this.lighting.side(args.color,args.brightness??100);
    }
    return super.request(op,args);
  }
  acceptNative(value) {
    const bytes=value.colors;
    const colors=Array.from({length:bytes.length/3},(_,i)=>'#'+bytes.slice(i*3,i*3+3).map(v=>v.toString(16).padStart(2,'0')).join(''));
    this.state.state=[...value.state];this.decorate();
    return {...value,colors};
  }
  async readNative() {
    if(this.shuttingDown||this.lighting?.status().phase!=='armed')throw failure('NOT_ARMED','内置灯效事务已经停止');
    try{return this.acceptNative(await this.lighting.nativeSnapshot());}
    catch(error){this.lightingFailure=error;this.decorate();throw error;}
  }
  async restore() {
    if(this.lightingFailure)throw this.lightingFailure;
    if(this.recoveryNeedsAttention&&this.lighting?.status().phase!=='armed')throw failure('RECOVERY_REQUIRED','旧记录尚未恢复，请先在恢复页面检查并处理');
    if(this.lighting?.status().phase==='armed') {
      try {const value=await this.lighting.restore();this.evidence={verified:true,recoveryPending:false,noMutation:value.noMutation};
        this.lastLightingWire=null;this.lightingPurpose=null;this.decorate();return value;}
      catch(error){this.lightingFailure=error;this.decorate();throw error;}
    }
    return {restored:true,verified:true,noMutation:true};
  }
  async retireLighting() {
    if(!this.lighting)return {closed:true,noLeaseRequested:true};
    try {
      const result=await this.lighting.close();
      this.evidence=this.lighting.shutdownEvidence();
      return result;
    } catch(error) {
      this.lightingFailure=error;
      this.evidence=this.lighting.shutdownEvidence();
      throw error;
    } finally {this.lastLightingWire=null;this.lightingPurpose=null;this.decorate();}
  }
  beginShutdown() {
    this.shuttingDown=true;
    if(!this.lightingClose){this.lightingClose=this.retireLighting();this.lightingClose.catch(()=>{});}
    this.decorate();return this.lightingClose;
  }
  shutdownEvidence() {return structuredClone(this.evidence);}
  async disconnect() {
    let failed;
    if(this.lighting) {
      try {await this.retireLighting();this.lighting=null;this.lightingFailure=null;this.evidence=emptyEvidence();}
      catch(error){failed=error;}
    }
    const result=await super.disconnect();if(failed)throw failed;return result;
  }
  close() {
    if(this.closePromise)return this.closePromise;
    const lighting=this.beginShutdown();
    this.closePromise=(async()=>{
      // The probe cannot own a lighting journal. Only the separate native
      // owner supplies restoration evidence, even while the probe exits.
      const results=await Promise.allSettled([lighting,super.close({restoreLighting:false})]);
      if(results[1].status==='rejected')throw results[1].reason;
      if(this.recoveryNeedsAttention||this.pendingProfiles.size||this.pendingSleep||this.pendingKeyProfiles.size||this.unconfirmedOwnership){this.evidence={verified:false,recoveryPending:true,noMutation:false};}
      if(!this.evidence.verified||this.evidence.recoveryPending)throw failure('RESTORE_REQUIRED','退出前尚未取得完整恢复确认，原记录已保留');
      return this.shutdownEvidence();
    })();
    return this.closePromise;
  }
}
