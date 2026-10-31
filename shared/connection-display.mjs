// Pure presentation derived from v7 spec/connection-display.json. No commands or effects.
import {nativeLightingOnly, sidebarDeviceIdentity} from './device-status.mjs';

const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

const STATE_COPY = freeze({
  "serviceUnknown": {
    "header": {
      "zh": "本地服务未响应",
      "en": "Local service unavailable"
    },
    "sidebar": {
      "zh": "输出未确认",
      "en": "Output unconfirmed"
    },
    "workTitle": {
      "zh": "暂时无法确认键盘状态",
      "en": "Keyboard status is unconfirmed"
    },
    "workBody": {
      "zh": "画布已保留，可继续编辑和页面预览。保存结果需重新确认，失败时可重试。",
      "en": "Your canvas is retained. You can keep editing and previewing on screen. Saving may need verification or a retry."
    },
    "deviceTitle": {
      "zh": "本地服务未响应",
      "en": "Local service unavailable"
    },
    "primaryAction": "refreshService"
  },
  "loading": {
    "header": {
      "zh": "正在读取状态",
      "en": "Reading status"
    },
    "sidebar": {
      "zh": "正在读取输出状态",
      "en": "Reading output status"
    },
    "workTitle": {
      "zh": "正在读取键盘与本机数据",
      "en": "Reading keyboard and local data"
    },
    "workBody": {
      "zh": "已有画布可继续编辑。",
      "en": "You can keep editing an available canvas."
    },
    "deviceTitle": {
      "zh": "正在读取状态",
      "en": "Reading status"
    },
    "primaryAction": null
  },
  "attention": {
    "header": {
      "zh": "连接需处理",
      "en": "Connection needs attention"
    },
    "sidebar": {
      "zh": "输出未确认",
      "en": "Output unconfirmed"
    },
    "primaryAction": "reason.action"
  },
  "reconnecting": {
    "header": {
      "zh": "正在重新连接",
      "en": "Reconnecting"
    },
    "sidebar": {
      "zh": "等待确认输出",
      "en": "Awaiting output confirmation"
    },
    "workTitle": {
      "zh": "正在重新连接键盘",
      "en": "Reconnecting to your keyboard"
    },
    "workBody": {
      "zh": "可继续编辑、页面预览和保存。",
      "en": "You can keep editing, previewing on screen and saving."
    },
    "deviceTitle": {
      "zh": "正在重新连接",
      "en": "Reconnecting"
    },
    "primaryAction": null
  },
  "paused": {
    "header": {
      "zh": "连接已暂停",
      "en": "Connection paused"
    },
    "sidebar": {
      "zh": "连接已暂停",
      "en": "Connection paused"
    },
    "workTitle": {
      "zh": "USB连接已暂停",
      "en": "USB connection is paused"
    },
    "workBody": {
      "zh": "可继续离线创作；需要播放时再连接。",
      "en": "You can keep creating offline and reconnect when you want to play."
    },
    "deviceTitle": {
      "zh": "连接已暂停",
      "en": "Connection paused"
    },
    "primaryAction": "connect"
  },
  "usbReady": {
    "header": {
      "zh": "{device} · USB已连接",
      "en": "{device} · USB connected"
    },
    "deviceTitle": {
      "zh": "USB已连接",
      "en": "USB connected"
    },
    "primaryAction": null
  },
  "bluetoothOnly": {
    "header": {
      "zh": "Air75 V3 · 蓝牙已连接",
      "en": "Air75 V3 · Bluetooth connected"
    },
    "sidebar": {
      "zh": "未通过USB输出",
      "en": "No USB lighting output"
    },
    "workTitle": {
      "zh": "蓝牙已连接 · 灯光需接线",
      "en": "Bluetooth connected · USB needed for lighting"
    },
    "workBody": {
      "zh": "可继续编辑、页面预览和保存；播放到键盘需要USB连接。",
      "en": "You can edit, preview on screen and save. Playing lighting on the keyboard requires USB."
    },
    "deviceTitle": {
      "zh": "蓝牙已连接",
      "en": "Bluetooth connected"
    },
    "primaryAction": "navigateDevice"
  },
  "disconnected": {
    "header": {
      "zh": "未连接键盘",
      "en": "No keyboard connected"
    },
    "sidebar": {
      "zh": "离线创作",
      "en": "Creating offline"
    },
    "workTitle": {
      "zh": "正在离线创作",
      "en": "Creating offline"
    },
    "workBody": {
      "zh": "可编辑、页面预览和保存。连接USB后可播放到键盘。",
      "en": "You can edit, preview on screen and save. Connect by USB to play lighting on the keyboard."
    },
    "deviceTitle": {
      "zh": "连接键盘",
      "en": "Connect your keyboard"
    },
    "primaryAction": "navigateDevice"
  }
});

const REASON_COPY = freeze({
  "multipleUsb": {
    "title": {
      "zh": "检测到多把USB键盘",
      "en": "Multiple USB keyboards detected"
    },
    "short": {
      "zh": "多把USB键盘",
      "en": "Multiple USB keyboards"
    },
    "body": {
      "zh": "请仅用数据线连接要使用的一把键盘。暂不能播放到键盘。",
      "en": "Connect only the keyboard you want to use by USB. Keyboard lighting playback is unavailable."
    },
    "action": "navigateDevice",
    "devicePrimary": "connect",
    "devicePrimaryCopy": {
      "zh": "重新检查",
      "en": "Check again"
    }
  },
  "appUpdateRequired": {
    "title": {
      "zh": "需要更新NuPhy Lab",
      "en": "NuPhy Lab update required"
    },
    "short": {
      "zh": "需要更新应用",
      "en": "App update required"
    },
    "body": {
      "zh": "请检查NuPhy Lab更新后重试。",
      "en": "Check for a NuPhy Lab update and try again."
    },
    "action": "checkAppUpdates"
  },
  "keyRecoveryBlocked": {
    "title": {
      "zh": "连接尚未完成",
      "en": "Connection is incomplete"
    },
    "short": {
      "zh": "连接尚未完成",
      "en": "Connection incomplete"
    },
    "body": {
      "zh": "请关闭其他键盘设置程序，再重新连接。",
      "en": "Close other keyboard apps, then reconnect."
    },
    "action": "navigateDevice",
    "devicePrimary": "connect"
  },
  "lightingRecoveryBlocked": {
    "title": {
      "zh": "需完成灯效恢复",
      "en": "Lighting recovery needs attention"
    },
    "short": {
      "zh": "需完成灯效恢复",
      "en": "Lighting recovery pending"
    },
    "body": {
      "zh": "原灯效尚未确认恢复。请在设备页重新检查。",
      "en": "Restoration of the original lighting is unconfirmed. Check the connection in Device."
    },
    "action": "navigateDevice",
    "devicePrimary": "connect"
  },
  "readOnly": {
    "title": {
      "zh": "已识别 · 灯光暂不可用",
      "en": "Identified · Lighting unavailable"
    },
    "short": {
      "zh": "已识别 · 需检查",
      "en": "Identified · Check connection"
    },
    "body": {
      "zh": "键盘已识别，灯光控制尚未就绪。请在设备页检查连接。",
      "en": "The keyboard is identified, but lighting control is not ready. Check the connection in Device."
    },
    "action": "navigateDevice",
    "devicePrimary": "connect"
  },
  "genericConnection": {
    "title": {
      "zh": "连接暂时中断",
      "en": "Connection interrupted"
    },
    "short": {
      "zh": "连接暂时中断",
      "en": "Connection interrupted"
    },
    "body": {
      "zh": "请确认有线模式，并关闭其他键盘设置程序。",
      "en": "Check wired mode and close other keyboard apps."
    },
    "action": "navigateDevice",
    "devicePrimary": "connect"
  }
});

const COMMON = freeze({
  "sidebarLabel": {
    "zh": "键盘输出",
    "en": "Keyboard output"
  },
  "offlineCapabilities": {
    "zh": "仍可编辑、页面预览和保存。",
    "en": "You can still edit, preview on screen and save."
  },
  "canvasIdentity": {
    "zh": "当前画布 · {model}",
    "en": "Canvas · {model}"
  },
  "preview": {
    "zh": "页面预览",
    "en": "On-screen preview"
  },
  "sessionPrefix": {
    "zh": "当前会话 · ",
    "en": "Current session · "
  },
  "historicalPrefix": {
    "zh": "上次状态 · ",
    "en": "Last known · "
  },
  "noArtworkPlaying": {
    "zh": "未播放作品",
    "en": "No artwork playing"
  },
  "outputUnconfirmed": {
    "zh": "输出未确认",
    "en": "Output unconfirmed"
  },
  "restored": {
    "zh": "原灯效已恢复",
    "en": "Original lighting restored"
  },
  "restoreDeferred": {
    "zh": "下次连接时检查恢复",
    "en": "Check recovery on reconnection"
  },
  "capabilitiesLoading": {
    "zh": "正在读取灯光能力",
    "en": "Reading lighting capabilities"
  }
});

const ACTION_COPY = freeze({
  "navigateDevice": {
    "zh": "查看连接",
    "en": "View connection"
  },
  "continueCreation": {
    "zh": "继续创作",
    "en": "Keep creating"
  },
  "refreshService": {
    "zh": "重新检查",
    "en": "Check again"
  },
  "connect": {
    "zh": "重新连接",
    "en": "Reconnect"
  },
  "checkAppUpdates": {
    "zh": "检查应用更新",
    "en": "Check app updates"
  },
  "restore": {
    "zh": "恢复键盘原灯效",
    "en": "Restore keyboard lighting"
  },
  "save": {
    "zh": "保存作品",
    "en": "Save artwork"
  }
});

const MODE_COPY = freeze({
  "static": {
    "zh": "静态灯光",
    "en": "Static lighting"
  },
  "animation": {
    "zh": "动画",
    "en": "Animation"
  },
  "paused": {
    "zh": "已暂停",
    "en": "Paused"
  },
  "agent": {
    "zh": "{agent}状态灯",
    "en": "{agent} status lights"
  },
  "audio": {
    "zh": "声音律动",
    "en": "Audio reactive"
  },
  "trigger": {
    "zh": "按键触发",
    "en": "Key trigger"
  },
  "game": {
    "zh": "{game}",
    "en": "{game}"
  },
  "native": {
    "zh": "内置灯效",
    "en": "Built-in lighting"
  }
});

const GAME_MODIFIERS = freeze({
  "paused": {
    "zh": " · 已暂停",
    "en": " · Paused"
  },
  "over": {
    "zh": " · 已结束",
    "en": " · Finished"
  },
  "won": {
    "zh": " · 已结束",
    "en": " · Finished"
  }
});

// Existing product game names (shared/i18n.mjs), substituted into the spec template.
const GAME_NAMES = freeze({
  snake: {zh:'贪吃蛇',en:'Snake'},
  whack: {zh:'打地鼠',en:'Whack-a-mole'},
  memory: {zh:'记忆灯序',en:'Memory sequence'},
  pong: {zh:'双人乒乓球',en:'Two-player Pong'},
});
const RESTORE_BLOCK_CODES = new Set(['RESTORE_REQUIRED','RECOVERY_REQUIRED','PRESET_RECOVERY_CONFLICT']);
const pair = (zh,en) => ({zh,en});
const join = (first,second) => pair(first.zh + second.zh,first.en + second.en);
const format = (template,values) => pair(
  template.zh.replace(/\{(\w+)\}/g,(_,key)=>values[key]?.zh ?? ''),
  template.en.replace(/\{(\w+)\}/g,(_,key)=>values[key]?.en ?? ''),
);

function currentModeCopy(state) {
  const mode=state?.playback?.mode;
  const template=Object.hasOwn(MODE_COPY,mode)?MODE_COPY[mode]:null;
  if(!template)return null;
  if(mode==='agent') {
    const agent=state?.settings?.agentSource==='claude'?'Claude Code':'Codex';
    return format(template,{agent:pair(agent,agent)});
  }
  if(mode==='game') {
    const name=Object.hasOwn(GAME_NAMES,state?.game?.type)?GAME_NAMES[state.game.type]:null;
    if(!name)return null;
    const label=format(template,{game:name});
    return Object.hasOwn(GAME_MODIFIERS,state?.game?.status) ? join(label,GAME_MODIFIERS[state.game.status]) : label;
  }
  return template;
}

/**
 * Optional evidence is supplied by an existing trusted restore-receipt owner,
 * never synthesized from device.verified. That owner must discard it permanently
 * on disconnect, service error, a new output session, or a blocking failure.
 * This pure function validates the current snapshot; it retains no lifecycle state.
 */
export function deriveConnectionDisplay({state=null,serviceError='',canvasModelId=null,keyRecoveryProblem=null,verifiedRestoreEvidence=null}={}) {
  const serviceFresh=state!==null&&!serviceError;
  const device=state?.device ?? {};
  const freshUsb=serviceFresh&&device.connected===true;
  const bluetoothOnly=serviceFresh&&!freshUsb&&state?.bluetooth?.connected===true;
  const explicitPause=serviceFresh&&!freshUsb&&device.connectionPaused===true;
  const phase=serviceFresh?device.connection?.status:null;
  const readOnly=freshUsb&&device.readOnly===true;
  const knownPerKey=freshUsb&&!readOnly&&device.capabilities?.perKey===true&&state?.firmware?.compatible!==false;
  const stockOnly=serviceFresh&&nativeLightingOnly(state);
  const capabilityUnknown=freshUsb&&!readOnly&&!knownPerKey&&!stockOnly;
  const pending=device.recoveryPending===true||device.needsRestore===true||device.unsafeWritesNeeded===true;
  const lightingRecoveryBlocked=freshUsb&&device.armed!==true&&pending&&RESTORE_BLOCK_CODES.has(device.errorCode);
  let reasonId=null;
  // Literal spec currentReason order. Ownership of other historical error-code
  // combinations is intentionally not guessed here; the caller supplies the
  // existing keyRecoveryProblem helper's already filtered result.
  if(serviceFresh) {
    if(device.errorCode==='DEVICE_AMBIGUOUS')reasonId='multipleUsb';
    else if(phase==='updateRequired'||device.errorCode==='UNSUPPORTED_FIRMWARE')reasonId='appUpdateRequired';
    else if(keyRecoveryProblem)reasonId='keyRecoveryBlocked';
    else if(lightingRecoveryBlocked)reasonId='lightingRecoveryBlocked';
    else if(readOnly)reasonId='readOnly';
    else if(phase==='attention')reasonId='genericConnection';
  }
  const stateId=serviceError?'serviceUnknown':state===null?'loading':explicitPause?'paused':reasonId?'attention':
    !freshUsb&&phase==='reconnecting'?'reconnecting':!freshUsb&&!bluetoothOnly&&phase==='paused'?'paused':
    freshUsb?'usbReady':bluetoothOnly?'bluetoothOnly':'disconnected';
  // Explicit pause outranks old reasons; no discarded reason escapes to consumers.
  if(stateId!=='attention')reasonId=null;
  const reason=reasonId?REASON_COPY[reasonId]:null;
  const identity=serviceFresh?sidebarDeviceIdentity(state):{modelName:null,transport:null};
  const capability={
    kind:readOnly?'readOnly':knownPerKey?'perKey':stockOnly?'stockOnly':capabilityUnknown?'unknown':'unavailable',
    label:readOnly?REASON_COPY.readOnly.title:knownPerKey?pair('逐键灯光可用','Per-key lighting available'):
      stockOnly?pair('内置灯效可用','Built-in lighting available'):capabilityUnknown?COMMON.capabilitiesLoading:null,
    tone:readOnly?'attention':knownPerKey||stockOnly?'ready':'neutral',
  };
  const tone=stateId==='attention'?'attention':stateId==='usbReady'&&(knownPerKey||stockOnly)?'ready':'neutral';
  const base=STATE_COPY[stateId];
  let header=base.header;
  if(stateId==='usbReady') {
    // An unknown model must not leak a placeholder or derive identity from canvas.
    header=identity.modelName?format(header,{device:pair(identity.modelName,identity.modelName)}):base.deviceTitle;
  }
  let sidebar=base.sidebar;
  const evidence=verifiedRestoreEvidence;
  const restoreEvidenceAccepted=stateId==='usbReady'&&device.armed!==true&&!pending&&state?.playback?.mode==='idle'&&
    evidence?.operation==='restore'&&evidence.verified===true&&evidence.restored===true&&evidence.invalidated!==true&&
    typeof device.connectionSessionId==='string'&&device.connectionSessionId.length>0&&
    evidence.connectionSessionId===device.connectionSessionId;
  if(stateId==='usbReady') {
    if(device.armed===true) {
      const mode=currentModeCopy(state);
      sidebar=state?.lightPower?.sleeping===true?pair('当前会话 · 灯光休眠','Current session · Lighting asleep'):
        mode?join(COMMON.sessionPrefix,mode):COMMON.outputUnconfirmed;
    } else sidebar=restoreEvidenceAccepted?COMMON.restored:stockOnly?pair('内置灯效可用','Built-in lighting available'):
      capabilityUnknown?COMMON.capabilitiesLoading:COMMON.noArtworkPlaying;
  }
  const workTitle=reason?.title ?? base.workTitle ?? null;
  const workBody=reason?pair(`${reason.body.zh}${COMMON.offlineCapabilities.zh}`,`${reason.body.en} ${COMMON.offlineCapabilities.en}`):base.workBody ?? null;
  const primaryAction=reason?.action ?? base.primaryAction;
  const devicePrimaryAction=reason?.devicePrimary ?? primaryAction;
  const modelName=canvasModelId==='kick75'?'Kick75':canvasModelId==='air75-v3'?'Air75 V3':null;
  return freeze({
    stateId,reasonId,tone,serviceFresh,freshUsb,header,sidebar,
    sidebarLabel:COMMON.sidebarLabel,workTitle,workBody,
    deviceTitle:reason?.title ?? base.deviceTitle,
    deviceBody:reason?.body ?? workBody,
    primaryAction,devicePrimaryAction,
    devicePrimaryCopy:reason?.devicePrimaryCopy ?? ACTION_COPY[devicePrimaryAction] ?? null,
    identity,canvasModelId:modelName?canvasModelId:null,
    canvasIdentity:modelName?format(COMMON.canvasIdentity,{model:pair(modelName,modelName)}):null,
    capability,offlineCapabilities:COMMON.offlineCapabilities,reason,restoreEvidenceAccepted,
  });
}
