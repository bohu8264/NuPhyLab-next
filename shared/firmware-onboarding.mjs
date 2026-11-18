import {getKeyboardProfile,isKeyboardModel} from './keyboard-models.mjs';
// Product decisions only: no network, USB, browser or permission side effects.
const parts=value=>typeof value==='string'&&/^\d+\.\d+\.\d+\.\d+$/.test(value)?value.split('.').map(Number):null;
const compare=(a,b)=>{a=parts(a);b=parts(b);if(!a||!b)return null;for(let i=0;i<4;i++)if(a[i]!==b[i])return Math.sign(a[i]-b[i]);return 0;};
// A remote "latest" version alone cannot identify the connected keyboard or
// grant its protocol capabilities. The persistent settings badge needs both.
export function availableFirmwareUpdate(state){
  const fw=state?.firmware,device=state?.device;
  const detected=device?.connected===true||device?.identified===true&&device.firmwareDetectionAvailable===true;
  if(!detected||!isKeyboardModel(device?.modelId)||fw?.modelId!==device.modelId||
    fw.current!==device.firmware||fw.latestConfirmed!==true||fw.updateAvailable!==true||
    fw.status!=='updateAvailable'||fw.stale===true||compare(fw.current,fw.latest)!==-1)return null;
  return {key:[device.modelId,fw.current,fw.latest].join(':'),modelId:device.modelId,
    model:fw.modelName||getKeyboardProfile(device.modelId).name,current:fw.current,target:fw.latest,latestUnverified:fw.latestSupported===false,pairedReceiverUpdate:fw.pairedReceiverUpdate===true};
}
export function firmwarePrompt(state){
  const fw=state?.firmware,device=state?.device;
  const detected=device?.connected===true||device?.identified===true&&device.firmwareDetectionAvailable===true;
  const modelId=device?.modelId;
  if(!detected||!isKeyboardModel(modelId)||fw?.modelId&&fw.modelId!==modelId)return null;
  const profile=getKeyboardProfile(modelId);
  const current=parts(device.firmware)?device.firmware:fw?.current;
  if(!parts(current))return null;
  // Required protocol upgrades are known locally, before the first network
  // response and even when an old keyboard fails its lighting handshake.
  const required=compare(current,profile.minimumVersion)===-1;
  const qualifiedLatest=fw?.latestConfirmed===true&&fw.stale!==true&&
    (profile.qualifiedFirmwares??[profile.qualifiedFirmware]).includes(fw.latest);
  const recommended=qualifiedLatest&&compare(current,fw.latest)===-1;
  if(!required&&!recommended)return null;
  const target=qualifiedLatest&&compare(profile.minimumVersion,fw.latest)!==1?fw.latest:profile.minimumVersion;
  if(compare(current,target)!==-1)return null;
  return {key:[modelId,current,target].join(':'),modelId,model:profile.name,current,target,
    required,officialLatest:qualifiedLatest&&target===fw.latest,pairedReceiverUpdate:qualifiedLatest&&fw.pairedReceiverUpdate===true,latestUnverified:fw?.latestConfirmed===true&&fw.latestSupported===false};
}
export function currentFirmwareReady(state){
  const fw=state?.firmware;
  return state?.device.connected===true&&fw?.compatible===true&&fw?.latestConfirmed===true&&['current','newer'].includes(fw.status)&&fw.upgradeRecommended!==true&&fw.updateRequired!==true;
}
export function firmwareUpdateSatisfied(state,prompt){
  if(!prompt)return currentFirmwareReady(state);
  const fw=state?.firmware,device=state?.device;
  const detected=device?.connected===true||device?.identified===true&&device.firmwareDetectionAvailable===true;
  const current=parts(device?.firmware)?device.firmware:fw?.current;
  // Finishing the official update and granting Lab write capabilities are
  // independent decisions. A newly observed protocol can remain read-only.
  return !!detected && device.modelId===prompt.modelId && (!fw?.modelId||fw.modelId===device.modelId) &&
    (!parts(device.firmware)||!parts(fw?.current)||device.firmware===fw.current) && [0,1].includes(compare(current,prompt.target));
}
