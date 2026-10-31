import { rangeStyle } from "./rangeStyle";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Paintbrush, Play, RotateCcw } from "lucide-react";
import { Keyboard } from "./Keyboard";
import { ColorWheel } from "./ColorWheel";
import { Button, run } from "./primitives";
import {readAppState} from './api';
import { t } from "./i18n";
import { useStartupCopy } from "./StartupGuide";
import "./library-native-v5.css";
import './inline-overlays-v6.css';
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
  const copy = useStartupCopy();
  const [hex, setHex] = useState("");
  const [config, setConfig] = useState(() => fromState(state.device.state));
  const [busy, setBusy] = useState("");
  const [error,setError]=useState(''),[hexError,setHexError]=useState(''),[colorExpanded,setColorExpanded]=useState(false);
  const pending=useRef(false);
  const [applied, setApplied] = useState(false);
  const dirty = useRef(false), colorMemory = useRef<HSV | null>(null);
  const liveSignature = JSON.stringify(state.device.state);
  useEffect(() => {
    if (!dirty.current) setConfig(fromState(state.device.state));
  }, [liveSignature]);
  const change = (patch: Partial<Config>) => { dirty.current = true; setApplied(false); setError('');if(patch.color)setHexError('');setConfig(value => ({...value, ...patch})); };
  useEffect(() => { setHex(config.color.toUpperCase()); }, [config.color]);
  const canColor = !fixedPalette.has(config.mode), canSpeed = !fixedSpeed.has(config.mode);
  const validateHex=()=>{
    const next=(hex.startsWith('#')?hex:`#${hex}`).toUpperCase();
    if(!/^#[0-9A-F]{6}$/.test(next)){setHexError('请输入 6 位十六进制颜色，如 #D8887F。');return null;}
    setHexError('');setHex(next);if(next!==config.color.toUpperCase())change({color:next});return next;
  };
  const apply = async () => {
    if(pending.current)return;
    const color=canColor?validateHex():null;if(canColor&&!color)return;
    pending.current=true;setError('');
    setBusy("apply");
    try {
      await command({op: "nativeLighting", mode: config.mode, brightness: config.brightness, speed: config.speed,
        ...(canColor ? {color} : {})},{silent:true});
      dirty.current = false;
      setApplied(true);
    } catch(error){
      const latest=await readAppState().catch(()=>null),actual=latest?fromState(latest.device.state):null;
      if(latest?.playback.mode==='native'&&actual?.mode===config.mode&&actual.brightness===config.brightness&&actual.speed===config.speed&&(!canColor||actual.color.toUpperCase()===color)){dirty.current=false;setApplied(true);}
      else setError(error instanceof Error?error.message:'操作未完成，请重试。');
    } finally { pending.current=false;setBusy(""); }
  };
  const restore = async () => {
    if(pending.current)return;pending.current=true;setError('');
    setBusy("restore");
    try { await command({op: "restore"},{silent:true});dirty.current = false;setApplied(false);setHexError(''); }
    catch(error){setError(error instanceof Error?error.message:'操作未完成，请重试。');}
    finally { pending.current=false;setBusy(""); }
  };
  const preview = canColor ? config.color : "#71958b";
  const previewColor = "#" + [1, 3, 5].map(i => Math.round(parseInt(preview.slice(i, i + 2), 16) * config.brightness / 100).toString(16).padStart(2, "0")).join("");
  const readback = state.playback.mode === "native" && !dirty.current && state.colors.length >= 80;
  const hexField=<div className="lab-native-hex"><input type="color" aria-label={copy("灯效颜色", "Effect color")} value={config.color} disabled={!!busy} onChange={event => change({color:event.target.value})}/><input aria-label={copy("颜色 HEX", "Color HEX")} aria-invalid={!!hexError} aria-describedby={hexError?'native-color-error':undefined} value={hex} maxLength={7} disabled={!!busy} onChange={event => {setHex(event.target.value);setHexError('');setApplied(false);}} onBlur={validateHex} onKeyDown={event => {if(event.key === "Enter"){event.preventDefault();validateHex();}if(event.key==='Escape'){setHex(config.color.toUpperCase());setHexError('');}}}/></div>;
  return <section className="lab-native-page">
    <div className="lab-native-workrow"><div><h2>{copy("Kick75 内置灯效", "Kick75 built-in lighting")}</h2><p>{copy("旧固件兼容状态", "Legacy firmware compatibility")}</p></div><Button kind="primary" icon={applied ? <Check size={16}/> : <Play size={16}/>} busy={busy === "apply"} disabled={!!busy || !state.device.connected || state.device.capabilities?.stockEffects !== true} onClick={() => run(apply())}>{copy(applied ? "已应用到键盘" : "应用内置灯效", applied ? "Applied to keyboard" : "Apply built-in effect")}</Button></div>
    <div className="lab-native-grid"><div className="lab-native-canvas">
      <div className="lab-native-intro"><h3>{copy("当前固件支持键盘内置灯效", "Built-in lighting is available on this firmware")}</h3><p>{copy("升级固件后可使用逐键创作。", "Update firmware to enable per-key creation.")}</p></div>
      <div className="lab-native-keyboard"><Keyboard layout={layout} colors={readback ? state.colors : Array(84).fill(previewColor)}/></div>
      <div className="lab-native-canvas-actions"><Button kind="ghost" icon={<RotateCcw size={16}/>} busy={busy === "restore"} disabled={!!busy || !state.device.connected} onClick={() => run(restore())}>{copy("恢复原灯效", "Restore lighting")}</Button><Button kind="ghost" icon={<Paintbrush size={16}/>} onClick={onOffline}>{copy("进入离线绘图", "Open offline drawing")}</Button></div>
      {error&&<div className="inline-v6-notice inline-v6-error" role="alert">{t(error)}</div>}
      <details className="lab-native-preview-note inline-v6-details"><summary>{copy("预览说明", "About this preview")}</summary><div className="inline-v6-detail-body"><p>{t(readback ? "上次回读颜色 · 动态效果以实体键盘为准，旋钮不作为按键灯。" : "颜色示意 · 动态效果以实体键盘为准，旋钮不作为按键灯。")}</p><p>{copy("应用前会备份当前灯效；点击恢复可还原。", "Current lighting is backed up before applying. Use Restore to return to it.")}</p></div></details>
    </div><aside className="lab-native-inspector">
      <h2>{copy("内置灯效", "Built-in effect")}</h2>
      <select aria-label={t("原生灯效")} value={config.mode} disabled={!!busy} onChange={event => change({mode:Number(event.target.value)})}>{modes.map(([value,label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
      <label className="lab-native-slider"><span>{t("亮度")}<output>{config.brightness}%</output></span><input aria-label={t("原生灯效亮度")} type="range" min="0" max="100" value={config.brightness} style={rangeStyle(config.brightness)} disabled={!!busy} onChange={event => change({brightness:Number(event.target.value)})}/></label>
      <label className="lab-native-slider"><span>{t("速度")}<output>{5 - config.speed} / 5</output></span><input aria-label={t("原生灯效速度")} type="range" min="1" max="5" value={5-config.speed} style={rangeStyle(5-config.speed,1,5)} disabled={!!busy || !canSpeed} onChange={event => change({speed:5-Number(event.target.value)})}/></label>
      {!canSpeed && <p className="lab-native-speed-note">{t("此灯效使用固定速度。")}</p>}
      <div className="lab-native-color" inert={!!busy}><h3>{t("颜色")}</h3>{canColor ? <>{!colorExpanded&&hexField}<details className="lab-native-color-wheel inline-v6-details" open={colorExpanded} onToggle={event=>setColorExpanded(event.currentTarget.open)}><summary>{copy("更多颜色", "More colors")}</summary><ColorWheel color={config.color} onChange={color => change({color})} memory={colorMemory} entry={hexField}/><label className="lab-native-system-picker"><input type="color" aria-label={t('选择颜色…')} value={config.color} disabled={!!busy} onChange={event=>change({color:event.target.value})}/><span>{t('选择颜色…')}</span><ArrowUpRight size={14}/></label></details>{hexError&&<p id="native-color-error" className="inline-v6-field-error" role="alert">{t(hexError)}</p>}</> : <p>{t("此灯效使用键盘内置配色。")}</p>}</div>
      <Button kind="ghost" icon={<ArrowUpRight size={16}/>} onClick={onDevice}>{t("查看固件更新")}</Button>
    </aside></div>
  </section>;
}
