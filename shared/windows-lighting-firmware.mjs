import versions from './contracts/windows-lighting-firmware.json' with {type:'json'};
import {getKeyboardProfile,isKeyboardModel} from './keyboard-models.mjs';
export function windowsLightingPolicy(modelId,firmwareVersion){
  if(!isKeyboardModel(modelId))return null;
  const m=getKeyboardProfile(modelId);
  if(firmwareVersion===(m.windowsQualifiedFirmware??m.qualifiedFirmware))return m.lightingRecoveryPolicy;
  return versions.additionalVersions.find(v=>v.modelId===modelId&&v.firmwareVersion===firmwareVersion&&
    v.stateLength===m.lightingStateLength&&v.keyCount===m.keyCount&&v.sideCount===m.sideCount)?.policy??null;
}
export function windowsBoardSleepSupported(modelId,firmwareVersion){
  if(modelId!=='air75-v3'||windowsLightingPolicy(modelId,firmwareVersion)===null)return false;
  if(firmwareVersion===(getKeyboardProfile(modelId).windowsQualifiedFirmware??getKeyboardProfile(modelId).qualifiedFirmware))return true;
  return versions.additionalVersions.some(v=>v.modelId===modelId&&v.firmwareVersion===firmwareVersion&&v.boardSleep===true);
}
