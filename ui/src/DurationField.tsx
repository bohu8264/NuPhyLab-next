import { useEffect, useId, useRef, useState } from "react";
import { t } from "./i18n";
import "./settings-overlays-v6.css";

export function DurationField({label, value, onChange, allowOff = true, maximum = 86400000, disabled = false, onBusyChange, onDone}: {
  label:string; value:number; onChange:(value:number)=>Promise<unknown>; allowOff?:boolean; maximum?:number;
  disabled?:boolean; onBusyChange?:(busy:boolean)=>void; onDone?:()=>void;
}) {
  const fieldId = useId();
  const initialUnit = value && value % 3600000 === 0 ? 3600000 : value && value % 60000 === 0 ? 60000 : 1000;
  const [unit,setUnit] = useState(initialUnit), [amount,setAmount] = useState(String(value / initialUnit));
  const [busy,setBusy] = useState(false), [error,setError] = useState("");
  const [uncertain,setUncertain]=useState(false);
  const [effective,setEffective] = useState(value);
  const pending = useRef(false), dirty = useRef(false), mounted = useRef(true), skipBlur = useRef(false);
  const attempted=useRef<number|null>(null);
  const input=useRef<HTMLInputElement>(null);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const currentUnit = useRef(unit); currentUnit.current = unit;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; busyCallback.current?.(false); }; }, []);
  useEffect(() => {
    setEffective(value);
    if(uncertain && attempted.current===value){dirty.current=false;setError("");setUncertain(false);}
    // Polling must not replace an unfinished or failed input.
    if (!dirty.current && !pending.current) setAmount(String(value / currentUnit.current));
  }, [value,uncertain]);
  const reset = () => { dirty.current = false; setAmount(String(effective / unit)); setError("");setUncertain(false); };
  const commit = async (explicit?:number) => {
    if (pending.current || disabled) return false;
    const next = explicit ?? Math.round(Number(amount)*unit);
    if ((explicit === undefined && !amount.trim()) || !Number.isFinite(next) || !Number.isInteger(next) || (next !== 0 && (next < 1000 || next > maximum)) || (!allowOff && next === 0)) {
      setError(t("请输入 1 秒至 24 小时，或选择「不限」。")); return false;
    }
    if (next === effective) { reset(); return true; }
    pending.current = true;attempted.current=next;setBusy(true); busyCallback.current?.(true); setError("");setUncertain(false);
    try {
      await onChange(next);
      if (mounted.current) { dirty.current = false; setEffective(next); setAmount(String(next/unit)); }
      return true;
    } catch (error) {
      if (mounted.current) {
        dirty.current = true;
        if (explicit !== undefined) setAmount(String(explicit/unit));
        const unknown=error instanceof Error && error.name==="DurationSaveUnconfirmed";
        setUncertain(unknown);setError(unknown ? error.message : t("时间未保存，请重试。"));
      }
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(false); busyCallback.current?.(false); }
    }
  };
  const effectiveLabel = effective === 0 ? t("不限") : `${effective/1000} ${t("秒")}`;
  return <div className="duration-field duration-field-v6" aria-busy={busy}>
    <label htmlFor={fieldId}>{t(label)}</label><div className="duration-inputs">
      <input ref={input} id={fieldId} type="number" aria-label={t(label)} aria-invalid={Boolean(error)} aria-describedby={`${fieldId}-status`}
        min={allowOff ? 0 : 1000/unit} max={maximum/unit} step="any" disabled={disabled || busy} value={amount}
        onChange={event=>{dirty.current=true;setAmount(event.target.value);setError("");}}
        onBlur={event=>{
          const action = (event.relatedTarget as HTMLElement | null)?.dataset.durationAction;
          // Unit selection starts from the saved duration; Unlimited is one explicit write.
          if (skipBlur.current || action === "unit" || action === "off") {skipBlur.current=false;return;}
          void commit().then(saved=>{if(saved && action === "done" && mounted.current) onDone?.();});
        }}
        onKeyDown={event=>{
          if(event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if(event.key === "Escape") { event.preventDefault(); event.stopPropagation(); reset(); }
        }} />
      <select data-duration-action="unit" aria-label={t("时间单位")} value={unit} disabled={disabled || busy} onPointerDown={()=>{skipBlur.current=document.activeElement===input.current;}} onChange={event=>{
        const nextUnit=Number(event.target.value); dirty.current=false; setUnit(nextUnit);setAmount(String(effective/nextUnit));setError("");
      }}>
        <option value={1000}>{t("秒")}</option><option value={60000}>{t("分钟")}</option>{maximum >= 3600000 && <option value={3600000}>{t("小时")}</option>}
      </select>
      {allowOff && <button type="button" data-duration-action="off" className="button duration-off" aria-pressed={effective === 0} disabled={disabled || busy} onPointerDown={()=>{skipBlur.current=document.activeElement===input.current;}} onClick={()=>void commit(0)}>{t("不限")}</button>}
      {onDone && <button type="button" data-duration-action="done" className="button ghost duration-done" disabled={disabled || busy} onClick={()=>{if(!pending.current&&!dirty.current&&!error)onDone();}}>{t("完成")}</button>}
    </div>
    <div id={`${fieldId}-status`} className="duration-status">
      {busy ? <span role="status">{t("正在保存…")}</span> : error ? <><span className="field-error" role="alert">{error}</span><span>{t(uncertain ? "上次已确认：" : "当前已生效：")}{effectiveLabel}</span></> : <span>{t("单位可选秒、分钟或小时。按 Enter 或移出数值框后保存。")}</span>}
    </div>
  </div>;
}
