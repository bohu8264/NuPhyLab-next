import { useEffect, useId, useRef, useState } from 'react';
import { providers } from './selection-providers';
import { translationLanguages, type TranslationLanguage } from './selection-languages';
import { selectionActions, enabledSelectionActions, type SelectionActionID } from './selection-actions';
import { t, useLanguage } from './i18n';
import { ArrowUpRight, Check, ChevronRight, CircleHelp, KeyRound, RotateCcw, ScanLine, Search, ShieldCheck } from 'lucide-react';
import { Button } from './primitives';
import './selection-lab.css';
type Configuration = {
    provider: string;
    endpoint: string;
    model: string;
    apiProtocol: string;
    imageInputConfirmed: boolean;
    maximumOutputTokens: number;
    anthropicWorkspaceID?: string;
};
type Preferences = {
    enabled: boolean;
    shortcut: {
        keyCode: number;
        modifiers: number;
        label: string;
        modifierOnly?: boolean;
        buttonIndex?: number;
    };
    configuration: Configuration;
    voiceEnabled: boolean;
    defaultAction: SelectionActionID;
    enabledActions?: SelectionActionID[];
    translationLanguage?: TranslationLanguage;
};
type Status = {
    supported: boolean;
    ready?: boolean;
    setupState?: string;
    shortcutConflict?: boolean;
    configurationIssue?: string;
    needsRelaunch?: boolean;
    microphoneState?: string;
    speechRecognitionState?: string;
    preferences: Preferences;
    hasKey: boolean;
    screenRecording: boolean;
    accessibility: boolean;
    inputMonitoring: boolean;
    microphone: boolean;
    speechRecognition: boolean;
    shortcutNotice: string;
    shortcutRegistered: boolean;
    issue: string;
    phase: string;
};
const defaults: Preferences = { enabled: false, voiceEnabled: false, defaultAction: 'translate', shortcut: { keyCode: 12, modifiers: 2560, label: '⌥ ⇧ Q' }, configuration: { provider: 'openAI', endpoint: 'https://api.openai.com/v1/responses', model: '', apiProtocol: 'responses', imageInputConfirmed: false, maximumOutputTokens: 4096 } };
// Keep one activation target for WebKit and accessibility, without an outer
// label forwarding clicks from the decorative switch thumb.
function Switch({ checked, onChange, label, disabled }: {
    checked: boolean;
    onChange: (value: boolean) => void;
    label: string;
    disabled?: boolean;
}) {
    return <div className={'switch-field ' + (disabled ? 'disabled' : '')}><button type="button" className={'switch ' + (checked ? 'checked' : '')} role="switch" aria-checked={checked} aria-label={t(label)} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></div>;
}
async function native(op: string, body: Record<string, unknown> = {}): Promise<any> {
    const bridge = (window as unknown as {
        webkit?: {
            messageHandlers?: {
                selectionLab?: {
                    postMessage: (body: unknown) => Promise<unknown>;
                };
            };
        };
    }).webkit?.messageHandlers?.selectionLab;
    if (!bridge)
        throw new Error('请在 NuPhy Lab中使用此功能。浏览器只展示界面。');
    return bridge.postMessage({ op, ...body });
}
function useSelectionStatus() {
    const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState('');
    useEffect(() => { let active = true, inFlight = false; const read = async () => { if (inFlight)
        return; inFlight = true; try {
        const value = await native('status');
        if (active) {
            setStatus(value);
            setError('');
        }
    }
    catch (e) {
        if (active) {
            setStatus(null);
            setError(String((e as Error).message || e));
        }
    }
    finally {
        inFlight = false;
    } }; void read(); const timer = setInterval(read, 1500); window.addEventListener('focus', read); document.addEventListener('visibilitychange', read); return () => { active = false; clearInterval(timer); window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', read); }; }, []);
    return { status, setStatus, error };
}
const openSettings = () => window.dispatchEvent(new CustomEvent('nuphylab:navigate', { detail: 'ai' }));
const configuredForSelection = (status: Status) => !!status.hasKey && !!status.preferences.configuration.model && !status.configurationIssue;
const needsBasePermissions = (status: Status) => !status.accessibility || !status.screenRecording || !status.inputMonitoring;
const needsVoicePermissions = (status: Status) => status.preferences.voiceEnabled && (!status.microphone || !status.speechRecognition);
function selectionReadiness(status: Status | null) {
    if (!status)
        return { label: '正在读取状态', detail: '正在检查框选状态。' };
    if (status.supported === false)
        return { label: '当前系统不支持', detail: '智能框选需要 macOS 14 或更新版本。' };
    if (!status.preferences.enabled)
        return { label: '已关闭', detail: '开启后可使用快捷键框选。' };
    if (status.setupState === 'recording')
        return { label: '正在录制快捷键', detail: '按下键盘快捷键或鼠标侧键，松开保存；Esc 取消。' };
    if (!configuredForSelection(status))
        return { label: '等待模型设置', detail: '选择模型并保存 API Key 后即可继续。' };
    if (status.needsRelaunch)
        return { label: '等待重新打开', detail: '系统授权已更新，请重新打开以完成检查。' };
    if (needsBasePermissions(status))
        return { label: '框选权限待开启', detail: '请在权限设置中完成基础授权。' };
    if (needsVoicePermissions(status))
        return { label: '语音权限待开启', detail: '可关闭语音，继续使用文字框选。' };
    if (status.shortcutConflict)
        return { label: '快捷键冲突', detail: '请录制其他按键或带修饰键的组合。' };
    if (status.setupState === 'secureInput')
        return { label: '安全输入中', detail: '当前输入受到系统保护，结束安全输入后可重新检查。' };
    if (status.setupState === 'monitorPaused')
        return { label: '监听已暂停', detail: '权限已允许，请重新检查以恢复全局快捷键监听。' };
    if (!status.shortcutRegistered)
        return { label: '监听未就绪', detail: '权限已允许，全局快捷键监听尚未启动。' };
    if (status.ready === true)
        return { label: '已就绪', detail: '可使用快捷键或立即框选。' };
    return { label: '状态待确认', detail: '监听已启动，正在确认框选是否可用。' };
}
export function SelectionLab() {
    useLanguage();
    const { status, setStatus, error } = useSelectionStatus();
    const [issue, setIssue] = useState(''), [busy, setBusy] = useState(false), [recording, setRecording] = useState(false);
    const prefs = status?.preferences ?? defaults, provider = providers.find(x => x.id === prefs.configuration.provider);
    const enabledActions = enabledSelectionActions(prefs.enabledActions, prefs.defaultAction);
    const unavailable = status?.supported === false, configured = !!status && configuredForSelection(status);
    const missingBase = !!status && needsBasePermissions(status), missingVoice = !!status && needsVoicePermissions(status);
    const readiness = selectionReadiness(status);
    const ready = status?.ready === true && readiness.label === '已就绪';
    const openPermissions = () => window.dispatchEvent(new CustomEvent('nuphylab:navigate', { detail: 'permissions' }));
    async function save(value: Partial<Pick<Preferences, 'enabled' | 'voiceEnabled' | 'defaultAction' | 'translationLanguage'>>) {
        setBusy(true);
        setIssue('');
        try {
            const latest: Status = await native('status');
            const result: Status = await native('save', { preferences: { ...latest.preferences, ...value } });
            setStatus(result);
            if (value.enabled && !configuredForSelection(result))
                openSettings();
        }
        catch (e) {
            setIssue((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    async function changeAction(id: SelectionActionID, toggle = false) {
        setBusy(true); setIssue('');
        try {
            const latest: Status = await native('status');
            const current = enabledSelectionActions(latest.preferences.enabledActions, latest.preferences.defaultAction);
            let enabled = current;
            if (toggle) {
                if (current.includes(id) && current.length === 1) {
                    setStatus(latest); setIssue('至少保留一个动作。'); return;
                }
                enabled = enabledSelectionActions(current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
            } else if (!current.includes(id)) {
                setStatus(latest); setIssue('此动作已关闭，请先勾选。'); return;
            }
            const defaultAction = toggle ? (enabled.includes(latest.preferences.defaultAction) ? latest.preferences.defaultAction : enabled[0]) : id;
            setStatus(await native('save', { preferences: { ...latest.preferences, enabledActions: enabled, defaultAction } }));
        } catch (e) { setIssue((e as Error).message); }
        finally { setBusy(false); }
    }
    async function saveImageConsent(imageInputConfirmed: boolean) {
        setBusy(true);
        setIssue('');
        try {
            const latest: Status = await native('status');
            // Consent applies to the model the user could see when activating the switch.
            if (imageInputConfirmed && (credentialScope(latest.preferences.configuration) !== credentialScope(prefs.configuration) || latest.preferences.configuration.model !== prefs.configuration.model)) {
                setStatus(latest);
                setIssue('模型设置已更新，请确认当前模型支持图片后重试。');
                return;
            }
            setStatus(await native('save', { preferences: { ...latest.preferences, configuration: { ...latest.preferences.configuration, imageInputConfirmed } } }));
        }
        catch (e) {
            setIssue((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    async function action(op: string, body: Record<string, unknown> = {}) {
        setBusy(true);
        setIssue('');
        try {
            const result = await native(op, body);
            if (op !== 'relaunch')
                setStatus(result?.preferences ? result : await native('status'));
        }
        catch (e) {
            setIssue((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    return <section className="selection-lab selection-formal" aria-label={t("智能框选设置")}>
  <div className="sl-settings-card">
   <div className="sl-enable-row">
    <div className="sl-row-copy"><h2>{t("启用智能框选")}</h2><p>{t("按下快捷键，拖动框选，松开即答。")}</p></div>
    <Switch label={t("开启智能框选")} checked={prefs.enabled} disabled={!status || unavailable || busy} onChange={enabled => void save({ enabled })}/>
   </div>
   <div className="sl-preferences">
    <div className="sl-preference-row"><div className="sl-row-copy"><h3>{t("快捷键")}</h3><p>{t(recording ? '按下键盘快捷键或鼠标侧键，松开保存；Esc 取消。' : '点击后按键盘快捷键或鼠标侧键')}</p></div>
     <button className={'sl-shortcut ' + (recording ? 'recording' : '')} aria-label={t("录制框选快捷键")} disabled={!status || unavailable || busy} onClick={async (event) => { event.currentTarget.focus(); setRecording(true); setBusy(true); setIssue(''); try {
        setStatus(await native('recordShortcut'));
    }
    catch (e) {
        setIssue((e as Error).message);
    }
    finally {
        setRecording(false);
        setBusy(false);
    } }}>{t(recording ? '等待键盘或侧键…' : prefs.shortcut.label)}</button>
    </div>
    {t(status?.shortcutNotice && <p className="sl-binding-alert" role="status">{t(status.shortcutNotice)}</p>)}
    <div className="sl-preference-row sl-enabled-actions-row"><div className="sl-row-copy"><h3>{t("启用的动作")}</h3><p>{t("勾选想用的动作，滚轮只切换已勾选项。至少保留一个。")}</p></div>
     <div className="sl-enabled-actions" role="group" aria-label={t("启用的框选动作")}>{selectionActions.map(([value, label]) => <label key={value} className={enabledActions.includes(value) ? 'selected' : ''}><input type="checkbox" checked={enabledActions.includes(value)} aria-label={t(label)} disabled={!status || unavailable || busy || enabledActions.length === 1 && enabledActions.includes(value)} onChange={() => void changeAction(value, true)}/><span className="sl-action-mark" aria-hidden="true">{enabledActions.includes(value) && <Check size={10} strokeWidth={2.5}/>}</span><span>{t(label)}</span></label>)}</div>
    </div>
    <div className="sl-preference-row sl-default-action-row"><div className="sl-row-copy"><h3>{t("松开后")}</h3><p>{t(prefs.defaultAction === 'reply' ? "结合选中内容和口述要求生成回复" : "框选时可用滚轮切换")}</p></div>
     <div className="sl-actions" role="group" aria-label={t("默认框选动作")}>{selectionActions.filter(([value]) => enabledActions.includes(value)).map(([value, label]) => <button key={value} aria-pressed={prefs.defaultAction === value} disabled={!status || unavailable || busy} onClick={() => void changeAction(value)}>{t(label)}</button>)}</div>
    </div>
    <div className="sl-preference-row sl-translation-row"><div className="sl-row-copy"><label htmlFor="selection-translation-language">{t("翻译为")}</label><p>{t("保存后，后续翻译默认使用此语言。")}</p></div><select id="selection-translation-language" aria-label={t("翻译目标语言")} value={prefs.translationLanguage ?? 'zh-CN'} disabled={!status || unavailable || busy} onChange={event => void save({ translationLanguage: event.target.value as TranslationLanguage })}>{translationLanguages.map(item => <option key={item.id} value={item.id}>{item.id === "zh-CN" ? item.label : t(item.label)}</option>)}</select></div>
    <div className="sl-preference-row"><div className="sl-row-copy"><h3>{t("按住说话")}</h3><p>{t("按住时说出问题，语音在本机转写。")}</p></div><Switch label={t("开启按住说话")} checked={prefs.voiceEnabled} disabled={!status || unavailable || busy} onChange={voiceEnabled => void save({ voiceEnabled })}/></div>
    <div className="sl-preference-row sl-image-row"><div className="sl-row-copy"><h3>{t("发送选区图片")}</h3><p>{t("需要支持图片的模型；关闭时只发送识别文字。")}</p></div><Switch label={t("发送选区图片")} checked={prefs.configuration.imageInputConfirmed} disabled={!status || unavailable || busy} onChange={value => void saveImageConsent(value)}/></div>
   </div>
   <div className="sl-connections">
    <div className="sl-connection-row"><KeyRound size={15} strokeWidth={1.5}/><span className="sl-connection-label">{t("模型服务")}</span><span className="sl-connection-value" title={t(configured ? prefs.configuration.model : undefined)}>{t(!status ? '正在读取' : configured ? `${t(provider?.name || prefs.configuration.provider)} · ${prefs.configuration.model}` : '尚未配置')}</span><button className="sl-text-button" onClick={openSettings}>{t("设置")}<ChevronRight size={13}/></button></div>
    <div className="sl-connection-row"><ShieldCheck size={15} strokeWidth={1.5}/><span className="sl-connection-label">{t("权限")}</span><span className="sl-connection-value">{t(!status ? '正在读取' : unavailable ? '框选需要 macOS 14+' : missingBase ? '基础权限待开启' : missingVoice ? '语音权限待开启' : prefs.voiceEnabled ? '所需权限已允许' : '基础权限已允许')}</span><button className="sl-text-button" onClick={openPermissions}>{t("查看")}<ChevronRight size={13}/></button></div>
   </div>
   <div className="sl-bottom-row"><span className="sl-runtime-status" role="status"><i className={ready ? 'on' : ''}/>{t(error && !status ? '状态读取失败' : readiness.label)}</span><div className="sl-runtime-actions">{t(status && prefs.enabled && !ready && !unavailable && <button className="sl-text-button" disabled={busy} onClick={() => void action('refresh')}><RotateCcw size={13}/>{t("重新检查")}</button>)}<button className="sl-capture" disabled={!status || unavailable || busy || configured && !ready} onClick={() => configured ? void action('capture') : openSettings()}><ScanLine size={14}/>{t(configured ? '立即框选' : '配置模型')}</button></div></div>
  </div>
  {t((error || issue || status?.issue) && <p className="selection-message error" role="alert">{t(issue || status?.issue || error)}</p>)}
  {t(prefs.enabled && !ready && !unavailable && <div className="sl-setup-note" role="status"><p>{t(readiness.detail)}</p><div className="sl-setup-actions">{t(!configured && <button className="sl-text-button" onClick={openSettings}>{t("前往模型设置")}<ChevronRight size={13}/></button>)}{t(missingBase && <button className="sl-text-button" onClick={openPermissions}>{t("查看权限")}<ChevronRight size={13}/></button>)}{t(missingVoice && <button className="sl-text-button" disabled={busy} onClick={() => void action('disableVoice')}>{t("关闭语音，继续文字框选")}</button>)}{t(status?.needsRelaunch && <button className="sl-text-button" disabled={busy} onClick={() => void action('relaunch')}>{t("完成授权并重新打开")}</button>)}</div></div>)}
  {t(status?.needsRelaunch && !prefs.enabled && !unavailable && <div className="sl-setup-note" role="status"><p>{t("系统授权已更新，请重新打开以完成检查。")}</p><button className="sl-text-button" disabled={busy} onClick={() => void action('relaunch')}>{t("完成授权并重新打开")}</button></div>)}
  {t(unavailable && <p className="selection-message" role="status">{t(readiness.detail)}</p>)}
  <div className="sl-page-notes"><p className="sl-disclosure">{t(prefs.configuration.imageInputConfirmed ? '选区图片与问题会发送至模型服务；录音不上传。' : '识别文字与问题会发送至模型服务；录音不上传。')}</p><details className="sl-shortcut-help"><summary>{t("快捷键说明")}</summary><p>{t("开启期间，所设单键会被框选功能占用。与当前 AI 键盘控制冲突的按键会暂停框选快捷键；可使用其他按键或带修饰键的组合。Esc、Caps Lock 及部分系统组合不支持；Fn 需由 macOS 上报。")}</p></details></div>
 </section>;
}
export function SelectionPermissionSettings() {
    useLanguage();
    const { status, setStatus, error } = useSelectionStatus();
    const [busy, setBusy] = useState(''), [issue, setIssue] = useState('');
    const readiness = selectionReadiness(status);
    async function perform(permission: string) { setBusy(permission); setIssue(''); try {
        if (permission === 'relaunch') {
            await native('relaunch');
            return;
        }
        if (permission === 'disableVoice')
            await native('disableVoice');
        else if (permission !== 'refresh')
            await native('permission', { permission });
        setStatus(await native('refresh'));
    }
    catch (e) {
        setStatus(null);
        setIssue((e as Error).message);
    }
    finally {
        setBusy('');
    } }
    const entries = [
        { id: 'accessibility' as const, title: '辅助功能', detail: '用于识别受保护的输入区域。新版 macOS 中可能显示为“设备控制和数据访问”。' },
        { id: 'inputMonitoring' as const, title: '输入监控', detail: '用于识别你设置的全局单键、组合键和松开动作。' },
        { id: 'microphone' as const, title: '麦克风', detail: '仅在启用“按住说话”并保持按住时录音。' },
        { id: 'speechRecognition' as const, title: '语音识别', detail: '将录音在本机转成问题；松开后发送问题文本。' },
        { id: 'screenRecording' as const, title: '屏幕录制', detail: '仅在主动框选时截取选定区域，用于本机文字识别和提问。' },
    ];
    return <div className="lab-permission-preferences selection-permissions">
  <div className="lab-settings-intro"><h2>{t("Mac 权限")}</h2><p>{t("键盘快捷操作需要辅助功能与输入监控；框选时还需要屏幕录制。按需开启语音权限。")}</p></div>
  <div className="sl-permission-readiness"><div><h3>{t("框选状态")}<span role="status">{t(error && !status ? '状态读取失败' : readiness.label)}</span></h3><p>{t(readiness.detail)}</p></div><Button kind="ghost" icon={<RotateCcw size={14}/>} busy={busy === 'refresh'} disabled={!!busy} onClick={() => void perform('refresh')}>{t("重新检查")}</Button></div>
  <div className="lab-setting-panel lab-permissions-panel">{t(entries.map(({ id, title, detail }) => <div className="lab-setting-row lab-permission-row" key={id}><div><h3>{t(title)}</h3><p>{t(detail)}</p></div><div className="lab-permission-action"><span className={'lab-permission-status ' + (status?.[id] ? 'ready' : '')}><i />{t(!status ? '状态未知' : status[id] ? '已允许' : (id === 'microphone' ? status.microphoneState : id === 'speechRecognition' ? status.speechRecognitionState : '') === 'denied' ? '已拒绝' : (id === 'microphone' ? status.microphoneState : id === 'speechRecognition' ? status.speechRecognitionState : '') === 'restricted' ? '受系统限制' : '尚未允许')}</span>{t(!status?.[id] && <Button icon={<ArrowUpRight size={16}/>} busy={busy === id} disabled={!!busy || !status} onClick={() => void perform(id)}>{t("前往授权")}</Button>)}</div></div>))}</div>
  <p className="lab-settings-note">{t("麦克风也可用于声音律动。框选功能的麦克风与语音识别用于“按住说话”；关闭语音后仍可自动翻译。智能框选无需系统声音权限。系统声音律动会在灯光创作中开始采集时单独请求。")}</p>
  {t(status && status.supported !== false && needsVoicePermissions(status) && <div className="lab-permission-footer"><span>{t("语音权限未完整开启，文字框选不需要这两项权限。")}</span><Button kind="ghost" disabled={!!busy} onClick={() => void perform('disableVoice')}>{t("关闭语音，继续文字框选")}</Button></div>)}
  {t(status && status.preferences.enabled && !configuredForSelection(status) && <div className="lab-permission-footer"><span>{t("模型服务尚未配置。")}</span><Button kind="ghost" onClick={openSettings}>{t("前往模型设置")}</Button></div>)}
  <div className="lab-permission-footer"><details className="lab-settings-help"><summary><CircleHelp size={15}/>{t("授权帮助")}</summary><p>{t("点击“前往授权”，在系统设置中开启“NuPhy Lab”。返回后会自动检查。权限“已允许”不代表框选已可用，请同时查看上方框选状态。如果系统要求重新打开，可使用下方按钮完成授权。")}</p></details></div>
  {t(status?.needsRelaunch && <div className="lab-permission-footer"><span>{t('系统授权已更新，需要重新打开后生效。')}</span><Button disabled={!!busy} onClick={() => void perform('relaunch')}>{t("完成授权并重新打开")}</Button></div>)}
  {t((error || issue) && <p className="settings-v6-note is-error" role="alert">{t(issue || error)}</p>)}
 </div>;
}
// A new key belongs only to the exact configuration it was entered for.
// Keep this stricter than backend normalization: changing a credential scope
// must never carry a typed secret to another service, including during polling.
const credentialScope = (config: Configuration) => JSON.stringify([config.provider, config.endpoint, config.apiProtocol, config.anthropicWorkspaceID ?? '']);
function ModelPicker({ value, items, accountItems, disabled, onChange }: {
    value: string;
    items: string[];
    accountItems: string[];
    disabled: boolean;
    onChange: (id: string) => void;
}) {
    const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
    const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
    const id = useId();
    const choices = [...new Set([...(value ? [value] : []), ...items])].filter(item => item.toLowerCase().includes(query.trim().toLowerCase()));
    const highlight = Math.min(active, Math.max(0, choices.length - 1));
    useEffect(() => { if (!open)
        return; search.current?.focus(); const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node))
        setOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, [open]);
    useEffect(() => { if (disabled)
        setOpen(false); }, [disabled]);
    useEffect(() => { if (open)
        list.current?.querySelector('[data-highlighted=true]')?.scrollIntoView({ block: 'nearest' }); }, [open, highlight, query]);
    const close = () => { setOpen(false); trigger.current?.focus(); };
    const choose = (model: string) => { onChange(model); close(); };
    return <div className="models-picker" ref={root} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node))
        setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        close();
    } }}>
  <button ref={trigger} id="models-model-trigger" type="button" className="models-picker-trigger" title={t(value || undefined)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open); setQuery(''); setActive(0); }}><span>{t(value || '选择模型')}</span><ChevronRight size={14}/></button>
  {t(open && <div className="models-picker-panel">
   <div className="models-search"><Search size={14}/><input ref={search} aria-label={t("搜索模型")} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={id} aria-activedescendant={choices.length ? `${id}-${highlight}` : undefined} type="search" value={query} placeholder={t("搜索预设与账户模型")} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActive(Math.max(0, Math.min(choices.length - 1, highlight + (event.key === 'ArrowDown' ? 1 : -1))));
                }
                else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (choices[highlight])
                        choose(choices[highlight]);
                }
            }}/></div>
   <div ref={list} id={id} role="listbox" aria-label={t("可选模型")} className="models-options">{t(choices.map((model, index) => <button key={model} id={`${id}-${index}`} type="button" role="option" aria-selected={model === value} tabIndex={-1} data-highlighted={index === highlight} onMouseEnter={() => setActive(index)} onClick={() => choose(model)}><span>{t(model)}</span><small>{t(model === value ? <Check size={13}/> : accountItems.includes(model) ? '账户' : '预设')}</small></button>))}</div>
   {t(!choices.length && <p className="models-empty">{t("没有匹配的模型，可切换到“手填 ID”。")}</p>)}
   <p className="models-picker-note">{t(choices.length)}{t("个匹配 \u00B7 每次使用一个模型")}</p>
  </div>)}
 </div>;
}
export function SelectionAPISettings() {
    useLanguage();
    const { status, setStatus, error } = useSelectionStatus();
    const [draft, setDraft] = useState<Configuration | null>(null);
    const [typedKey, setTypedKey] = useState({ scope: '', value: '' });
    const [accountModels, setAccountModels] = useState<{
        scope: string;
        items: string[];
    }>({ scope: '', items: [] });
    const [imageConsentReset, setImageConsentReset] = useState(false);
    const [modelMode, setModelMode] = useState<'auto' | 'manual' | 'list'>('auto');
    const [advanced, setAdvanced] = useState(false), [busy, setBusy] = useState('');
    const [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
    const endpointInput = useRef<HTMLInputElement>(null);
    const config = draft ?? status?.preferences.configuration ?? defaults.configuration;
    const provider = providers.find(item => item.id === config.provider);
    const scope = credentialScope(config), savedScope = status ? credentialScope(status.preferences.configuration) : '';
    const key = typedKey.scope === scope ? typedKey.value : '';
    const hasKey = !!status?.hasKey && scope === savedScope;
    const candidates = [...new Set<string>([...(provider?.models ?? []), ...(accountModels.scope === scope ? accountModels.items : [])])];
    const manual = modelMode === 'manual' || (modelMode === 'auto' && (!candidates.length || !!config.model && !candidates.includes(config.model)));
    const customAddress = !provider || provider.id === 'custom' || !provider.endpoint || config.endpoint !== provider.endpoint || config.apiProtocol !== provider.protocol;
    const validTokens = Number.isInteger(config.maximumOutputTokens) && config.maximumOutputTokens >= 1 && config.maximumOutputTokens <= 16384;
    const validModel = new TextEncoder().encode(config.model).length <= 256 && !/\s/.test(config.model);
    const canSave = !!status && status.supported !== false && !busy && !!config.endpoint.trim() && validTokens && validModel;
    const canRequest = canSave && (!!key.trim() || hasKey);
    const accountListSupported = !config.provider.startsWith('qwen');
    const working = !!busy;
    useEffect(() => { setTypedKey({ scope, value: '' }); }, [scope]);
    function update(value: Partial<Configuration>) {
        const next = { ...config, ...value };
        if (credentialScope(next) !== scope) {
            setTypedKey({ scope: '', value: '' });
            setAccountModels({ scope: '', items: [] });
            next.imageInputConfirmed = false;
            setImageConsentReset(true);
        }
        if (value.model !== undefined && value.model !== config.model) {
            next.imageInputConfirmed = false;
            setImageConsentReset(true);
        }
        setDraft(next);
        setMessage('');
        setFailed(false);
    }
    function chooseProvider(id: string) {
        const next = providers.find(item => item.id === id);
        if (!next)
            return;
        setModelMode('auto');
        update({ provider: next.id, endpoint: next.endpoint, apiProtocol: next.protocol, model: next.models[0] ?? '', imageInputConfirmed: false, anthropicWorkspaceID: undefined });
    }
    function editAddress() { setAdvanced(true); requestAnimationFrame(() => endpointInput.current?.focus()); }
    async function run(op: 'save' | 'models' | 'test' | 'deleteKey') {
        setBusy(op);
        setMessage('');
        setFailed(false);
        let saved = false;
        try {
            if (op === 'deleteKey') {
                const latest: Status = await native('status');
                if (credentialScope(latest.preferences.configuration) !== scope) {
                    setStatus(latest);
                    throw new Error('服务配置已更新，请确认后再移除密钥。');
                }
                setStatus(await native(op));
                setTypedKey({ scope, value: '' });
                setMessage('已移除当前服务的 API Key。');
            }
            else {
                // Re-read unrelated preferences immediately before saving so an API edit
                // cannot roll back feature/shortcut changes made since the last poll.
                const latest: Status = await native('status');
                const sameModel = credentialScope(latest.preferences.configuration) === scope && latest.preferences.configuration.model === config.model;
                const nextConfig = { ...config, imageInputConfirmed: !imageConsentReset && sameModel ? latest.preferences.configuration.imageInputConfirmed : false };
                const result = await native('save', { preferences: { ...latest.preferences, configuration: nextConfig }, apiKey: key });
                setStatus(result);
                setDraft(null);
                setImageConsentReset(false);
                setTypedKey({ scope, value: '' });
                saved = true;
                if (op === 'save')
                    setMessage('设置已保存。');
                else if (op === 'models') {
                    const result = await native('models');
                    const items = Array.isArray(result.models) ? result.models.filter((item: unknown): item is string => typeof item === 'string') : [];
                    setAccountModels({ scope, items });
                    setMessage(`设置已保存，已读取 ${items.length} 个账户模型${result.hasMore ? '（列表未全部读取，可手填其他 ID）' : ''}。可在模型列表中搜索。`);
                }
                else {
                    const result = await native('test');
                    setMessage(result.message);
                }
            }
        }
        catch (e) {
            setFailed(true);
            setMessage(`${saved ? '设置已保存；' : ''}${String((e as Error).message || e)}`);
        }
        finally {
            setBusy('');
        }
    }
    return <section className="selection-api-settings models-settings" aria-label={t("模型与 API 设置")}>
  <header className="models-heading"><h2>{t("模型与 API")}</h2><p>{t("连接自己的模型服务，用于智能框选。")}</p></header>
  <div className="models-card" aria-busy={working}>
   <fieldset disabled={!status || working}>
    <div className="models-field">
     <label htmlFor="models-provider">{t("服务")}</label>
     <select id="models-provider" value={config.provider} onChange={event => chooseProvider(event.target.value)}>
      {t(!provider && <option value={config.provider}>{t(config.provider)}{t("\u00B7 已保存")}</option>)}
      {t(providers.map(item => <option key={item.id} value={item.id}>{t(item.name)}{t(providers.filter(other => other.name === item.name).length > 1 ? ` · ${t(item.region)}` : '')}</option>))}
     </select>
     {t(customAddress && <div className="models-address-note"><span>{t(config.endpoint ? '使用自定义地址' : '需要填写服务地址')}</span><button type="button" onClick={editAddress}>{t("编辑地址")}<ChevronRight size={12}/></button></div>)}
    </div>
    <div className="models-field">
     <div className="models-label-row"><label htmlFor={manual ? 'models-model-id' : 'models-model-trigger'}>{t("模型")}</label><button type="button" className="models-text-button" onClick={() => setModelMode(manual ? 'list' : 'manual')}>{t(manual ? '从列表选择' : '手填 ID')}</button></div>
     {t(manual ? <input id="models-model-id" value={config.model} onChange={event => update({ model: event.target.value })} placeholder={t("输入模型 ID")} spellCheck={false} autoCapitalize="none" autoComplete="off" aria-invalid={!validModel}/> :
            <ModelPicker value={config.model} items={candidates} accountItems={accountModels.scope === scope ? accountModels.items : []} disabled={!status || working} onChange={model => update({ model })}/>)}
     <div className="models-model-note"><span>{t(!validModel ? '模型 ID 不能包含空格，最长 256 字节。' : `${candidates.length} 个可选 · 也可手填 ID`)}</span>{t(accountListSupported && <button type="button" className="models-fetch-button" disabled={!canRequest} onClick={() => void run('models')}><RotateCcw size={12}/>{t(busy === 'models' ? '正在读取…' : '读取账户模型')}</button>)}</div>
     <p className="models-access-note">{t(!accountListSupported ? '此服务使用预设或手填 ID；可用性以账户权限为准。' : canRequest ? '列表不代表账户权限；请以连接测试为准。' : '保存或填写 API Key 后，可读取账户模型。')}</p>
    </div>
    <div className="models-field models-key-field">
     <div className="models-label-row"><label htmlFor="models-key">API Key</label><span className="models-key-state">{t(key ? '待保存' : hasKey ? '已保存' : '未保存')}</span></div>
     <input id="models-key" type="password" value={key} onChange={event => { setTypedKey({ scope, value: event.target.value }); setMessage(''); }} placeholder={t(hasKey ? '留空保留已保存的密钥' : '粘贴 API Key')} autoComplete="new-password" autoCapitalize="none" spellCheck={false}/>
     <div className="models-key-note"><span>{t("密钥保存在本机钥匙串。")}</span>{t(hasKey && <button type="button" className="models-text-button" disabled={!!draft || !!key || working} onClick={() => void run('deleteKey')}>{t("移除密钥")}</button>)}</div>
    </div>
    <details className="models-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
     <summary>{t("高级设置")}<ChevronRight size={14}/></summary>
     <div className="models-advanced-fields">
      <div className="models-field">
       <div className="models-label-row"><label htmlFor="models-endpoint">{t("API 地址")}</label>{t(provider?.endpoint && config.endpoint !== provider.endpoint && <button type="button" className="models-text-button" onClick={() => update({ endpoint: provider.endpoint, apiProtocol: provider.protocol })}>{t("恢复预设")}</button>)}</div>
       <input ref={endpointInput} id="models-endpoint" type="url" value={config.endpoint} onChange={event => update({ endpoint: event.target.value })} placeholder="https://…/v1/chat/completions" autoComplete="off" autoCapitalize="none" spellCheck={false}/>
      </div>
      <div className="models-field"><label htmlFor="models-protocol">{t("接口协议")}</label><select id="models-protocol" value={config.apiProtocol} onChange={event => update({ apiProtocol: event.target.value })}>
       {t(!['responses', 'chatCompletions', 'anthropicMessages'].includes(config.apiProtocol) && <option value={config.apiProtocol}>{t(config.apiProtocol)}{t("\u00B7 已保存")}</option>)}
       <option value="responses">OpenAI Responses</option><option value="chatCompletions">OpenAI Chat Completions</option><option value="anthropicMessages">Anthropic Messages</option>
      </select></div>
      {t((config.provider === 'anthropic' || config.apiProtocol === 'anthropicMessages' || !!config.anthropicWorkspaceID) && <div className="models-field"><label htmlFor="models-workspace">{t("Claude 工作空间")}<span className="models-optional">{t("可选")}</span></label><input id="models-workspace" value={config.anthropicWorkspaceID ?? ''} onChange={event => update({ anthropicWorkspaceID: event.target.value || undefined })} placeholder="Workspace ID" autoComplete="off" spellCheck={false}/></div>)}
      <div className="models-field"><label htmlFor="models-tokens">{t("最大输出 tokens")}</label><input id="models-tokens" type="number" min={1} max={16384} step={1} value={config.maximumOutputTokens || ''} onChange={event => update({ maximumOutputTokens: Number(event.target.value) })} aria-invalid={!validTokens} aria-describedby="models-tokens-note"/><p id="models-tokens-note" className="models-field-note">{t(validTokens ? '范围 1–16,384；实际限制由模型决定。' : '请输入 1–16,384 之间的整数。')}</p></div>
     </div>
    </details>
   </fieldset>
   <div className="models-actions"><Button kind="primary" busy={busy === 'save'} disabled={!canSave} onClick={() => void run('save')}>{t("保存设置")}</Button><Button busy={busy === 'test'} disabled={!canRequest || !config.model} onClick={() => void run('test')}>{t("测试连接")}</Button></div>
   <p className="models-footnote">{t("读取模型与测试会先保存；测试会发送一条短文本，费用由服务商收取。")}</p>
   {t((message || error) && <p className={'models-status ' + (failed || error && !message ? 'is-error' : '')} role={failed || error && !message ? 'alert' : 'status'}>{t(message || error)}</p>)}
  </div>
  {t(provider?.url && <a className="models-doc-link" href={provider.url} target="_blank" rel="noreferrer">{t("服务商文档")}<ArrowUpRight size={12}/></a>)}
 </section>;
}
