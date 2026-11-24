type DeviceState={desktop?:{host:string;capabilities?:Record<string,boolean>};device?:{connected?:boolean;identified?:boolean;errorCode?:unknown;modelId?:string;readOnly?:boolean;connection?:{status:string};capabilities?:{stockEffects?:boolean;perKey?:boolean}};firmware?:{upgradeRecommended?:boolean}};
export function isWindowsReadonlyPreview(state:DeviceState|null|undefined):boolean;
export function nativeLightingOnly(state:DeviceState|null|undefined):boolean;
export function lightingUnavailableMessage(state:DeviceState|null|undefined):string;
export function sidebarDeviceIdentity(state: {device?:{connected?:boolean;modelId?:string;model?:string};bluetooth?:{connected?:boolean}}|null|undefined): {modelName:string|null;transport:'usb'|'bluetooth'|null};
