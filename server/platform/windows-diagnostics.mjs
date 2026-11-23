import {isKeyboardModel} from '../../shared/keyboard-models.mjs';
const firmware=v=>typeof v==='string'&&/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)?v:null;
const oneOf=(v,values,fallback='unknown')=>values.includes(v)?v:fallback;
// An allowlist, not a scrub of the full state. No identities, paths, AI
// sessions, key contents, raw audio or environment variables are exported.
export function windowsDiagnostics({state,io,osRelease='',arch=process.arch}={}){
  const device=state?.device??{},caps=state?.desktop?.capabilities??{},recovery=device.windowsRecovery??{};
  return {format:'nuphylab-windows-diagnostics',version:1,
    application:{version:/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(state?.build?.version??'')?state.build.version:'1.2.40',host:'tauri',
      architecture:oneOf(arch,['x64','arm64']),system:/^\d{1,3}\.\d{1,3}\.\d{1,8}$/.test(osRelease)?osRelease:null},
    capabilities:Object.fromEntries(['lighting','globalKeys','audio','agentStatus','agentControl','updates'].map(key=>[key,caps[key]===true])),
    device:{connected:device.connected===true,modelId:isKeyboardModel(device.modelId)?device.modelId:null,firmware:firmware(device.firmwareVersion??device.firmware),
      lightingProfile:[0,1].includes(device.lightingProfile)?device.lightingProfile:null,identityQualified:device.identityQualification?.status==='qualified',
      readOnly:device.readOnly!==false,recoveryPending:device.recoveryPending===true||device.boardSleepLease?.pending===true,
      recoveryStatus:oneOf(recovery.status,['idle','checking','ready','recovering','complete','pending','failed','unavailable'])},
    playback:{mode:oneOf(state?.playback?.mode,['idle','native','static','animation','paused','agent','audio','trigger','game']),playing:state?.playback?.playing===true},
    capture:{phase:oneOf(io?.phase,['created','starting','ready','closing','closed','failed']),sensitiveKeys:false},
    privacy:{serialNumbers:false,devicePaths:false,projectPaths:false,taskContents:false,keyContents:false,rawAudio:false}};
}
