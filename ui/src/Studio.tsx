import { rangeStyle } from "./rangeStyle";
import {lightingUnavailableMessage} from '../../shared/device-status.mjs';
import type {ConnectionDisplay} from '../../shared/connection-display.mjs';
import {canvasCaption,connectionCopy,keyboardActionHint} from './connection-copy-v7';
import { t as tr } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  Folder,
  RotateCcw,
  MousePointer2,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CircleAlert,
  Copy,
  Eraser,
  Heart,
  Paintbrush,
  Pencil,
  Pause,
  Play,
  Plus,
  Redo2,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import "./studio-v5.css";
import './creation-experience-v7.css';
import './studio-play-edit-v8.css';
import './studio-workspace-layout.css';
import {useWorkspaceLayout} from './useWorkspaceLayout';
import { renderAnimation, animationDuration, applyArtworkAppearance, scaleColor } from "../../shared/render-animation.mjs";
import { Keyboard, lightingPeak } from "./Keyboard";
import { ColorWheel } from "./ColorWheel";
import { GamePanel } from "./GamePanel";
import { TriggerPanel } from "./TriggerPanel";
import type { HSV } from "../../shared/color.mjs";
import { Button, run, Switch } from "./primitives";
import { heartColors, DEFAULT_COLOR } from "./presets";
import { blankColors } from "./types";
import type {
  Animation,
  AppState,
  Command,
  Direction,
  Key,
  Notify,
  Scene,
  StudioMode,
} from "./types";

type Props = {
  mode: StudioMode;
  layout: Key[];
  state: AppState | null;
  connectionDisplay?: ConnectionDisplay;
  command: Command;
  draft: Scene;
  setDraft: (scene: Scene) => void;
  onSave: () => void;
  onBrowsePresets: () => void;
  onNavigateDevice?: () => void;
  onEditCodexColors: () => void;
  playRequestId?: string | null;
  playRequestKind?: "animation" | "trigger";
  onPlayRequestHandled?: () => void;
  onPlayRequestFinished?: () => void;
  notify: Notify;
};
const directions: [Direction, string, typeof ArrowUp][] = [
  ["left", "向左", ArrowLeft],
  ["right", "向右", ArrowRight],
  ["up", "向上", ArrowUp],
  ["down", "向下", ArrowDown],
];
const sceneContent = (scene: Scene) => JSON.stringify([
  scene.name, scene.colors, scene.animation.effect, scene.animation.direction,
  scene.animation.speed, scene.animation.loop, scene.animation.hueShift ?? 0, scene.animation.colorOverride?.toLowerCase() ?? null, scene.animation.brightness ?? 100,
  (scene.animation.frames || []).map(frame => [frame.colors, frame.duration]),
  scene.trigger?.code, scene.trigger?.count, scene.trigger?.intervalMs,
]);
const animationContent = (scene: Pick<Scene, "colors" | "animation">) => JSON.stringify([
  scene.colors.map(color => color.toLowerCase()), scene.animation.effect,
  scene.animation.direction, scene.animation.speed, scene.animation.loop, scene.animation.hueShift ?? 0, scene.animation.colorOverride?.toLowerCase() ?? null, scene.animation.brightness ?? 100,
  (scene.animation.frames || []).map(frame => [frame.colors.map(color => color.toLowerCase()), frame.duration]),
]);
const labels: Record<string, string> = {
  static: "静态",
  move: "移动",
  pulse: "呼吸",
  wave: "波浪",
  frames: "逐帧",
};
export function Studio({
  mode: tab,
  layout,
  state,
  connectionDisplay,
  command,
  draft,
  setDraft,
  onSave,
  onBrowsePresets,
  onNavigateDevice,
  onEditCodexColors,
  playRequestId,
  playRequestKind = "animation",
  onPlayRequestHandled,
  onPlayRequestFinished,
  notify,
}: Props) {
  const workspace=useWorkspaceLayout({aspectRatio:layout.length===80?1009/440:959/384,enabled:tab!=='game'});
  const perKeySupported = state?.device.capabilities?.perKey !== false;
  const previewPeak = useMemo(() => lightingPeak([draft.colors, ...(draft.animation.frames || []).map(frame => frame.colors)]
    .map(colors => applyArtworkAppearance(colors, {...draft.animation, brightness: 100}))), [draft.colors, draft.animation]);
  const [tool, setTool] = useState<"paint" | "select" | "erase">("paint");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const colorMemory = useRef<HSV | null>(null);
  const [colorScope,setColorScope] = useState("brush");
  const colorGesture = useRef({active:false,recorded:false});
  const colorTargets = useRef<{signature:string;scope:string;selection:string;indices:number[]}|null>(null);
  const [hex, setHex] = useState(color);
  const [selected, setSelected] = useState<number[]>([]);
  const [live, setLive] = useState(false);
  const [editingPattern, setEditingPattern] = useState(false);
  const [frameEditor, setFrameEditor] = useState<{index:number}|null>(null);
  const [frameColors, setFrameColors] = useState<string[]>([]);
  const [pagePreview, setPagePreview] = useState(false);
  const [previewColors, setPreviewColors] = useState<string[]|null>(null);
  const [reducedMotion,setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    const update=() => setReducedMotion(media.matches);
    media.addEventListener('change',update);update();
    return () => media.removeEventListener('change',update);
  }, []);
  const [undoStack, setUndo] = useState<string[][]>([]);
  const [redoStack, setRedo] = useState<string[][]>([]);
  useEffect(() => {
    setEditingPattern(false); setFrameEditor(null); setPagePreview(false);
    setSelected([]); setUndo([]); setRedo([]);
  }, [tab]);
  const [frameIndex, setFrameIndex] = useState(() => Math.max(0,
    (draft.animation.frames || []).findIndex(frame =>
      frame.colors.every((value, index) => value.toLowerCase() === draft.colors[index]?.toLowerCase()),
    ),
  ));
  const [playBusy, setPlayBusy] = useState(false);
  const playLock = useRef(false);
  const appliedAnimation = useRef<{signature: string; context: string} | null>(null);
  const playbackGeneration = useRef(0);
  const playbackContext = `${state?.device.modelId ?? ""}:${state?.device.connectionSessionId ?? ""}`;
  const animationSignature = animationContent(draft);
  useEffect(() => {
    playbackGeneration.current++;
    appliedAnimation.current = null;
  }, [playbackContext, state?.device.connected]);
  useEffect(() => {
    if (!state || !["animation", "paused"].includes(state.playback.mode) || state.playback.lastError || connectionDisplay?.stateId === "serviceUnknown") {
      playbackGeneration.current++;
      appliedAnimation.current = null;
    }
  }, [state?.playback.mode, state?.playback.lastError, connectionDisplay?.stateId]);
  const [brightness, setBrightness] = useState(70);
  const stroke = useRef(new Set<number>());
  const draftRef = useRef(draft);
  draftRef.current = frameEditor ? { ...draft, colors: frameColors } : draft;
  const draftColorSignature = draft.colors.join("").toLowerCase();
  const liveColorSignature = `${draftColorSignature}:${draft.animation.hueShift ?? 0}:${draft.animation.colorOverride?.toLowerCase() ?? ""}:${draft.animation.brightness ?? 100}`;
  const lastPreview = useRef(liveColorSignature);
  const mounted = useRef(false);
  useEffect(() => {
    if (state) setBrightness(state.settings.brightness);
  }, [state?.settings.brightness]);
  useEffect(() => {
    setHex(color);
  }, [color]);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (
      !live ||
      tab !== "paint" ||
      !perKeySupported ||
      !state?.device.connected ||
      state?.firmware?.compatible === false ||
      state.playback.mode === "game" ||
      state.playback.mode === "agent" ||
      state.playback.mode === "trigger"
    )
      return;
    const signature = liveColorSignature;
    if (signature === lastPreview.current) return;
    const timer = setTimeout(() => {
      // A manual paint submission may have applied this same canvas meanwhile.
      if (signature === lastPreview.current) return;
      lastPreview.current = signature;
      void command({ op: "preview", colors: applyArtworkAppearance(draft.colors, draft.animation) }).catch(() => {
        if (lastPreview.current === signature) lastPreview.current = "";
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [liveColorSignature, live, state?.device.connected, state?.firmware?.compatible, state?.playback.mode, state?.playback.playing, perKeySupported, tab, command]);
  const commit = (colors: string[], history = true) => {
    if (history) {
      const previous = draftRef.current.colors.slice();
      setUndo((stack) => [
        ...stack.slice(-49),
        previous,
      ]);
      setRedo([]);
    }
    const updated={ ...draftRef.current, colors };
    draftRef.current=updated;
    if (frameEditor) setFrameColors(colors);
    else setDraft(updated);
  };
  const changeColor = (nextColor:string) => {
    setColor(nextColor);
    if(colorScope === "brush") return;
    const previous=draftRef.current.colors,signature=previous.join("").toLowerCase(),selection=selected.join(",");
    const cached=colorTargets.current;
    let indices:number[];
    if(cached?.signature===signature && cached.scope===colorScope && cached.selection===selection) indices=cached.indices;
    else if(colorScope === "all") indices=layout.map(k=>k.index);
    else if(selected.length) indices=selected;
    else {indices=layout.filter(k=>previous[k.index]?.toLowerCase()!=="#000000").map(k=>k.index);if(!indices.length)indices=layout.map(k=>k.index);}
    const next=[...previous];indices.forEach(i=>next[i]=nextColor.toLowerCase());
    colorTargets.current={signature:next.join("").toLowerCase(),scope:colorScope,selection,indices};
    if(signature===next.join("").toLowerCase()) return;
    commit(next,!colorGesture.current.active || !colorGesture.current.recorded);
    if(colorGesture.current.active)colorGesture.current.recorded=true;
  };
  const startStroke = () => {
    stroke.current = new Set();
    if (tool !== "select") {
      // Capture before touchKey updates the ref in this same pointer event.
      const previous = draftRef.current.colors.slice();
      setUndo((stack) => [
        ...stack.slice(-49),
        previous,
      ]);
      setRedo([]);
    }
  };
  const touchKey = (index: number) => {
    if (stroke.current.has(index)) return;
    stroke.current.add(index);
    if (tool === "select")
      setSelected((keys) =>
        keys.includes(index)
          ? keys.filter((k) => k !== index)
          : [...keys, index],
      );
    else {
      const next = draftRef.current.colors.slice();
      next[index] = tool === "erase" ? "#000000" : color;
      const updated = { ...draftRef.current, colors: next };
      draftRef.current = updated;
      if (frameEditor) setFrameColors(next);
      else setDraft(updated);
    }
  };
  const undo = () => {
    const previous = undoStack.at(-1);
    if (previous) {
      setRedo((stack) => [...stack, draftRef.current.colors.slice()]);
      setUndo((stack) => stack.slice(0, -1));
      commit(previous, false);
    }
  };
  const redo = () => {
    const next = redoStack.at(-1);
    if (next) {
      setUndo((stack) => [...stack, draftRef.current.colors.slice()]);
      setRedo((stack) => stack.slice(0, -1));
      commit(next, false);
    }
  };
  const setAnimation = (patch: Partial<Animation>) =>
    setDraft({ ...draft, animation: { ...draft.animation, ...patch } });
  const applyHex = () => {
    const next = hex.startsWith("#") ? hex : `#${hex}`;
    if (/^#[0-9a-f]{6}$/i.test(next)) changeColor(next.toUpperCase());
    else {
      setHex(color);
      notify("颜色格式应为 #DC847B");
    }
  };
  const play = async () => {
    if (playLock.current) return;
    if (!state?.device.connected || !perKeySupported || state.firmware?.compatible === false || connectionDisplay?.stateId === "serviceUnknown") {
      notify("当前无法播放到键盘，请检查连接状态。");
      return;
    }
    playLock.current = true;
    setPlayBusy(true);
    const submitted = structuredClone({colors: draft.colors, animation: draft.animation});
    const signature = animationContent(submitted), context = playbackContext, generation = playbackGeneration.current;
    // The paint page applies its canvas, even when the saved artwork also has
    // animation parameters. Only the animation page starts/resumes an effect.
    const staticSubmission = tab === "paint" || submitted.animation.effect === "static";
    const paintSignature = liveColorSignature;
    if (tab === "paint") lastPreview.current = paintSignature;
    appliedAnimation.current = null;
    try {
      await command({
        op: staticSubmission ? "preview" : "play",
        ...submitted,
        colors: staticSubmission ? applyArtworkAppearance(submitted.colors, submitted.animation) : submitted.colors,
      });
      if (!staticSubmission && generation === playbackGeneration.current)
        appliedAnimation.current = {signature, context};
    } catch (error) {
      if (tab === "paint" && lastPreview.current === paintSignature) lastPreview.current = "";
      throw error;
    } finally {
      playLock.current = false;
      setPlayBusy(false);
    }
  };
  const hardwarePlaying = Boolean(state?.playback.playing && state.playback.mode !== "trigger"),
    paused = state?.playback.mode === "paused";
  const currentAnimationApplied = appliedAnimation.current?.signature === animationSignature
    && appliedAnimation.current.context === playbackContext
    && ["animation", "paused"].includes(state?.playback.mode ?? "")
    && !state?.playback.lastError && connectionDisplay?.stateId !== "serviceUnknown";
  const animationNeedsApply = tab === "animation" && (hardwarePlaying || paused) && !currentAnimationApplied;
  const togglePlayback = tab === "animation" && !animationNeedsApply && (hardwarePlaying || paused);
  const pausedDraft = useRef<{ paused: boolean; signature: string }>({
    paused: false,
    signature: draftColorSignature,
  });
  if (paused && !pausedDraft.current.paused) {
    pausedDraft.current = { paused: true, signature: draftColorSignature };
  } else if (!paused) {
    pausedDraft.current.paused = false;
  }
  const outputColors =
    tab === "game" ||
    (tab === "paint" && live && state?.device.armed && state.playback.mode === "static") ||
    (tab === "trigger" && state?.playback.mode === "trigger" && state.trigger?.armed) ||
    (hardwarePlaying && !animationNeedsApply) ||
    (paused &&
      !animationNeedsApply &&
      state?.device.armed &&
      pausedDraft.current.signature === draftColorSignature)
      ? state?.colors || draft.colors
      : draft.colors;
  const frames = draft.animation.frames || [];
  const savedScene = draft.id ? state?.scenes.find(scene => scene.id === draft.id) : undefined;
  const draftSaved = savedScene ? sceneContent(savedScene) === sceneContent(draft) : false;
  const selectedFrame = frames[Math.min(frameIndex, Math.max(0, frames.length - 1))];
  const paintTools = tab === "paint" || Boolean(frameEditor) || editingPattern;
  const showingDraft = tab === "animation" && (!hardwarePlaying || animationNeedsApply) && (!paused || animationNeedsApply);
  const currentColors = frameEditor ? frameColors : paintTools ? draft.animation.colorOverride !== undefined && !editingPattern ? applyArtworkAppearance(draft.colors, draft.animation) : draft.colors : pagePreview && previewColors ? previewColors
    : showingDraft ? applyArtworkAppearance(draft.animation.effect === "frames" ? selectedFrame?.colors || draft.colors : draft.colors, draft.animation)
      : tab === "trigger" && !(state?.playback.mode === "trigger" && state.trigger?.armed) ? applyArtworkAppearance(draft.colors, draft.animation) : outputColors;
  useEffect(() => {
    if (!pagePreview || tab !== "animation" || frameEditor) { setPreviewColors(null); return; }
    const start = performance.now();
    const update = () => {
      const elapsed = performance.now() - start;
      setPreviewColors(renderPageAnimation(draft.colors, draft.animation, elapsed, layout));
      if (elapsed >= animationDuration(draft.animation)) setPagePreview(false);
    };
    update();
    if (reducedMotion) return;
    const timer = window.setInterval(update, 50);
    return () => window.clearInterval(timer);
  }, [pagePreview, tab, frameEditor, draft.colors, draft.animation, layout, reducedMotion]);
  const beginFrame = (index: number) => {
    const frame = frames[index];
    if (!frame) return;
    setPagePreview(false);
    setFrameEditor({ index });
    setFrameColors(frame.colors.slice());
    setUndo([]); setRedo([]); setSelected([]);
  };
  const finishFrame = (apply: boolean) => {
    if (!frameEditor) return;
    const replacesPoster = frames[frameEditor.index]?.colors.every((color, index) => color.toLowerCase() === draft.colors[index]?.toLowerCase());
    if (apply) setDraft({ ...draft, colors: replacesPoster ? frameColors.slice() : draft.colors, animation: {
      ...draft.animation,
      frames: frames.map((frame, index) => index === frameEditor.index ? { ...frame, colors: frameColors.slice() } : frame),
    } });
    setFrameEditor(null); setUndo([]); setRedo([]); setSelected([]);
  };
  const clearSource = frameEditor ? frameColors : tab === "animation" && draft.animation.effect === "frames" ? selectedFrame?.colors || draft.colors : draft.colors;
  const clearCanvas = () => {
    setPagePreview(false);setSelected([]);
    if (!frameEditor && tab === "animation" && draft.animation.effect === "frames" && selectedFrame) {
      beginFrame(Math.min(frameIndex, frames.length - 1));
      setFrameColors(blankColors());setUndo([selectedFrame.colors.slice()]);
    } else {
      if (!paintTools) setEditingPattern(true);
      commit(blankColors());
    }
  };
  const triggerArmed = Boolean(state?.trigger?.armed && state.playback.mode === "trigger");
  // Explain the existing live effect above; this display never changes eligibility.
  const syncHoldReason = !live || tab !== 'paint' ? ''
    : connectionDisplay?.stateId === 'serviceUnknown' ? '同步状态未确认：本地服务未响应。'
    : connectionDisplay?.reasonId && (!perKeySupported || !state?.device.connected || state?.firmware?.compatible === false) ? `同步暂缓：${connectionCopy(connectionDisplay.workTitle)}`
    : !perKeySupported ? `同步暂缓：${tr(lightingUnavailableMessage(state))}`
    : !state?.device.connected ? '同步暂缓：连接 USB 后可同步画布。'
    : state.firmware?.compatible === false ? '同步暂缓：当前固件暂不支持逐键输出。'
    : state.playback.mode === 'agent' ? '同步暂缓：AI 状态灯正在控制输出。'
    : state.playback.mode === 'game' ? '同步暂缓：灯光游戏正在控制输出。'
    : state.playback.mode === 'trigger' ? '同步暂缓：按键触发正在控制输出。' : '';
  const scopeHelp = colorScope === 'brush' ? '只改变之后绘制的颜色。'
    : colorScope === 'all' ? '改色会立即应用到全部可上色按键。'
    : selected.length ? `已选 ${selected.length} 个键；改色会立即生效。`
    : '未选键时改已亮键；全黑时改全部键。';
  // Service colors already include global output brightness, but not the
  // device-only correction. Compare in that same logical color space.
  const paintOutput = tab === "paint" && state?.device.connected && state.device.armed && perKeySupported
    && state.firmware?.compatible !== false && state.playback.mode === "static" && !state.playback.lastError
    ? applyArtworkAppearance(draft.colors, draft.animation).map(color => scaleColor(color, state.settings.brightness / 100)) : null;
  const currentPaintShown = Boolean(paintOutput && state?.colors.length === paintOutput.length
    && state.colors.every((color, index) => color.toLowerCase() === paintOutput[index].toLowerCase()));
  const paintStatus = connectionDisplay?.stateId === "serviceUnknown" ? "同步状态未确认：本地服务未响应。"
    : state?.lightPower?.sleeping ? "灯光已休眠"
    : syncHoldReason || (currentPaintShown ? "当前画布已同步到键盘"
      : state?.device.connected && state.device.armed && state.playback.mode !== "idle" ? "正在显示其他输出；当前画布待应用"
      : "当前画布待应用到键盘");
  const status = tab === "paint" ? paintStatus : state?.lightPower?.sleeping ? "灯光已休眠" : !state?.device.connected ? "连接 USB 后即可播放到键盘"
    : tab === "trigger" ? triggerArmed ? state?.trigger?.flashing ? "正在闪烁" : "等待按键 · 键盘保持熄灭" : "未启用按键触发"
    : animationNeedsApply ? "点击「更新播放」应用当前动画。"
    : paused ? "播放已暂停" : hardwarePlaying ? "正在显示当前画布" : "尚未播放到键盘";
  const triggerAction = async (newPattern = false) => {
    if (!state?.device.connected || !perKeySupported || state.firmware?.compatible === false || connectionDisplay?.stateId === "serviceUnknown") {
      notify("当前无法播放到键盘，请检查连接状态。");
      return;
    }
    if ((!triggerArmed || newPattern) && !applyArtworkAppearance(draft.colors, draft.animation).some(value => value.toLowerCase() !== "#000000")) {
      notify((draft.animation.brightness ?? 100) === 0 ? "作品亮度为 0%，调高亮度后可启用按键触发。" : "当前没有亮起的按键，先选一个图案。");
      return;
    }
    setPlayBusy(true);
    try {
      if (triggerArmed && !newPattern) await command({ op: "triggerStop" });
      else await command({ op: "triggerArm", colors: applyArtworkAppearance(draft.colors, draft.animation), trigger: draft.trigger || { code: "Space", count: 3, intervalMs: 600 } });
    } finally { setPlayBusy(false); }
  };
  const handledPlayRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!playRequestId || handledPlayRequest.current === playRequestId) return;
    handledPlayRequest.current = playRequestId;
    onPlayRequestHandled?.();
    run((async () => {
      try { await (playRequestKind === "trigger" ? triggerAction(true) : play()); }
      finally { onPlayRequestFinished?.(); }
    })());
  }, [playRequestId]);
  const paintPanel = (
    <aside className="v5-properties v5-paint-properties">
      <h3>{tr("画笔颜色")}</h3>
      {(Boolean(draft.animation.hueShift) || draft.animation.colorOverride !== undefined || (draft.animation.brightness ?? 100) !== 100) && <p className="v8-palette-help">{tr("这里编辑原始颜色；整体配色与亮度在预览和播放时统一应用。")}</p>}
      <div className="v7-color-scope-field">
      <label htmlFor="studio-color-scope">{tr("颜色应用范围")}</label>
      <select id="studio-color-scope" className="v5-color-scope" aria-label={tr("颜色应用范围")} aria-describedby="studio-color-scope-help" value={colorScope} onChange={event => setColorScope(event.target.value)}>
        <option value="brush">{tr("仅画笔")}</option>
        <option value="pattern">{tr(selected.length ? `选中按键（${selected.length}）` : "当前图案")}</option>
        <option value="all">{tr("整把键盘")}</option>
      </select>
      <p id="studio-color-scope-help" className="v7-scope-help">{tr(scopeHelp)}</p>
      </div>
      {state?.settings.codexEnabled && !(state.bluetooth?.connected && !state.device.connected) && <div className="v5-color-ownership"><span>{tr("AI 状态灯使用独立配色")}</span><button type="button" onClick={onEditCodexColors}>{tr("设置状态颜色")}</button></div>}
      <ColorWheel color={color} onChange={changeColor} memory={colorMemory}
        onChangeStart={() => { colorGesture.current = { active: true, recorded: false }; }}
        onChangeEnd={() => { colorGesture.current.active = false; }}
        entry={<div className="color-entry">
          <span className="color-preview" style={{ background: color }} aria-label={tr(`当前颜色 ${color}`)} />
          <input aria-label={tr("十六进制颜色")} value={hex} onChange={event => setHex(event.target.value)} onBlur={applyHex} onKeyDown={event => { if (event.key === "Enter") applyHex(); }} maxLength={7} />
          <button className="v5-copy-color" type="button" aria-label={tr("复制颜色")} title={tr("复制颜色")} onClick={() => run(navigator.clipboard.writeText(color).then(() => notify("颜色已复制", "success")).catch(() => notify("无法复制，请选中颜色值复制")))}><Copy size={14} /></button>
        </div>} />
      {selected.length > 0 && <div className="v5-selected">
        <div><span>{tr(`已选择 ${selected.length} 个按键`)}</span><button onClick={() => setSelected([])}>{tr("取消")}</button></div>
        <Button onClick={() => { const next = draftRef.current.colors.slice(); selected.forEach(index => next[index] = color); commit(next); }}>{tr("应用当前颜色")}</Button>
        <button onClick={() => { const next = draftRef.current.colors.slice(); selected.forEach(index => next[index] = "#000000"); commit(next); }}>{tr("熄灭选中按键")}</button>
      </div>}
      <section className="v5-quick-patterns"><h4>{tr("快速图案")}</h4>
        <div><Button icon={<Heart size={16} />} onClick={() => commit(heartColors(layout, color))}>{tr("爱心")}</Button></div>
        <button className="text-button" onClick={onBrowsePresets}><Folder size={16} />{tr("从作品库选择")}</button>
      </section>
      {tab === "paint" && <AnimationPalette draft={draft} setAnimation={setAnimation}/>}
    </aside>
  );
  if (tab === "game") return <section className="studio-page studio-v5" data-mode="game"><GamePanel state={state} command={command} layout={layout} display={connectionDisplay} onNavigateDevice={onNavigateDevice} /></section>;
  return <section className="studio-page studio-v5" data-mode={tab} data-workspace-layout={workspace.mode} style={workspace.style}>
    {!perKeySupported && (!connectionDisplay || connectionDisplay.stateId === 'usbReady') && <div className="wireless-notice" role="status">{tr(lightingUnavailableMessage(state))}</div>}
    <header ref={workspace.headerRef} className={`v5-work-row ${frameEditor ? "v5-frame-edit-heading" : ""}`}>
      <div className="v5-work-identity">
        {frameEditor ? <><button className="text-button" onClick={() => finishFrame(false)}><ArrowLeft size={16} />{tr("返回动画")}</button><h2>{tr(`正在编辑第 ${frameEditor.index + 1} 帧`)}</h2></> : <>
          <label className="v5-work-name"><input aria-label={tr("当前作品名称")} title={tr("点击修改作品名称")} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} maxLength={80} /><Pencil size={12} /></label>
          <span>{tr(draftSaved ? "已保存到本机" : draft.id ? "有未保存修改" : "新作品 · 未保存")}</span>
        </>}
      </div>
      <div className="v5-work-actions">
        {workspace.previewAway&&<Button kind="ghost" className="v5-workspace-return" data-workspace-navigation onClick={workspace.returnToKeyboard}><ArrowUp size={14}/>{tr('回到键盘')}</Button>}
        {frameEditor ? <><Button kind="ghost" onClick={() => finishFrame(false)}>{tr("取消")}</Button><Button kind="primary" icon={<Check size={16} />} onClick={() => finishFrame(true)}>{tr(`应用到第 ${frameEditor.index + 1} 帧`)}</Button></> : <>
          <Button onClick={onSave}>{tr("保存作品")}</Button>
          <div className="v7-keyboard-action">{tab === "trigger" ? <Button kind="primary" icon={triggerArmed ? <Square size={16} /> : <Play size={16} />} busy={playBusy} disabled={!perKeySupported || !state?.device.connected || state?.firmware?.compatible === false || (!triggerArmed && !applyArtworkAppearance(draft.colors, draft.animation).some(value => value.toLowerCase() !== "#000000"))} onClick={() => run(triggerAction())}>{tr(triggerArmed ? "关闭按键触发" : "启用按键触发")}</Button> : <Button kind="primary" icon={togglePlayback && hardwarePlaying ? <Pause size={16} /> : <Play size={16} />} busy={playBusy} disabled={!perKeySupported || !state?.device.connected || state?.firmware?.compatible === false} onClick={() => run(togglePlayback ? command({ op: "pause" }) : play())}>{tr(tab === "paint" ? "播放到键盘" : animationNeedsApply ? paused ? "更新并播放" : "更新播放" : hardwarePlaying ? "暂停播放" : paused ? "继续播放" : "播放到键盘")}</Button>}{connectionDisplay && keyboardActionHint(connectionDisplay) && <span className="v7-keyboard-action-hint">{keyboardActionHint(connectionDisplay)}</span>}</div>
        </>}
      </div>
    </header>
    {state?.playback.lastError && <div className="inline-error" role="alert"><CircleAlert size={16} /><span>{tr(state.playback.lastError)}</span></div>}
    <div ref={workspace.gridRef} className="v5-studio-grid">
      <section className="v5-canvas">
        <div ref={workspace.stageRef} className="v5-workspace-core" tabIndex={-1}>
        <div className="v5-output-status" role="status">{connectionDisplay && (connectionDisplay.stateId !== 'usbReady' || tab === 'paint') ? <span className="v7-canvas-identity">{tab === "paint" ? tr(status) : canvasCaption(connectionDisplay)}</span> : <><i className={`status-dot ${hardwarePlaying || triggerArmed ? "green" : ""}`} /><span>{tr(status)}</span></>}</div>
        {syncHoldReason && <div className="v7-sync-hold" role="status"><p>{tr(syncHoldReason)}</p><p>{tr('同步设置已保留。')}</p></div>}
        <div className="v5-canvas-tools">
          {paintTools ? <>
            <div className="v5-tool-group">{([
              ["paint", "画笔", Paintbrush], ["select", "选择", MousePointer2], ["erase", "橡皮擦", Eraser],
            ] as const).map(([value, label, Icon]) => <button key={value} className={tool === value ? "active" : ""} onClick={() => setTool(value)} aria-pressed={tool === value}><Icon size={16} /><span>{tr(label)}</span></button>)}</div>
            <div className="v5-history"><Button kind="ghost" className="icon-button" aria-label={tr("撤销")} title={tr("撤销")} disabled={!undoStack.length} icon={<Undo2 size={16} />} onClick={undo} /><Button kind="ghost" className="icon-button" aria-label={tr("重做")} title={tr("重做")} disabled={!redoStack.length} icon={<Redo2 size={16} />} onClick={redo} /></div>
            {tab === "paint" && <Switch label={tr("绘制时同步到键盘")} checked={live && perKeySupported && Boolean(state?.device.connected)} disabled={!perKeySupported || !state?.device.connected} onChange={value => { if (value) lastPreview.current = ""; setLive(value); }} />}
            {editingPattern && <Button onClick={() => setEditingPattern(false)} icon={<Check size={16} />}>{tr("完成编辑")}</Button>}
          </> : tab === "animation" ? <><Button icon={<Eye size={16} />} onClick={() => setPagePreview(value => !value)}>{tr(pagePreview ? "停止预览" : "预览动画")}</Button><span className="v5-helper">{tr("仅在页面播放")}</span>{draft.animation.effect !== "frames" && <Button kind="ghost" icon={<Paintbrush size={16} />} onClick={() => {setPagePreview(false);setEditingPattern(true);}}>{tr("编辑图案")}</Button>}</> : tab === "trigger" ? <Button icon={<Paintbrush size={16} />} onClick={() => setEditingPattern(true)}>{tr("编辑图案")}</Button> : null}
          <Button kind="ghost" icon={<Trash2 size={16}/>} disabled={!clearSource.some(value => !/^#0{6}$/i.test(value))} onClick={clearCanvas}>{tr(frameEditor || tab === "animation" && draft.animation.effect === "frames" ? "清空当前帧" : "清空画板")}</Button>
        </div>
        <div ref={workspace.keyboardRef} className="v5-keyboard" tabIndex={tab === "trigger" && !editingPattern ? -1 : undefined} onPointerDown={tab === "trigger" && !editingPattern ? event => { event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); } : undefined}>
          {layout.length ? <Keyboard layout={layout} colors={currentColors} lightPreview={tab === "animation" && draft.animation.effect !== "static"} lightPreviewPeak={previewPeak} selected={paintTools ? selected : []} onKey={paintTools ? touchKey : undefined} onStrokeStart={paintTools ? startStroke : undefined} sideColor={state?.device.connected && typeof state.device.sideColor === "string" ? state.device.sideColor : undefined} /> : <div className="layout-loading">{tr("正在读取键盘布局…")}</div>}
        </div>
        </div>
        <div ref={workspace.auxiliaryRef} className="v5-workspace-aux">
        {frameEditor ? <div className="v5-canvas-note">{tr(`本次修改只应用到第 ${frameEditor.index + 1} 帧`)}</div>
          : tab === "trigger" ? <div className="v5-canvas-note">{tr(`平时熄灭；按下 ${(draft.trigger?.code || "Space").replace(/^(Key|Digit)/, "")} 时显示此图案。`)}</div>
          : tab === "animation" ? <>
            <div className="v5-animation-kind"><h3>{tr(draft.animation.effect === "frames" ? "逐帧动画" : "效果动画")}</h3><button onClick={() => { setPagePreview(false); setAnimation({ effect: draft.animation.effect === "frames" ? "move" : "frames" }); }}>{tr(draft.animation.effect === "frames" ? "切换到效果动画" : "切换到逐帧动画")}</button></div>
            {draft.animation.effect === "frames" && <div className="v5-frame-strip">{frames.map((frame, index) => <button key={index} className={`v5-frame-chip ${frameIndex === index ? "active" : ""}`} aria-label={tr(`选择第 ${index + 1} 帧`)} onClick={() => { setFrameIndex(index); setPagePreview(false); }}><Keyboard layout={layout} colors={draft.animation.colorOverride !== undefined ? applyArtworkAppearance(frame.colors, draft.animation) : frame.colors} mini /><span><b>{index + 1}</b><span>{frame.duration} ms</span></span></button>)}<button className="v5-add-frame" disabled={frames.length >= 120} onClick={() => { setAnimation({ frames: [...frames, { colors: selectedFrame?.colors.slice() || draft.colors.slice(), duration: 300 }] }); setFrameIndex(frames.length); }}><Plus size={16} />{tr("新建帧")}</button></div>}
          </> : <div className="v5-canvas-controls v7-output-controls"><span>{tr("逐键输出亮度")}</span><input aria-label={tr("逐键输出亮度")} aria-describedby="studio-output-brightness-help" type="range" min="0" max="100" value={brightness} style={rangeStyle(brightness)} onChange={event => setBrightness(Number(event.target.value))} onPointerUp={() => run(command({ op: "settings", settings: { brightness } }))} onKeyUp={() => run(command({ op: "settings", settings: { brightness } }))} /><span>{brightness}%</span><button className="text-button" onClick={() => run(command({ op: "restore" }))} disabled={!state?.device.connected}><RotateCcw size={16} />{tr("恢复原灯效")}</button><div id="studio-output-brightness-help" className="v7-output-help"><p>{tr('影响所有逐键输出；不改 HEX，不随作品保存。')}</p><p>{tr('AI 状态灯还会叠加此全局亮度。')}</p></div></div>}
        </div>
      </section>
      {paintTools ? paintPanel : tab === "trigger" ? <TriggerPanel state={state} command={command} draft={draft} setDraft={setDraft} layout={layout} notify={notify} onColors={commit} /> : tab === "animation" ? <AnimationProperties draft={draft} setAnimation={setAnimation} frameIndex={frameIndex} setFrameIndex={setFrameIndex} onEditFrame={beginFrame} /> : <GamePanel state={state} command={command} />}
    </div>
  </section>;
}

function AnimationProperties({ draft, setAnimation, frameIndex, setFrameIndex, onEditFrame }: {
  draft: Scene; setAnimation: (patch: Partial<Animation>) => void; frameIndex: number;
  setFrameIndex: (value: number) => void; onEditFrame: (index: number) => void;
}) {
  const animation = draft.animation, frames = animation.frames || [];
  const index = Math.min(frameIndex, Math.max(0, frames.length - 1));
  const frame = frames[index];
  return <aside className="v5-properties v5-animation-properties">
    <AnimationPalette draft={draft} setAnimation={setAnimation}/>
    <h3>{tr(animation.effect === "frames" ? `第 ${index + 1} 帧` : "动画参数")}</h3>
    {animation.effect === "frames" ? <>
      <label className="v5-property-field"><span>{tr("单帧时长")}</span>{frame ? <FrameDuration value={frame.duration} index={index} onChange={duration => setAnimation({ frames: frames.map((value, i) => i === index ? { ...value, duration } : value) })} /> : <span className="v5-helper">{tr("先新建一帧")}</span>}</label>
      <Button className="v5-edit-frame" icon={<Paintbrush size={16} />} disabled={!frame} onClick={() => onEditFrame(index)}>{tr("编辑这一帧")}</Button>
      <div className="v5-frame-actions"><Button kind="ghost" icon={<Copy size={16} />} disabled={!frame || frames.length >= 120} onClick={() => { if (!frame) return; setAnimation({ frames: [...frames.slice(0, index + 1), { colors: frame.colors.slice(), duration: frame.duration }, ...frames.slice(index + 1)] }); setFrameIndex(index + 1); }}>{tr("复制")}</Button><Button kind="ghost" className="v5-danger" icon={<Trash2 size={16} />} disabled={!frame} onClick={() => { setAnimation({ frames: frames.filter((_, i) => i !== index) }); setFrameIndex(Math.max(0, index - 1)); }}>{tr("删除")}</Button></div>
      <p className="v5-property-help">{tr("编辑只影响所选帧；整体配色影响全部帧。")}</p>
    </> : <>
      <label className="v5-property-field"><span>{tr("灯光效果")}</span><select aria-label={tr("动画效果")} value={animation.effect} onChange={event => setAnimation({ effect: event.target.value as Animation["effect"] })}>{Object.entries(labels).filter(([key]) => key !== "frames").map(([value, label]) => <option key={value} value={value}>{tr(label)}</option>)}</select></label>
      {animation.effect === "move" && <label className="v5-property-field"><span>{tr("方向")}</span><select aria-label={tr("动画方向")} value={animation.direction} onChange={event => setAnimation({ direction: event.target.value as Direction })}>{directions.map(([value, label]) => <option key={value} value={value}>{tr(label)}</option>)}</select></label>}
    </>}
    <label className="v5-property-field v5-speed"><span>{tr("速度")}<span>{animation.speed} / 10</span></span><input aria-label={tr("动画速度")} type="range" min="1" max="10" value={animation.speed} style={rangeStyle(animation.speed,1,10)} disabled={animation.effect === "static"} onChange={event => setAnimation({ speed: Number(event.target.value) })} /></label>
    <Switch label={tr("循环播放")} checked={animation.loop} onChange={loop => setAnimation({ loop })} />
    <p className="v8-palette-help">{tr("播放中可继续调整颜色与参数；修改后点击「更新播放」。")}</p>
    <button type="button" className="text-button v8-back-to-play" onClick={() => {
      const action = document.querySelector<HTMLButtonElement>(".v7-keyboard-action button");
      action?.scrollIntoView({block: "center"});
      action?.focus({preventScroll: true});
    }}>{tr("回到更新播放")}</button>
  </aside>;
}

function AnimationPalette({draft, setAnimation}: {draft: Scene; setAnimation: (patch: Partial<Animation>) => void}) {
  const animation = draft.animation, artworkBrightness = animation.brightness ?? 100;
  const memory = useRef<HSV | null>(null);
  const original = draft.colors.find(color => color.toLowerCase() !== "#000000")
    ?? animation.frames?.flatMap(frame => frame.colors).find(color => color.toLowerCase() !== "#000000")
    ?? DEFAULT_COLOR;
  // Display the selected colour before artwork brightness, so a dimmed or
  // black result does not move the wheel's selection to another colour.
  const selectedColor = applyArtworkAppearance([original], {...animation, brightness: 100})[0];
  return <section className="v8-animation-palette" aria-label={tr("整体配色")}>
    <h3>{tr("整体颜色")}</h3>
    <ColorWheel color={selectedColor} memory={memory} onChange={color => setAnimation({colorOverride: color.toLowerCase()})}
      entry={<div className="v8-palette-selection"><span style={{background: selectedColor}} aria-hidden="true"/><output aria-label={tr("当前整体颜色")}>{selectedColor.toUpperCase()}</output></div>}/>
    <Button kind="ghost" icon={<RotateCcw size={14}/>} disabled={animation.colorOverride === undefined} onClick={() => setAnimation({colorOverride: undefined})}>{tr("还原配色")}</Button>
    <label className="v5-property-field v8-artwork-brightness"><span>{tr("作品亮度")}<output>{artworkBrightness}%</output></span>
      <input aria-label={tr("作品亮度")} aria-valuetext={`${artworkBrightness}%`} type="range" min="0" max="100" step="1" value={artworkBrightness} style={rangeStyle(artworkBrightness)} onChange={event => setAnimation({brightness: Number(event.target.value)})}/>
    </label>
    <Button kind="ghost" icon={<RotateCcw size={14}/>} disabled={artworkBrightness === 100} onClick={() => setAnimation({brightness: 100})}>{tr("还原亮度")}</Button>
    {artworkBrightness === 0 && <p className="v8-palette-help" role="status">{tr("作品亮度为 0%；应用后该作品熄灭，原始颜色仍保留。")}</p>}
    <p className="v8-palette-help">{tr("选色应用到图案和全部帧；熄灭的按键保持不亮。")}</p>
    <p className="v8-palette-help">{tr("还原配色可恢复原来的颜色；作品亮度单独调整。")}</p>
  </section>;
}

function FrameDuration({ value, index, onChange }: { value: number; index: number; onChange: (value: number) => void }) {
  const [input, setInput] = useState(String(value));
  useEffect(() => setInput(String(value)), [value]);
  const commit = () => { const duration = Math.round(Math.max(80, Math.min(10000, Number(input) || 80))); setInput(String(duration)); onChange(duration); };
  return <input aria-label={tr(`第 ${index + 1} 帧时长`)} type="number" min="80" max="10000" value={input} onChange={event => setInput(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") { commit(); event.currentTarget.blur(); } }} />;
}

function renderPageAnimation(colors: string[], animation: Animation, elapsed: number, layout: Key[]) {
  return renderAnimation(colors, animation, elapsed, layout);
}
