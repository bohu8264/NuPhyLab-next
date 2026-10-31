import { t as tr } from "./i18n";
import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, X } from "lucide-react";
export function Button({
  children,
  kind = "secondary",
  icon,
  busy,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: "primary" | "secondary" | "ghost" | "danger";
  icon?: ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button ${kind} ${props.className || ""}`}
      disabled={props.disabled || busy}
    >
      {tr(busy ? <LoaderCircle size={16} className="spin" /> : icon)}
      {tr(children)}
    </button>
  );
}
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={`switch-field ${disabled ? "disabled" : ""}`}>
      <span>{tr(label)}</span>
      <button
        type="button"
        className={`switch ${checked ? "checked" : ""}`}
        role="switch"
        aria-checked={checked}
        aria-label={tr(label)}
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span />
      </button>
    </label>
  );
}
const modalStack: HTMLElement[] = [];
let rootWasInert = false;
let bodyOverflow = "";
const visibleControls = (element: HTMLElement) => Array.from(element.querySelectorAll<HTMLElement>(
  'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])',
)).filter(item => item.getClientRects().length > 0 && !item.closest('[inert],[hidden]'));
function syncModalStack() {
  modalStack.forEach((element, index) => { element.inert = index !== modalStack.length - 1; });
}
export function Modal({title,children,onClose,width=480,busy=false,footer,captureKeys=false,initialFocus='title',description,className='',returnFocus}: {
  title:string; children:ReactNode; onClose:()=>void; width?:424|460|480|560|640;
  busy?:boolean; footer?:ReactNode; captureKeys?:boolean;
  initialFocus?:'input'|'cancel'|'title'; description?:string; className?:string;
  returnFocus?:HTMLElement|null;
}) {
  const modal=useRef<HTMLElement>(null),shade=useRef<HTMLDivElement>(null);
  const [slow,setSlow]=useState(false);
  useEffect(()=>{setSlow(false);if(!busy)return;const timer=setTimeout(()=>setSlow(true),8000);return()=>clearTimeout(timer);},[busy]);
  const titleId=useId(),descriptionId=useId();
  const before=useRef<HTMLElement|null>(returnFocus??(document.activeElement instanceof HTMLElement?document.activeElement:null));
  const focusMode=useRef(initialFocus),wasBusy=useRef(busy);
  useEffect(()=>{
    const element=shade.current,dialog=modal.current,root=document.getElementById('root');
    if(!element||!dialog)return;
    if(returnFocus)before.current=returnFocus;
    if(!modalStack.length){rootWasInert=root?.inert??false;bodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}
    if(root)root.inert=true;
    modalStack.push(element);syncModalStack();
    const target=focusMode.current==='input'?dialog.querySelector<HTMLElement>('input:not([disabled]),textarea:not([disabled])'):
      focusMode.current==='cancel'?dialog.querySelector<HTMLElement>('[data-modal-cancel],.modal-footer button:not([disabled])'):dialog.querySelector<HTMLElement>('h2');
    (target??dialog).focus();
    if(target instanceof HTMLInputElement&&focusMode.current==='input')target.select();
    return()=>{
      const index=modalStack.indexOf(element);if(index>=0)modalStack.splice(index,1);syncModalStack();
      if(!modalStack.length){if(root)root.inert=rootWasInert;document.body.style.overflow=bodyOverflow;}
      queueMicrotask(()=>{
        const entry=before.current,top=modalStack.at(-1);
        if(top){
          if(entry?.isConnected&&top.contains(entry)&&!(entry as HTMLButtonElement).disabled)entry.focus({preventScroll:true});
          else if(!top.contains(document.activeElement))(top.querySelector<HTMLElement>('h2,[role="dialog"]'))?.focus({preventScroll:true});
          return;
        }
        if(entry?.isConnected&&!entry.closest('[inert]')&&!(entry as HTMLButtonElement).disabled)entry.focus({preventScroll:true});
        else {const fallback=document.querySelector<HTMLElement>('.lab-page-header h1,main h1,[aria-current="page"]');if(fallback){if(!fallback.hasAttribute('tabindex'))fallback.tabIndex=-1;fallback.focus();}}
      });
    };
  },[]);
  useEffect(()=>{
    if(wasBusy.current&&!busy&&modal.current?.querySelector('[role="alert"]')){
      const target=modal.current.querySelector<HTMLElement>('input[aria-invalid="true"]:not([disabled])')
        ??modal.current.querySelector<HTMLElement>('[data-modal-retry]:not([disabled])')
        ??modal.current.querySelector<HTMLElement>('input:not([disabled]):not([type=range]):not([type=checkbox]),textarea:not([disabled])');
      target?.focus();
    }
    wasBusy.current=busy;
  },[busy]);
  const close=()=>{if(!busy)onClose();};
  return createPortal(<div ref={shade} className="modal-shade overlay-v6" onClick={event=>{if(event.target===event.currentTarget)close();}} onKeyDown={event=>{
    if(modalStack.at(-1)!==shade.current||captureKeys)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
    if(event.key==='Tab'&&modal.current){
      const controls=visibleControls(modal.current),first=controls[0],last=controls.at(-1);
      if(!first){event.preventDefault();modal.current.focus();}
      else if(event.shiftKey&&(document.activeElement===first||!controls.includes(document.activeElement as HTMLElement))){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||!controls.includes(document.activeElement as HTMLElement))){event.preventDefault();first.focus();}
    }
  }}><section ref={modal} className="modal" style={{width}} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description?descriptionId:undefined} aria-busy={busy||undefined} tabIndex={-1}>
    <header className="modal-header"><h2 id={titleId} tabIndex={-1}>{tr(title)}</h2><Button kind="ghost" className="icon-button modal-close" aria-label={tr('关闭')} icon={<X size={16}/>} disabled={busy} onClick={close}/></header>
    <div className={`modal-body ${className}`}>{description&&<p id={descriptionId} className="modal-description">{tr(description)}</p>}{tr(children)}{slow&&busy&&<p className="overlay-helper" role="status">{tr("仍在处理，请稍候。")}</p>}</div>
    {footer&&<footer className="modal-footer">{tr(footer)}</footer>}
  </section></div>,document.body);
}
export function Empty({icon,title,children,actions}:{icon?:ReactNode;title:string;children?:ReactNode;actions?:ReactNode}) {
  return <div className="empty-state">{tr(icon)}<h3>{tr(title)}</h3><p>{tr(children)}</p>{actions&&<div className="empty-actions">{tr(actions)}</div>}</div>;
}
export function run(promise: Promise<unknown>) {
  void promise.catch(() => undefined);
}
