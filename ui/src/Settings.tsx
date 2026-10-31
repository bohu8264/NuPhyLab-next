import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronRight, CircleHelp, RotateCcw, Sun } from "lucide-react";
import { Button, Modal, run, Switch } from "./primitives";
import { DurationField } from "./DurationField";
import { DEFAULT_LIGHT_TIME_MS } from "../../shared/lighting-power.mjs";
import { requestAppPermission, refreshAppPermissions, useStartupCopy } from "./StartupGuide";
import { nativeCodexKeys } from "./codexKeys";
import { useLanguage } from "./i18n";
import type { AppState, Command } from "./types";
import packageInfo from "../../package.json";
import { readAppState } from "./api";
import type { ConnectionDisplay } from "../../shared/connection-display.mjs";
import { connectionCopy } from "./connection-copy-v7";
import type { OutputColorProfile, OutputColorProfileStatus } from "../../shared/output-color-profile.mjs";
import "./device-settings-v5.css";
import "./settings-overlays-v6.css";
import "./action-reasons-v7.css";

type SettingsTab = "general" | "lighting" | "permissions" | "about";
type Permission = "inputMonitoring" | "accessibility";
const timeOptions = [0, 60000, 300000, 900000, 1800000, 3600000, 7200000];
function granted(value: unknown) { return value === true || value === "granted" || value === "authorized"; }
function denied(value: unknown) { return value === false || value === "denied" || value === "restricted"; }

function LightingPreferences({ state, command, display, onNavigateStudio }: {state: AppState | null; command: Command; display?: ConnectionDisplay; onNavigateStudio?: () => void}) {
  const copy = useStartupCopy();
  const [custom, setCustom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [customBusy, setCustomBusy] = useState(false);
  const [timerError, setTimerError] = useState("");
  const power = state?.lightPower;
  const nativeOnly = state?.device.modelId === "kick75" && state.device.capabilities?.perKey === false;
  const timerStateUnknown = display?.stateId === "serviceUnknown";
  const noLightingSession = !state?.device.armed && !nativeOnly;
  const connectionReason = display&&display.stateId!=="usbReady"?connectionCopy(display.workTitle):"";
  const timeLabel = (value: number) => value === 0 ? copy("不限", "Unlimited") : value % 3600000 === 0 ? `${value / 3600000} ${copy("小时", value === 3600000 ? "hour" : "hours")}` : value % 60000 === 0 ? `${value / 60000} ${copy("分钟", value === 60000 ? "minute" : "minutes")}` : `${value / 1000} ${copy("秒", "seconds")}`;
  const rows = [
    { key: "lightDurationMs", label: copy("每次亮灯时长", "Lighting duration"), detail: copy("达到时长后熄灭，需手动重新亮灯。", "Lights turn off when time is up. Restart them manually.") },
    { key: "lightIdleMs", label: copy("空闲多久后休眠", "Sleep when idle"), detail: copy("无操作达到此时间后熄灭，继续操作自动唤醒。", "Lights turn off when idle and wake when you resume.") },
  ];
  const wake = async () => { if(busy)return;setBusy(true);setTimerError(""); try { await command({op: "lightWake"},{silent:true}); } catch(error) { setTimerError(error instanceof Error ? error.message : copy("暂时无法重新计时，请重试。", "Could not restart the timer. Try again.")); } finally { setBusy(false); } };
  const saveDuration = async (key:string,next:number) => {
    try { await command({op:"settings",settings:{[key]:next}},{silent:true}); }
    catch(error) {
      // A transport error can follow a successful disk write; check before offering a retry.
      const current = await readAppState().catch(()=>null);
      if(!current){const unknown=new Error(copy("暂时无法确认保存结果。请稍后重新检查设置。","Could not confirm the save. Check the setting again shortly."));unknown.name="DurationSaveUnconfirmed";throw unknown;}
      if(Number(current?.settings[key]) !== next) throw error;
    }
  };
  const remaining = power?.remainingMs;
  const timerTitle = timerStateUnknown ? copy("当前计时", "Current timer") : power?.sleeping ? copy(power.reason === "duration" ? "灯光计时已结束" : "空闲休眠中", power.reason === "duration" ? "Lighting timer ended" : "Sleeping while idle") : copy("当前计时", "Current timer");
  const countdown = timerStateUnknown ? connectionCopy(display?.sidebar)
    : noLightingSession ? copy("当前未播放键盘灯光。","No keyboard lighting session is active.")
    : power?.sleeping ? copy("点击重新亮灯即可开始新的计时。", "Restart the lights to begin a new timer.")
    : remaining == null ? copy("当前未设置亮灯时限。", "No lighting time limit is active.")
    : copy("剩余亮灯时间", "Lighting time remaining") + " " + timeLabel(Math.max(1000, Math.ceil(remaining / 60000) * 60000));
  return <div className="lab-lighting-preferences">
    <div className="lab-settings-intro"><h2>{copy("灯光与休眠", "Lighting and sleep")}</h2><p>{copy("计时适用于普通作品。AI 状态灯持续显示，关闭模式后才停止。", "Timers apply to ordinary artwork. AI status lights stay on until the mode is turned off.")}</p></div>
    <div className="lab-setting-panel lab-timer-panel">{rows.map(({key,label,detail}) => {
      const value = Number(state?.settings[key] ?? DEFAULT_LIGHT_TIME_MS);
      const options = timeOptions.includes(value) ? timeOptions : [...timeOptions, value].sort((a,b)=>a-b);
      return <div className="lab-setting-row lab-timer-row" key={key}>
        <div><h3>{label}</h3><p>{detail}</p></div>
        <select aria-label={label} disabled={!state || customBusy} value={custom === key ? "custom" : value} onChange={event => {
          if (event.target.value === "custom") setCustom(key);
          else { setCustom(null); run(command({op: "settings", settings: {[key]: Number(event.target.value)}})); }
        }}>{options.map(option => <option key={option} value={option}>{timeLabel(option)}</option>)}<option value="custom">{copy("自定义…", "Custom…")}</option></select>
        {custom === key && <div className="lab-custom-duration"><DurationField label={label} value={value} disabled={!state} onChange={next => saveDuration(key,next)} onBusyChange={setCustomBusy} onDone={() => setCustom(null)} /></div>}
      </div>;
    })}</div>
    <div className="lab-lighting-summary-stack">
    <div className={`lab-setting-panel lab-current-timer ${noLightingSession?"v7-timer-unavailable":""}`}><div><h3>{timerTitle}</h3><p>{countdown}</p></div><Button kind={power?.sleeping ? "primary" : "secondary"} icon={power?.sleeping ? <Sun size={16}/> : <RotateCcw size={16}/>} busy={busy} disabled={!state?.device.armed || nativeOnly} aria-describedby={noLightingSession||nativeOnly?"lighting-timer-unavailable":undefined} onClick={() => run(wake())}>{copy(power?.sleeping ? "重新亮灯" : "重新计时", power?.sleeping ? "Restart lighting" : "Restart timer")}</Button>
      {noLightingSession&&<p id="lighting-timer-unavailable" className="v7-timer-action-reason" role="status">{connectionReason&&<span>{connectionReason}</span>}<span>{copy("开始键盘灯光后可重新计时；仍可修改时长与休眠设置。","Start keyboard lighting to restart its timer. Duration and sleep settings can still be edited.")}</span>{onNavigateStudio&&<button type="button" className="text-button v7-action-link v7-timer-studio-link" onClick={onNavigateStudio}>{copy("前往灯光创作","Go to lighting studio")}<ChevronRight size={16} aria-hidden="true"/></button>}</p>}
    </div>
    {timerError && <p className="settings-v6-note is-error" role="alert">{timerError}</p>}
    <OutputColorPreferences state={state} command={command} serviceUnknown={timerStateUnknown}/>
    </div>
    {nativeOnly && <p id="lighting-timer-unavailable" className="lab-settings-note">{copy("当前固件使用键盘内置灯效；升级后可使用灯光计时。", "Built-in lighting is active. Update firmware to use lighting timers.")}</p>}
    {power?.systemIdleAvailable === false && <p className="lab-settings-note">{copy("系统空闲时间暂不可读，当前仅根据本应用内的操作判断空闲。", "System idle time is unavailable. Idle detection currently uses activity in this app.")}</p>}
    <details className="lab-settings-help"><summary><CircleHelp size={15}/>{copy("计时说明", "About timers")}</summary><p>{copy("自定义时间支持 1 秒至 24 小时；设为 0 或选择「不限」可关闭对应计时。空闲休眠后，使用键盘、鼠标或操作本应用会自动唤醒；不记录按键内容。休眠时动画和游戏暂停推进。", "Custom times range from 1 second to 24 hours. Set 0 or choose Unlimited to disable a timer. Keyboard, mouse or app activity wakes idle lighting without recording key content. Animations and games pause during sleep.")}</p></details>
  </div>;
}

function OutputColorPreferences({state, command, serviceUnknown}: {state: AppState|null; command: Command; serviceUnknown: boolean}) {
  const copy = useStartupCopy();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const raw = state?.settings.outputColorProfile;
  const profile = raw && typeof raw === "object" ? raw as OutputColorProfile : null;
  const status = state?.device.outputColorProfile as OutputColorProfileStatus|undefined;
  if (!profile) return null;
  const message = serviceUnknown ? copy("校正状态暂时无法确认。", "Correction status is not confirmed.")
    : !profile.enabled ? copy("已停用；已保存的校正数据仍保留。", "Disabled. Saved correction data is kept.")
    : status?.active ? copy("已启用，正在修正这把键盘的逐键输出。", "Enabled for this keyboard's per-key output.")
    : status?.reason === "bindingMismatch" ? copy("当前键盘不匹配，未应用校正。", "This keyboard does not match. Correction is not applied.")
    : copy("无法确认已校正的键盘身份，未应用校正。", "The corrected keyboard cannot be identified. Correction is not applied.");
  const toggle = async (enabled: boolean) => {
    if (lock.current) return;
    lock.current = true;setBusy(true);setError("");
    const next = {...profile, enabled};
    try { await command({op: "settings", settings: {outputColorProfile: next}}, {silent: true}); }
    catch (failure) {
      const current = await readAppState().catch(() => null);
      if (!current) setError(copy("暂时无法确认保存结果。校正数据仍保留，请稍后检查。", "The save is not confirmed. Correction data is kept; check again shortly."));
      else if (JSON.stringify(current.settings.outputColorProfile) !== JSON.stringify(next))
        setError(failure instanceof Error ? failure.message : copy("未能保存校正开关，请重试。", "Could not save the correction switch. Try again."));
    } finally { lock.current = false;setBusy(false); }
  };
  return <section className="lab-setting-panel v8-output-color-profile" aria-label={copy("本机颜色校正", "Local color correction")}>
    <div className="lab-setting-row"><div><h3>{copy("本机颜色校正", "Local color correction")}</h3><p role="status">{busy ? copy("正在保存…", "Saving…") : message}</p></div>
      <Switch label={copy("启用已保存校正", "Use saved correction")} checked={profile.enabled} disabled={busy || serviceUnknown} onChange={value => run(toggle(value))}/>
    </div>
    <p className="v8-output-color-help">{copy("只修正这把键盘的逐键输出，不改作品原始颜色。其他键盘不会自动套用。", "Only corrects this keyboard's per-key output. Artwork colors are kept, and other keyboards do not inherit it.")}</p>
    {error && <p className="settings-v6-note is-error" role="alert">{error}</p>}
  </section>;
}

function PermissionPreferences({ state, command }: {state: AppState | null; command: Command}) {
  const copy = useStartupCopy();
  const [busy, setBusy] = useState<Permission | "refresh" | "">("");
  const [error,setError] = useState("");
  const inFlight=useRef(false);
  const native = state?.native || {};
  const permissions = native.permissions && typeof native.permissions === "object" ? native.permissions as Record<string,unknown> : native;
  useEffect(() => {
    let active=true;
    const refresh = () => { if (document.hidden || inFlight.current) return; inFlight.current=true;setBusy("refresh");void refreshAppPermissions(command,{silent:true}).catch(()=>{}).finally(()=>{inFlight.current=false;if(active)setBusy("");}); };
    refresh(); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { active=false;window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [command]);
  const perform = async (permission:Permission|"refresh") => {
    if(inFlight.current)return;inFlight.current=true;setBusy(permission);setError("");
    try { if(permission === "refresh")await refreshAppPermissions(command,{silent:true});else await requestAppPermission(command,permission,{silent:true}); }
    catch(error) { setError(error instanceof Error ? error.message : copy("暂时无法检查权限，请稍后重试。","Could not check permissions. Try again shortly.")); }
    finally {inFlight.current=false;setBusy("");}
  };
  const entries: {id:Permission; title:string; detail:string}[] = [
    {id: "inputMonitoring", title: copy("输入监控", "Input Monitoring"), detail: copy("用于读取选定按键，响应快捷键与按键灯效。", "Reads selected keys for shortcuts and key-triggered lighting.")},
    {id: "accessibility", title: copy("辅助功能", "Accessibility"), detail: copy("用于执行系统快捷操作。", "Runs system shortcuts.")},
  ];
  return <div className="lab-permission-preferences">
    <div className="lab-settings-intro"><h2>{copy("Mac 权限", "Mac permissions")}</h2><p>{copy("在使用相关功能时按需授权。", "Grant access when you need a feature.")}</p></div>
    <div className="lab-setting-panel lab-permissions-panel">{entries.map(({id,title,detail}) => {
      const allowed = granted(permissions[id]);
      return <div className="lab-setting-row lab-permission-row" key={id}><div><h3>{title}</h3><p>{detail}</p></div><div className="lab-permission-action">{allowed ? <span className="lab-permission-status ready"><i/>{copy("已允许", "Allowed")}</span> : <><span className="lab-permission-status">{copy(denied(permissions[id]) ? "尚未允许" : "状态未知", denied(permissions[id]) ? "Not allowed" : "Unknown")}</span><Button icon={<ArrowUpRight size={16}/>} busy={busy === id} disabled={Boolean(busy)} onClick={() => run(perform(id))}>{copy("前往授权", "Allow access")}</Button></>}</div></div>;
    })}
      <div className="lab-setting-row lab-permission-row"><div><h3>{copy("系统声音", "System audio")}</h3><p>{copy("开始系统声音律动时请求。", "Requested when you start system audio lighting.")}</p></div><span className={`lab-permission-status ${state?.audio?.active && state?.settings.audio && (state.settings.audio as {source?:string}).source === "system" ? "ready" : ""}`}><i/>{state?.audio?.active && (state.settings.audio as {source?:string}|undefined)?.source === "system" ? copy("已允许", "Allowed") : copy("使用时请求", "Requested when used")}</span></div>
      <div className="lab-setting-row lab-permission-row"><div><h3>{copy("麦克风", "Microphone")}</h3><p>{copy("选择麦克风作为声音来源时请求。", "Requested when microphone input is used.")}</p></div><span className={`lab-permission-status ${state?.audio?.active && (state.settings.audio as {source?:string}|undefined)?.source === "microphone" ? "ready" : ""}`}><i/>{state?.audio?.active && (state.settings.audio as {source?:string}|undefined)?.source === "microphone" ? copy("已允许", "Allowed") : copy("使用时请求", "Requested when used")}</span></div>
    </div>
    <div className="lab-permission-footer"><details className="lab-settings-help"><summary><CircleHelp size={15}/>{copy("授权帮助", "Permission help")}</summary><p>{copy("点击「前往授权」直达对应设置，在系统中开启 NuPhy Lab。列表中没有 NuPhy Lab 时，用「＋」添加。返回后会自动检查权限；如系统提示重新打开应用，请按提示操作。", "Choose Allow access and enable NuPhy Lab in System Settings. If it is missing, add it with +. Permissions refresh when you return. Reopen the app if macOS asks you to.")}</p></details><Button kind="ghost" icon={<RotateCcw size={15}/>} busy={busy === "refresh"} disabled={Boolean(busy)} onClick={() => run(perform("refresh"))}>{copy(busy === "refresh" ? "正在检查…" : "重新检查",busy === "refresh" ? "Checking…" : "Check again")}</Button></div>
    {error && <p className="settings-v6-note is-error" role="alert">{error}</p>}
    {Boolean(native.error) && <p className="lab-settings-note">{String(native.error)}</p>}
  </div>;
}

function AboutPreferences({ state }: {state: AppState | null}) {
  const copy = useStartupCopy();
  const [open, setOpen] = useState<"help" | "licenses" | "diagnostics" | null>(null);
  const [licenseText, setLicenseText] = useState<string|null>(null);
  const [licenseError,setLicenseError] = useState(false);
  const [licenseAttempt,setLicenseAttempt] = useState(0);
  const [updateMessage, setUpdateMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const version = state?.build?.version || packageInfo.version;
  useEffect(() => {
    if (open !== "licenses" || licenseText !== null) return;
    let active = true;const controller=new AbortController();setLicenseError(false);
    void fetch(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url).href,{signal:controller.signal}).then(response => {
      if (!response.ok) throw new Error("license unavailable"); return response.text();
    }).then(text => { if(active) setLicenseText(text); }).catch(() => { if(active) setLicenseError(true); });
    return () => {active=false;controller.abort();};
  }, [open,licenseAttempt,licenseText]);
  const checkUpdates = async () => {
    setChecking(true); setUpdateMessage("");
    try { if (!await nativeCodexKeys({kind:"checkForUpdates"})) setUpdateMessage(copy("请在 NuPhy Lab 桌面应用中检查更新。", "Check for updates in the NuPhy Lab desktop app.")); }
    catch {setUpdateMessage(copy("暂时无法检查更新，请稍后重试。","Could not check for updates. Try again shortly."));}
    finally {setChecking(false);}
  };
  const titles = {help:copy("使用帮助", "Help"), licenses:copy("开源许可", "Open-source licenses"), diagnostics:copy("诊断详情", "Diagnostics")};
  const lightingModes:Record<string,string>={idle:copy("键盘原灯效","Keyboard lighting"),native:copy("内置灯效","Built-in lighting"),static:copy("静态灯光","Static lighting"),animation:copy("动画播放","Animation"),paused:copy("已暂停","Paused"),agent:copy("AI 状态灯","AI status lights"),audio:copy("声音律动","Audio reactive"),trigger:copy("按键触发","Key trigger"),game:copy("灯光游戏","Lighting games")};
  const connectionModes:Record<string,string>={ready:copy("已连接","Connected"),paused:copy("已暂停","Paused"),waiting:copy("等待连接","Waiting for connection"),reconnecting:copy("正在重新连接","Reconnecting"),attention:copy("连接暂时中断","Connection interrupted"),updateRequired:copy("请更新 NuPhy Lab","Update NuPhy Lab")};
  const diagnosticRows:[string,string][]=[
    [copy("应用版本","App version"),state ? version : "—"],
    [copy("平台","Platform"),state ? state.build ? `${state.build.platform || "macOS"} · ${state.build.arch || "—"}` : copy("浏览器预览","Browser preview") : "—"],
    [copy("键盘","Keyboard"),!state ? "—" : state.device.connected || state.bluetooth?.connected ? state.device.model || state.device.modelId || "—" : copy("未连接","Disconnected")],
    [copy("键盘固件","Keyboard firmware"),state?.firmware?.current || state?.device.firmware || "—"],
    [copy("灯光状态","Lighting status"),state ? lightingModes[state.playback.mode] || state.playback.mode || "—" : "—"],
    [copy("连接状态","Connection status"),state ? state.bluetooth?.connected && !state.device.connected ? copy("蓝牙已连接","Bluetooth connected") : connectionModes[state.device.connection?.status || ""] || copy(state.device.connected ? "已连接" : "未连接",state.device.connected ? "Connected" : "Disconnected") : "—"],
  ];
  const diagnosticError=state?.device.error || state?.playback.lastError;
  return <div className="lab-about-preferences">
    <div className="lab-about-brand"><img src="/nuphy-studio.png" alt="NuPhy Lab" width={64} height={64}/><div><h2>NuPhy Lab</h2><p>{copy("版本", "Version")} {version}</p></div><Button busy={checking} onClick={() => run(checkUpdates())}>{copy("检查更新", "Check for updates")}</Button></div>
    {updateMessage && <p className="lab-settings-note" role="status">{updateMessage}</p>}
    <div className="lab-setting-panel lab-about-links">{(["help","licenses","diagnostics"] as const).map(id => <button key={id} onClick={() => setOpen(id)}>{titles[id]}<ChevronRight size={16}/></button>)}</div>
    {open && <Modal title={titles[open]} width={open === "licenses" ? 640 : 560} initialFocus="title" className="settings-overlay-v6" onClose={() => setOpen(null)} footer={<>
      {open === "licenses" && licenseError && <Button onClick={()=>setLicenseAttempt(value=>value+1)}>{copy("重试","Retry")}</Button>}
      <Button kind="primary" onClick={()=>setOpen(null)}>{copy("完成","Done")}</Button>
    </>}>
      {open === "help" && <div className="settings-v6-help">
        <section><h3>{copy("灯光与作品","Lighting and artwork")}</h3><p>{copy("连接键盘后，在「灯光创作」绘制、编辑动画或跟随声音；作品保存在这台 Mac。","Connect your keyboard to paint, animate or follow audio in Lighting studio. Artwork is saved on this Mac.")}</p></section>
        <section><h3>{copy("设备与设置","Device and settings")}</h3><p>{copy("在「设备」选择 Air 右上角的旋钮或 Del 键帽预览。在「设置」管理语言、灯光时间和 Mac 权限。","Choose the Air knob or Del keycap preview in Device. Manage language, lighting timers and Mac permissions in Settings.")}</p></section>
        <section><h3>{copy("连接键盘","Connect your keyboard")}</h3><p>{copy("灯光播放需要 USB 有线连接。请关闭其他键盘设置软件，避免同时控制键盘。","Lighting playback requires USB. Close other keyboard apps to avoid competing controls.")}</p></section>
      </div>}
      {open === "licenses" && (licenseError ? <div className="overlay-error" role="alert">{copy("暂时无法读取许可文件。可查看随应用提供的 THIRD_PARTY_NOTICES.md。","Could not load the license file. See THIRD_PARTY_NOTICES.md provided with the app.")}</div> : licenseText === null ? <div className="settings-v6-loading" role="status">{copy("正在读取…","Loading…")}</div> : <pre className="settings-v6-license">{licenseText}</pre>)}
      {open === "diagnostics" && <><dl className="settings-v6-diagnostics">{diagnosticRows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {diagnosticError && <section className="settings-v6-diagnostic-error"><h3>{copy("最近错误","Latest error")}</h3><div className="overlay-error" role="status">{diagnosticError}</div></section>}
        {!state && <div className="overlay-notice">{copy("当前没有可用的诊断数据，稍后重新打开此窗口。","No diagnostic data is available. Open this window again later.")}</div>}
      </>}
    </Modal>}
  </div>;
}

export function Settings({ state, command, initialTab = "general", display, onNavigateStudio }: {state: AppState | null; command: Command; initialTab?: SettingsTab; display?: ConnectionDisplay; onNavigateStudio?: () => void}) {
  const copy = useStartupCopy();
  const language = useLanguage();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  const tabs: [SettingsTab,string][] = [["general",copy("通用", "General")],["lighting",copy("灯光与休眠", "Lighting and sleep")],["permissions",copy("权限", "Permissions")],["about",copy("关于", "About")]];
  return <section className="lab-settings-page">
    <div className="lab-settings-tabs" role="tablist" aria-label={copy("设置分类", "Settings categories")}>{tabs.map(([id,label]) => <button key={id} id={`settings-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`settings-panel-${id}`} onClick={() => setTab(id)}>{label}</button>)}</div>
    <div className="lab-settings-content" id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
      {tab === "general" && <div className="lab-setting-panel lab-general-panel"><div className="lab-setting-row"><h3>语言 / Language</h3><select aria-label="Language / 语言" disabled={!state} value={language} onChange={event => run(command({op: "settings", settings: {language:event.target.value}}))}><option value="zh-CN">简体中文</option><option value="en">English</option></select></div><div className="lab-setting-row"><Switch label={copy("插线后自动连接", "Connect automatically when plugged in")} disabled={!state} checked={Boolean(state?.settings.autoConnect)} onChange={autoConnect => run(command({op:"settings",settings:{autoConnect}}))}/></div></div>}
      {tab === "lighting" && <LightingPreferences state={state} command={command} display={display} onNavigateStudio={onNavigateStudio}/>}
      {tab === "permissions" && <PermissionPreferences state={state} command={command}/>}
      {tab === "about" && <AboutPreferences state={state}/>}
    </div>
  </section>;
}
