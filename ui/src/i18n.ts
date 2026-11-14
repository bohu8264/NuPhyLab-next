import { useSyncExternalStore } from "react";
import { translate } from "../../shared/i18n.mjs";
export type Language = "zh-CN" | "en";
let currentLanguage:Language = document.documentElement.lang === "en" ? "en" : "zh-CN";
const listeners = new Set<()=>void>();
export function setLanguage(value:Language) {
  if (value === currentLanguage) return;
  currentLanguage = value;
  document.documentElement.lang = value;
  // Update the native HUD immediately as well as React. The host's regular
  // settings polling remains a fallback if the bridge is still starting.
  const bridge=(window as unknown as {webkit?:{messageHandlers?:{selectionLab?:{postMessage:(body:unknown)=>Promise<unknown>}}}}).webkit?.messageHandlers?.selectionLab;
  if(bridge)void bridge.postMessage({op:'language',language:value}).catch(()=>{});
  const pocket=(window as unknown as {webkit?:{messageHandlers?:{keyboardPocket?:{postMessage:(body:unknown)=>Promise<unknown>}}}}).webkit?.messageHandlers?.keyboardPocket;
  if(pocket)void pocket.postMessage({op:'language',language:value}).catch(()=>{});
  for (const notify of listeners) notify();
}
export function language() {return currentLanguage;}
export function useLanguage() {
  return useSyncExternalStore(notify=>{listeners.add(notify);return ()=>{listeners.delete(notify);};},language);
}
export function t<T>(value:T):T { return translate(currentLanguage,value); }
export function dateLocale() {return currentLanguage === "en" ? "en-US" : "zh-CN";}
