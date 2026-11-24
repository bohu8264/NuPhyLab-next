import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Pencil, Pin, Plus, Trash2, X } from 'lucide-react';
import { Button, Modal } from './primitives';
import { language, useLanguage } from './i18n';
import { SelectionLab } from './SelectionLab';

type Command = { id: string; name: string; instruction: string; pinned: boolean };
type Draft = { id?: string; name: string; instruction: string };
type Status = { commands: Command[]; enabled: boolean; accessibility: boolean; shortcutLabel: string; shortcutReady: boolean; shortcutIssue: string; issue: string };
type Handler = { postMessage: (body: Record<string, unknown>) => Promise<Status> };

async function request(op: string, extra: Record<string, unknown> = {}) {
  const host = (window as unknown as { webkit?: { messageHandlers?: { mySelectionCommands?: Handler } } }).webkit?.messageHandlers?.mySelectionCommands;
  if (!host) throw new Error(language() === 'en' ? 'Open My Commands in the NuPhy Lab app.' : '请在 NuPhy Lab 应用中打开我的指令。');
  return await host.postMessage({ op, language: language(), ...extra });
}

export function MySelectionCommands() {
  const locale = useLanguage();
  const l = (zh: string, en: string) => locale === 'en' ? en : zh;
  const [status, setStatus] = useState<Status>();
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sample, setSample] = useState('');
  const [remove, setRemove] = useState<Command | null>(null);
  const pending = useRef(false);
  const active = useRef(false);

  useEffect(() => {
    let alive = true;
    active.current = true;
    const refresh = () => {
      if (!pending.current) void request('status').then(s => { if (alive && !pending.current) setStatus(s); }).catch(e => { if (alive) setIssue(String(e.message || e)); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      active.current = false;
      window.removeEventListener('focus', refresh);
      void request('cancelRecording').catch(() => {});
    };
  }, [locale]);

  async function action(op: string, extra: Record<string, unknown> = {}) {
    if (pending.current) return false;
    pending.current = true;
    setIssue('');
    setBusy(true);
    try {
      const value = await request(op, extra);
      if (active.current) setStatus(value);
      return true;
    } catch (e) {
      if (active.current) setIssue(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      pending.current = false;
      if (active.current) { setBusy(false); setRecording(false); }
    }
  }

  function edit(item?: Command) {
    setIssue('');
    setSample('');
    setDraft(item ? { id: item.id, name: item.name, instruction: item.instruction } : { name: '', instruction: '' });
  }
  const valid = draft && Boolean(draft.name.trim() && draft.instruction.trim());
  const error = (issue || status?.issue) && <p role="alert" className="mc-issue">{issue || status?.issue}</p>;

  return <section className="selection-lab selection-formal my-selection-commands" aria-label={l('我的指令', 'My Commands')}>
    <div className="sl-settings-card">
      <div className="sl-enable-row">
        <div className="sl-row-copy"><h2>{l('启用指令快捷键', 'Enable command shortcut')}</h2>
          <p>{l('选中文字后按快捷键，选择指令并预览结果。', 'Select text, press the shortcut, then choose a command to preview its result.')}</p></div>
        <label className="switch-field"><button role="switch" aria-label={l('启用指令快捷键','Enable command shortcut')} aria-checked={status?.enabled === true}
          className={'switch' + (status?.enabled ? ' checked' : '')} disabled={!status || busy} onClick={() => void action('enabled', { value: !status?.enabled })}><span /></button></label>
      </div>
      <div className="sl-preferences"><div className="sl-preference-row">
        <div className="sl-row-copy"><h3>{l('指令快捷键','Command shortcut')}</h3>
          {status?.shortcutIssue && <p>{status.shortcutIssue}</p>}
          {status?.enabled && !status.accessibility && <button className="mc-link" onClick={() => window.dispatchEvent(new CustomEvent('nuphylab:navigate', {detail:'permissions'}))}>
            {l('在权限设置中允许辅助功能','Allow Accessibility in permissions')}</button>}
        </div>
        <button className={'sl-shortcut' + (recording ? ' recording' : '')} disabled={!status || busy}
          onClick={() => { setRecording(true); void action('record'); }}>{recording ? l('请按下快捷键…','Press a shortcut…') : status?.shortcutLabel || l('未设置','Not set')}</button>
        {status?.shortcutLabel && <button className="mc-icon" disabled={busy} aria-label={l('清除快捷键','Clear shortcut')} onClick={() => void action('clear')}><X size={14} /></button>}
      </div></div>
    </div>
    <div className="mc-heading"><h3>{l('指令列表','Commands')}</h3>
      <Button icon={<Plus size={15} />} disabled={!status || busy} onClick={() => edit()}>{l('新建指令','New command')}</Button></div>
    {status?.commands.map((c, i, all) => <div key={c.id} className="mc-command">
      <div className="sl-row-copy"><h3>{c.name}</h3><p>{c.instruction}</p></div>
      <div className="mc-tools">{[
        { label: l('固定','Pin'), icon:<Pin size={15} fill={c.pinned ? 'currentColor' : 'none'}/>, op: () => action('pin', {id:c.id}), pressed:c.pinned },
        { label: l('上移','Move up'), icon:<ArrowUp size={15}/>, op: () => action('move', {id:c.id, offset:-1}), disabled:!all[i-1] || all[i-1].pinned !== c.pinned },
        { label: l('下移','Move down'), icon:<ArrowDown size={15}/>, op: () => action('move', {id:c.id, offset:1}), disabled:!all[i+1] || all[i+1].pinned !== c.pinned },
        { label: l('创建副本','Duplicate'), icon:<Copy size={15}/>, op: () => action('duplicate', {id:c.id}) },
        { label: l('编辑','Edit'), icon:<Pencil size={15}/>, op: () => edit(c) },
        { label: l('移除','Remove'), icon:<Trash2 size={15}/>, op: () => {setIssue(''); setRemove(c);} }
      ].map(b => <button key={b.label} className="mc-icon" title={b.label} aria-label={b.label+' · '+c.name} aria-pressed={b.pressed} disabled={busy || b.disabled} onClick={() => void b.op()}>{b.icon}</button>)}</div>
    </div>)}
    {status?.commands.length === 0 && <p>{l('点击「新建指令」添加第一条指令。','Choose New command to add your first command.')}</p>}
    {!draft && !remove && error}
    {draft && <Modal title={draft.id ? l('编辑指令','Edit command') : l('新建指令','New command')} initialFocus="input" onClose={() => setDraft(null)} busy={busy}
      footer={<><Button disabled={busy} onClick={() => setDraft(null)}>{l('取消','Cancel')}</Button>
        <Button kind="primary" disabled={!valid || busy} onClick={async () => { if (await action('save', draft)) setDraft(null); }}>{l('保存','Save')}</Button></>}>
      <div className="mc-fields">
        <label>{l('名称','Name')}<input maxLength={80} value={draft.name} onChange={e => setDraft({...draft, name:e.target.value})} /></label>
        <label>{l('处理要求','Instruction')}<textarea maxLength={8000} rows={4} value={draft.instruction} onChange={e => setDraft({...draft, instruction:e.target.value})} /></label>
        <label>{l('试运行原文','Sample text')}<textarea rows={2} value={sample} onChange={e => setSample(e.target.value)} /></label>
        <Button disabled={!valid || !sample.trim() || busy} onClick={() => void action('try', {...draft, sample})}>{l('试运行','Try command')}</Button>
        {error}
      </div>
    </Modal>}
    {remove && <Modal title={l('移除指令','Remove command')} description={remove.name} initialFocus="cancel" busy={busy} onClose={() => setRemove(null)}
      footer={<><Button onClick={() => setRemove(null)}>{l('取消','Cancel')}</Button><Button kind="danger" disabled={busy}
        onClick={async () => { if (await action('delete', {id:remove.id})) setRemove(null); }}>{l('移除','Remove')}</Button></>}>{error}</Modal>}
  </section>;
}

export function SmartSelectionPage() {
    const en = useLanguage() === 'en';
    const [tab, setTab] = useState<'region' | 'commands'>('region');
    return <>
      <nav className="lab-tabs mc-tabs" aria-label={en ? 'Smart Selection' : '智能框选'}>
        <button type="button" className={tab === 'region' ? 'active' : ''} aria-pressed={tab === 'region'} onClick={() => setTab('region')}>{en ? 'Screen selection' : '屏幕框选'}</button>
        <button type="button" className={tab === 'commands' ? 'active' : ''} aria-pressed={tab === 'commands'} onClick={() => setTab('commands')}>{en ? 'My Commands' : '我的指令'}</button>
      </nav>
      {tab === 'region' ? <SelectionLab /> : <MySelectionCommands />}
    </>;
}
