import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowDown, ArrowRight, ArrowUp, Check, CircleAlert, GripVertical, Keyboard, Layers, LayoutGrid, Pencil, Plus, RotateCcw, Shapes, Trash2} from 'lucide-react';
import {Button, Modal, Switch} from './primitives';
import {useLanguage} from './i18n';
import './dock-scenes.css';

type AppTile = {id: string; name: string; available: boolean; icon?: string};
type Scene = {id: string; name: string; apps: AppTile[]; custom: boolean; registered: boolean; shortcut?: string; warning?: string};
type DockState = {enabled: boolean; scenes: Scene[]; current?: string; pending?: string; applying: boolean; recovery: boolean; appliedRevision: number; error?: string; created?: string};
type Dialog = {kind: 'create'} | {kind: 'rename' | 'delete' | 'edit'; id: string};
type DockBridge = {postMessage: (body: Record<string, unknown>) => Promise<DockState>};

function AppIcon({app}: {app: AppTile}) {
  return app.icon ? <img className="dock-app-icon" src={app.icon} alt="" draggable={false}/> : <LayoutGrid aria-hidden="true" className="dock-app-icon"/>;
}

export function DockScenes() {
  const english = useLanguage() === 'en';
  const t = (zh: string, en: string) => english ? en : zh;
  const [state, setState] = useState<DockState | null>(null);
  const [selected, select] = useState('all');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), sequence = useRef(0), applied = useRef(-1);
  const writing = useRef(false), dragging = useRef<{scene: string; app: string} | null>(null);
  const send = useCallback(async (op: string, values: Record<string, unknown> = {}) => {
    const bridge = (window as unknown as {webkit?: {messageHandlers?: {dockScenes?: DockBridge}}}).webkit?.messageHandlers?.dockScenes;
    if (!bridge) throw new Error(english ? 'Open Dock Scenes in NuPhy Lab for Mac.' : '请在 Mac 的 NuPhy Lab 中打开 Dock 场景。');
    return bridge.postMessage({op, ...values});
  }, [english]);

  const accept = useCallback((next: DockState) => {
    setState(next);
    const didApply = applied.current !== next.appliedRevision;
    applied.current = next.appliedRevision;
    select(previous => next.created ?? next.pending ?? (didApply ? next.current : undefined)
      ?? (next.scenes.some(scene => scene.id === previous) ? previous : next.current ?? 'all'));
  }, []);

  useEffect(() => {
    const epoch = ++generation.current;
    const read = async () => {
      const ticket = ++sequence.current;
      try {
        const next = await send('state');
        if (epoch === generation.current && ticket === sequence.current) { accept(next); }
      } catch (reason) {
        if (epoch === generation.current && ticket === sequence.current) setError(String(reason instanceof Error ? reason.message : reason));
      }
    };
    void read();
    window.addEventListener('nuphylab:dock-scenes', read);
    return () => { ++generation.current; window.removeEventListener('nuphylab:dock-scenes', read); };
  }, [send, accept]);

  async function action(op: string, values: Record<string, unknown> = {}) {
    if (writing.current) return false;
    const epoch = generation.current;
    writing.current = true;
    ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const next = await send(op, values);
      if (epoch !== generation.current) return false;
      accept(next);
      return true;
    } catch (reason) {
      if (epoch === generation.current) setError(String(reason instanceof Error ? reason.message : reason));
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  const scene = state?.scenes.find(item => item.id === selected) ?? state?.scenes[0];
  const editing = dialog && 'id' in dialog ? state?.scenes.find(item => item.id === dialog.id) : undefined;
  const editingBlocked = !scene || !!state?.applying || busy;
  const message = error || state?.error;
  function show(next: Dialog) {
    setError('');
    setName(next.kind === 'rename' ? scene?.name ?? '' : '');
    setDialog(next);
  }
  async function saveName() {
    if (!dialog || (dialog.kind !== 'rename' && dialog.kind !== 'create')) return;
    if (await action(dialog.kind, {name, ...(dialog.kind === 'rename' ? {id: dialog.id} : {})})) setDialog(null);
  }

  return <section className="dock-scenes">
    <div className="dock-toolbar">
      <Switch voiceId="dock-scenes" checked={state?.enabled ?? false} disabled={busy || !scene} label={t('场景快捷键', 'Scene shortcuts')} onChange={enabled => void action('enable', {enabled})}/>
      <Button kind="ghost" icon={<RotateCcw size={15}/>} disabled={busy || state?.applying} onClick={() => void action('reload')}>{t('重新读取', 'Reload')}</Button>
      <Button icon={<Plus size={16}/>} disabled={editingBlocked} onClick={() => show({kind: 'create'})}>{t('新建场景', 'New scene')}</Button>
    </div>
    {(message && !dialog) && <p className="dock-feedback" role="alert">{message}</p>}
    {state?.recovery && <div className="dock-feedback" role="status">{t('上次切换尚未确认。', 'The last switch was not confirmed.')} <Button disabled={busy || state.applying} onClick={() => void action('apply', {id: 'all'})}>{t('恢复原 Dock', 'Restore original Dock')}</Button></div>}
    <div className="dock-scene-picker" aria-label={t('场景', 'Scenes')}>
      {state?.scenes.map(item => <button type="button" key={item.id} aria-pressed={scene?.id === item.id} className="dock-scene-card" onClick={() => select(item.id)}>
        {item.id === 'all' ? <Layers size={18}/> : item.id === 'design' ? <Pencil size={17}/> : item.id === 'entertainment' ? <Shapes size={18}/> : <LayoutGrid size={17}/>}
        <strong>{item.name}</strong>
        {item.id === state.current && <Check size={15} aria-label={t('当前场景', 'Current scene')}/>}
        {item.warning && <CircleAlert size={15} aria-label={item.warning}/>}
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button>)}
    </div>
    {scene && <div className="dock-preview">
      <div className="dock-preview-header">
        <div><h2>{scene.name}</h2><p>{scene.id === 'all' ? t('首次保存的 Dock 布局', 'Original Dock layout') : t('固定应用', 'Pinned apps')} · {scene.apps.length}</p></div>
        <div className="dock-actions">
          {scene.id !== 'all' && <Button kind="ghost" disabled={editingBlocked} onClick={() => show({kind: 'edit', id: scene.id})}>{t('编辑场景','Edit scene')}</Button>}
          <Button icon={<Keyboard size={15}/>} disabled={editingBlocked} onClick={() => void action('shortcut', {id: scene.id})}>{t('设置快捷键','Set shortcut')}</Button>
          <Button kind="primary" icon={<ArrowRight size={15}/>} disabled={busy || state?.pending === scene.id || (!state?.applying && scene.id === state?.current) || (scene.id !== 'all' && !scene.apps.length)}
            onClick={() => void action('apply', {id: scene.id})}>{state?.pending === scene.id ? t('切换中…','Switching…') : scene.id === state?.current && !state?.applying ? t('已应用','Applied') : t('应用到 Dock','Apply to Dock')}</Button>
        </div>
      </div>
      {scene.warning && <p className="dock-feedback">{scene.warning}</p>}
      <div className="dock-app-grid">{scene.apps.map(app => <div key={app.id} title={app.name}><AppIcon app={app}/><span>{app.name}</span>{!app.available && <small>{t('未找到','Missing')}</small>}</div>)}</div>
      {!scene.apps.length && (scene.id === 'all' ? <p>{t('原 Dock 没有固定应用。','Your original Dock has no pinned apps.')}</p> :
        <Button disabled={editingBlocked} icon={<Plus size={14}/>} onClick={() => void action('addApps', {id: scene.id})}>{t('添加应用','Add apps')}</Button>)}
    </div>}
    {dialog && (dialog.kind === 'create' || dialog.kind === 'rename') && <Modal title={dialog.kind === 'create' ? t('新建场景','New scene') : t('重命名场景','Rename scene')} onClose={() => setDialog(null)} initialFocus="input" busy={busy}
      footer={<><Button onClick={() => setDialog(null)}>{t('取消','Cancel')}</Button><Button kind="primary" disabled={busy || !name.trim()} onClick={() => void saveName()}>{t('保存','Save')}</Button></>}>
      <label className="dock-name">{t('场景名称','Scene name')}<input maxLength={40} value={name} onChange={event => setName(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && !event.nativeEvent.isComposing && name.trim()) void saveName();}}/></label>
      {message && <p role="alert">{message}</p>}
    </Modal>}
    {dialog?.kind === 'edit' && editing && <Modal title={editing.name} width={560} onClose={() => setDialog(null)} footer={<Button kind="primary" onClick={() => setDialog(null)}>{t('完成','Done')}</Button>}>
      <div className="dock-edit-actions">
        <Button icon={<Plus size={14}/>} disabled={editingBlocked} onClick={() => void action('addApps', {id: editing.id})}>{t('添加应用','Add apps')}</Button>
        {editing.custom && <><Button kind="ghost" onClick={() => show({kind: 'rename', id: editing.id})}>{t('重命名','Rename')}</Button><Button kind="ghost" onClick={() => show({kind: 'delete', id: editing.id})}>{t('删除场景','Delete scene')}</Button></>}
      </div>
      <ol className="dock-edit-list">{editing.apps.map((app, index) => <li key={app.id} draggable={!editingBlocked}
        onDragStart={event => {dragging.current = {scene: editing.id, app: app.id}; event.dataTransfer.setData('text/plain',app.id);}}
        onDragOver={event => {if (dragging.current?.scene === editing.id) event.preventDefault();}}
        onDrop={event => {event.preventDefault(); const from = dragging.current; dragging.current = null; if (from?.scene === editing.id && from.app !== app.id) void action('moveApp',{id: editing.id, app: from.app, to: index});}}
        onDragEnd={() => {dragging.current = null;}}>
        <GripVertical size={14}/><AppIcon app={app}/><span>{app.name}</span>
        <button disabled={editingBlocked || index === 0} aria-label={t('上移','Move up')+' '+app.name} onClick={() => void action('moveApp',{id: editing.id, app: app.id, to: index-1})}><ArrowUp size={15}/></button>
        <button disabled={editingBlocked || index === editing.apps.length-1} aria-label={t('下移','Move down')+' '+app.name} onClick={() => void action('moveApp',{id: editing.id, app: app.id, to: index+1})}><ArrowDown size={15}/></button>
        <button disabled={editingBlocked} aria-label={t('移除','Remove')+' '+app.name} onClick={() => void action('removeApp',{id: editing.id, app: app.id})}><Trash2 size={15}/></button>
      </li>)}</ol>
      {message && <p role="alert">{message}</p>}
    </Modal>}
    {dialog?.kind === 'delete' && editing && <Modal title={t('删除场景','Delete scene')} initialFocus="cancel" onClose={() => setDialog(null)}
      footer={<><Button data-modal-cancel onClick={() => setDialog(null)}>{t('取消','Cancel')}</Button><Button kind="danger" onClick={async () => {if (await action('delete',{id: editing.id})) setDialog(null);}}>{t('删除','Delete')}</Button></>}>
      <p>{english ? 'Remove “'+editing.name+'” from your scenes?' : '从你的场景中删除「'+editing.name+'」？'}</p>{message && <p role="alert">{message}</p>}
    </Modal>}
  </section>;
}
