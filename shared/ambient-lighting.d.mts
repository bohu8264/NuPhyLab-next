export type AmbientLightingSettings = {enabled:boolean;learn:boolean;brightRoom:'off'|'dim';profiles:Record<string,{lux:number;brightness:number}[]>};
export type AmbientLightingState = {status:'disabled'|'manualOff'|'noKeyboard'|'unsupportedKeyboard'|'idle'|'waiting'|'active'|'unavailable'|'lidClosed'|'sleeping';lux:number|null;effectiveBrightness:number;targetBrightness:number;learnedPoints:number};
export const DEFAULT_AMBIENT_LIGHTING: AmbientLightingSettings;
export function validateAmbientLighting(value:unknown,previous?:AmbientLightingSettings):AmbientLightingSettings;
