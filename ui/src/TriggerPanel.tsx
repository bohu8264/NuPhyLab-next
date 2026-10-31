import { rangeStyle } from "./rangeStyle";
import { t as tr } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import { DEFAULT_TRIGGER } from "../../shared/trigger.mjs";
import { applyArtworkAppearance } from "../../shared/render-animation.mjs";
import { TriggerKeyRecorder } from "./TriggerKeyRecorder";
import { Button, run } from "./primitives";
import type { AppState, Command, Key, Notify, Scene, TriggerConfig } from "./types";
import './inline-overlays-v6.css';

export function useTriggerKeys(state: AppState | null, command: Command) {
  const latest = useRef({ state, command });
  latest.current = { state, command };
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const { state, command } = latest.current;
      const trigger = state?.trigger;
      if (
        event.defaultPrevented || state?.playback.mode !== "trigger" ||
        !trigger?.armed || trigger.monitor !== "window" ||
        event.code !== trigger.config.code || event.repeat ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
      ) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable || target.closest(
          "input,textarea,select,button,a,[role='slider'],[role='textbox'],[role='dialog'],[contenteditable='true']",
        )
      )) return;
      run(command({ op: "triggerKey", code: event.code }));
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, []);
}

export function TriggerPanel({
  state, command, draft, setDraft, layout, notify, onColors,
}: {
  state: AppState | null;
  command: Command;
  draft: Scene;
  setDraft: (scene: Scene) => void;
  layout: Key[];
  notify: Notify;
  onColors: (colors: string[], history?: boolean) => void;
}) {
  const config = draft.trigger || DEFAULT_TRIGGER;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const trigger = state?.trigger;
  const armed = Boolean(trigger?.armed && state?.playback.mode === "trigger");
  const [busy, setBusy] = useState(false),[error,setError]=useState('');
  const pending=useRef(false);
  const setConfig = (patch: Partial<TriggerConfig>) =>
    setDraft({ ...draft, trigger: { ...config, ...patch } });
  const perform = async (body: Record<string, unknown>) => {
    if(pending.current)return;
    pending.current=true;
    setBusy(true);
    setError('');
    try { await command(body,{silent:true}); }
    catch(error){setError(error instanceof Error?error.message:'操作未完成，请重试。');throw error;}
    finally { pending.current=false;setBusy(false); }
  };
  const arm = async () => {
    const settings = { ...config };
    const colors = applyArtworkAppearance(draft.colors, draft.animation);
    await perform({ op: "triggerArm", colors, trigger: settings });
    if (mounted.current) setDraft({ ...draftRef.current, trigger: draftRef.current.trigger || settings });
  };
  const hasPattern = applyArtworkAppearance(draft.colors, draft.animation).some((value) => value.toLowerCase() !== "#000000");
  return <aside className="v5-properties v5-trigger-properties">
    <h3>{tr("触发规则")}</h3>
    <section className="v5-trigger-key"><TriggerKeyRecorder value={config.code} onChange={(code) => setConfig({ code })} /></section>
    <label className="v5-trigger-count"><span>{tr("闪烁次数")}</span><input aria-label={tr("闪烁次数")} type="number" min="1" max="20" value={config.count}
      onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 20) setConfig({ count: value }); }} /></label>
    <label className="v5-property-field v5-trigger-speed"><span>{tr("闪烁速度")}<span>{tr(`${(config.intervalMs / 1000).toFixed(1)} 秒`)}</span></span>
      <input aria-label={tr("闪烁速度")} type="range" min="200" max="2000" step="100" value={2200 - config.intervalMs} style={rangeStyle(2200-config.intervalMs,200,2000)} onChange={event => setConfig({ intervalMs: 2200 - Number(event.target.value) })} />
    </label>
    <div className="v5-trigger-listening"><span><i className="status-dot" />{tr(armed ? trigger?.monitor === "global" ? "全局监听" : "窗口内监听" : "启用后开始监听")}</span><p>{tr(armed && trigger?.monitor !== "global" ? "点击图案后按键。" : "按键仍会正常输入。")}</p></div>
    <div className="v5-trigger-test">
      {armed && <Button busy={busy} disabled={!hasPattern} onClick={() => run(arm())}>{tr("应用设置")}</Button>}
      <Button kind="ghost" busy={busy} icon={<Play size={16} />} disabled={!armed || trigger?.flashing} onClick={() => run(perform({ op: "triggerFire" }))}>{tr("试闪一次")}</Button>
      {!armed && <span>{tr("启用后可试闪")}</span>}
    </div>
    {trigger?.warning && <details className="trigger-warning inline-v6-details"><summary>{tr("全局监听提示")}</summary><div className="inline-v6-detail-body"><p>{tr(trigger.warning)}</p><p>{tr('按键仍会正常输入。')}</p>{armed&&trigger.monitor==='window'&&<p>{tr('点击图案后按键。')}</p>}<Button kind="ghost" icon={<ArrowUpRight size={14}/>} onClick={()=>window.dispatchEvent(new CustomEvent('nuphylab:navigate',{detail:'permissions'}))}>{tr('管理权限')}</Button></div></details>}
    {error&&<div className="inline-v6-notice inline-v6-error" role="alert">{tr(error)}</div>}
    {!hasPattern && <p className="trigger-warning">{tr((draft.animation.brightness ?? 100) === 0 ? "作品亮度为 0%，调高亮度后可启用按键触发。" : "当前没有亮起的按键，先选一个图案。")}</p>}
  </aside>;
}
