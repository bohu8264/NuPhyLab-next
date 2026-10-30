type DeviceState={device?:{connected?:boolean;modelId?:string;readOnly?:boolean;connection?:{status:string};capabilities?:{stockEffects?:boolean;perKey?:boolean}};firmware?:{upgradeRecommended?:boolean}};
export function nativeLightingOnly(state:DeviceState|null|undefined):boolean;
export function lightingUnavailableMessage(state:DeviceState|null|undefined):string;
export function sidebarDeviceIdentity(state: {device?:{connected?:boolean;modelId?:string;model?:string};bluetooth?:{connected?:boolean}}|null|undefined): {modelName:string|null;transport:'usb'|'bluetooth'|null};
