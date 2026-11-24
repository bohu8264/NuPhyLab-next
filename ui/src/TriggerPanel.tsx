import { rangeStyle } from "./rangeStyle";
import { t as tr } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import { DEFAULT_TRIGGER, TYPING_KEYS, triggerPlaybackConfig } from "../../shared/trigger.mjs";
import { TypingCross } from "../../shared/typing-cross.mjs";
import { ColorWheel } from "./ColorWheel";
import type { HSV } from "../../shared/color.mjs";
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
        event.repeat
      ) return;
      if(trigger.config.effect==='cross'){
        const code=event.code==='F13'?'PrintScreen':event.code;
        if(TYPING_KEYS.some(key=>key.code===code))run(command({op:'triggerKey',code}));
        return;
      }
      if(event.code!==trigger.config.code||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
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
  state, command, draft, setDraft, layout, notify, onColors, onPreviewColors,
}: {
  state: AppState | null;
  command: Command;
  draft: Scene;
  setDraft: (scene: Scene) => void;
  layout: Key[];
  notify: Notify;
  onColors: (colors: string[], history?: boolean) => void;
  onPreviewColors?: (colors:string[]|null) => void;
}) {
  const config = draft.trigger || DEFAULT_TRIGGER;
  const cross=config.effect==='cross',effective=triggerPlaybackConfig(config,draft.animation);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const colorMemory=useRef<HSV|null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const trigger = state?.trigger;
  const armed = Boolean(trigger?.armed && state?.playback.mode === "trigger");
  const [busy, setBusy] = useState(false),[error,setError]=useState('');
  const pending=useRef(false),previewFire=useRef<((code:string)=>void)|null>(null);
  const setConfig = (patch: Partial<TriggerConfig>) => {
    const current=draftRef.current,animation={...current.animation};
    if(patch.color!==undefined)delete animation.colorOverride;
    const next={...current,animation,trigger:{...(current.trigger||DEFAULT_TRIGGER),...patch}};
    draftRef.current=next;setDraft(next);
  };
  useEffect(()=>{
    if(!cross||armed){previewFire.current=null;onPreviewColors?.(null);return;}
    const engine=new TypingCross(layout),settings={color:effective.color,speed:effective.speed};
    let frame:number|null=null,stopped=false;
    const update=(now:number)=>{
      if(stopped)return;
      frame=null;onPreviewColors?.(engine.render(now,settings));
      if(engine.activeWaves)frame=window.requestAnimationFrame(update);
    };
    previewFire.current=code=>{
      if(!engine.fire(code,window.performance.now()))return;
      if(frame===null)frame=window.requestAnimationFrame(update);
    };
    return()=>{stopped=true;previewFire.current=null;if(frame!==null)window.cancelAnimationFrame(frame);engine.clear();onPreviewColors?.(null);};
  },[cross,armed,layout,effective.color,effective.speed,onPreviewColors]);
  const perform = async (body: Record<string, unknown>) => {
    if(pending.current)return;
    pending.current=true;setBusy(true);setError('');
    try { await command(body,{silent:true}); }
    catch(error){setError(error instanceof Error?error.message:'操作未完成，请重试。');throw error;}
    finally { pending.current=false;setBusy(false); }
  };
  const hasPattern = cross ? effective.color?.toLowerCase()!=='#000000'
    :applyArtworkAppearance(draft.colors,draft.animation).some(value=>value.toLowerCase()!=='#000000');
  const arm = async () => {
    if(!hasPattern){notify((draft.animation.brightness??100)===0?'作品亮度为 0%，调高亮度后可启用按键触发。':'当前设置下图案没有亮起的按键，请调整颜色或作品亮度。');return;}
    const settings=triggerPlaybackConfig(config,draft.animation),colors=applyArtworkAppearance(draft.colors,draft.animation);
    await perform({op:'triggerArm',colors,trigger:settings});
    if(mounted.current)setDraft({...draftRef.current,trigger:draftRef.current.trigger||config});
  };
  const signature=(value:unknown)=>JSON.stringify(Object.entries((value??{}) as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)));
  const changed=cross&&armed&&signature(effective)!==signature(trigger?.config);
  const testOnce=()=>{
    if(cross&&!armed){previewFire.current?.('Space');return;}
    return perform(cross?{op:'triggerFire',code:'Space'}:{op:'triggerFire'});
  };
  return <aside className="v5-properties v5-trigger-properties">
    <h3>{tr("触发规则")}</h3>
    {cross?<>
      <p>{tr('按任意键，从对应位置向横纵扩散。')}</p>
      <section className="v5-trigger-color"><h3>{tr('触发颜色')}</h3>
        <ColorWheel color={config.color||'#ffffff'} memory={colorMemory} onChange={color=>setConfig({color:color.toLowerCase()})}/>
      </section>
      <label className="v5-property-field v5-trigger-speed"><span>{tr('扩散速度')}<span>{config.speed??4}</span></span>
        <input aria-label={tr('扩散速度')} type="range" min="1" max="10" step="1" value={config.speed??4} style={rangeStyle(config.speed??4,1,10)}
          onChange={event=>{const speed=Number(event.target.value);if(Number.isFinite(speed)&&speed>=1&&speed<=10)setConfig({speed});}}/>
      </label>
      <p className="muted">{tr('连续按键独立叠加')}</p>
      <label className="v5-trigger-preview"><textarea rows={3} style={{width:'100%',resize:'vertical'}} aria-label={tr('在此输入以预览灯效')} placeholder={tr('在此输入以预览灯效')}
        onKeyDown={event=>{if(!event.repeat&&!armed)previewFire.current?.(event.code);}}/></label>
      <p className="muted">{tr('预览输入仅用于触发灯效，不会保存文字。')}</p>
    </>:<>
      <section className="v5-trigger-key"><TriggerKeyRecorder value={config.code} onChange={code=>setConfig({code})}/></section>
      <label className="v5-trigger-count"><span>{tr('闪烁次数')}</span><input aria-label={tr('闪烁次数')} type="number" min="1" max="20" value={config.count}
        onChange={event=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=1&&value<=20)setConfig({count:value});}}/></label>
      <label className="v5-property-field v5-trigger-speed"><span>{tr('闪烁速度')}<span>{tr(`${(config.intervalMs/1000).toFixed(1)} 秒`)}</span></span>
        <input aria-label={tr('闪烁速度')} type="range" min="200" max="2000" step="100" value={2200-config.intervalMs} style={rangeStyle(2200-config.intervalMs,200,2000)} onChange={event=>setConfig({intervalMs:2200-Number(event.target.value)})}/>
      </label>
    </>}
    <div className="v5-trigger-listening"><span><i className="status-dot"/>{tr(armed?trigger?.monitor==='global'?'全局监听':'窗口内监听':'启用后开始监听')}</span>
      <p>{tr(cross?'启用后在其他应用打字也会触发，按键照常输入。':armed&&trigger?.monitor!=='global'?'点击图案后按键。':'按键仍会正常输入。')}</p>
    </div>
    {changed&&<p className="inline-v6-notice">{tr('颜色和速度已修改，点击应用设置更新键盘。')}</p>}
    <div className="v5-trigger-test">
      {armed&&<Button busy={busy} disabled={!hasPattern} onClick={()=>run(arm())}>{tr('应用设置')}</Button>}
      <Button kind="ghost" busy={busy} icon={<Play size={16}/>} disabled={cross?!hasPattern:!armed||trigger?.flashing} onClick={()=>{const result=testOnce();if(result)run(result);}}>{tr(cross?'试放一次':'试闪一次')}</Button>
      {!cross&&!armed&&<span>{tr('启用后可试闪')}</span>}
    </div>
    {trigger?.warning&&<details className="trigger-warning inline-v6-details"><summary>{tr('全局监听提示')}</summary><div className="inline-v6-detail-body"><p>{tr(trigger.warning)}</p><p>{tr('按键仍会正常输入。')}</p>{armed&&trigger.monitor==='window'&&<p>{tr('点击图案后按键。')}</p>}{state?.desktop?.platform!=='win32'&&<Button kind="ghost" icon={<ArrowUpRight size={14}/>} onClick={()=>window.dispatchEvent(new CustomEvent('nuphylab:navigate',{detail:'permissions'}))}>{tr('管理权限')}</Button>}</div></details>}
    {error&&<div className="inline-v6-notice inline-v6-error" role="alert">{tr(error)}</div>}
    {!hasPattern&&<p className="trigger-warning">{tr((draft.animation.brightness??100)===0?'作品亮度为 0%，调高亮度后可启用按键触发。':cross?'当前设置下图案没有亮起的按键，请调整颜色或作品亮度。':'当前没有亮起的按键，先选一个图案。')}</p>}
  </aside>;
}
