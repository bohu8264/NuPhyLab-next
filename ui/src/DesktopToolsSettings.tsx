import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {X} from 'lucide-react';
import {Button, Switch} from './primitives';
import {useLanguage} from './i18n';
import './screen-replay.css';

type Choice = readonly [id: string, zh: string, en: string];
type Shortcut = {shortcutLabel: string; shortcutIssue: string};
type Collection = {enabled: boolean; source: string; sources: string[]; path: string; target: string; filter: string; status: string};
type ShelfState = {
  enabled: boolean; ready: boolean; loading: boolean; keys: Record<string, Shortcut>; options: Record<string, unknown>;
  accessibility: boolean; storage: number; notice: string; shelves: {id: string; name: string}[]; collection: Collection;
};
type BridgeArgs = Record<string, unknown>;
const sources: Choice[] = [['screenshots', '新截图', 'New screenshots'], ['downloads', '下载目录', 'Downloads'], ['custom', '自选文件夹', 'Custom folder']];
const filters: Choice[] = [['all','全部','All'], ['images','图片','Images'], ['documents','文档','Documents'], ['media','影音','Audio and video']];
const bindings: Choice[] = [['shelf','打开或收起暂存台','Show or hide shelf'], ['clipboard','加入当前剪贴板','Add current clipboard'], ['batch','处理选中素材','Process selected items']];

export function DesktopToolsSettings() {
  const en = useLanguage() === 'en';
  const t = (zh: string, english: string) => en ? english : zh;
  const title = t('桌面临时暂存台', 'Desktop Shelf');
  const [state, setState] = useState<ShelfState>();
  const [pending, setPending] = useState(''), [error, setError] = useState('');
  const live = useRef(false), lock = useRef(''), revision = useRef(0);
  const send = useCallback((op: string, args: BridgeArgs = {}) => {
    const bridge = (window as unknown as {webkit?: {messageHandlers?: {desktopTools?: {postMessage(v: unknown): Promise<ShelfState>}}}}).webkit?.messageHandlers?.desktopTools;
    if (!bridge) return Promise.reject(new Error(en ? 'Open this tool in the Mac app.' : '请在 Mac 应用里打开。'));
    return bridge.postMessage({op, feature: 'desktop-shelf', language: en ? 'en' : 'zh-CN', ...args});
  }, [en]);
  const refresh = useCallback(() => {
    if (lock.current) return;
    const token = ++revision.current;
    send('status').then(next => {
      if (live.current && token === revision.current) { setState(next); setError(''); }
    }).catch(err => { if (live.current && token === revision.current) setError(String(err.message ?? err)); });
  }, [send]);
  useEffect(() => {
    live.current = true;
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('nuphylab:shelf-settings', refresh);
    return () => {
      live.current = false;
      ++revision.current;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('nuphylab:shelf-settings', refresh);
      if (lock.current.startsWith('record-')) void send('cancel').catch(() => {});
    };
  }, [refresh, send]);
  const collecting = state?.collection;
  useEffect(() => {
    if (!state?.loading && collecting?.status !== 'starting') return;
    const timer = window.setInterval(refresh, 450);
    return () => window.clearInterval(timer);
  }, [state?.loading, collecting?.status, refresh]);

  async function act(op: string, args: BridgeArgs = {}, key = op) {
    if (lock.current) return;
    const token = ++revision.current;
    lock.current = key; setPending(key); setError('');
    try {
      const next = await send(op, args);
      if (live.current && token === revision.current) setState(next);
    } catch (err) {
      if (live.current && token === revision.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      lock.current = '';
      if (live.current) setPending('');
    }
  }
  const option = (key: string, value: unknown) => void act('option', {key, value});
  const collection = (args: BridgeArgs) => void act('collection', args);
  const opts = state?.options ?? {}, busy = !!pending || !state;
  const collectionDisabled = busy || !state?.enabled || !state.ready;
  const choices = (values: Choice[]) => values.map(([id, zh, english]) => <option key={id} value={id}>{t(zh, english)}</option>);
  const row = (name: string, controls: ReactNode, detail?: string) => <div className="replay-row" key={name}><div><strong>{name}</strong>{detail && <p>{detail}</p>}</div><div className="replay-actions">{controls}</div></div>;
  const toggle = (key: string, zh: string, english: string) => <div className="replay-row shelf-switch-row"><Switch label={t(zh, english)} checked={!!opts[key]} disabled={busy} onChange={value => option(key, value)}/></div>;
  const pick = (key: string, zh: string, english: string, options: Choice[]) => row(t(zh, english),
    <select aria-label={t(zh, english)} disabled={busy} value={String(opts[key] ?? '')} onChange={e => option(key, e.target.value)}>{choices(options)}</select>);
  const number = (key: string, zh: string, english: string, min: number, max: number) => row(t(zh, english),
    <input key={String(opts[key])} className="shelf-number" type="number" aria-label={t(zh, english)} min={min} max={max} step={1} defaultValue={Number(opts[key] ?? min)} disabled={busy}
      onBlur={e => { if (e.target.validity.valid && e.target.value !== '' && Number(e.target.value) !== opts[key]) option(key, Number(e.target.value)); }}/>);
  const chooseSource = (value: string) => collection({source: value, chooseFolder: value === 'custom' && !collecting?.path});
  return <section className="screen-replay desktop-shelf" aria-label={title}>
    <div className="replay-controls">
      <div className="replay-head"><Switch voiceId="desktop-shelf" label={title} checked={!!state?.enabled} disabled={busy} onChange={value => void act('enable', {value})}/></div>
      <p className="shelf-intro">{t('把素材拖到屏幕顶部，出现提示后松手收下。打开暂存台即可取用。','Drag items to the top of the display and release when the drop target appears. Open the shelf to use them.')}</p>
      {row(t('当前暂存台','Current shelf'), <Button kind="primary" disabled={collectionDisabled} onClick={() => void act('open')}>{t('打开或收起','Show or hide')}</Button>)}
      {bindings.map(([id, zh, english]) => row(t(zh, english), <>
        <button className="replay-key" disabled={busy} onClick={() => void act('record', {key:id}, 'record-' + id)}>{pending === 'record-' + id ? t('按下快捷键…','Press shortcut…') : (state?.keys[id]?.shortcutLabel || t('设置快捷键','Set shortcut'))}</button>
        <button aria-label={t('清除 ','Clear ') + t(zh, english)} className="replay-clear" disabled={busy || !state?.keys[id]?.shortcutLabel} onClick={() => void act('clear', {key:id})}><X size={14}/></button>
      </>, state?.keys[id]?.shortcutIssue))}
    </div>
    <div className="replay-controls">
      {toggle('notch','拖到刘海或顶部中央唤出','Show at the notch or top center')}
      {pick('edge','拖到屏幕边缘唤出','Show at screen edge',[['off','关闭','Off'],['left','左','Left'],['right','右','Right'],['top','上','Top'],['bottom','下','Bottom']])}
      {pick('placement','快捷键唤出位置','Shortcut opens at',[['notch','刘海或顶部中央','Notch or top center'],['free','自由悬浮','Floating'],['left','左侧','Left'],['right','右侧','Right'],['bottom','底部','Bottom']])}
      {toggle('collapse','离开后自动收起','Hide when the pointer leaves')}{toggle('thumb','显示缩略图','Show thumbnails')}
      {pick('batchOp','批处理快捷键动作','Batch shortcut action',[['zip','打包 ZIP','Create ZIP'],['compress','压缩图片','Compress images'],['ocr','识别文字','OCR'],['merge','合并文字','Merge text'],['pdf','图片转 PDF','Images to PDF'],['montage','拼图','Collage'],['ai','询问 AI','Ask AI']])}
    </div>
    <div className="replay-controls">
      {number('days','未固定素材保留天数','Keep unpinned items for (days)',1,365)}
      {number('mb','暂存空间上限（MB）','Temporary storage limit (MB)',32,4096)}
      {row(t('暂存文件已用空间','Temporary files on disk'), <span>{((state?.storage ?? 0) / 1048576).toFixed(1)} MB</span>)}
    </div>
    <div className="replay-controls shelf-collection">
      <div className="replay-head"><Switch label={t('自动收集','Auto-collect')} checked={!!collecting?.enabled} disabled={collectionDisabled} onChange={enabled => collection({enabled})}/></div>
      {row(t('收集来源','Source'), <select className="shelf-source" aria-label={t('收集来源','Source')} disabled={collectionDisabled} value={collecting?.source ?? 'screenshots'} onChange={e => chooseSource(e.target.value)}>
        {collecting?.source === 'legacy' && <option value="legacy">{sources.filter(([id]) => collecting.sources.includes(id)).map(([,zh,english]) => t(zh, english)).join(' + ')}</option>}
        {choices(sources)}</select>, t('只收集开启后新增的项目。','Collects items added after you turn this on.'))}
      {collecting?.source === 'custom' && row(t('文件夹','Folder'), <Button kind="ghost" disabled={collectionDisabled} onClick={() => collection({source:'custom', chooseFolder:true})}>{t('选择文件夹…','Choose folder…')}</Button>, collecting.path)}
      {row(t('收集到','Destination'), <select aria-label={t('目标暂存台','Destination shelf')} disabled={collectionDisabled} value={collecting?.target || state?.shelves[0]?.id || ''} onChange={e => collection({target:e.target.value})}>
        {collecting?.target === 'mixed' && <option value="mixed">{t('按来源分别保存','Saved per source')}</option>}
        {state?.shelves.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select>)}
      {row(t('文件类型','File type'), <select aria-label={t('文件类型','File type')} disabled={collectionDisabled} value={collecting?.filter ?? 'all'} onChange={e => collection({filter:e.target.value})}>
        {collecting?.filter === 'mixed' && <option value="mixed">{t('按来源分别筛选','Filtered per source')}</option>}{choices(filters)}</select>)}
      {collecting?.status === 'starting' && <p className="shelf-intro" role="status">{t('正在准备所选来源…','Preparing the selected source…')}</p>}
      {collecting?.status === 'unavailable' && <p className="shelf-intro" role="status">{t('无法读取所选文件夹。请检查文件夹是否存在，以及 NuPhy Lab 的文件夹访问权限，再重新开启自动收集。','Cannot read the selected folder. Check that it exists and that NuPhy Lab has access, then turn auto-collect on again.')}</p>}
    </div>
    {state && !state.accessibility && <div className="replay-controls">{row(t('全局快捷键需要辅助功能权限','Global shortcuts need Accessibility'), <Button kind="ghost" onClick={() => void act('permission')}>{t('授权','Allow')}</Button>)}</div>}
    {(error || state?.notice) && <p role="status">{error || state?.notice}</p>}
  </section>;
}
