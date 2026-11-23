export function isTauriDesktop(target=globalThis.window) {
  return typeof target?.__TAURI__?.core?.invoke==='function';
}

export function isNativeDesktop(target=globalThis.window) {
  return isTauriDesktop(target)||typeof target?.webkit?.messageHandlers?.codexKeys?.postMessage==='function';
}

// Desktop hosts own key routing, even while a preview has no global-key
// capability. Do not silently replace an unavailable native path with DOM keys.
export function usesDesktopKeyRouting(target=globalThis.window) {
  return isNativeDesktop(target);
}

export async function nativeDesktopRequest(channel,value,target=globalThis.window) {
  if(!['codexKeys','audioControl'].includes(channel))throw new Error('不支持的桌面通道');
  if(isTauriDesktop(target)){
    if(channel==='audioControl'&&value&&Object.keys(value).length===1&&['microphone','system'].includes(value.permission))
      return {available:true,result:await target.__TAURI__.core.invoke('audio_settings',{permission:value.permission})};
    if(channel==='codexKeys'&&value&&typeof value==='object'){
      if(value.kind==='openOfficialDriver'&&Object.keys(value).length===1)return {available:true,result:await target.__TAURI__.core.invoke('open_official_driver',{})};
      const commands={windowsUpdateStatus:'update_status',checkForUpdates:'update_check',installWindowsUpdate:'update_install'};
      const command=Object.hasOwn(commands,value.kind)?commands[value.kind]:null;
      const keys=Object.keys(value);
      if(command&&keys.length===(value.kind==='installWindowsUpdate'?2:1)&&keys.every(k=>['kind','version'].includes(k))){
        if(value.kind==='installWindowsUpdate'&&(typeof value.version!=='string'||value.version.length>100||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version)))throw new Error('更新版本无效');
        return {available:true,result:await target.__TAURI__.core.invoke(command,value.kind==='installWindowsUpdate'?{version:value.version}:{})};
      }
    }
    return {available:false,result:null,reason:'Windows 预览版尚未开放此桌面功能'};
  }
  const handler=target?.webkit?.messageHandlers?.[channel];
  if(typeof handler?.postMessage!=='function')return {available:false,result:null};
  return {available:true,result:await handler.postMessage(value)};
}

export async function desktopRequest(route,body,target=globalThis.window) {
  if(!isTauriDesktop(target))return null;
  if(!['/api/state','/api/layout','/api/command'].includes(route))throw new Error('不支持的桌面请求');
  // Never fall back to unauthenticated fetch after a native request fails.
  const value=await target.__TAURI__.core.invoke('service_request',{route,body:body??null});
  if(value===null||typeof value!=='object')throw new Error('桌面服务回复格式无效');
  return value;
}
