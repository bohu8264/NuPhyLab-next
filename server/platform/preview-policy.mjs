import {validateSidebarFeatures} from '../../shared/sidebar-features.mjs';
import policy from '../../shared/contracts/windows-preview.json' with {type:'json'};

export function validatePreviewCommand(body,{lightingAvailable=false,audioAvailable=false,globalKeysAvailable=false,agentStatus=false}={}) {
  const reject=message=>{throw Object.assign(new Error(message),{code:'WINDOWS_PREVIEW_UNAVAILABLE'});};
  if(!body||typeof body!=='object'||Array.isArray(body))reject('不支持的桌面请求');
  if(Buffer.byteLength(JSON.stringify(body),'utf8')>policy.maxBytes)reject('文件过大，最大 8 MB');
  const validEditor=value=>typeof value==='string'&&value.length>0&&value.length<=80;
  if(Object.hasOwn(policy.editorOperations,body.op)){
    if(Object.keys(body).length!==2||!validEditor(body.editorId))reject('不支持的桌面请求');
    return;
  }
  if(policy.operations.includes(body.op))return;
  if(policy.handoffOperations.includes(body.op)){
    if(Object.keys(body).length!==1)reject('释放键盘不接受外部地址或其他参数');return;
  }
  if(policy.inspectionOperations.includes(body.op)){
    if(Object.keys(body).length!==1)reject('只读检查不接受设备编号、路径或其他参数');
    return;
  }
  if(policy.recoveryOperations.includes(body.op)){
    if(Object.keys(body).length!==1)reject('恢复操作不接受设备编号、路径或其他参数');
    return;
  }
  if(Object.hasOwn(policy.agentOperations,body.op)){
    if(Object.keys(body).some(key=>key!=='op'&&!policy.agentOperations[body.op].includes(key)))reject('不支持的 Windows AI 参数');
    if(!agentStatus&&!(body.op==='agentMode'&&body.enabled===false))reject('Windows AI 状态组件尚未就绪，请先准备配套资源');
    return;
  }
  if(Object.hasOwn(policy.lightingOperations,body.op)){
    if(Object.hasOwn(body,'editorId')&&!validEditor(body.editorId) ||
      Object.hasOwn(body,'connectionSessionId')&&!(typeof body.connectionSessionId==='string'&&body.connectionSessionId.length>0&&body.connectionSessionId.length<=128))reject('不支持的 Windows 灯光参数');
    if(!lightingAvailable)reject('Windows 键盘唯一身份或固件尚未通过灯光检查，可继续离线创作');
    if(policy.nativeRequirements[body.op]==='audio'&&!audioAvailable||policy.nativeRequirements[body.op]==='globalKeys'&&!globalKeysAvailable)reject('Windows 原生采集能力尚未就绪，请检查声音或按键服务');
    if(Object.keys(body).some(key=>key!=='op'&&!policy.lightingOperations[body.op].includes(key)))reject('不支持的 Windows 灯光参数');
    if(body.op==='nativeLighting'&&(!Number.isInteger(body.mode)||body.mode<1||body.mode>20||!Number.isInteger(body.brightness)||body.brightness<0||body.brightness>100||
      !Number.isInteger(body.speed)||body.speed<0||body.speed>4||!(body.color===undefined||typeof body.color==='string'&&/^#[0-9a-f]{6}$/i.test(body.color))))reject('内置灯效参数无效');
    return;
  }
  if(body.op==='settings'){
    const settings=body.settings;
    if(!settings||typeof settings!=='object'||Array.isArray(settings))reject('设置格式无效');
    if(Object.hasOwn(settings,'sidebarFeatures')){
      let ids;try{ids=validateSidebarFeatures(settings.sidebarFeatures);}catch{reject('设置格式无效');}
      if(Object.keys(settings).length!==1||ids.some(id=>!policy.featureIds.includes(id)))reject('Windows 预览版尚未开放这些设置');
    }
    if(settings.codexKeyAdaptation===true)reject('Windows 实体任务键尚未通过来源核对');
    if(!agentStatus&&(settings.codexEnabled===true||settings.claudeEnabled===true))reject('Windows AI 状态组件尚未就绪');
    if(Object.keys(settings).every(key=>policy.settings.includes(key)||policy.agentSettings.includes(key)))return;
    reject('Windows 预览版尚未开放这些设置');
  }
  reject('Windows 预览版尚未开放此操作，可继续编辑和保存作品');
}
