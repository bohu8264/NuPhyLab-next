// Product decisions only: no network, USB, browser or permission side effects.
const parts=value=>typeof value==='string'&&/^\d+\.\d+\.\d+\.\d+$/.test(value)?value.split('.').map(Number):null;
const compare=(a,b)=>{a=parts(a);b=parts(b);if(!a||!b)return null;for(let i=0;i<4;i++)if(a[i]!==b[i])return Math.sign(a[i]-b[i]);return 0;};
export function firmwarePrompt(state){
  const fw=state?.firmware,device=state?.device;
  const detected=device?.connected===true||device?.identified===true&&device.firmwareDetectionAvailable===true;
  if(!detected||!parts(fw?.current)||!(fw.upgradeRecommended===true||fw.updateAvailable===true||fw.updateRequired===true||fw.status==='updateAvailable'))return null;
  const target=fw.latestConfirmed&&fw.latest?fw.latest:fw.minimumRequired;
  if(compare(fw.current,target)!==-1)return null;
  const modelId=device.modelId;if(!['air75-v3','kick75'].includes(modelId))return null;
  return {key:[modelId,fw.current,target].join(':'),modelId,model:fw.modelName||device.model?.replace(/ ANSI$/,'')||(modelId==='kick75'?'Kick75':'Air75 V3'),current:fw.current,target};
}
export function currentFirmwareReady(state){
  const fw=state?.firmware;
  return state?.device.connected===true&&fw?.latestConfirmed===true&&['current','newer'].includes(fw.status)&&fw.upgradeRecommended!==true&&fw.updateRequired!==true;
}
export function firmwareUpdateSatisfied(state,prompt){
  if(currentFirmwareReady(state))return true;
  const fw=state?.firmware;
  return !!prompt&&state?.device.connected===true&&state.device.modelId===prompt.modelId&&fw?.compatible===true&&
    !firmwarePrompt(state)&&[0,1].includes(compare(fw.current,prompt.target));
}
