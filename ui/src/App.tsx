import {displayPresetName} from '../../shared/preset-names.mjs';
import {getKeyboardProfile,isKeyboardModel} from '../../shared/keyboard-models.mjs';
import {getLayoutModel} from '../../shared/layout.mjs';
import {nativeLightingOnly} from '../../shared/device-status.mjs';
import {deriveConnectionDisplay} from '../../shared/connection-display.mjs';
import {friendlyConnectionError,keyRecoveryProblem} from './KeyRecoveryPanel';
import {connectionCopy,connectionHeader,connectionSidebar,presentConnectionDisplay} from './connection-copy-v7';
import './connection-display-v7.css';
import './library-play-edit-v8.css';
import { parseDraftRecord } from './draftPersistence';
import { t as tr } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {useCodexKeys} from './codexKeys';
import {
  CircleAlert,
  LayoutGrid,
  ChevronDown,
  ScanLine,
  SquareTerminal,
  Folder,
  Keyboard,
  Gamepad2,
  AudioLines,
  Lightbulb,
  SlidersHorizontal,
} from "lucide-react";
import { useAirApi } from "./api";
import { FeedbackToast } from "./FeedbackToast";
import {AudioPanel} from "./AudioPanel";
import {AudioPendingNotice} from './AudioPendingNotice';
import { NativeLighting } from "./NativeLighting";
import { Studio } from "./Studio";
import { UnifiedLibrary, type LibraryFilter } from './UnifiedLibrary';
import { FeatureCenter,features } from './FeatureCenter';
import { sidebarFeatures,type FeatureId } from '../../shared/sidebar-features.mjs';
import type { MusicEntry } from './music/MusicLab';
import {prepareMusicLibraryAction} from './music/persistence';
import { Codex } from "./Codex";
import { ClaudeCode } from "./ClaudeCode";
import { agentSource } from "./AgentSourceSwitch";
import { Device } from "./Device";
import {SelectionLab} from "./SelectionLab";
import {MusicLab} from "./music/MusicLab";
import {TypingSounds} from "./TypingSounds";
import { Settings } from "./Settings";
import {availableFirmwareUpdate} from '../../shared/firmware-onboarding.mjs';
import './update-notices.css';
import { KeyboardModuleContext } from "./Keyboard";
import { StartupGuide } from "./StartupGuide";
import { useTriggerKeys } from "./TriggerPanel";
import { Button, Modal, run } from "./primitives";
import { presets } from "./presets";
import { applyArtworkAppearance } from "../../shared/render-animation.mjs";
import { triggerPlaybackConfig } from "../../shared/trigger.mjs";
import { blankColors, DEFAULT_ANIMATION } from "./types";
import type { Scene, StudioMode } from "./types";
import {useLanguage, setLanguage} from "./i18n";
import {DragConvertLab} from './DragConvertLab';
import {KeyboardPocketLab} from './KeyboardPocketLab';

type Page = "features" | "keyboard-pocket" | "drag-convert" | "music" | "typing-sounds" | "selection-question" | "studio" | "library" | "codex" | "device" | "settings" | "game" | "audio" | "offline";
const cloneScene = (scene: Scene): Scene => JSON.parse(JSON.stringify(scene));
const modeForScene = (scene: Scene): StudioMode =>
  scene.trigger ? "trigger" : scene.animation.effect === "static" ? "paint" : "animation";
const sceneSignature = (scene: Scene) => JSON.stringify([
  scene.name, scene.colors.map(color => color.toLowerCase()), scene.animation.effect,
  scene.animation.direction, scene.animation.speed, scene.animation.loop, scene.animation.hueShift ?? 0, scene.animation.colorOverride?.toLowerCase() ?? null, scene.animation.brightness ?? 100,
  (scene.animation.frames ?? []).map(frame => [frame.colors.map(color => color.toLowerCase()), Math.round(frame.duration)]),
  scene.trigger ? Object.entries(scene.trigger).sort(([left],[right])=>left.localeCompare(right))
    .map(([key,value])=>[key,key==='color'&&typeof value==='string'?value.toLowerCase():value]) : null,
]);
type LibraryPlayRequest = { id: string; scene: Scene; action: 'open' | 'new'; context: string; generation: number; restoreKey?: string; saved?: boolean };
export default function App() {
  const language=useLanguage();
  const [draftSession, setDraftSession] = useState(0);
  const [settingsTab, setSettingsTab] = useState<"general"|"lighting"|"permissions"|"updates"|"about"|"ai">("general");
  useEffect(()=>{
    const navigate=(event:Event)=>{
      const target=(event as CustomEvent<string>).detail;
      if(target === "ai" || target === "lighting" || target === "permissions" || target === "updates" || target === "about" || target === "general") {setSettingsTab(target);setPage("settings");}
      else if(target === "drag-convert" || target === "keyboard-pocket"){setPage(target);}
      else if(target === "device" || target === "library")setPage(target);
    };
    window.addEventListener("nuphylab:navigate",navigate);
    return()=>window.removeEventListener("nuphylab:navigate",navigate);
  },[]);
  const [studioMode, setStudioMode] = useState<StudioMode>("paint");
  const [focusCodexColors,setFocusCodexColors] = useState(false);
  const [libraryFilter,setLibraryFilter] = useState<LibraryFilter>('all');
  const [librarySource,setLibrarySource] = useState<'saved'|'presets'>('saved');
  const [musicEntry,setMusicEntry] = useState<MusicEntry|null>(null);
  const [featureBusy,setFeatureBusy] = useState(false);
  const featureLock=useRef(false),initialNavigation=useRef(false),navigationEpoch=useRef(0);
  function setPage(next:Page){navigationEpoch.current++;commitPage(next);}
  const [page, commitPage] = useState<Page>("studio"),
    [draft, setDraft] = useState<Scene>({
      name: "一颗小心意",
      colors: blankColors(),
      animation: { ...DEFAULT_ANIMATION },
    }),
    [draftReady, setDraftReady] = useState(false),
    [draftModel, setDraftModel] = useState<string | null>(null);
  const [toast, setToast] = useState<{
      id: number;
      message: string;
      kind: "error" | "success";
    } | null>(null),
    [saveOpen, setSaveOpen] = useState(false),
    [saveName, setSaveName] = useState(""),
    [saveBusy, setSaveBusy] = useState(false),
    [saveError,setSaveError] = useState(""),
    [checkingService,setCheckingService]=useState(false),
    [saveCopy, setSaveCopy] = useState(false);
  const [libraryPlayBusy,setLibraryPlayBusy] = useState(false);
  const [draftTransitionBusy,setDraftTransitionBusy] = useState(false);
  const transitionLock=useRef<string|null>(null);
  const blockedDraftKeys=useRef(new Set<string>());
  const untouchedNewDraft=useRef<{model:string;signature:string}|null>(null);
  const setStudioDraft=useCallback<typeof setDraft>((next)=>{
    // Any Studio edit permanently consumes this provenance, including undo
    // or a later clear that happens to return to the same scene signature.
    untouchedNewDraft.current=null;setDraft(next);
  },[]);
  const [draftStorageIssue,setDraftStorageIssue]=useState<{model:string;kind:'read'|'write'}|null>(null);
  const [pendingLibraryPlay,setPendingLibraryPlay] = useState<LibraryPlayRequest|null>(null);
  const [guardSaveName,setGuardSaveName] = useState('');
  const libraryPlayRequest = useRef<LibraryPlayRequest|null>(null),libraryPlayGeneration=useRef(0);
  const directLibraryPlay = useRef<string|null>(null);
  const notify = useCallback(
    (message: string, kind: "error" | "success" = "error") =>
      setToast({ id: Date.now(), message, kind }),
    [],
  );
  const { state, layout, serviceError, command, readState, refresh, exiting } = useAirApi(notify);
  const addedFeatures=sidebarFeatures(state?.settings.sidebarFeatures);
  const persistFeatures=async(next:FeatureId[])=>{
    if(featureLock.current||!state||exiting||serviceError)return false;
    featureLock.current=true;setFeatureBusy(true);
    try{await command({op:'settings',settings:{sidebarFeatures:next}},{silent:true});return true;}
    catch(error){notify(language==='en'?'Could not save your sidebar. Please try again.':'侧栏设置未能保存，请重试。');return false;}
    finally{featureLock.current=false;setFeatureBusy(false);}
  };
  const ensureFeature=async(id:FeatureId)=>addedFeatures.includes(id)||await persistFeatures([...addedFeatures,id]);
  const toggleFeature=async(id:FeatureId)=>{
    const epoch=navigationEpoch.current;
    const next=addedFeatures.includes(id)?addedFeatures.filter(value=>value!==id):[...addedFeatures,id];
    if(await persistFeatures(next)){if(epoch===navigationEpoch.current&&(page===id||id==='studio'&&['audio','offline'].includes(page)))setPage('features');}
  };
  const editMusic=async(entry:MusicEntry)=>{const epoch=++navigationEpoch.current;try{await prepareMusicLibraryAction();if(epoch!==navigationEpoch.current)return;if(await ensureFeature('music')&&epoch===navigationEpoch.current){setMusicEntry(entry);setPage('music');}}catch(error){notify(language==='en'?'Save your current music project before opening another work.':'请先完成当前演奏的保存，再打开其他作品。');}};
  const loadFromLibrary=async(scene:Scene,create=false)=>{const epoch=++navigationEpoch.current;if(await ensureFeature('studio')&&epoch===navigationEpoch.current)load(scene,{create});};
  const browseMusic=()=>{setLibraryFilter('music');setLibrarySource('saved');setPage('library');};
  useEffect(()=>{if(state&&!initialNavigation.current){initialNavigation.current=true;if(navigationEpoch.current===0&&!sidebarFeatures(state.settings.sidebarFeatures).includes('studio'))setPage('features');}},[state]);
  const modelId = isKeyboardModel(state?.device.modelId) ? state.device.modelId : getLayoutModel();
  const nativeOnly = nativeLightingOnly(state);
  const connectionDisplay=presentConnectionDisplay(deriveConnectionDisplay({state,serviceError,canvasModelId:layout.length ? modelId : null,keyRecoveryProblem:keyRecoveryProblem(state)}));
  const libraryPlayContext=`${modelId}:${state?.device.connectionSessionId ?? ''}:${Boolean(state?.device.connected)}`;
  const canLibraryPlay=layout.length>0 && !serviceError && !exiting && Boolean(state?.device.connected) && state?.device.readOnly !== true
    && state?.device.capabilities?.perKey !== false && state?.firmware?.compatible !== false;
  const latestLibraryContext=useRef({context:libraryPlayContext,canPlay:canLibraryPlay});
  latestLibraryContext.current={context:libraryPlayContext,canPlay:canLibraryPlay};
  const latestDraftContext=useRef(`${modelId}:${draftSession}`);
  latestDraftContext.current=`${modelId}:${draftSession}`;
  useEffect(()=>{
    libraryPlayGeneration.current++;
    libraryPlayRequest.current=null;directLibraryPlay.current=null;
    setPendingLibraryPlay(null);setLibraryPlayBusy(false);
  },[libraryPlayContext,Boolean(serviceError),exiting]);
  const draftKey = (model: string) => model === "air75-v3" ? "air-studio-draft-v1" : `nuphylab-draft-${model}-v1`;
  useEffect(()=>{if(page!=="codex")setFocusCodexColors(false);},[page]);
  useCodexKeys(state,command,notify);
  useEffect(()=>{const value=state?.settings.language;if(value === "en" || value === "zh-CN") setLanguage(value);},[state?.settings.language]);
  useEffect(()=>{
    if (!state?.settings.lightIdleMs) return;
    let last = -Infinity;
    const activity=()=>{if(performance.now()-last<250)return;last=performance.now();void command({op:"lightActivity"}).catch(()=>{});};
    window.addEventListener("pointerdown",activity);window.addEventListener("keydown",activity);
    return ()=>{window.removeEventListener("pointerdown",activity);window.removeEventListener("keydown",activity);};
  },[state?.settings.lightIdleMs,command]);
  useTriggerKeys(state, command);
  useEffect(()=>{
    const show=(event:Event)=>{const value=(event as CustomEvent<{message:string;kind?:'success'|'error'}>).detail;if(value?.message)notify(value.message,value.kind??'success');};
    window.addEventListener('nuphylab:notify',show);return()=>window.removeEventListener('nuphylab:notify',show);
  },[notify]);
  useEffect(() => {
    if (!layout.length || draftModel === modelId) return;
    untouchedNewDraft.current=null;
    let restored = { ...presets(layout)[0], animation: { ...DEFAULT_ANIMATION } };
    setDraftStorageIssue(null);
    try {
      const saved = localStorage.getItem(draftKey(modelId));
      if (saved !== null) restored = parseDraftRecord(saved,modelId);
      blockedDraftKeys.current.delete(draftKey(modelId));
    } catch {
      blockedDraftKeys.current.add(draftKey(modelId));
      setDraftStorageIssue({model:modelId,kind:'read'});
    }
    setDraft(restored);
    setStudioMode(modeForScene(restored));
    setDraftReady(true);
    setDraftModel(modelId);
    setSaveOpen(false);
    setDraftSession((value) => value + 1);
  }, [layout, modelId, draftModel]);
  const writeLocalDraft = (model:string,scene:Scene) => {
    if(blockedDraftKeys.current.has(draftKey(model)))return;
    try {
      localStorage.setItem(draftKey(model), JSON.stringify(scene));
      setDraftStorageIssue(current=>current?.model===model?null:current);
    } catch { setDraftStorageIssue({model,kind:'write'}); }
  };
  useEffect(() => {
    if (draftReady && draftModel === modelId)
      writeLocalDraft(modelId,draft);
  }, [draft, draftReady, draftModel, modelId]);
  const saveAttemptId=useRef<string|null>(null),saveLock=useRef(false);
  useEffect(()=>{saveAttemptId.current=null;},[draftSession,modelId]);
  const openSave = () => {
    setSaveError("");
    setSaveName(displayPresetName(draft.name,tr));
    setSaveCopy(false);
    setSaveOpen(true);
  };
  const persistDraft = async (name: string, copy = false):Promise<Scene|null> => {
    if(saveLock.current)return null;
    if(!name.trim()){setSaveError('请输入作品名称。');return null;}
    saveLock.current=true;setSaveError('');setSaveBusy(true);
    const context=latestDraftContext.current,newIdentity=copy||!draft.id;
    const scene:Scene={...cloneScene(draft),name:name.trim(),id:newIdentity?(saveAttemptId.current??=crypto.randomUUID()):draft.id,...(copy?{createdAt:undefined,updatedAt:undefined}:{})};
    try {
      const raw=await command({op:'saveScene',scene},{silent:true}) as {savedScene?:Scene;scene?:Scene;id?:string}|undefined;
      saveAttemptId.current=null;
      return raw?.savedScene??raw?.scene??{...scene,id:raw?.id??scene.id};
    }catch(error){
      const current=await readState().catch(()=>null);
      const saved=current?.scenes.find(item=>item.id===scene.id);
      if(saved&&sceneSignature(saved)===sceneSignature(scene)){saveAttemptId.current=null;return saved;}
      if(latestDraftContext.current===context)setSaveError(tr(current?'未能完成保存。已保留名称和画布，请重试。':'暂时无法确认保存结果。名称和画布已保留，重试不会重复创建作品。')+(error instanceof Error?` ${tr(error.message)}`:''));
      return null;
    }finally{saveLock.current=false;setSaveBusy(false);}
  };
  const acceptSavedDraft = (source:Scene,saved:Scene) => {
    // A connection failure may close the guard while a save is still pending.
    // Keep later edits, but attach the acknowledged ID so a retry updates that work.
    setDraft(current=>sceneSignature(current)===sceneSignature(source)?saved:{
      ...current,id:saved.id,createdAt:saved.createdAt??current.createdAt,updatedAt:saved.updatedAt??current.updatedAt,
    });
  };
  const save = async () => {
    const context=latestDraftContext.current,source=cloneScene(draft);
    const saved=await persistDraft(saveName,saveCopy);
    if(!saved||latestDraftContext.current!==context)return;
    acceptSavedDraft(source,saved);setSaveOpen(false);notify('作品已保存到这台 Mac','success');
  };
  const finishLibraryPlay = (id: string|null) => {
    if(!id||libraryPlayRequest.current?.id!==id)return;
    libraryPlayRequest.current=null;setPendingLibraryPlay(null);setLibraryPlayBusy(false);
  };
  const adoptLibraryPlay = async (request:LibraryPlayRequest) => {
    const epoch=navigationEpoch.current;
    if(libraryPlayRequest.current?.id!==request.id || request.generation!==libraryPlayGeneration.current
      || request.context!==latestLibraryContext.current.context || transitionLock.current)return;
    transitionLock.current=request.id;setDraftTransitionBusy(true);
    try {
      if(!request.restoreKey&&state&&(state.playback.mode!=='idle'||state.game.status!=='idle'||state.device.armed))await command({op:'stop'},{silent:true});
      if(libraryPlayRequest.current?.id!==request.id || request.generation!==libraryPlayGeneration.current
        || request.context!==latestLibraryContext.current.context)return;
      if(epoch!==navigationEpoch.current){finishLibraryPlay(request.id);return;}
      if(request.restoreKey){blockedDraftKeys.current.delete(request.restoreKey);setDraftStorageIssue(null);}
      untouchedNewDraft.current=request.action==='new'&&!request.restoreKey
        ?{model:modelId,signature:sceneSignature(request.scene)}:null;
      setDraft(cloneScene(request.scene));setStudioMode(modeForScene(request.scene));
      setDraftSession(value=>value+1);setPage(nativeOnly?'offline':'studio');setSaveError('');finishLibraryPlay(request.id);
    } catch(error){
      const message=tr(request.saved?(request.action==='new'?'当前草稿已保存，但新建尚未完成。当前画布未替换，请重试。':'当前草稿已保存，但打开尚未完成。当前画布未替换，请重试。'):'未能切换作品，当前草稿已保留，请重试。')+(error instanceof Error?` ${tr(error.message)}`:'');
      if(libraryPlayRequest.current?.id===request.id){
        if(pendingLibraryPlay)setSaveError(message);else{notify(message);finishLibraryPlay(request.id);}
      }
    } finally {if(transitionLock.current===request.id){transitionLock.current=null;setDraftTransitionBusy(false);}}
  };
  const playLibraryScene = async (scene:Scene) => {
    if(directLibraryPlay.current||libraryPlayRequest.current||saveLock.current||!canLibraryPlay)return;
    const id=crypto.randomUUID(),context=libraryPlayContext,generation=libraryPlayGeneration.current;
    directLibraryPlay.current=id;setLibraryPlayBusy(true);
    try {
      if(context!==latestLibraryContext.current.context||!latestLibraryContext.current.canPlay)return;
      const submitted=cloneScene(scene),appearance=applyArtworkAppearance(submitted.colors,submitted.animation);
      if(submitted.trigger){
        const trigger=triggerPlaybackConfig(submitted.trigger,submitted.animation);
        const lit=trigger.effect==='cross' ? trigger.color?.toLowerCase()!=='#000000'
          : layout.some(key=>appearance[key.index]&&appearance[key.index].toLowerCase()!=='#000000');
        if(!lit){notify((submitted.animation.brightness??100)===0?'作品亮度为 0%，调高后可启用按键触发。':'当前设置下图案没有亮起的按键，请调整颜色或作品亮度。');return;}
        await command({op:'triggerArm',colors:appearance,trigger},{silent:true});
      }else await command({op:submitted.animation.effect==='static'?'preview':'play',
        colors:submitted.animation.effect==='static'?appearance:submitted.colors,animation:submitted.animation},{silent:true});
    }catch(error){
      if(generation===libraryPlayGeneration.current&&context===latestLibraryContext.current.context)
        notify(error instanceof Error?error.message:'操作失败');
    }finally{
      if(directLibraryPlay.current===id){directLibraryPlay.current=null;setLibraryPlayBusy(false);}
    }
  };
  const saveThenLibraryPlay = async () => {
    const request=libraryPlayRequest.current;
    if(!request||saveLock.current)return;
    if(request.saved){await adoptLibraryPlay(request);return;}
    const context=latestDraftContext.current,source=cloneScene(draft);
    const saved=await persistDraft(draft.name.trim()?draft.name:guardSaveName);
    if(!saved||context!==latestDraftContext.current)return;
    acceptSavedDraft(source,saved);notify('作品已保存到这台 Mac','success');
    request.saved=true;
    if(pendingLibraryPlay)setPendingLibraryPlay({...request});
    if(libraryPlayRequest.current?.id===request.id)await adoptLibraryPlay(request);
  };
  const load = (scene: Scene, options?:{create?:boolean;restoreKey?:string}) => {
    if(directLibraryPlay.current||libraryPlayRequest.current||saveLock.current)return;
    const request:LibraryPlayRequest={id:crypto.randomUUID(),scene:cloneScene(scene),action:options?.create?'new':'open',context:libraryPlayContext,generation:libraryPlayGeneration.current,restoreKey:options?.restoreKey};
    libraryPlayRequest.current=request;setLibraryPlayBusy(true);setSaveError('');
    const saved=draft.id?state?.scenes.find(item=>item.id===draft.id):undefined;
    const untouchedNew=draftReady&&draftModel===modelId&&!draftStorageIssue&&!serviceError
      &&!blockedDraftKeys.current.has(draftKey(modelId))&&untouchedNewDraft.current?.model===modelId
      &&untouchedNewDraft.current.signature===sceneSignature(draft);
    if((!saved||sceneSignature(saved)!==sceneSignature(draft))&&!untouchedNew){
      setGuardSaveName(draft.name);setPendingLibraryPlay(request);
    }else run(adoptLibraryPlay(request));
  };
  const retryDraftRead = () => {
    try {
      const raw=localStorage.getItem(draftKey(modelId));
      if(raw===null)throw new Error('Missing draft');
      load(parseDraftRecord(raw,modelId),{restoreKey:draftKey(modelId)});
    } catch {notify('暂时无法读取本机草稿。原记录已保留，请重试读取。');}
  };
  const creative = ["studio", "audio", "offline"].includes(page);
  useEffect(()=>{window.scrollTo(0,0);},[page]);
  const pageTitle = page === 'features' ? (language==='en'?'Feature Center':'功能中心') : page === 'keyboard-pocket' ? '键盘口袋' : page === 'drag-convert' ? (language === 'en' ? 'Drag Convert' : '拖拽转换') : page === "music" ? "演奏模式" : page === "typing-sounds" ? "模拟声浪" : page === "selection-question" ? "智能框选" : creative ? "灯光创作" : page === "library" ? "作品库" : page === "codex" ? "AI 助手" : page === "game" ? "灯光游戏" : page === "settings" ? "设置" : "设备";
  return (
    <KeyboardModuleContext.Provider value={state?.settings.airTopRightModule === "keycap" ? "keycap" : "rotary"}>
    <div className="app-shell lab-v5" data-page={page} data-native={Boolean((window as Window & {webkit?:unknown}).webkit)}>
      <aside className="sidebar">
        <div className="window-lights" aria-hidden="true"><i/><i/><i/></div>
        <div className="brand"><img className="brand-symbol" src="/nuphy-studio.png" alt="" width={32} height={32}/><span>NuPhy Lab</span></div>
        <nav className="feature-sidebar-nav" aria-label={tr("主导航")}>
          {addedFeatures.map(id=>{const feature=features.find(item=>item.id===id)!;const Icon=feature.icon;const active=id==='studio'?creative:page===id;const label=language==='en'?feature.en:feature.zh;return <button key={id} aria-label={label} title={label} className={active?'active':''} aria-current={active?'page':undefined} onClick={()=>{if(id==='music')setMusicEntry(null);if(id==='library'){setLibraryFilter('all');setLibrarySource('saved');}setPage(id);}}><Icon size={18} strokeWidth={1.5}/><span>{label}</span></button>;})}
        </nav>
        <div className="sidebar-bottom">
          <nav aria-label={language==='en'?'Feature Center':'功能中心'}><button title={language==='en'?'Feature Center':'功能中心'} aria-label={language==='en'?'Feature Center':'功能中心'} className={'feature-center-link '+(page==='features'?'active':'')} aria-current={page==='features'?'page':undefined} onClick={()=>setPage('features')}><LayoutGrid size={18} strokeWidth={1.5}/><span>{language==='en'?'Feature Center':'功能中心'}</span></button></nav>
          <div className="sidebar-output sidebar-output-v7" role="status" data-connection-state={connectionDisplay.stateId}><span>{connectionCopy({zh:'键盘输出',en:'Keyboard output'})}</span><strong title={connectionSidebar(connectionDisplay)}>{connectionSidebar(connectionDisplay)}</strong></div>
          <nav aria-label={tr("设备与设置")}>
            <button aria-label={tr("设备")} title={tr("设备")} className={page === "device" ? "active" : ""} aria-current={page === "device" ? "page" : undefined} onClick={()=>setPage("device")}><Keyboard size={18} strokeWidth={1.5}/><span>{tr("设备")}</span></button>
            <button aria-label={tr("设置")} title={tr("设置")} className={page === "settings" ? "active" : ""} aria-current={page === "settings" ? "page" : undefined} onClick={()=>{if(availableFirmwareUpdate(state))setSettingsTab('updates');setPage("settings");}}><SlidersHorizontal size={18} strokeWidth={1.5}/><span>{tr("设置")}</span>{availableFirmwareUpdate(state)&&<i className="settings-update-dot" aria-label={language==='en'?'Keyboard firmware update available':'键盘固件有可用更新'}/>}</button>
          </nav>
        </div>
      </aside>
      <main>
        <header className="lab-page-header"><h1>{tr(pageTitle)}</h1><button className="lab-connection lab-connection-v7" data-connection-state={connectionDisplay.stateId} onClick={()=>setPage("device")}><Keyboard size={16} strokeWidth={1.5}/><span>{connectionHeader(connectionDisplay)}</span></button></header>
        {exiting && <div className="wireless-notice" role="status">{tr("正在完成当前操作…")}</div>}
        {!state&&!serviceError&&<div className="service-error" role="status">{tr('正在读取键盘与本机数据…')}</div>}
        {serviceError&&<div className="service-error service-error-v6" role="alert"><CircleAlert size={16}/><span>{tr('本地服务未响应：')}{tr(friendlyConnectionError(serviceError))}</span><Button kind="ghost" busy={checkingService} onClick={()=>{if(checkingService)return;setCheckingService(true);void refresh().finally(()=>setCheckingService(false));}}>{tr('重新检查')}</Button></div>}
        <StartupGuide state={state} command={command} disabled={exiting}/>
        <AudioPendingNotice onReturn={()=>setPage('audio')}/>
        {draftStorageIssue?.model===modelId&&<div className="service-error" role="alert"><CircleAlert size={16}/><span>{tr(draftStorageIssue.kind==='read'?'暂时无法读取本机草稿。原记录已保留，请重试读取。':'草稿自动保存失败。当前内容仍在本窗口，关闭前请重试或保存到作品库。')}</span><Button kind="ghost" onClick={()=>draftStorageIssue.kind==='read'?retryDraftRead():writeLocalDraft(modelId,draft)}>{tr(draftStorageIssue.kind==='read'?'重试读取':'重试自动保存')}</Button><Button kind="ghost" onClick={openSave}>{tr('保存作品')}</Button></div>}
        <div className="page-content" inert={exiting}>
          {creative && (!nativeOnly || page === "offline") && <nav className="lab-tabs creative-tabs" aria-label={tr("灯光创作")}>
            {([["paint","绘制"],["animation","动画"],["trigger","按键触发"],["audio","声音律动"]] as const).map(([id,label])=><button key={id} aria-current={(id === "audio" ? page === "audio" : page !== "audio" && studioMode === id) ? "page" : undefined} className={(id === "audio" ? page === "audio" : page !== "audio" && studioMode === id) ? "active" : ""} onClick={()=>{if(id === "audio")setPage("audio");else{setStudioMode(id);setPage("studio");}}}>{tr(label)}</button>)}
          </nav>}
          {connectionDisplay.stateId === 'bluetoothOnly' && ['studio','library'].includes(page) && <div className="wireless-notice" role="status"><strong>{tr("蓝牙已连接 · 灯光需接线")}</strong><p>{tr("可以编辑、预览和保存作品；播放到键盘、按键灯效及灯光游戏需要 USB 有线连接。")}</p></div>}
          {nativeOnly && state && ["studio", "audio"].includes(page) && <NativeLighting state={state} layout={layout} command={command}
            onOffline={() => setPage("offline")} onDevice={() => setPage("device")}/>}
          {page === "offline" && nativeOnly && <div className="wireless-notice" role="status"><p>{tr("离线绘图仅编辑和保存作品，不向当前固件发送逐键颜色。")}</p><Button onClick={() => setPage("studio")}>{tr("返回原生灯效")}</Button></div>}
          {tr((page === "studio" && !nativeOnly || page === "offline" || page === "game") && (
            <Studio
              key={draftSession}
              mode={page === "game" ? "game" : page === "offline" ? "paint" : studioMode}
              layout={layout}
              state={state}
              connectionDisplay={connectionDisplay}
              command={command}
              draft={draft}
              setDraft={setStudioDraft}
              onSave={openSave}
              onBrowsePresets={() => {setLibraryFilter("lighting");setLibrarySource("presets");setPage("library");}}
              onNavigateDevice={() => setPage("device")}
              onEditCodexColors={()=>{setFocusCodexColors(true);setPage("codex");}}
              notify={notify}
            />
          ))}{tr(" ")}
          {page === "audio" && !nativeOnly && <AudioPanel state={state} layout={layout} command={command}/>}
          {tr(page === "library" && (
            <UnifiedLibrary
              filter={libraryFilter} onFilter={setLibraryFilter} initialSource={librarySource}
              lightingAdded={addedFeatures.includes('studio')} musicAdded={addedFeatures.includes('music')}
              onMusicEdit={editMusic} onBrowse={()=>{navigationEpoch.current++;}}
              layout={layout}
              state={state}
              display={connectionDisplay}
              serviceError={serviceError}
              transitionBusy={libraryPlayBusy || saveBusy || featureBusy || exiting}
              command={command}
              onLoad={scene=>{void loadFromLibrary(scene);}}
              onPlay={scene=>{void playLibraryScene(scene);}}
              onNew={() => {void loadFromLibrary({
                  name: "未命名作品",
                  colors: blankColors(),
                  animation: { ...DEFAULT_ANIMATION },
                },true);}}
              notify={notify}
            />
          ))}{tr(" ")}
          {tr(page === "codex" && (agentSource(state) === "claude"
            ? <ClaudeCode state={state} command={command} notify={notify} focusColors={focusCodexColors} readState={readState} serviceError={serviceError} />
            : <Codex state={state} command={command} focusColors={focusCodexColors} readState={readState} serviceError={serviceError} />))}{tr(" ")}
          {tr(page === "device" && (
            <Device
              state={state}
              command={command}
              serviceError={serviceError}
              display={connectionDisplay}
              onRefresh={refresh}
              layout={layout}
              onOffline={()=>setPage(nativeOnly ? "offline" : "studio")}
            />
          ))}
          {page === "features" && <FeatureCenter added={addedFeatures} busy={featureBusy||!state||!!serviceError||exiting} onToggle={id=>void toggleFeature(id)} onOpen={id=>{if(id==='music')setMusicEntry(null);setPage(id);}}/>}
          {page === "music" && <MusicLab entry={musicEntry} onLibrary={browseMusic}/>}
          {page === "typing-sounds" && <TypingSounds/>}
          {page === 'drag-convert' && <DragConvertLab/>}
          {page === "selection-question" && <SelectionLab/>}
          {page === "keyboard-pocket" && <KeyboardPocketLab/>}
          {page === "settings" && <Settings state={state} command={command} display={connectionDisplay} onNavigateStudio={()=>setPage("studio")} initialTab={settingsTab}/>}
        </div>
      </main>
      {toast&&<FeedbackToast key={toast.id} message={toast.message} kind={toast.kind} onClose={()=>setToast(null)}/>}
      {pendingLibraryPlay&&<Modal title={tr('当前草稿有未保存修改')} width={560} busy={saveBusy||draftTransitionBusy} initialFocus="cancel" onClose={()=>{if(!saveLock.current&&!transitionLock.current){finishLibraryPlay(pendingLibraryPlay.id);setSaveError('');}}} className="library-play-guard-v8" footer={<>
        <Button kind="ghost" data-modal-cancel disabled={saveBusy||draftTransitionBusy} onClick={()=>{finishLibraryPlay(pendingLibraryPlay.id);setSaveError('');}}>{tr('取消')}</Button>
        <Button busy={draftTransitionBusy} disabled={saveBusy} onClick={()=>run(adoptLibraryPlay(pendingLibraryPlay))}>{tr(pendingLibraryPlay.action==='new'?'放弃修改并新建':'放弃修改并打开')}</Button>
        <Button kind="primary" data-modal-retry busy={saveBusy||draftTransitionBusy} disabled={!pendingLibraryPlay.saved&&!(draft.name.trim()||guardSaveName.trim())} onClick={()=>run(saveThenLibraryPlay())}>{tr(saveBusy?'保存中…':pendingLibraryPlay.saved?(pendingLibraryPlay.action==='new'?'重试新建':'重试打开'):pendingLibraryPlay.action==='new'?(saveError?'重试保存后新建':'保存后新建'):(saveError?'重试保存后打开':'保存后打开'))}</Button>
      </>}>
        <p>{tr('先处理「')}<span translate="no">{displayPresetName(draft.name,tr)||tr('未命名作品')}</span>{pendingLibraryPlay.action==='new'?tr('」的修改，再新建作品。'):<>{tr('」的修改，再打开「')}<span translate="no">{displayPresetName(pendingLibraryPlay.scene.name,tr)}</span>{language==='en'?'”.':'」。'}</>}</p>
        {!draft.name.trim()&&<label className="form-field">{tr('作品名称')}<input aria-label={tr('保存当前草稿名称')} value={guardSaveName} disabled={saveBusy} maxLength={80} onChange={event=>{setGuardSaveName(event.target.value);setSaveError('');}}/></label>}
        <p className="muted">{tr('取消会保留当前草稿和键盘输出。')}</p>
        {saveError&&<div className="overlay-error" role="alert"><CircleAlert size={14}/><span>{tr(saveError)}</span></div>}
      </Modal>}
      {saveOpen&&<Modal title={tr('保存作品')} busy={saveBusy} initialFocus="input" onClose={()=>setSaveOpen(false)} footer={<><Button kind="ghost" disabled={saveBusy} onClick={()=>setSaveOpen(false)}>{tr('取消')}</Button><Button kind="primary" busy={saveBusy} disabled={!saveName.trim()} onClick={()=>run(save())}>{tr(saveBusy?'保存中…':saveError?'重试保存':'保存作品')}</Button></>}>
        <label className="form-field">{tr('作品名称')}<input aria-label={tr('保存作品名称')} aria-invalid={!saveName.trim()&&Boolean(saveError)} value={saveName} disabled={saveBusy} maxLength={80} onChange={event=>{setSaveName(event.target.value);setSaveError('');}} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();run(save());}}}/></label>
        {!saveName.trim()&&<p className="overlay-field-error">{tr('请输入作品名称。')}</p>}
        {draft.id&&<label className="checkbox-field"><input type="checkbox" checked={saveCopy} disabled={saveBusy} onChange={event=>setSaveCopy(event.target.checked)}/>{tr('另存为新作品')}</label>}
        <p className="muted">{tr('图案、颜色、动画与触发规则一起保存。')}</p><p className="muted">{tr('输出亮度是全局设置，不随作品保存。')}</p><p className="muted">{tr('保存到')}{' '}{getKeyboardProfile(modelId).name} · {tr('我的作品')}</p>
        {saveError&&saveName.trim()&&<div className="overlay-error" role="alert"><CircleAlert size={14}/><span>{tr(saveError)}</span></div>}
      </Modal>}
    </div>
    </KeyboardModuleContext.Provider>
  );
}
