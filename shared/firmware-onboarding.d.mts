import type {AppState} from '../ui/src/types';
export type FirmwarePrompt={key:string;modelId:string;model:string;current:string;target:string};
export function firmwarePrompt(state:AppState|null):FirmwarePrompt|null;
export function currentFirmwareReady(state:AppState|null):boolean;
export function firmwareUpdateSatisfied(state:AppState|null,prompt:FirmwarePrompt|null):boolean;
