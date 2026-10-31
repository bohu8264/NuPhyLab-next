import {t as tr,dateLocale} from './i18n';
import type {AppState} from './types';
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
type QuotaWindow = {
  name: string;
  used: number | null;
  resetsAt?: number | string;
};
function quotaWindows(value: unknown): QuotaWindow[] {
  const q = asObject(value),
    result: QuotaWindow[] = [];
  const add = (name: string, v: unknown, includeUnknown = false) => {
    const item = asObject(v);
    const raw = item.usedPercent ?? item.used_percent;
    const remaining = item.remainingPercent ?? item.remaining_percent;
    const used =
      typeof raw === "number" && Number.isFinite(raw)
        ? raw
        : typeof remaining === "number" && Number.isFinite(remaining)
          ? 100 - remaining
          : null;
    if (used === null && !includeUnknown) return;
    const minutes = Number(item.windowDurationMins ?? item.window_minutes ?? 0);
    const duration =
      minutes === 300
        ? "5 小时"
        : minutes === 10080
          ? "每周"
          : minutes > 0
            ? `${minutes / 60} 小时`
            : "";
    result.push({
      name: String(
        item.label || item.name || [name, duration].filter(Boolean).join(" · "),
      ),
      used: used === null ? null : Math.max(0, Math.min(100, used)),
      resetsAt: (item.resetsAt ?? item.resets_at) as
        | number
        | string
        | undefined,
    });
  };
  if (Array.isArray(q.buckets)) {
    q.buckets.forEach((bucket) => {
      const b = asObject(bucket);
      if (Array.isArray(b.windows))
        b.windows.forEach((window) =>
          add(String(b.label || b.id || "Codex"), window, true),
        );
    });
    return result;
  }
  if (Array.isArray(q.windows)) {
    q.windows.forEach((v, i) => add(`额度 ${i + 1}`, v));
    return result;
  }
  const buckets = asObject(q.rateLimitsByLimitId);
  if (Object.keys(buckets).length) {
    Object.entries(buckets).forEach(([id, v]) => {
      const b = asObject(v);
      if (b.primary) add(id === "codex" ? "5 小时" : id, b.primary);
      if (b.secondary)
        add(id === "codex" ? "每周" : `${id} · 每周`, b.secondary);
    });
    return result;
  }
  const base = asObject(q.rateLimits || q);
  if (base.primary) add("5 小时", base.primary);
  if (base.secondary) add("每周", base.secondary);
  if (!result.length) add("可用额度", q);
  return result;
}
function resetText(value?: string | number) {
  if (value === undefined) return "";
  const date = new Date(
    typeof value === "number" && value < 1e12 ? value * 1000 : value,
  );
  return Number.isNaN(date.getTime())
    ? ""
    : `${date.toLocaleString(dateLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 重置`;
}
export function AgentQuota({state,source}:{state:AppState|null;source:'codex'|'claude'}) {
  const claude=source==='claude',quota=asObject(claude?state?.claude?.quota:state?.codex.quota);
  const windows=claude||quota.available===false&&!quota.stale?[]:quotaWindows(quota);
  return <section className="agent-quota agent-quota-v6"><h3>{tr(claude?'账户额度':'Codex 额度')}{Boolean(quota.stale)&&<small>{tr('上次读数')}</small>}</h3>
    {windows.length?<div className="quota-windows">{windows.map((item,index)=><div className="quota-window" key={index}><div><span>{tr(item.name)}</span><strong>{item.used===null?'—':`${Math.round(100-item.used)}%`} <small>{tr('剩余')}</small></strong></div>{item.used!==null&&<div className="quota-track" role="meter" aria-label={tr(item.name)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100-item.used)}><span style={{width:`${100-item.used}%`}}/></div>}<p>{tr(resetText(item.resetsAt))}</p></div>)}</div>:<p className="agent-note">{tr(String(quota.reason??(claude?'Claude Code 暂不支持读取账户剩余额度':'暂时无法读取额度，没有使用估算值。')))}</p>}
    {Boolean(quota.stale)&&<p className="agent-note">{tr(String(quota.reason??'当前额度无法刷新，这里保留上次读数。'))}</p>}
    {claude&&<p className="agent-note">{tr(String(quota.detail??''))}</p>}
  </section>;
}
