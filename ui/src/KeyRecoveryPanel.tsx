import type {AppState} from './types';

type RecoveryState={status?:string;errorCode?:string|null;error?:string|null;pending?:boolean;blocking?:boolean;requiresSameKeyboardConfirmation?:boolean};
// Legacy recovery remains an internal device state. Product pages offer the
// ordinary reconnect action instead of exposing journals or individual keys.
export function keyRecoveryProblem(state:AppState|null):RecoveryState|null{
  const value=state?.device.keyRecovery;
  if(value?.status==='none'||value?.status==='active'||value?.unownedHistory===true||state?.device.unownedFunctionKeyHistory===true)return null;
  if(value&&(value.blocking||value.status==='confirmationRequired'||value.status==='blocked'))return value;
  const code=String(state?.device.errorCode??'');
  return code.startsWith('KEY_LEASE_')?{status:'blocked',errorCode:code,pending:true,blocking:true}:null;
}
export function friendlyConnectionError(value:unknown){
  const text=String(value??'');
  if(!/[\u3400-\u9fff]/.test(text)&&/HID|keyboard|palette|backup|packet|response|route|checksum|device|IOKit|configuration/i.test(text))return '连接暂时中断，软件正在重新连接。';
  return /F4|KEY_(?:LEASE|RECOVERY)|恢复记录|原备份|原 USB|协议结构|灯位数量|灯效协议|键位结构|[A-Z][A-Z_]{5,}/.test(text)?'暂时无法连接键盘，请关闭其他键盘设置程序，重新插拔键盘后再试。':text;
}
