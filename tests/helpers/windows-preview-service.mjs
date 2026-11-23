// Real service, storage and host-control lifecycle, with a pipe-only helper.
// No HID handle, real AI environment, user library or application window.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';

export async function previewServiceFixture(t,configuration={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'NuPhy Windows 测试 空格-'));
  const helper=path.join(directory,'测试 helper.mjs'),log=path.join(directory,'helper.jsonl');
  await writeFile(helper,`
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
import {NATIVE_READONLY} from ${JSON.stringify(new URL('../../server/native-contract.mjs',import.meta.url).href)};
import {NATIVE_LIGHTING} from ${JSON.stringify(new URL('../../server/native-lighting-contract.mjs',import.meta.url).href)};
import {windowsLightingPolicy,windowsBoardSleepSupported} from ${JSON.stringify(new URL('../../shared/windows-lighting-firmware.mjs',import.meta.url).href)};
import {getKeyboardProfile,getLightingReadLength,getSleepReadLength,getKeymapReadCount} from ${JSON.stringify(new URL('../../shared/keyboard-models.mjs',import.meta.url).href)};
const configuration=${JSON.stringify(configuration)},modelId=configuration.modelId??'air75-v3',model=getKeyboardProfile(modelId);
const log=value=>appendFileSync(${JSON.stringify(log)},JSON.stringify({...value,pid:process.pid})+'\\n');
log({event:'started'});
const input=createInterface({input:process.stdin});
const lighting=process.argv.includes('--lighting');
let sessionId=null;
let lease=0,mutated=false,finished=false,actionFailed=false,wakeArmed=false;
const originalState=[2,60,2,0,1,3,31,47,63,2,45,1,0,0,12,34,56];let nativeState=[...originalState];
let recoveryPending={lightingProfiles:configuration.recoveryPending?[1]:[],boardSleep:!!configuration.recoveryPending,keymapProfiles:configuration.keyRecoveryPending?[1]:[]};
function finishLighting(request){
  if(finished)return;finished=true;
  const restored=!configuration.failLightingRestore&&!recoveryPending.lightingProfiles.length&&!recoveryPending.boardSleep&&!recoveryPending.keymapProfiles.length;
  if(request)console.log(JSON.stringify(restored?{id:request.id,ok:true,result:{quitting:true,lightingRestored:true,noMutation:!mutated}}:{id:request.id,ok:false,error:{code:'RESTORE_REQUIRED',message:'isolated restoration failure'}}));
  log({event:'lightingClosed',restored});
  process.stdout.write(JSON.stringify({event:'shutdownComplete',sessionId,eventSequence:1,lightingRestored:restored,recoveryPending:!restored,noMutation:restored&&!mutated,reasonCode:restored?(actionFailed?'PAINT_TEST_FAILURE':null):'RESTORE_REQUIRED'})+'\\n',()=>process.exit(restored&&!actionFailed?0:1));
}
let connected=false;
const version=configuration.firmwareVersion??(model.windowsQualifiedFirmware??model.qualifiedFirmware);
const state=()=>({connected,identified:connected,armed:false,readOnly:true,modelId,model:model.name,firmwareVersion:version,transport:'USB',vendorId:model.vendorId,productId:model.productIds[0],
 lightingProfile:configuration.lightingProfile??1,ledCount:model.keyCount+model.sideCount,keyLedCount:model.keyCount,sideLedCount:model.sideCount,errorCode:connected?'WINDOWS_PROBE_ONLY':null,
 lightingInspection:{available:getLightingReadLength(modelId,version)!==null,qualifiedFirmware:(model.windowsQualifiedFirmware??model.qualifiedFirmware)},sleepInspection:{available:getSleepReadLength(modelId,version)!==null},keymapInspection:{available:getKeymapReadCount(modelId,version)!==null},capabilities:{perKey:false,mainWholeZone:false,functionKeyAdaptation:false,readOnlyProbe:true}});
input.on('line',line=>{
  const request=JSON.parse(line),{id,op}=request;log({op,...(op==='paint'?{black:request.colors.every(v=>v===0),held:configuration.holdLightingPaint===true&&!(wakeArmed&&request.colors.every(v=>v===0))}:{})});
  let result;
  if(lighting){
    if(op==='hello'){sessionId=request.sessionId;result={profile:NATIVE_LIGHTING.profile,protocolVersion:NATIVE_LIGHTING.protocolVersion,implementation:NATIVE_LIGHTING.implementation,implementationVersion:'1.2.40',sessionId,backend:'windows-hid',readOnly:false,maxLineBytes:NATIVE_LIGHTING.maxLineBytes,capabilities:NATIVE_LIGHTING.capabilities};}
    else if(op==='heartbeat')result={alive:true};
    else if(op==='recoveryStatus')result={modelId:'air75-v3',firmwareVersion:version,lightingProfile:1,pending:recoveryPending,canRestore:windowsLightingPolicy(modelId,version)!==null,noMutation:true};
    else if(op==='recoverExisting'){
      mutated=true;const sleepFailed=configuration.failColdSleep===true,keysFailed=configuration.failColdKeys===true&&recoveryPending.keymapProfiles.length>0,hadKeys=recoveryPending.keymapProfiles.length>0;
      recoveryPending={lightingProfiles:[],boardSleep:sleepFailed,keymapProfiles:keysFailed?[1]:[]};
      result={modelId:'air75-v3',lightingProfile:1,functionKeys:keysFailed?{status:'failed',error:{code:'FUNCTION_KEYS_BARRIER_UNQUALIFIED',message:'改键提交尚未核对，原记录已保留'}}:hadKeys&&!configuration.omitKeyReceipt?{status:'restored',completion:{verified:true,noMutation:false,archived:true,restoredKeys:2,externalChangesPreserved:true}}:{status:'notNeeded'},lighting:{status:'restored',completion:{verified:true,noMutation:false,archived:true}},
        boardSleep:sleepFailed?{status:'failed',error:{code:'SLEEP_TEST_FAILURE',message:'isolated sleep recovery failure'}}:{status:'restored',completion:{supported:true,restored:true,noMutation:false,archived:true,preservedExternalChange:false}},
        deferredProfiles:[],remaining:recoveryPending,complete:!sleepFailed&&!keysFailed,completedCleanup:{lightingProfiles:[],boardSleep:false,keymapProfiles:[]}};
    }
    else if(['arm','armNative','armConnectionWake'].includes(op)){
      if(recoveryPending.lightingProfiles.length||recoveryPending.boardSleep||recoveryPending.keymapProfiles.length){console.log(JSON.stringify({id,ok:false,error:{code:'RECOVERY_REQUIRED',message:'isolated original retained'}}));finishLighting();return;}
      wakeArmed=op==='armConnectionWake';mutated||=op!=='armNative';result={armed:true,leaseId:++lease,boardSleepLease:{supported:windowsBoardSleepSupported(modelId,version),active:windowsBoardSleepSupported(modelId,version),pending:windowsBoardSleepSupported(modelId,version)},device:{modelId,firmwareVersion:version,lightingProfile:1,vendorId:model.vendorId,productId:model.productIds[0],keyLedCount:model.keyCount,ledCount:model.keyCount+model.sideCount,canvasCount:model.canvasCount,connectionToken:'isolated-native-'+process.pid},...(wakeArmed?{connectionWake:{mainBlackVerified:true,sideMuted:true,sideIndicatorObserved:false,allLightsBlack:true,paletteExposureRequired:true}}:{})};}
    else if(op==='nativeLighting'||op==='nativeSnapshot'){
      if(op==='nativeLighting'){mutated=true;nativeState[0]=request.mode;nativeState[1]=request.brightness;nativeState[2]=request.speed;if(request.color){nativeState[4]=0;nativeState.splice(6,3,...request.color);}}
      result={verified:true,changed:op==='nativeLighting',state:nativeState,colors:Array(model.keyCount+model.sideCount).fill(nativeState.slice(6,9)).flat()};
    }
    else if(op==='paint'){
      const cachedBlack=wakeArmed&&request.colors.every(v=>v===0);
      if(!cachedBlack&&configuration.holdLightingPaint)return;
      if(!cachedBlack&&configuration.failLightingPaint){actionFailed=true;console.log(JSON.stringify({id,ok:false,error:{code:'PAINT_TEST_FAILURE',message:'isolated paint failure'}}));return;}
      if(!cachedBlack)wakeArmed=false;
      result={painted:model.keyCount,skipped:cachedBlack,readback:request.verify};
    }
    else if(op==='side')result={updated:true};
    else if(op==='restore'){nativeState=[...originalState];result={verified:true,noMutation:false,archived:true};}
    else if(op==='quit'){finishLighting(request);return;}
    else throw new Error('unexpected isolated lighting operation');
    console.log(JSON.stringify({id,ok:true,result}));return;
  }
  if(op==='connect'&&!configuration.connected)return console.log(JSON.stringify({id,ok:false,error:{code:'DEVICE_NOT_FOUND',message:'isolated test: no device'}}));
  if(op==='hello'){sessionId=request.sessionId;result={...NATIVE_READONLY,sessionId,readOnly:true,implementationVersion:'1.2.40'};}
  else if(op==='connect'){connected=true;result=state();}
  else if(op==='disconnect'){connected=false;result=state();}
  else if(op==='lightingSnapshot')result={modelId:'air75-v3',firmwareVersion:version,lightingProfile:configuration.lightingProfile??1,ledCount:104,
    state:[2,60,0,0,0,0,0,0,0,2,50,0,0,0,0,0,0,0,0,0,0,94],renderedColors:Array(104).fill('#123456'),readOnly:true,noMutation:true,restorationReady:false};
  else if(op==='sleepSnapshot')result={modelId:'air75-v3',firmwareVersion:version,lightingProfile:configuration.lightingProfile??1,
    enabled:true,state:[1,10,30,213],readOnly:true,noMutation:true,restorationReady:false};
  else if(op==='keymapSnapshot'){
    const matrixKeyCount=model.rows*model.columns,keymapKeyCount=matrixKeyCount+model.extraKeys,defaults=[Array(keymapKeyCount).fill(4),Array(keymapKeyCount).fill(4)];
    const mac=[105,106,32262,32263,32264,32278,172,174,171,168,170,169];
    for(let i=0;i<12;i++){defaults[0][i+1]=mac[i];defaults[1][i+1]=58+i;}
    defaults[0][30]=39;defaults[1][30]=39;
    const active=[...defaults[configuration.lightingProfile??1]];
    if(configuration.extendedFunctionKeys)for(let i=0;i<12;i++)active[i+1]=104+i;
    result={modelId,firmwareVersion:version,lightingProfile:configuration.lightingProfile??1,matrixKeyCount,keymapKeyCount,active,defaults,readOnly:true,noMutation:true,restorationReady:false};
  }
  else if(op==='permissions')result={platform:'win32',inputMonitoring:false,accessibility:false,canPostEvents:false};
  else if(op==='bluetoothDevices')result={devices:[],available:false};
  else if(op==='quit')result={quitting:true,noMutation:true};
  else if(['restoreKeys','restore'].includes(op))result={restored:true,verified:true,noMutation:true};
  else result=state();
  if(configuration.identityQualification&&['connect','status'].includes(op))result.identityQualification=configuration.identityQualification;
  console.log(JSON.stringify({id,ok:true,result}));
  if(op==='quit')input.close();
});
input.on('close',()=>{if(lighting){finishLighting();return;}log({event:'exited'});process.stdout.write(JSON.stringify({event:'shutdownComplete',sessionId,eventSequence:1,noMutation:true,lightingRestored:true,keysRestored:true})+'\\n',()=>process.exit(0));});
`);
  const children=[];
  const ioHelper=path.join(directory,'桌面 IO helper.mjs'),ioLog=path.join(directory,'io.jsonl');
  if(configuration.desktopIO)await writeFile(ioHelper,`
import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
let sessionId,sequence=0,captures=0;const event=value=>console.log(JSON.stringify({...value,sessionId,eventSequence:++sequence}));
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);appendFileSync(${JSON.stringify(ioLog)},JSON.stringify(q)+'\\n');let result={alive:true,stopped:true};
 if(q.op==='hello'){sessionId=q.sessionId;result={protocolVersion:2,implementation:'windows-desktop-io',platform:'win32',sessionId,capabilities:{audio:true,globalKeys:true,sensitiveKeys:false,orderedKeyEvents:true}};}
 if(q.op==='inventory')result={systemSupported:true,microphonePermission:false,devices:[]};
 if(q.op==='startAudio'){captures++;result={started:true,session:q.session};const fail=${configuration.audioDeviceFailure===true}&&captures===1;setTimeout(()=>{if(fail)event({event:'audioFeature',session:q.session,status:'error',error:'systemCapture',reasonCode:'AUDIO_DEVICE_CHANGED'});event({event:'audioFeature',session:q.session,status:'listening',rms:${configuration.failCapture?2:0.5},bands:Array(8).fill(0.2)});},30);}
 if(q.op==='monitorKeys'){result={monitoring:true,suppressing:false,sensitiveKeys:false};setTimeout(()=>{event({event:'key',modelId:q.modelId,source:'windowsRawInput',code:q.codes.includes('KeyA')?'KeyA':q.codes[0],phase:'down',monitorId:q.monitorId,sensitiveKeys:false});if(${configuration.resetInput===true}){event({event:'keysReset',modelId:q.modelId,monitorId:q.monitorId,reasonCode:'INPUT_EVENT_OVERFLOW'});event({event:'key',modelId:q.modelId,source:'windowsRawInput',code:'KeyA',phase:'down',monitorId:q.monitorId,sensitiveKeys:false});}},30);}
 console.log(JSON.stringify({id:q.id,ok:true,result:q.op==='quit'?{quitting:true}:result}));
 if(q.op==='quit'){event({event:'shutdownComplete',audioStopped:true,keysStopped:true});process.exit(0);}
});
`);
  t.after(async()=>{
    try { for(const service of children)await service.close(); }
    finally { await rm(directory,{recursive:true,force:true}); }
  });
  async function start() {
    const token=randomBytes(32).toString('hex'),secret=randomBytes(32).toString('hex'),shutdownId=randomBytes(32).toString('hex');
    const networkGuard='data:text/javascript,'+encodeURIComponent('globalThis.fetch=async()=>{throw new Error("Network disabled in isolated fixture");};');
    const child=spawn(process.execPath,['--import',networkGuard,fileURLToPath(new URL('../../server/main.mjs',import.meta.url))],{
      cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe'],
      env:{...process.env,AIR_STUDIO_DESKTOP_HOST:'tauri',AIR_STUDIO_HOST_SECRET:secret,
        AIR_STUDIO_DATA:path.join(directory,'作品 数据'),AIR_STUDIO_PORT:'0',AIR_STUDIO_PREFERRED_PORT:undefined,
        AIR_STUDIO_HID:process.execPath,AIR_STUDIO_HID_ARGS:JSON.stringify([helper]),AIR_STUDIO_HID_MODELS:undefined,
        AIR_STUDIO_IO:configuration.desktopIO?process.execPath:undefined,AIR_STUDIO_IO_ARGS:configuration.desktopIO?JSON.stringify([ioHelper]):undefined,
        AIR_STUDIO_PARENT_PID:undefined,AIR_STUDIO_TOKEN:token,
        CODEX_HOME:path.join(directory,'unused codex'),CLAUDE_CONFIG_DIR:path.join(directory,'unused claude')},
    });
    let stderr='';child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-8192);});
    child.stdin.on('error',()=>{});
    const exited=once(child,'close');exited.catch(()=>{});
    const control=op=>{if(!child.stdin.destroyed)child.stdin.write(JSON.stringify({op,secret,...(op==='shutdown'?{shutdownId}:{})})+'\n');};
    const heartbeat=setInterval(()=>control('ping'),1000);heartbeat.unref();control('hello');
    let closePromise;
    const service={child,exited,shutdownId,hostMessages:[],async close(eof=false,{expectedExit=0}={}){
      if(closePromise)return closePromise;
      closePromise=(async()=>{
        clearInterval(heartbeat);
        if(child.exitCode===null&&child.signalCode===null){if(eof)child.stdin.end();else control('shutdown');}
        const timeout=setTimeout(()=>child.kill(),8000);
        try{const [code,signal]=await exited;assert.equal(signal,null,stderr);assert.equal(code,expectedExit,stderr);}
        finally{clearTimeout(timeout);}
      })();
      return closePromise;
    }};
    children.push(service);
    const lines=createInterface({input:child.stdout});
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Service not ready: '+stderr)),8000);
      const failed=()=>{clearTimeout(timer);reject(new Error('Service exited before ready: '+stderr));};
      child.once('exit',failed);
      lines.on('line',line=>{
        let value;try{value=JSON.parse(line);}catch{return;}
        service.hostMessages.push(value);
        if(value.event==='ready'){clearTimeout(timer);child.off('exit',failed);resolve(value.port);}
      });
    });
    const request=async(route,body)=>{
      const response=await fetch(`http://127.0.0.1:${port}${route}`,{
        method:body===undefined?'GET':'POST',headers:{'X-Air-Token':token,'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(8000)});
      return {status:response.status,value:await response.json()};
    };
    Object.assign(service,{url:`http://127.0.0.1:${port}`,request,state:async()=>(await request('/api/state')).value,
      command:async body=>(await request('/api/command',body)).value});
    return service;
  }
  return {directory,start,operations:async()=>(await readFile(log,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),
    ioOperations:async()=>(await readFile(ioLog,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
}
