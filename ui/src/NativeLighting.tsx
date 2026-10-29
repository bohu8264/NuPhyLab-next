import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Paintbrush, Play, RotateCcw } from "lucide-react";
import { Keyboard } from "./Keyboard";
import { ColorWheel } from "./ColorWheel";
import { Button, run } from "./primitives";
import { t } from "./i18n";
import type { AppState, Command, Key } from "./types";
import type { HSV } from "../../shared/color.mjs";

// Official Kick75 SelfDevKeyboardLightMode values; mode 0 is not an editable
// stock effect. Firmware 4.0.15.6 exposes these through its D5/D6 state.
const modes = [
  [1, "光谱"], [2, "阶梯"], [3, "静态"], [4, "呼吸"], [5, "百花"],
  [6, "波浪"], [7, "上下波浪"], [8, "喷泉"], [9, "银河"], [10, "旋转"],
  [11, "涟漪"], [12, "单点"], [13, "宫格"], [14, "流光"], [15, "落雨"],
  [16, "波带"], [17, "游戏灯效"], [18, "定位"], [19, "风车"], [20, "双标"],
] as const;
const fixedPalette = new Set([1, 5, 16, 20]);
const fixedSpeed = new Set([2, 3]);
type Config = { mode: number; brightness: number; speed: number; color: string };
function fromState(value: unknown): Config {
  const bytes = Array.isArray(value) ? value : [];
  const byte = (index: number, fallback: number) => Number.isInteger(bytes[index]) ? bytes[index] : fallback;
  const mode = byte(0, 3);
  return {
    mode: mode >= 1 && mode <= 20 ? mode : 3,
    brightness: Math.max(0, Math.min(100, byte(1, 60))),
    speed: Math.max(0, Math.min(4, byte(2, 2))),
    color: "#" + [6, 7, 8].map(i => Math.max(0, Math.min(255, byte(i, 120))).toString(16).padStart(2, "0")).join(""),
  };
}
export function NativeLighting({ state, layout, command, onOffline, onDevice }:{
  state: AppState; layout: Key[]; command: Command; onOffline: () => void; onDevice: () => void;
}) {
  const [config, setConfig] = useState(() => fromState(state.device.state));
  const [busy, setBusy] = useState("");
  const [applied, setApplied] = useState(false);
  const dirty = useRef(false), colorMemory = useRef<HSV | null>(null);
  const liveSignature = JSON.stringify(state.device.state);
  useEffect(() => {
    if (!dirty.current) setConfig(fromState(state.device.state));
  }, [liveSignature]);
  const change = (patch: Partial<Config>) => { dirty.current = true; setApplied(false); setConfig(value => ({...value, ...patch})); };
  const canColor = !fixedPalette.has(config.mode), canSpeed = !fixedSpeed.has(config.mode);
  const apply = async () => {
    setBusy("apply");
    try {
      await command({op: "nativeLighting", mode: config.mode, brightness: config.brightness, speed: config.speed,
        ...(canColor ? {color: config.color} : {})});
      dirty.current = false;
      setApplied(true);
    } finally { setBusy(""); }
  };
  const restore = async () => {
    setBusy("restore");
    try { dirty.current = false; await command({op: "restore"}); setApplied(false); }
    finally { setBusy(""); }
  };
  const preview = canColor ? config.color : "#71958b";
  const previewColor = "#" + [1, 3, 5].map(i => Math.round(parseInt(preview.slice(i, i + 2), 16) * config.brightness / 100).toString(16).padStart(2, "0")).join("");
  const readback = state.playback.mode === "native" && !dirty.current && state.colors.length >= 80;
  return <section className="native-lighting-page studio-page">
    <header className="page-heading"><div><h1>Kick75 {t("原生灯效")}</h1><p>{t("调整键盘自带的整键盘灯光。")} {state.device.firmware}</p></div>
      <Button icon={<Paintbrush size={16}/>} onClick={onOffline}>{t("离线绘图")}</Button>
    </header>
    <div className="wireless-notice native-capability-notice" role="status">
      <div><strong>{t("当前固件支持原生灯效")}</strong><p>{t("当前固件不支持逐键灯效；升级到官方 4.0.18.6 后可使用绘图、动画、按键触发、游戏和声音律动。")}</p></div>
      <Button icon={<ArrowUpRight size={15}/>} onClick={onDevice}>{t("查看固件更新")}</Button>
    </div>
    <div className="native-lighting-preview">
      <div className="keyboard-area"><Keyboard layout={layout} colors={readback ? state.colors : Array(84).fill(previewColor)}/></div>
      <p className="muted">{t(readback ? "上次回读颜色 · 动态效果以实体键盘为准，旋钮不作为按键灯。" : "颜色示意 · 动态效果以实体键盘为准，旋钮不作为按键灯。")}</p>
    </div>
    <section className="native-lighting-controls">
      <div className="native-lighting-parameters">
        <label className="form-field"><span>{t("原生灯效")}</span><select aria-label={t("原生灯效")} value={config.mode}
          disabled={!!busy} onChange={event => change({mode: Number(event.target.value)})}>
          {modes.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select></label>
        <label className="native-lighting-slider"><span>{t("亮度")}<output>{config.brightness}%</output></span>
          <input aria-label={t("原生灯效亮度")} type="range" min="0" max="100" value={config.brightness} disabled={!!busy}
            onChange={event => change({brightness: Number(event.target.value)})}/></label>
        <label className="native-lighting-slider"><span>{t("速度")}<output>{5 - config.speed} / 5</output></span>
          <input aria-label={t("原生灯效速度")} type="range" min="1" max="5" value={5 - config.speed} disabled={!!busy || !canSpeed}
            onChange={event => change({speed: 5 - Number(event.target.value)})}/></label>
        {!canSpeed && <p className="muted">{t("此灯效使用固定速度。")}</p>}
        <div className="native-lighting-actions"><Button kind="primary" icon={applied ? <Check size={16}/> : <Play size={16}/>}
          busy={busy === "apply"} disabled={!!busy || !state.device.connected || state.device.capabilities?.stockEffects !== true}
          onClick={() => run(apply())}>{t(applied ? "已应用到键盘" : "应用到键盘")}</Button>
          <Button icon={<RotateCcw size={16}/>} busy={busy === "restore"} disabled={!!busy || !state.device.connected}
            onClick={() => run(restore())}>{t("恢复原有灯效")}</Button></div>
        {!state.device.connected && <p className="muted">{t("连接 Kick75 数据线后可应用原生灯效。")}</p>}
      </div>
      <div className="native-lighting-color" inert={!!busy}><h3>{t("颜色")}</h3>
        {canColor ? <ColorWheel color={config.color} onChange={color => change({color})} memory={colorMemory}/> :
          <p className="muted">{t("此灯效使用键盘内置配色。")}</p>}
      </div>
    </section>
    <p className="muted native-lighting-footnote">{t("应用前会备份当前灯效；点击恢复可还原。AIR75 V3 继续保留完整逐键创作功能。")}</p>
  </section>;
}
