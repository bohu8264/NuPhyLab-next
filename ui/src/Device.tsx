import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bluetooth, Cable, ChevronRight, CircleAlert, RotateCcw, Unplug } from "lucide-react";
import { Button, run } from "./primitives";
import type { AppState, Command, Key } from "./types";
import { Keyboard } from "./Keyboard";
import { firmwarePrompt, showFirmwareGuide, useStartupCopy } from "./StartupGuide";
import { friendlyConnectionError, keyRecoveryProblem } from "./KeyRecoveryPanel";
import { nativeCodexKeys } from "./codexKeys";
import { FunctionKeyRecoveryDialog } from "./FunctionKeyRecoveryDialog";
import type { ConnectionDisplay } from "../../shared/connection-display.mjs";
import { connectionCopy } from "./connection-copy-v7";
import "./device-settings-v5.css";
import "./settings-overlays-v6.css";
import "./device-connection-v7.css";

export function Device({ state, command, serviceError, layout = state?.layout || [], onOffline, display, onRefresh }: {
  state: AppState | null;
  command: Command;
  serviceError: string;
  layout?: Key[];
  onOffline?: () => void;
  display?: ConnectionDisplay;
  onRefresh?: () => Promise<unknown>;
}) {
  const copy = useStartupCopy();
  const [busy, setBusy] = useState("");
  const [actionError,setActionError] = useState("");
  const [recoveryOpen,setRecoveryOpen] = useState(false);
  const recoveryTrigger=useRef<HTMLElement|null>(null);
  const actionPending=useRef(false),actionContext=useRef(0);
  const device = state?.device;
  const phase = device?.connection?.status;
  const recovery = keyRecoveryProblem(state);
  const wireless = state?.bluetooth?.connected === true && !device?.connected;
  const connected = device?.connected === true;
  const recoveryPending=device?.keyRecovery?.pending===true||device?.functionKeyRecoveryPending===true;
  const identified = connected || wireless || device?.identified === true;
  const kick = device?.modelId === "kick75" || layout.length === 80;
  const outdated = firmwarePrompt(state);
  const firmware = state?.firmware;
  const module = state?.settings.airTopRightModule === "keycap" ? "keycap" : "rotary";
  const nativeOnly = kick && device?.capabilities?.stockEffects === true && device?.capabilities?.perKey === false;
  useEffect(()=>{actionContext.current++;setActionError("");},[device?.modelId]);
  useEffect(()=>()=>{actionContext.current++;},[]);
  useEffect(()=>{setRecoveryOpen(false);},[device?.connectionSessionId,device?.modelId,connected,state?.settings.codexEnabled,state?.settings.claudeEnabled]);
  const transient = phase === "waiting" || phase === "reconnecting";
  const connectionError = outdated || transient ? "" : phase === "updateRequired"
    ? copy("请更新 NuPhy Lab 后继续使用。", "Update NuPhy Lab to continue.")
    : phase === "attention" || recovery
      ? copy("请确认键盘已切到有线模式，并关闭其他键盘设置程序。软件会自动重试。", "Switch your keyboard to wired mode and close other keyboard apps. We will retry automatically.")
      : friendlyConnectionError(device?.error || state?.playback.lastError || serviceError || "");
  const execute = async (op: string) => {
    if(actionPending.current)return;actionPending.current=true;const context=actionContext.current;setBusy(op);setActionError("");
    try { await command({ op },{silent:true}); }
    catch(error) {if(context===actionContext.current)setActionError(error instanceof Error ? error.message : copy("操作未完成，请重试。","Could not complete the action. Try again."));}
    finally {actionPending.current=false;setBusy("");}
  };
  const changeModule = async (airTopRightModule: "rotary" | "keycap") => {
    if(actionPending.current)return;actionPending.current=true;const context=actionContext.current;setBusy("module");setActionError("");
    try { await command({ op: "settings", settings: { airTopRightModule } },{silent:true}); }
    catch(error) {if(context===actionContext.current)setActionError(error instanceof Error ? error.message : copy("设置未保存，请重试。","Could not save the setting. Try again."));}
    finally {actionPending.current=false;setBusy("");}
  };
  const status = wireless ? copy("蓝牙已连接 · 灯光播放需要 USB 连接", "Bluetooth connected · USB required for lighting")
    : outdated ? copy("固件待更新", "Firmware update required")
    : phase === "reconnecting" ? copy("正在重新连接", "Reconnecting")
    : phase === "attention" ? copy("连接暂时中断", "Connection interrupted")
    : phase === "updateRequired" ? copy("请更新 NuPhy Lab", "Update NuPhy Lab")
    : recovery ? copy("连接尚未完成", "Connection incomplete")
    : device?.readOnly && device.identified ? copy("已识别 · 请检查连接", "Identified · Check connection")
    : connected ? nativeOnly ? copy("USB 已连接 · 当前使用内置灯效", "USB connected · Built-in lighting")
      : copy("USB 已连接 · 灯光与快捷键可用", "USB connected · Lighting and shortcuts ready")
    : copy("未连接", "Disconnected");
  const firmwareUnconfirmed = Boolean(display && !display.freshUsb);
  const firmwareStatus = !connected ? copy("未连接","Disconnected") : outdated ? copy("请更新键盘固件", "Update keyboard firmware")
    : firmware?.checking ? copy("正在检查", "Checking")
    : firmware?.error || firmware?.stale ? copy("暂时无法检查官方最新固件，请稍后重试。","Could not check the latest official firmware. Try again later.")
    : firmware?.latestConfirmed && ["current", "newer"].includes(firmware.status) ? copy("已是最新版", "Up to date")
    : firmware?.current ? copy("已读取当前版本", "Current version detected") : copy("尚未读取", "Not detected");

  const refreshConnection = async () => {
    if (!onRefresh || actionPending.current) return;
    actionPending.current=true;const context=actionContext.current;setBusy("refreshService");setActionError("");
    try { await onRefresh(); }
    catch(error) {if(context===actionContext.current)setActionError(error instanceof Error?error.message:copy("操作未完成，请重试。","Could not complete the action. Try again."));}
    finally {actionPending.current=false;setBusy("");}
  };
  const connectionAction = () => display?.devicePrimaryAction === "refreshService"
    ? refreshConnection()
    : display?.devicePrimaryAction === "checkAppUpdates"
      ? nativeCodexKeys({kind:"checkForUpdates"})
      : execute("connect");

  // App supplies one shared display result. A retained layout/identified flag
  // remains usable for editing, but does not identify a current connection.
  if (display && (display.reasonId === "multipleUsb" || !identified)) {
    const multipleUsb=display.reasonId === "multipleUsb";
    return <section className={`lab-device-page lab-device-connection-v7 ${multipleUsb?"is-multiple-usb":""}`} data-connection-state={display.stateId}>
      <div className="lab-device-connection-intro">
        <h2>{connectionCopy(display.deviceTitle)}</h2>
        {display.deviceBody&&<p role="status">{connectionCopy(display.deviceBody)}</p>}
      </div>
      {multipleUsb&&<>
        <p className="lab-device-connection-scope">{copy("键盘输出暂不可用，离线编辑不受影响。","Keyboard output is unavailable. Offline editing stays available.")}</p>
        <dl className="lab-device-local-capabilities" aria-label={copy("当前可用功能","Available features")}>
          {[
            [copy("编辑画布","Edit canvas"),copy("可用","Available")],
            [copy("页面预览","Page preview"),copy("可用","Available")],
            [copy("保存到本机","Save on this Mac"),copy("可用","Available")],
            [copy("播放与键盘控制","Keyboard playback and control"),copy("暂不可用","Unavailable")],
          ].map(([label,value],index)=><div key={index}><dt>{label}</dt><dd className={index===3?"is-unavailable":""}>{value}</dd></div>)}
        </dl>
      </>}
      {actionError&&<div className="settings-v6-note is-error" role="alert">{actionError}</div>}
      {Boolean(device?.storageWarning)&&<p className="lab-device-error">{String(device?.storageWarning)}</p>}
      <div className="lab-device-connection-actions">
        {onOffline&&<Button kind={multipleUsb?"primary":"ghost"} onClick={onOffline}>{copy("继续离线创作","Continue offline")}</Button>}
        <Button kind={multipleUsb?"secondary":"primary"} disabled={display.devicePrimaryAction==="refreshService"?!onRefresh:!state} busy={Boolean(busy)||display.stateId==="reconnecting"} onClick={()=>run(connectionAction())}>
          {display.stateId==="reconnecting"?copy("正在重新连接","Reconnecting"):!display.devicePrimaryAction||display.devicePrimaryAction==="navigateDevice"?copy("重新连接","Reconnect"):connectionCopy(display.devicePrimaryCopy)||copy("重新连接","Reconnect")}
        </Button>
      </div>
      {multipleUsb&&<p className="lab-device-connection-hint">{copy("连接未就绪时，可保留当前画布继续创作。","Keep working on the current canvas while the connection is unavailable.")}</p>}
    </section>;
  }

  if (!identified) return <section className="lab-device-page lab-device-offline">
    <div className="lab-offline-intro"><h2>{copy("连接键盘", "Connect your keyboard")}</h2><p role={!state ? "status" : undefined}>{!state && layout.length===0 ? copy("正在读取键盘布局","Loading keyboard layout") : copy("使用 USB 线连接 Air75 V3 或 Kick75。", "Connect Air75 V3 or Kick75 with a USB cable.")}</p></div>
    <div className="lab-connection-guide"><Cable size={28} strokeWidth={1.5} /><div>
      <h3>{copy("灯光播放需要 USB 连接", "USB connection required for lighting")}</h3>
      <ol><li>{copy("将键盘切换到有线模式。", "Switch your keyboard to wired mode.")}</li><li>{copy("使用支持数据传输的 USB 线连接电脑。", "Connect a USB data cable to your computer.")}</li><li>{copy("关闭其他正在连接键盘的软件后重试。", "Close other keyboard apps and try again.")}</li></ol>
    </div></div>
    {connectionError && <div className="lab-device-error" role="status"><CircleAlert size={16}/><span>{connectionError}</span></div>}
    {actionError && <div className="settings-v6-note is-error" role="alert">{actionError}</div>}
    {device?.errorCode === "DEVICE_AMBIGUOUS" && <p className="lab-device-error">{copy("检测到多把支持的键盘，请仅用数据线连接要使用的一把。","Multiple supported keyboards were found. Connect only the one you want to use by USB.")}</p>}
    {state?.bluetooth?.status === "ambiguous" && <p className="lab-device-error">{copy("检测到多把 Air75 V3 蓝牙键盘，请只连接要使用的一把。", "Multiple Air75 V3 keyboards found. Connect only the one you want to use.")}</p>}
    <div className="lab-device-footer">{onOffline && <Button kind="ghost" icon={<ArrowLeft size={16}/>} onClick={onOffline}>{copy("返回离线创作", "Back to offline creation")}</Button>}<Button kind="primary" icon={<RotateCcw size={16}/>} disabled={!state} busy={Boolean(busy) || phase === "reconnecting"} onClick={() => run(execute("connect"))}>{copy(phase === "reconnecting" ? "正在重新连接" : "重新连接",phase === "reconnecting" ? "Reconnecting" : "Reconnect")}</Button></div>
  </section>;

  return <section className={`lab-device-page ${display?"lab-device-identified-v7":""}`}>
    {display?<div className="lab-device-identity-v7">
      <h2>{display.identity.modelName||connectionCopy(display.deviceTitle)}</h2>
      <div className={`lab-device-status ${display.tone==="ready"?"ready":display.tone==="attention"?"attention":""}`} role="status"><i/>{connectionCopy(display.deviceBody)||connectionCopy(display.deviceTitle)}</div>
      {!display.freshUsb&&display.canvasIdentity&&<p>{connectionCopy(display.canvasIdentity)}</p>}
      {display.stateId==="serviceUnknown"&&onRefresh&&<Button kind="ghost" busy={busy==="refreshService"} disabled={Boolean(busy)} onClick={()=>run(refreshConnection())}>{connectionCopy(display.devicePrimaryCopy)||copy("重新检查","Check again")}</Button>}
    </div>:<div className="lab-device-models" aria-label={copy("当前键盘", "Current keyboard")}>
      <span className={!kick ? "selected" : ""}>Air75 V3</span><span className={kick ? "selected" : ""}>Kick75</span>
    </div>}
    <div className="lab-device-grid">
      <div className="lab-device-canvas">
        {!display&&<div className={`lab-device-status ${connected && !outdated && !recovery ? "ready" : ""}`} role="status"><i/>{status}</div>}
        <Keyboard layout={layout} colors={Array(84).fill("#000000")} />
        <div className="lab-device-restore"><Button kind="ghost" icon={<RotateCcw size={16}/>} disabled={!connected || Boolean(busy)} busy={busy === "restore"} onClick={() => run(execute("restore"))}>{copy("恢复键盘原灯效", "Restore keyboard lighting")}</Button></div>
        {recoveryPending&&<div className="function-key-recovery-entry"><p>{copy("部分按键的原功能尚未确认，可先检查当前键盘。","Some original key functions have not been confirmed. Check the connected keyboard first.")}</p><Button kind="ghost" disabled={!connected||Boolean(busy)||Boolean(serviceError)} onClick={event=>{recoveryTrigger.current=event.currentTarget;setRecoveryOpen(true);}}>{copy("检查并恢复按键","Check and restore keys")}</Button></div>}
        {wireless && !display && <p className="lab-device-note">{copy("任务键和命令键继续可用，灯光保持键盘自身的设置。", "Task and command keys remain available. The keyboard keeps its own lighting.")}</p>}
        {connectionError && <div className={display?"lab-device-reconnect-v7":"lab-device-error"} role={display?undefined:"status"}>{!display&&<><CircleAlert size={16}/><span>{connectionError}</span></>}<Button disabled={Boolean(busy)} onClick={() => run(phase === "updateRequired" ? nativeCodexKeys({kind: "checkForUpdates"}) : execute("connect"))}>{copy(phase === "updateRequired" ? "检查更新" : "重新连接", phase === "updateRequired" ? "Check for updates" : "Reconnect")}</Button></div>}
        {Boolean(device?.storageWarning) && <p className="lab-device-error">{String(device?.storageWarning)}</p>}
        {actionError && <div className="settings-v6-note is-error" role="alert">{actionError}</div>}
      </div>
      <aside className="lab-device-inspector">
        <h2>{copy(kick ? "设备信息" : "设备配置", kick ? "Device information" : "Device configuration")}</h2>
        {!kick && <section className="lab-module-section">
          <h3>{copy("右上角模块", "Top-right module")}</h3>
          <div className="lab-module-options" role="group" aria-label={copy("右上角模块", "Top-right module")}>
            <button type="button" aria-pressed={module === "rotary"} disabled={!state || Boolean(busy)} onClick={() => run(changeModule("rotary"))}>{copy("旋钮", "Knob")}</button>
            <button type="button" aria-pressed={module === "keycap"} disabled={!state || Boolean(busy)} onClick={() => run(changeModule("keycap"))}>{copy("键帽", "Keycap")}</button>
          </div>
          <p>{copy("手动选择当前安装的模块。", "Choose the module you installed.")}<br/>{copy("仅调整预览外观，不更改按键功能。", "Preview only. Key functions stay the same.")}</p>
        </section>}
        <section className="lab-device-firmware">
          <h3>{firmwareUnconfirmed?`${copy("上次状态","Last known state")} · `:""}{copy("键盘固件", "Keyboard firmware")}</h3>
          <strong>{firmware?.current || device?.firmware || "—"}</strong>
          <div className={`lab-device-status ${firmwareUnconfirmed?"":outdated ? "attention" : kick && device?.capabilities?.perKey ? "ready" : ""}`}><i/>{firmwareUnconfirmed?copy("上次状态","Last known state"):kick && device?.capabilities?.perKey && !outdated ? copy("逐键灯光可用", "Per-key lighting ready") : firmwareStatus}</div>
        </section>
        {kick && <section className="lab-kick-capabilities"><h3>{copy("灯光控制", "Lighting control")}</h3><p>{copy("80 个按键与 5 个侧灯", "80 keys and 5 side LEDs")}<br/>{copy("旋钮不参与灯光上色", "Knob is outside the lighting canvas")}</p>{nativeOnly && <p>{copy("升级固件后可使用逐键创作。", "Update firmware to enable per-key creation.")}</p>}</section>}
        <details className="lab-firmware-details"><summary><ChevronRight size={16}/>{copy("固件信息", "Firmware information")}</summary><div>
          <p>{copy(firmwareUnconfirmed?"上次读取版本":"当前版本", firmwareUnconfirmed?"Last known version":"Current version")} {firmware?.current || device?.firmware || "—"}</p>
          {firmware?.latest && <p>{firmwareUnconfirmed?`${copy("上次状态","Last known state")} · `:""}{copy("官方版本", "Official version")} {firmware.latest}</p>}
          {(!(firmware?.error || firmware?.stale) || firmware?.checking) && <p role="status">{firmwareUnconfirmed?copy("上次状态","Last known state"):firmwareStatus}</p>}
          {(firmware?.error || firmware?.stale) && !firmware?.checking && <p className="settings-v6-note is-error" role="status">{copy("暂时无法检查官方最新固件，请稍后重试。","Could not check the latest official firmware. Try again later.")}{firmware.error&&<span className="settings-v6-error-detail">{firmware.error}</span>}</p>}
          <Button disabled={!connected || Boolean(busy) || firmware?.checking} busy={busy === "checkFirmware"} onClick={() => run(execute("checkFirmware"))}>{copy("检查固件", "Check firmware")}</Button>
          {outdated && <Button kind="primary" onClick={showFirmwareGuide}>{copy("前往 NuPhyIO 更新", "Update in NuPhyIO")}</Button>}
        </div></details>
        <Button kind="ghost" className="lab-device-disconnect" icon={wireless ? <Bluetooth size={16}/> : <Unplug size={16}/>} busy={busy === "disconnect" || busy === "refreshBluetooth"} disabled={Boolean(busy)} onClick={() => run(execute(wireless ? "refreshBluetooth" : connected ? "disconnect" : "connect"))}>{copy(wireless ? "检查连接" : connected ? "断开连接" : "重新连接", wireless ? "Check connection" : connected ? "Disconnect" : "Reconnect")}</Button>
      </aside>
    </div>
    {recoveryOpen&&<FunctionKeyRecoveryDialog state={state} command={command} serviceError={serviceError} returnFocus={recoveryTrigger.current} onClose={()=>setRecoveryOpen(false)}/>}
  </section>;
}
