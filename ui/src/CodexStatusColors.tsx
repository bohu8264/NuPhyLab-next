import { useEffect, useRef, useState } from "react";
import { RotateCcw, ChevronRight } from "lucide-react";
import { CUSTOM_STATUS_IDS, STATUS_COLORS, STATUS_NAMES, statusColor } from "../../shared/codex-lighting.mjs";
import {readAppState} from "./api";
import { ColorWheel } from "./ColorWheel";
import type { HSV } from "../../shared/color.mjs";
import { Button, Modal, run } from "./primitives";
import { t as tr } from "./i18n";
import type { Command } from "./types";

export function CodexStatusColors({settings,command,focusOnMount}:{settings:Record<string,unknown>;command:Command;focusOnMount?:boolean}) {
  const section=useRef<HTMLElement>(null);
  useEffect(()=>{if(focusOnMount){section.current?.scrollIntoView({block:"nearest"});section.current?.focus({preventScroll:true});}},[focusOnMount]);
  const [editing,setEditing]=useState<string|null>(null);
  const [color,setColor]=useState("#FFFFFF"),[hex,setHex]=useState("#FFFFFF");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[pending,setPending]=useState(false),[resetNote,setResetNote]=useState("");
  const lock=useRef(false);
  const memory=useRef<HSV|null>(null);
  useEffect(()=>{if(error&&!pending)requestAnimationFrame(()=>document.querySelector<HTMLInputElement>('.agent-color-v6 input:not([disabled])')?.focus());},[error,pending]);
  const validHex=/^#?[0-9a-f]{6}$/i.test(hex);
  const change=(value:string)=>{if(lock.current)return;setColor(value);setHex(value);setError("");};
  const parse=()=>{const value=hex.startsWith("#")?hex:`#${hex}`;if(!/^#[0-9a-f]{6}$/i.test(value)){setError(tr("请输入 6 位十六进制颜色，如 #98C7AC。"));return null;}change(value.toUpperCase());return value.toUpperCase();};
  const notify=(message:string)=>window.dispatchEvent(new CustomEvent('nuphylab:notify',{detail:{message,kind:'success'}}));
  const apply=async()=>{
    if(lock.current||!editing)return;
    const value=parse();if(!value)return;
    lock.current=true;setBusy(true);setError('');
    try{
      await command(pending?{op:'codexAdaptCheck',source:'codex'}:{op:'settings',settings:{codexStatusColors:{[editing]:value}}},{silent:true});
      setEditing(null);notify('颜色已应用');
    }catch(failure){
      let stored=false;try{const current=(await readAppState()).settings['codexStatusColors'] as Record<string,string>|undefined;stored=current?.[editing]?.toUpperCase()===value;}catch{/* unknown result */}
      setPending(stored);setError(tr(stored?'颜色已保存，键盘同步尚未完成。请重新检查；关闭不会撤销已保存的颜色。':'未能确认应用结果。已保留颜色，请重新检查后重试。'));
    }finally{lock.current=false;setBusy(false);}
  };
  const reset=async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);setResetNote('');
    const defaults=Object.fromEntries(CUSTOM_STATUS_IDS.map(id=>[id,STATUS_COLORS[id]]));
    try{await command({op:'settings',settings:{codexStatusColors:defaults}},{silent:true});notify('已恢复默认颜色');}
    catch(failure){let stored=false;try{const current=(await readAppState()).settings['codexStatusColors'] as Record<string,string>|undefined;stored=Object.entries(defaults).every(([id,value])=>current?.[id]?.toUpperCase()===value.toUpperCase());}catch{/* unknown */}setResetNote(stored?'默认颜色已保存，键盘同步尚未完成。请重新检查。':'未能确认恢复结果，请重新检查后重试。');}
    finally{lock.current=false;setBusy(false);}
  };
  return <section className="codex-palette" ref={section} tabIndex={-1} aria-label={tr("状态颜色")}>
    <div className="section-heading compact"><h3>{tr("状态颜色")}</h3><Button kind="ghost" icon={<RotateCcw size={14}/>} disabled={busy} onClick={()=>run(reset())}>{tr("恢复默认颜色")}</Button></div>
    <div className="codex-palette-grid">{[...CUSTOM_STATUS_IDS].sort((a,b)=>['running','needsInput','completed','idle','error','unknown'].indexOf(a)-['running','needsInput','completed','idle','error','unknown'].indexOf(b)).map(id=><button className="status-color-button" key={id} disabled={busy}
      aria-label={tr(`修改${STATUS_NAMES[id]}颜色`)} onClick={()=>{memory.current=null;setPending(false);setError("");change(statusColor({status:id},settings));setEditing(id);}}>
      <span className="status-color-swatch" style={{backgroundColor:statusColor({status:id},settings)}} aria-hidden="true"/>
      <span>{tr(STATUS_NAMES[id])}</span><ChevronRight className="status-color-caret" size={14} strokeWidth={1.5} aria-hidden="true"/>
    </button>)}</div>
    {resetNote&&<p className="agent-inline-error" role="alert">{tr(resetNote)}</p>}
    {editing && <Modal title={tr(`修改${STATUS_NAMES[editing]}颜色`)} width={424} className="agent-overlay-v6 agent-color-v6" busy={busy} initialFocus="input" onClose={()=>{if(!lock.current)setEditing(null);}} footer={<><Button kind="ghost" disabled={busy} onClick={()=>setEditing(null)}>{tr(pending?'完成':'取消')}</Button><Button kind="primary" busy={busy} disabled={!validHex} onClick={()=>{void apply();}}>{tr(pending?'重新检查':'应用颜色')}</Button></>}>
      <div className="agent-color-editor-v6" aria-busy={busy}>
        <fieldset disabled={busy||pending} inert={busy||pending}>
          <ColorWheel key={editing} color={color} onChange={value=>{if(!pending)change(value);}} memory={memory} entry={<label className="agent-color-entry-v6"><span>{tr('HEX 颜色')}</span><div><span className="color-preview" style={{background:color}} aria-hidden="true"/><input aria-label={tr('状态颜色值')} aria-invalid={!validHex} disabled={busy||pending} value={hex} maxLength={7} onChange={e=>setHex(e.target.value)} onBlur={parse} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void apply();}}}/></div></label>}/>
        </fieldset>
        {error?<p className="agent-inline-error" role="alert">{error}</p>:<p className="agent-overlay-hint">{tr('颜色应用到所选状态。不会改变另一套 AI 的配色。')}</p>}
      </div>
    </Modal>}
  </section>;
}
