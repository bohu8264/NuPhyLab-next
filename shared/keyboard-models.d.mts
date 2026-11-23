import type {KeyboardKey,KeyboardModel} from './layout.mjs';
export interface KeyboardProfile {name:string;vendorId:number;productIds:number[];keyCount:number;sideCount:number;canvasCount:number;rows:number;columns:number;extraKeys:number;qualifiedFirmware:string;qualifiedFirmwares?:readonly string[];windowsQualifiedFirmware?:string;lightingStateLength:number;lightingRecoveryPolicy:'air75-v3-1.0.23.6'|'kick75-4.0.18.6'|'s4-qualified-17';minimumVersion:string;businessId:string;globalPalette:boolean;functionRow:boolean;unmappedIndices:number[];layout?:KeyboardKey[];rgbWriteIndices?:number[];}
export const MAX_CANVAS_COUNT:number;
export const KEYBOARD_MODELS: Record<KeyboardModel,KeyboardProfile>;
export const KEYBOARD_MODEL_IDS: readonly KeyboardModel[];
export function isKeyboardModel(id:unknown): id is KeyboardModel;
export function getKeyboardProfile(id?:string):KeyboardProfile;
export function getLightingReadLength(modelId:unknown,firmwareVersion:unknown):number|null;
export function getSleepReadLength(modelId:unknown,firmwareVersion:unknown):number|null;
export function getCanvasCount(id?:string):number;
export function canvasCountForLayout(keys:KeyboardKey[]):number;
