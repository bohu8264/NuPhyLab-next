import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readJsonLines} from './native-jsonl.mjs';
import {validateAudioFeature} from '../shared/audio-reactive.mjs';
import {isKeyboardModel} from '../shared/keyboard-models.mjs';
import {TYPING_KEYS} from '../shared/trigger.mjs';
import contract from '../shared/contracts/windows-desktop-io-v2.json' with {type:'json'};
const codes=new Set(TYPING_KEYS.map(k=>k.code).filter(code=>code!=='Fn'));
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const invalid=message=>fail('IO_PROTOCOL_ERROR',message);

// This child can be stopped independently: it has no keyboard output or journal.
// Raw Input is restricted to lighting triggers and never signs AI gestures.
export class WindowsDesktopIO extends EventEmitter {
  constructor({command,args=[],spawnProcess=spawn}={}){
    super();Object.assign(this,{command,args,spawnProcess});this.child=null;this.pending=new Map();this.id=0;this.sequence=0;
    this.tail=Promise.resolve();this.sessionId=randomUUID();this.phase='created';this.capabilities={audio:false,globalKeys:false,sensitiveKeys:false,orderedKeyEvents:false};
    this.audioSignature='';this.audioDesired=null;this.audioSync=null;this.failure=null;this.shutdown=null;
    this.queued=0;this.heldKeys=new Set();this.keysStarting=null;
  }
  status(){return {available:this.phase==='ready',capabilities:{...this.capabilities},reasonCode:this.failure?.code??null};}
  async start(){
    if(this.shutdownRequested)throw fail('IO_CLOSED','采集服务正在退出');
    if(this.starting)return this.starting;
    if(this.phase!=='created')throw this.failure??fail('IO_CLOSED','原生采集进程已关闭');
    this.phase='starting';
    this.starting=(async()=>{
      const child=this.spawnProcess(this.command,this.args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_OPTIONS:undefined,NODE_PATH:undefined}});this.child=child;
      child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
      child.on('error',()=>this.abort(fail('IO_START_FAILED','无法启动 Windows 按键和声音服务')));
      child.on('close',(code,signal)=>{
        this.ended=true;clearInterval(this.heartbeat);
        if(code!==0||signal||this.phase!=='closing'||!this.shutdown)this.abort(fail('IO_EXIT_FAILED','Windows 采集服务未确认停止'));
        else{this.phase='closed';for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(fail('IO_CLOSED','采集服务已关闭'));}this.pending.clear();}
        this.emit('closed',{verified:this.phase==='closed'});
      });
      readJsonLines(child.stdout,v=>this.receive(v),e=>this.abort(e),{maxLineBytes:32768,validate:v=>{if(!object(v))throw invalid('采集回复无效');return v;},invalid});
      const hello=await this.send('hello',{protocolVersion:contract.protocolVersion,sessionId:this.sessionId});
      if(hello.protocolVersion!==contract.protocolVersion||hello.implementation!=='windows-desktop-io'||hello.platform!=='win32'||hello.sessionId!==this.sessionId||
        !object(hello.capabilities)||Object.keys(hello.capabilities).length!==4||typeof hello.capabilities.audio!=='boolean'||
        typeof hello.capabilities.globalKeys!=='boolean'||hello.capabilities.sensitiveKeys!==false||hello.capabilities.orderedKeyEvents!==true)throw invalid('Windows 采集服务版本或能力不匹配');
      this.capabilities={...hello.capabilities};this.phase='ready';
      this.heartbeat=setInterval(()=>this.request('heartbeat').catch(e=>this.abort(e)),1000);this.heartbeat.unref();return this.status();
    })().catch(e=>{this.abort(e);throw e;});
    return this.starting;
  }
  receive(value){
    if(Object.hasOwn(value,'event')){
      if(value.sessionId!==this.sessionId||!Number.isSafeInteger(value.eventSequence)||value.eventSequence!==this.sequence+1||Object.hasOwn(value,'id'))throw invalid('采集事件的会话或顺序无效');
      this.sequence=value.eventSequence;
      if(value.event==='shutdownComplete'){
        if(this.phase!=='closing'||value.audioStopped!==true||value.keysStopped!==true||this.shutdown)throw invalid('采集服务未确认停止');
        this.shutdown=true;return;
      }
      if(this.phase==='failed'||this.phase==='closing')return;
      if(value.event==='audioFeature'){
        if(typeof value.session!=='string'||!['listening','error'].includes(value.status))throw invalid('声音特征事件无效');
        if(value.status==='listening')validateAudioFeature(value);
        else if(value.error!=='systemCapture'||typeof value.reasonCode!=='string')throw invalid('声音错误事件无效');
        if(value.session===this.audioDesired?.session){
          // A failed capture cannot resume from queued samples or its late
          // start acknowledgement. Keep the signature until stop is verified.
          if(value.status==='error')this.audioDesired=null;
          this.emit('audio',{session:value.session,status:value.status,
            ...(value.status==='listening'?validateAudioFeature(value):{error:value.error})});
        }
      }else if(value.event==='key'){
        if(value.source!=='windowsRawInput'||value.sensitiveKeys!==false||!isKeyboardModel(value.modelId)||!uuid(value.monitorId)||!codes.has(value.code)||!['down','up'].includes(value.phase))throw invalid('按键观察事件无效');
        if(this.keysStarting?.id===value.monitorId&&this.keysStarting.model===value.modelId){
          if(this.keysStarting.events.length>=contract.maxStartingKeys)throw invalid('启动期间按键过多，监听已停止');
          this.keysStarting.events.push({value,at:performance.now()});
        }else this.deliverKey(value);
      }else if(value.event==='keysReset'){
        if(!isKeyboardModel(value.modelId)||!uuid(value.monitorId)||!contract.keyResetReasons.includes(value.reasonCode))throw invalid('按键来源变化事件无效');
        if(value.monitorId===this.keysMonitor&&value.modelId===this.keysRequestedModel){this.clearKeys();this.emit('keysReset',{reasonCode:value.reasonCode});}
      }
      else if(value.event==='systemSuspend'){this.audioDesired=null;this.audioSignature='null';this.clearKeys();this.emit('suspend');}
      else throw invalid('未知采集事件');
      return;
    }
    const p=this.pending.get(value.id);
    if(!p||typeof value.ok!=='boolean'||(value.ok?!object(value.result):!object(value.error)||typeof value.error.code!=='string'||typeof value.error.message!=='string'))throw invalid('采集回复编号或内容无效');
    this.pending.delete(value.id);clearTimeout(p.timer);
    if(value.ok)p.resolve(value.result);else p.reject(fail(value.error.code,value.error.message));
  }
  abort(error){
    if(this.phase==='closed'||this.phase==='failed')return;
    this.failure=error;this.phase='failed';clearInterval(this.heartbeat);this.clearKeys();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    this.child?.stdin.end();this.emit('failure',error);
    // This helper owns neither device settings nor recovery records.
    if(this.child&&!this.ended)this.child.kill();
  }
  send(op,args={}){
    if(!Object.hasOwn(contract.operations,op)||!object(args)||Object.keys(args).some(k=>!contract.operations[op].includes(k)))return Promise.reject(invalid('采集命令或参数无效'));
    if(this.phase==='failed'||!this.child||this.ended)return Promise.reject(this.failure??fail('IO_CLOSED','采集服务已关闭'));
    if(this.pending.size>=16)return Promise.reject(fail('IO_QUEUE_FULL','采集请求过多'));
    const id=++this.id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.abort(fail('IO_TIMEOUT','Windows 采集服务响应超时')),8000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,op,...args})+'\n',e=>{if(e)this.abort(fail('IO_PIPE','Windows 采集通道已关闭'));});
    });
  }
  request(op,args={}){
    if(op==='hello'||!Object.hasOwn(contract.operations,op)||!object(args)||Object.keys(args).some(k=>!contract.operations[op].includes(k)))return Promise.reject(invalid('采集命令或参数无效'));
    if(this.queued>=contract.maxPending)return Promise.reject(fail('IO_QUEUE_FULL','采集请求过多'));
    this.queued++;
    if(op==='stopKeys')this.clearKeys();
    const run=async()=>{await this.start();if(this.phase!=='ready')throw this.failure??fail('IO_CLOSED','采集服务正在退出');return this.send(op,args);};
    const p=this.tail.then(run,run).finally(()=>{this.queued--;});this.tail=p.catch(()=>{});return p;
  }
  async monitorKeys(modelId,selected){
    if(!isKeyboardModel(modelId)||!Array.isArray(selected)||selected.some(c=>!codes.has(c)))throw invalid('按键选择无效');
    this.clearKeys();this.keysMonitor=randomUUID();this.keysRequestedModel=selected.length?modelId:null;
    if(!selected.length)return this.request('stopKeys');
    const monitorId=this.keysMonitor;
    const starting={id:monitorId,model:modelId,events:[]};this.keysStarting=starting;
    try{
      const result=await this.request('monitorKeys',{modelId,codes:[...new Set(selected)],monitorId});
      if(result.monitoring!==true||result.suppressing!==false||result.sensitiveKeys!==false)throw invalid('按键观察能力无效');
      if(this.keysRequestedModel!==modelId||this.keysMonitor!==monitorId||this.keysStarting!==starting)throw fail('IO_SOURCE_CHANGED','键盘来源已改变，请重新启用触发');
      if(starting.events.some(e=>performance.now()-e.at>contract.maxStartingKeyAgeMs))throw invalid('启动期间按键已过期，请重新启用触发');
      this.keysModel=modelId;this.keysCodes=new Set(selected);this.keysStarting=null;
      for(const {value} of starting.events)this.deliverKey(value);
      return result;
    }catch(error){if(this.keysMonitor===monitorId)this.clearKeys();if(error.code==='IO_PROTOCOL_ERROR')this.abort(error);throw error;}
  }
  clearKeys(){this.keysModel=null;this.keysCodes=null;this.keysMonitor=null;this.keysRequestedModel=null;this.keysStarting=null;this.heldKeys.clear();}
  deliverKey(value){
    if(this.keysModel!==value.modelId||this.keysMonitor!==value.monitorId||!this.keysCodes?.has(value.code))return;
    if(value.phase==='down'){if(this.heldKeys.has(value.code))return;this.heldKeys.add(value.code);}
    else if(!this.heldKeys.delete(value.code))return;
    this.emit('key',{modelId:value.modelId,code:value.code,phase:value.phase,source:value.source});
  }
  syncAudio(capture){
    this.audioDesired=capture?.enabled?{session:capture.session,source:capture.source,deviceId:capture.deviceId??''}:null;
    if(this.audioSync)return this.audioSync;
    this.audioSync=(async()=>{for(;;){
      const desired=this.audioDesired,signature=JSON.stringify(desired);
      if(signature===this.audioSignature)return;
      if(this.audioSignature&&this.audioSignature!=='null'){
        const stopped=await this.request('stopAudio');
        if(stopped.stopped!==true){const error=invalid('声音采集停止未确认');this.abort(error);throw error;}
      }
      this.audioSignature='null';
      if(JSON.stringify(this.audioDesired)!==signature)continue;
      if(desired){
        const started=await this.request('startAudio',desired);
        if(started.started!==true||started.session!==desired.session){const error=invalid('声音采集启动会话未确认');this.abort(error);throw error;}
      }
      this.audioSignature=signature;
    }})().finally(()=>{this.audioSync=null;});return this.audioSync;
  }
  async restart(){
    if(this.phase!=='failed'||!this.ended||this.closing||this.shutdownRequested)throw fail('IO_RESTART_UNAVAILABLE','采集服务尚未结束，不能重启');
    await this.audioSync?.catch(()=>{});await this.tail;
    if(this.shutdownRequested)throw fail('IO_CLOSED','采集服务正在退出');
    this.child=null;this.starting=null;this.ended=false;this.id=0;this.sequence=0;this.sessionId=randomUUID();this.failure=null;this.shutdown=null;this.phase='created';
    this.audioDesired=null;this.audioSignature='';this.audioSync=null;this.clearKeys();
    this.capabilities={audio:false,globalKeys:false,sensitiveKeys:false,orderedKeyEvents:false};return this.start();
  }
  close(){
    this.shutdownRequested=true;
    if(this.closing)return this.closing;
    this.closing=(async()=>{
      clearInterval(this.heartbeat);this.audioDesired=null;this.clearKeys();
      if(this.phase==='created'){this.phase='closed';return;}
      if(this.phase==='failed'){
        // This child has no settings, journal or spawned descendants. Confirm
        // actual process/pipe closure; never confuse this with a HID receipt.
        if(!this.ended){
          const ended=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(fail('IO_STOP_TIMEOUT','采集进程结束尚未确认')),10000);
            this.once('closed',()=>{clearTimeout(timer);resolve();});});
          await ended;
        }
        await this.tail;this.phase='closed';this.captureTerminated=true;return;
      }
      await this.audioSync?.catch(()=>{});await this.tail;
      clearInterval(this.heartbeat);
      this.phase='closing';
      const closed=new Promise((resolve,reject)=>{this.once('closed',r=>r.verified?resolve():reject(this.failure));});
      closed.catch(()=>{});
      const timer=setTimeout(()=>this.abort(fail('IO_STOP_TIMEOUT','Windows 采集服务停止超时')),10000);
      try{await this.send('quit');await closed;}finally{clearTimeout(timer);}
    })();return this.closing;
  }
}
