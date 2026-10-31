export type ConnectionDisplayCopy = Readonly<{zh:string;en:string}>;
export type ConnectionStateId = 'serviceUnknown'|'loading'|'attention'|'reconnecting'|'paused'|'usbReady'|'bluetoothOnly'|'disconnected';
export type ConnectionReasonId = 'multipleUsb'|'appUpdateRequired'|'keyRecoveryBlocked'|'lightingRecoveryBlocked'|'readOnly'|'genericConnection';
export type ConnectionActionId = 'navigateDevice'|'continueCreation'|'refreshService'|'connect'|'checkAppUpdates'|'restore'|'save';
export type ConnectionTone = 'neutral'|'attention'|'ready';
/** A minimal read-only structural view; compatible with the existing AppState. */
export type ConnectionDisplayState = {
  device?: {
    connected?:boolean;armed?:boolean;modelId?:string;model?:string;readOnly?:boolean;
    connectionSessionId?:string;connectionPaused?:unknown;errorCode?:unknown;
    recoveryPending?:unknown;needsRestore?:unknown;unsafeWritesNeeded?:unknown;
    connection?:{status:string};capabilities?:{perKey?:boolean;stockEffects?:boolean};
  };
  bluetooth?:{connected?:boolean};firmware?:{compatible?:boolean};
  playback?:{mode?:string;playing?:boolean};lightPower?:{sleeping?:boolean};
  settings?:{agentSource?:unknown;[key:string]:unknown};game?:{type?:string;status?:string};
};
export type VerifiedRestoreEvidence = Readonly<{
  /** Only an existing trusted receipt owner may supply this; never device.verified. */
  operation:'restore';verified:true;restored:true;connectionSessionId:string;invalidated?:boolean;
}>;
export type KeyRecoveryProblemResult = Readonly<{status?:string;blocking?:boolean;pending?:boolean;errorCode?:string|null;error?:string|null;requiresSameKeyboardConfirmation?:boolean}>;
export type ConnectionDisplayInput = {
  state?:ConnectionDisplayState|null;serviceError?:string;canvasModelId?:string|null;
  /** Result of the existing UI keyRecoveryProblem helper, not a shared TSX import. */
  keyRecoveryProblem?:KeyRecoveryProblemResult|null;
  /** Default null. Owner discards on new output/disconnect/service error/blocking error. */
  verifiedRestoreEvidence?:VerifiedRestoreEvidence|null;
};
export type ConnectionDisplayReason = Readonly<{
  title:ConnectionDisplayCopy;short:ConnectionDisplayCopy;body:ConnectionDisplayCopy;
  action:ConnectionActionId;devicePrimary?:ConnectionActionId;devicePrimaryCopy?:ConnectionDisplayCopy;
}>;
export type ConnectionDisplay = Readonly<{
  stateId:ConnectionStateId;reasonId:ConnectionReasonId|null;tone:ConnectionTone;serviceFresh:boolean;freshUsb:boolean;
  header:ConnectionDisplayCopy;sidebar:ConnectionDisplayCopy;sidebarLabel:ConnectionDisplayCopy;
  workTitle:ConnectionDisplayCopy|null;workBody:ConnectionDisplayCopy|null;
  deviceTitle:ConnectionDisplayCopy;deviceBody:ConnectionDisplayCopy|null;
  primaryAction:ConnectionActionId|null;devicePrimaryAction:ConnectionActionId|null;devicePrimaryCopy:ConnectionDisplayCopy|null;
  identity:Readonly<{modelName:string|null;transport:'usb'|'bluetooth'|null}>;
  canvasModelId:'air75-v3'|'kick75'|null;canvasIdentity:ConnectionDisplayCopy|null;
  capability:Readonly<{kind:'perKey'|'stockOnly'|'readOnly'|'unknown'|'unavailable';label:ConnectionDisplayCopy|null;tone:ConnectionTone}>;
  offlineCapabilities:ConnectionDisplayCopy;reason:ConnectionDisplayReason|null;restoreEvidenceAccepted:boolean;
}>;
export function deriveConnectionDisplay(input?:ConnectionDisplayInput):ConnectionDisplay;
