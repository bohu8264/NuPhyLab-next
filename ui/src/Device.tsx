import { t as tr } from "./i18n";
import {
  Cable,
  Bluetooth,
  ArrowUpRight,
  Check,
  CircleAlert,
  Keyboard,
  RotateCcw,
  Unplug,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button, run, Switch } from "./primitives";
import type { AppState, Command } from "./types";
import { FirmwareStatus } from "./FirmwareStatus";
import { LightingTimers } from "./LightingTimers";
import {requestAppPermission,refreshAppPermissions,useStartupCopy} from './StartupGuide';
import {friendlyConnectionError,keyRecoveryProblem} from './KeyRecoveryPanel';
import {nativeCodexKeys} from './codexKeys';
function permissionLabel(value: unknown) {
  if (value === true || value === "granted" || value === "authorized")
    return "已允许";
  if (value === false || value === "denied" || value === "restricted")
    return "尚未允许";
  return "状态未知";
}
const permissionEntries = [
  { id: "inputMonitoring", title: "输入监控", description: "用于按键触发灯效。" },
  { id: "accessibility", title: "辅助功能", description: "用于执行 Codex 命令键。" },
] as const;
export function Device({
  state,
  command,
  serviceError,
}: {
  state: AppState | null;
  command: Command;
  serviceError: string;
}) {
  const copy=useStartupCopy(),keyRecovery=keyRecoveryProblem(state);
  const phase=state?.device.connection?.status;
  const transient=phase==='waiting'||phase==='reconnecting';
  const connectionError=state?.firmware?.upgradeRecommended||transient?'':phase==='updateRequired'?copy('请更新 NuPhy Lab 后继续使用。','Update NuPhy Lab to continue.'):phase==='attention'||keyRecovery?copy('请确认键盘已切到有线模式，并关闭其他键盘设置程序。软件会自动重试。','Switch your keyboard to wired mode and close other keyboard apps. We will retry automatically.'):friendlyConnectionError(state?.device.error||state?.playback.lastError||serviceError||'');
  const [busy, setBusy] = useState(""),
    device = state?.device,
    native = state?.native || {},
    permissions = (
      native.permissions && typeof native.permissions === "object"
        ? native.permissions
        : native
    ) as Record<string, unknown>;
  const wireless=state?.bluetooth?.connected===true&&!device?.connected;
  const nativeOnly=device?.modelId === "kick75" && device.capabilities?.stockEffects === true && device.capabilities?.perKey === false;
  const execute = async (op: string) => {
    setBusy(op);
    try {
      await command({ op });
    } finally {
      setBusy("");
    }
  };
  const openSettings = async (permission: 'inputMonitoring'|'accessibility') => {
    setBusy(permission);
    try {
      await requestAppPermission(command,permission);
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    let refreshing = false;
    const refreshPermissions = () => {
      if (document.visibilityState === "hidden" || refreshing) return;
      refreshing = true;
      void refreshAppPermissions(command)
        .catch(() => {})
        .finally(() => { refreshing = false; });
    };
    refreshPermissions();
    window.addEventListener("focus", refreshPermissions);
    document.addEventListener("visibilitychange", refreshPermissions);
    return () => {
      window.removeEventListener("focus", refreshPermissions);
      document.removeEventListener("visibilitychange", refreshPermissions);
    };
  }, [command]);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>{tr("设备")}</h1>
          <p>{tr("让创作与键盘保持连接。")}</p>
        </div>
      </header>
      <section className="device-card">
        <div className="device-illustration">
          <Keyboard size={54} strokeWidth={1} />
        </div>
        <div className="device-summary">
          <h2>{device?.connected ? `NuPhy ${device.model?.replace(/ ANSI$/, "") || "键盘"}` : wireless ? "NuPhy Air75 V3" : "AIR75 V3 / Kick75"}</h2>
          <p>{tr(wireless ? "蓝牙连接 · Codex 快捷控制" : "ANSI · USB-C 有线连接")}</p>
          <div
            className={`device-state ${keyRecovery?"needs-key-recovery":device?.connected || wireless ? "connected" : ""}`}
          >
            <span
              className={`status-dot ${keyRecovery?"needs-key-recovery":device?.connected || wireless ? "green" : ""}`}
            />
            {tr(wireless ? "蓝牙已连接" : state?.firmware?.upgradeRecommended ? "固件待更新" : phase==='reconnecting'?"正在重新连接":phase==='attention'?"连接暂时中断":phase==='updateRequired'?"请更新 NuPhy Lab":keyRecovery ? copy("连接尚未完成","Connection incomplete") : device?.readOnly && device?.identified ? '已识别 · 请检查连接' : device?.connected ? "已连接" : device?.connectionPaused ? "自动连接已暂停" : device?.autoConnecting ? "等待连接键盘" : "未连接")}
          </div>
          {tr(!device?.connected && <p className="device-connection-help">
            {tr(wireless ? "任务键和命令键继续可用，灯光保持键盘自身的设置。" : device?.connectionPaused ? "点击「连接键盘」恢复连接。" : "用 USB 数据线连接 AIR75 V3 或 Kick75，应用会自动识别；Air75 V3 也支持蓝牙快捷控制。")}
          </p>)}
        </div>
        <div className="device-actions">
          <Button kind={device?.connected ? "secondary" : "primary"}
            icon={wireless ? <Bluetooth size={16}/> : device?.connected ? <Unplug size={16} /> : <Cable size={16} />}
            busy={Boolean(busy)} disabled={Boolean(busy)}
            onClick={() => run(execute(wireless ? "refreshBluetooth" : device?.connected ? "disconnect" : "connect"))}>
            {tr(wireless ? "检查连接" : device?.connected ? "断开连接" : "连接键盘")}
          </Button>
        </div>
      </section>
      <FirmwareStatus state={state} command={command} />
      {wireless ? <div className="wireless-notice"><strong>{tr("灯光控制需要 USB 有线连接")}</strong><p>{tr("蓝牙下不发送状态灯、动画、游戏或灯光计时指令。原有设置会保留，切回有线后可继续使用。")}</p></div> : nativeOnly ? <div className="wireless-notice"><p>{tr("当前固件下原生灯效由键盘自行播放；灯光计时需新版逐键模式。")}</p></div> : <LightingTimers state={state} command={command} />}
      {state?.bluetooth?.status==='ambiguous' && <p className="inline-error">{tr("检测到多把 Air75 V3 蓝牙键盘，请只连接要使用的一把。")}</p>}
      {connectionError&&<div className="inline-error"><CircleAlert size={18}/><span>{tr(connectionError)}</span>{!wireless&&<Button icon={<RotateCcw size={16}/>} busy={busy === "connect"} disabled={Boolean(busy)} onClick={()=>run(phase==='updateRequired'?nativeCodexKeys({kind:'checkForUpdates'}):execute("connect"))}>{tr(phase==='updateRequired'?"检查更新":"重新连接")}</Button>}</div>}
      {Boolean(device?.storageWarning)&&<p className="inline-error">{tr(String(device?.storageWarning))}</p>}
      <div className="device-grid device-preferences">
        <section className="settings-section">
          <h2>{tr("常用设置")}</h2>
          <div className="preference-row">
            <Switch label={tr("插线后自动连接")} checked={Boolean(state?.settings.autoConnect)}
              onChange={autoConnect => run(command({op:"settings",settings:{autoConnect}}))} />
          </div>
          <div className="restore-section">
            <h3>{tr("恢复原有灯效")}</h3>
            <p className="muted">{tr("结束当前播放，恢复键盘原来的灯光。")}</p>
            <Button icon={<RotateCcw size={16} />} busy={busy === "restore"}
              disabled={!device?.connected || Boolean(busy)} onClick={() => run(execute("restore"))}>
              {tr("恢复原有灯效")}
            </Button>
          </div>
        </section>
        <section className="settings-section">
          <h2>{tr("Mac 权限")}</h2>
          {permissionEntries.map(({id,title,description}) => {
            const allowed=permissionLabel(permissions[id]) === "已允许";
            return <div className="permission-row" key={id}>
              <div className="permission-description"><h3>{tr(title)}</h3><p>{tr(description)}</p></div>
              <Button className={`permission-button ${allowed ? "permission-ok" : ""}`}
                icon={allowed ? <Check size={16} /> : <ArrowUpRight size={16} />}
                aria-label={tr(allowed ? `打开${tr(title)}设置` : `允许${tr(title)}`)}
                title={tr(allowed ? "系统设置" : "允许")} busy={busy === id} disabled={Boolean(busy)}
                onClick={() => run(openSettings(id))}>{tr(allowed ? "已允许" : "允许")}</Button>
            </div>;
          })}
          <details className="product-details permission-guide">
            <summary>{tr("授权帮助")}</summary>
            <p>{tr("点击「允许」直达对应设置，在系统中开启 NuPhy Lab。 列表中没有 NuPhy Lab 时，用「＋」添加。 返回后会自动检查权限；如系统提示重新打开应用，请按提示操作。")}</p>
          </details>
          {Boolean(native.error) && <p className="error-text">{tr(String(native.error))}</p>}
        </section>
      </div>
      <section className="preference-row app-update-row">
        <div><strong>NuPhy Lab {state?.build?.version || ''}</strong><p className="muted">{copy('有新版本时会自动提醒。作品与设置会保留。','We will notify you about updates. Your work and settings are kept.')}</p></div>
        <Button onClick={()=>run(nativeCodexKeys({kind:'checkForUpdates'}))}>{copy('检查更新','Check for updates')}</Button>
      </section>
    </>
  );
}
