import {AmbientLightingPreferences} from './AmbientLightingPreferences';
import {SelectionAPISettings, SelectionPermissionSettings} from "./SelectionLab";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronRight, CircleHelp, RotateCcw, Sun } from "lucide-react";
import { Button, Modal, run, Switch } from "./primitives";
import { DurationField } from "./DurationField";
import { DEFAULT_LIGHT_TIME_MS, lightingTimerDeadline } from "../../shared/lighting-power.mjs";
import { useStartupCopy, OFFICIAL_DRIVER_URL } from "./StartupGuide";
import { useLanguage, t } from "./i18n";
import type { AppState, Command } from "./types";
import packageInfo from "../../package.json";
import { readAppState } from "./api";
import type { ConnectionDisplay } from "../../shared/connection-display.mjs";
import { connectionCopy } from "./connection-copy-v7";
import { UpdatePreferences } from "./UpdatePreferences";
import { availableFirmwareUpdate } from "../../shared/firmware-onboarding.mjs";
import type { OutputColorProfile, OutputColorProfileStatus } from "../../shared/output-color-profile.mjs";
import "./device-settings-v5.css";
import "./settings-overlays-v6.css";
import "./action-reasons-v7.css";

type SettingsTab = "ai" | "general" | "lighting" | "permissions" | "updates" | "about";
const timeOptions = [0, 60000, 300000, 900000, 1800000, 3600000, 7200000];

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
    { key: "lightDurationMs", label: copy("每次亮灯时长", "Lighting duration"), detail: copy("从播放或重新计时起计算；到时熄灭，空闲唤醒不会延长。", "Counts from playback or Restart timer. Idle activity does not extend this deadline.") },
    { key: "lightIdleMs", label: copy("空闲多久后休眠", "Sleep when idle"), detail: copy("持续无操作会提前休眠；总时长未到时，继续操作自动唤醒。", "Inactivity can sleep the lights earlier. Activity wakes them while the duration has not expired.") },
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
  const durationLimit = Number(state?.settings.lightDurationMs ?? 0), idleLimit = Number(state?.settings.lightIdleMs ?? 0);
  const deadline = lightingTimerDeadline(power,{lightDurationMs:durationLimit,lightIdleMs:idleLimit});
  const remaining = deadline.nextSleepInMs;
  const timerTitle = timerStateUnknown ? copy("当前计时", "Current timer") : power?.sleeping ? copy(power.reason === "duration" ? "灯光计时已结束" : "空闲休眠中", power.reason === "duration" ? "Lighting timer ended" : "Sleeping while idle") : copy("当前计时", "Current timer");
  const countdown = timerStateUnknown ? connectionCopy(display?.sidebar)
    : noLightingSession ? copy("当前未播放键盘灯光。","No keyboard lighting session is active.")
    : power?.sleeping ? power.reason === "idle"
      ? copy("继续操作会唤醒；本次亮灯总时长继续计时。", "Activity wakes the lights; the current duration keeps counting down.")
      : copy("点击重新亮灯即可开始新的计时。", "Restart the lights to begin a new timer.")
    : remaining == null ? copy("当前未设置亮灯时限。", "No lighting time limit is active.")
    : copy(deadline.nextSleepReason === "idle" ? "若无操作，将在此时间后休眠" : "本次亮灯剩余时间", deadline.nextSleepReason === "idle" ? "If inactive, sleep in" : "Lighting duration remaining") + " " + timeLabel(Math.max(1000, Math.ceil(remaining / 60000) * 60000));
  return <div className="lab-lighting-preferences">
    <div className="lab-settings-intro"><h2>{copy("灯光与休眠", "Lighting and sleep")}</h2><p>{copy("计时适用于普通作品。两项分别计时，先到先熄灯；AI 状态灯持续显示，关闭模式后才停止。", "Timers apply to ordinary artwork. The first deadline sleeps the lights; AI status lights stay on until the mode is turned off.")}</p></div>
    <AmbientLightingPreferences state={state} command={command}/>
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
    {durationLimit > 0 && idleLimit > 0 && idleLimit < durationLimit && <p className="lab-settings-note" role="status">{copy(`亮灯时长为 ${timeLabel(durationLimit)}，空闲休眠为 ${timeLabel(idleLimit)}；持续无操作时会先进入空闲休眠。`, `Lighting duration is ${timeLabel(durationLimit)} and idle sleep is ${timeLabel(idleLimit)}. Continued inactivity reaches idle sleep first.`)}</p>}
    {state?.device.capabilities?.boardSleepLease === true
      ? <p className="lab-settings-note">{copy("Lab 播放灯光时按本页设置计时，避免键盘自身休眠提前关灯；停止播放或退出后恢复键盘原来的休眠设置。", "While Lab controls lighting, these timers take priority over the keyboard's own sleep. Stopping playback or quitting restores the keyboard's original sleep settings.")}</p>
      : state?.device.modelId === "air75-v3" && <p className="lab-settings-note">{copy("Air75 V3 自身另有自动休眠，开启时约 6 分钟无键盘输入会熄灯，不受本页时长控制。若灯光早于这里的计时熄灭，请检查键盘自身的休眠设置。", "Air75 V3 also has its own auto sleep. When enabled, about 6 minutes without keyboard input can turn off its lights independently of these timers. If lighting stops earlier, check the keyboard's sleep setting.")} <a href={OFFICIAL_DRIVER_URL}>{copy("打开 NuPhyIO 设置", "Open NuPhyIO settings")}<ArrowUpRight size={13} aria-hidden="true"/></a></p>}
    <div className="lab-lighting-summary-stack">
    <div className={`lab-setting-panel lab-current-timer ${noLightingSession?"v7-timer-unavailable":""}`}><div><h3>{timerTitle}</h3><p>{countdown}</p></div><Button kind={power?.sleeping ? "primary" : "secondary"} icon={power?.sleeping ? <Sun size={16}/> : <RotateCcw size={16}/>} busy={busy} disabled={!state?.device.armed || nativeOnly} aria-describedby={noLightingSession||nativeOnly?"lighting-timer-unavailable":undefined} onClick={() => run(wake())}>{copy(power?.sleeping ? "重新亮灯" : "重新计时", power?.sleeping ? "Restart lighting" : "Restart timer")}</Button>
      {noLightingSession&&<p id="lighting-timer-unavailable" className="v7-timer-action-reason" role="status">{connectionReason&&<span>{connectionReason}</span>}<span>{copy("开始键盘灯光后可重新计时；仍可修改时长与休眠设置。","Start keyboard lighting to restart its timer. Duration and sleep settings can still be edited.")}</span>{onNavigateStudio&&<button type="button" className="text-button v7-action-link v7-timer-studio-link" onClick={onNavigateStudio}>{copy("前往灯光创作","Go to lighting studio")}<ChevronRight size={16} aria-hidden="true"/></button>}</p>}
    </div>
    {timerError && <p className="settings-v6-note is-error" role="alert">{t(timerError)}</p>}
    <OutputColorPreferences state={state} command={command} serviceUnknown={timerStateUnknown}/>
    </div>
    {nativeOnly && <p id="lighting-timer-unavailable" className="lab-settings-note">{copy("当前固件使用键盘内置灯效；升级后可使用灯光计时。", "Built-in lighting is active. Update firmware to use lighting timers.")}</p>}
    {power?.systemIdleAvailable === false && <p className="lab-settings-note">{copy("系统空闲时间暂不可读，当前仅根据本应用内的操作判断空闲。", "System idle time is unavailable. Idle detection currently uses activity in this app.")}</p>}
    <details className="lab-settings-help"><summary><CircleHelp size={15}/>{copy("计时说明", "About timers")}</summary><p>{copy("自定义时间支持 1 秒至 24 小时；设为 0 或选择「不限」只关闭对应计时。空闲休眠后，使用键盘、鼠标或操作本应用会自动唤醒，但不会重新开始本次总时长；总时长到期需手动重新亮灯。休眠时动画和游戏暂停推进，不记录按键内容。", "Custom times range from 1 second to 24 hours. Set 0 or choose Unlimited to disable only that timer. Keyboard, mouse or app activity wakes idle lighting without restarting the duration. An expired duration requires Restart lighting. Animations and games pause during sleep; key content is not recorded.")}</p></details>
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
    {error && <p className="settings-v6-note is-error" role="alert">{t(error)}</p>}
  </section>;
}



function AboutPreferences({ state, command }: {state: AppState | null; command: Command}) {
  const copy = useStartupCopy();
  const [open, setOpen] = useState<"help" | "licenses" | "diagnostics" | null>(null);
  const [licenseText, setLicenseText] = useState<string|null>(null);
  const [licenseError,setLicenseError] = useState(false);
  const [licenseAttempt,setLicenseAttempt] = useState(0);
  const version = state?.build?.version || packageInfo.version;
  useEffect(() => {
    if (open !== "licenses" || licenseText !== null) return;
    let active = true;const controller=new AbortController();setLicenseError(false);
    void fetch(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url).href,{signal:controller.signal}).then(response => {
      if (!response.ok) throw new Error("license unavailable"); return response.text();
    }).then(text => { if(active) setLicenseText(text); }).catch(() => { if(active) setLicenseError(true); });
    return () => {active=false;controller.abort();};
  }, [open,licenseAttempt,licenseText]);
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
    <UpdatePreferences state={state} command={command}/>
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
        {diagnosticError && <section className="settings-v6-diagnostic-error"><h3>{copy("最近错误","Latest error")}</h3><div className="overlay-error" role="status">{t(diagnosticError)}</div></section>}
        {!state && <div className="overlay-notice">{copy("当前没有可用的诊断数据，稍后重新打开此窗口。","No diagnostic data is available. Open this window again later.")}</div>}
      </>}
    </Modal>}
  </div>;
}

export function Settings({ state, command, initialTab = "general", display, onNavigateStudio }: {state: AppState | null; command: Command; initialTab?: SettingsTab; display?: ConnectionDisplay; onNavigateStudio?: () => void}) {
  const copy = useStartupCopy();
  const language = useLanguage();
  const normalizeTab = (value: SettingsTab): SettingsTab => value === "updates" ? "about" : value;
  const [tab, setTab] = useState<SettingsTab>(normalizeTab(initialTab));
  useEffect(() => { setTab(normalizeTab(initialTab)); }, [initialTab]);
  const tabs: [SettingsTab,string][] = [["general",copy("通用", "General")],["ai",copy("模型与 API","Models & API")],["lighting",copy("灯光与休眠", "Lighting and sleep")],["permissions",copy("权限", "Permissions")],["about",copy("关于与更新", "About & updates")]];
  return <section className="lab-settings-page">
    <div className="lab-settings-tabs" role="tablist" aria-label={copy("设置分类", "Settings categories")}>{tabs.map(([id,label]) => <button key={id} id={`settings-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`settings-panel-${id}`} onClick={() => setTab(id)}>{label}{id==='about'&&availableFirmwareUpdate(state)&&<i className="settings-update-dot" aria-label={copy('键盘固件有可用更新','Keyboard firmware update available')}/>}</button>)}</div>
    <div className="lab-settings-content" id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
      {tab === "ai" && <SelectionAPISettings/>}
      {tab === "general" && <div className="lab-setting-panel lab-general-panel"><div className="lab-setting-row"><h3>{copy("语言 / Language", "Language")}</h3><select aria-label={copy("Language / 语言", "Language")} disabled={!state} value={language} onChange={event => run(command({op: "settings", settings: {language:event.target.value}}))}><option value="zh-CN">简体中文</option><option value="en">English</option></select></div><div className="lab-setting-row"><Switch label={copy("插线后自动连接", "Connect automatically when plugged in")} disabled={!state} checked={Boolean(state?.settings.autoConnect)} onChange={autoConnect => run(command({op:"settings",settings:{autoConnect}}))}/></div></div>}
      {tab === "lighting" && <LightingPreferences state={state} command={command} display={display} onNavigateStudio={onNavigateStudio}/>}
      {tab === "permissions" && <SelectionPermissionSettings/>}
      {tab === "about" && <AboutPreferences state={state} command={command}/>}
    </div>
  </section>;
}
