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
export {friendlyConnectionError} from '../../shared/error-message.mjs';
