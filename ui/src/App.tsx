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
  SquareTerminal,
  Folder,
  Keyboard,
  Gamepad2,
  Lightbulb,
  SlidersHorizontal,
} from "lucide-react";
import { useAirApi } from "./api";
import { FeedbackToast } from "./FeedbackToast";
import {AudioPanel} from "./AudioPanel";
import {AudioPendingNotice} from './AudioPendingNotice';
import { NativeLighting } from "./NativeLighting";
import { Studio } from "./Studio";
import { Library } from "./Library";
import { Codex } from "./Codex";
import { ClaudeCode } from "./ClaudeCode";
import { agentSource } from "./AgentSourceSwitch";
import { Device } from "./Device";
import { Settings } from "./Settings";
import { KeyboardModuleContext } from "./Keyboard";
import { StartupGuide } from "./StartupGuide";
import { useTriggerKeys } from "./TriggerPanel";
import { Button, Modal, run } from "./primitives";
import { presets } from "./presets";
import { blankColors, DEFAULT_ANIMATION } from "./types";
import type { Scene, StudioMode } from "./types";
import {useLanguage, setLanguage} from "./i18n";
type Page = "studio" | "library" | "codex" | "device" | "settings" | "game" | "audio" | "offline";
const cloneScene = (scene: Scene): Scene => JSON.parse(JSON.stringify(scene));
const modeForScene = (scene: Scene): StudioMode =>
  scene.trigger ? "trigger" : scene.animation.effect === "static" ? "paint" : "animation";
const sceneSignature = (scene: Scene) => JSON.stringify([
  scene.name, scene.colors.map(color => color.toLowerCase()), scene.animation.effect,
  scene.animation.direction, scene.animation.speed, scene.animation.loop, scene.animation.hueShift ?? 0, scene.animation.colorOverride?.toLowerCase() ?? null, scene.animation.brightness ?? 100,
  (scene.animation.frames ?? []).map(frame => [frame.colors.map(color => color.toLowerCase()), Math.round(frame.duration)]),
  scene.trigger?.code, scene.trigger?.count, scene.trigger?.intervalMs,
]);
type LibraryPlayRequest = { id: string; scene: Scene; action: 'play' | 'open' | 'new'; kind: 'animation' | 'trigger'; context: string; generation: number; restoreKey?: string; saved?: boolean };
export default function App() {
  const language=useLanguage();
  const [draftSession, setDraftSession] = useState(0);
  const [settingsTab, setSettingsTab] = useState<"general"|"lighting"|"permissions"|"about">("general");
  useEffect(()=>{
    const navigate=(event:Event)=>{
      const target=(event as CustomEvent<string>).detail;
      if(target === "lighting" || target === "permissions" || target === "about" || target === "general") {setSettingsTab(target);setPage("settings");}
      else if(target === "device" || target === "library")setPage(target);
    };
    window.addEventListener("nuphylab:navigate",navigate);
    return()=>window.removeEventListener("nuphylab:navigate",navigate);
  },[]);
  const [studioMode, setStudioMode] = useState<StudioMode>("paint");
  const [focusCodexColors,setFocusCodexColors] = useState(false);
  const [page, setPage] = useState<Page>("studio"),
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
  const [playRequestId,setPlayRequestId] = useState<string|null>(null);
  const [playRequestKind,setPlayRequestKind] = useState<'animation'|'trigger'>('animation');
  const libraryPlayRequest = useRef<LibraryPlayRequest|null>(null),libraryPlayGeneration=useRef(0);
  const notify = useCallback(
    (message: string, kind: "error" | "success" = "error") =>
      setToast({ id: Date.now(), message, kind }),
    [],
  );
  const { state, layout, serviceError, command, readState, refresh, exiting } = useAirApi(notify);
  const modelId = layout.length === 80 ? "kick75" : "air75-v3";
  const nativeOnly = nativeLightingOnly(state);
  const connectionDisplay=presentConnectionDisplay(deriveConnectionDisplay({state,serviceError,canvasModelId:layout.length ? modelId : null,keyRecoveryProblem:keyRecoveryProblem(state)}));
  const libraryPlayContext=`${modelId}:${state?.device.connectionSessionId ?? ''}:${Boolean(state?.device.connected)}`;
  const canLibraryPlay=draftReady && draftModel===modelId && !serviceError && !exiting && Boolean(state?.device.connected) && state?.device.readOnly !== true
    && state?.device.capabilities?.perKey !== false && state?.firmware?.compatible !== false;
  const latestLibraryContext=useRef({context:libraryPlayContext,canPlay:canLibraryPlay});
  latestLibraryContext.current={context:libraryPlayContext,canPlay:canLibraryPlay};
  const latestDraftContext=useRef(`${modelId}:${draftSession}`);
  latestDraftContext.current=`${modelId}:${draftSession}`;
  useEffect(()=>{
    libraryPlayGeneration.current++;
    libraryPlayRequest.current=null;
    setPendingLibraryPlay(null);setPlayRequestId(null);setLibraryPlayBusy(false);
  },[libraryPlayContext,Boolean(serviceError),exiting]);
  const draftKey = (model: string) => model === "kick75" ? "nuphylab-draft-kick75-v1" : "air-studio-draft-v1";
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
      if (saved !== null) restored = parseDraftRecord(saved);
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
    setSaveName(draft.name);
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
    setPlayRequestId(current=>current===id?null:current);
  };
  const adoptLibraryPlay = async (request:LibraryPlayRequest) => {
    if(libraryPlayRequest.current?.id!==request.id || request.generation!==libraryPlayGeneration.current
      || request.context!==latestLibraryContext.current.context || transitionLock.current)return;
    if(request.action==='play'&&!latestLibraryContext.current.canPlay){
      const message='当前连接暂不可播放到键盘，请检查连接后重试。';
      if(pendingLibraryPlay)setSaveError(message);
      else{notify(message);finishLibraryPlay(request.id);}
      return;
    }
    if(request.action!=='play'){
      transitionLock.current=request.id;setDraftTransitionBusy(true);
      try {
        if(!request.restoreKey&&state&&(state.playback.mode!=='idle'||state.game.status!=='idle'||state.device.armed))await command({op:'stop'},{silent:true});
        if(libraryPlayRequest.current?.id!==request.id || request.generation!==libraryPlayGeneration.current
          || request.context!==latestLibraryContext.current.context)return;
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
      return;
    }
    // One draft adoption, then Studio consumes this explicit request once.
    // Do not call the ordinary load path: its stop would restore the old output.
    untouchedNewDraft.current=null;
    setPendingLibraryPlay(null);setSaveError('');
    setDraft(cloneScene(request.scene));setStudioMode(modeForScene(request.scene));
    setDraftSession(value=>value+1);setPage('studio');
    setPlayRequestKind(request.kind);setPlayRequestId(request.id);
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
  const load = (scene: Scene, options?:{play?:boolean;create?:boolean;restoreKey?:string}) => {
    if(libraryPlayRequest.current||saveLock.current)return;
    if(options?.play){
      if(!canLibraryPlay)return;
      if(scene.trigger&&!layout.some(key=>typeof scene.colors[key.index]==='string'&&scene.colors[key.index].toLowerCase()!=='#000000'))return;
    }
    const request:LibraryPlayRequest={id:crypto.randomUUID(),scene:cloneScene(scene),action:options?.play?'play':options?.create?'new':'open',kind:scene.trigger?'trigger':'animation',context:libraryPlayContext,generation:libraryPlayGeneration.current,restoreKey:options?.restoreKey};
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
      load(parseDraftRecord(raw),{restoreKey:draftKey(modelId)});
    } catch {notify('暂时无法读取本机草稿。原记录已保留，请重试读取。');}
  };
  const creative = ["studio", "audio", "offline"].includes(page);
  const pageTitle = creative ? "灯光创作" : page === "library" ? "作品库" : page === "codex" ? "AI 助手" : page === "game" ? "灯光游戏" : page === "settings" ? "设置" : "设备";
  const currentLibraryPlayId=libraryPlayRequest.current?.id??null;
  return (
    <KeyboardModuleContext.Provider value={state?.settings.airTopRightModule === "keycap" ? "keycap" : "rotary"}>
    <div className="app-shell lab-v5" data-page={page} data-native={Boolean((window as Window & {webkit?:unknown}).webkit)}>
      <aside className="sidebar">
        <div className="window-lights" aria-hidden="true"><i/><i/><i/></div>
        <div className="brand"><img className="brand-symbol" src="/nuphy-studio.png" alt="" width={32} height={32}/><span>NuPhy Lab</span></div>
        <nav aria-label={tr("主导航")}>
          {([
            ["studio", "灯光创作", Lightbulb],
            ["library", "作品库", Folder],
            ["codex", "AI 助手", SquareTerminal],
            ["game", "灯光游戏", Gamepad2],
          ] as const).map(([id, label, Icon]) => <button key={id} aria-label={tr(label)} title={tr(label)} className={(id === "studio" ? creative : page === id) ? "active" : ""} aria-current={(id === "studio" ? creative : page === id) ? "page" : undefined} onClick={()=>setPage(id)}><Icon size={18} strokeWidth={1.5}/><span>{tr(label)}</span></button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-output sidebar-output-v7" role="status" data-connection-state={connectionDisplay.stateId}><span>{connectionCopy({zh:'键盘输出',en:'Keyboard output'})}</span><strong title={connectionSidebar(connectionDisplay)}>{connectionSidebar(connectionDisplay)}</strong></div>
          <nav aria-label={tr("设备与设置")}>
            <button aria-label={tr("设备")} title={tr("设备")} className={page === "device" ? "active" : ""} aria-current={page === "device" ? "page" : undefined} onClick={()=>setPage("device")}><Keyboard size={18} strokeWidth={1.5}/><span>{tr("设备")}</span></button>
            <button aria-label={tr("设置")} title={tr("设置")} className={page === "settings" ? "active" : ""} aria-current={page === "settings" ? "page" : undefined} onClick={()=>setPage("settings")}><SlidersHorizontal size={18} strokeWidth={1.5}/><span>{tr("设置")}</span></button>
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
              playRequestId={playRequestId}
              playRequestKind={playRequestKind}
              onPlayRequestHandled={()=>{if(playRequestId)setPlayRequestId(current=>current===playRequestId?null:current);}}
              onPlayRequestFinished={()=>finishLibraryPlay(currentLibraryPlayId)}
              command={command}
              draft={draft}
              setDraft={setStudioDraft}
              onSave={openSave}
              onBrowsePresets={() => setPage("library")}
              onNavigateDevice={() => setPage("device")}
              onEditCodexColors={()=>{setFocusCodexColors(true);setPage("codex");}}
              notify={notify}
            />
          ))}{tr(" ")}
          {page === "audio" && !nativeOnly && <AudioPanel state={state} layout={layout} command={command}/>}
          {tr(page === "library" && (
            <Library
              layout={layout}
              state={state}
              display={connectionDisplay}
              serviceError={serviceError}
              transitionBusy={libraryPlayBusy || saveBusy || exiting}
              command={command}
              onLoad={load}
              onNew={() =>
                load({
                  name: "未命名作品",
                  colors: blankColors(),
                  animation: { ...DEFAULT_ANIMATION },
                },{create:true})
              }
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
          {page === "settings" && <Settings state={state} command={command} display={connectionDisplay} onNavigateStudio={()=>setPage("studio")} initialTab={settingsTab}/>}
        </div>
      </main>
      {toast&&<FeedbackToast key={toast.id} message={toast.message} kind={toast.kind} onClose={()=>setToast(null)}/>}
      {pendingLibraryPlay&&<Modal title={tr('当前草稿有未保存修改')} width={560} busy={saveBusy||draftTransitionBusy} initialFocus="cancel" onClose={()=>{if(!saveLock.current&&!transitionLock.current){finishLibraryPlay(pendingLibraryPlay.id);setSaveError('');}}} className="library-play-guard-v8" footer={<>
        <Button kind="ghost" data-modal-cancel disabled={saveBusy||draftTransitionBusy} onClick={()=>{finishLibraryPlay(pendingLibraryPlay.id);setSaveError('');}}>{tr('取消')}</Button>
        <Button busy={draftTransitionBusy} disabled={saveBusy||(pendingLibraryPlay.action==='play'&&!canLibraryPlay)} onClick={()=>run(adoptLibraryPlay(pendingLibraryPlay))}>{tr(pendingLibraryPlay.action==='play'?'放弃修改并播放':pendingLibraryPlay.action==='new'?'放弃修改并新建':'放弃修改并打开')}</Button>
        <Button kind="primary" data-modal-retry busy={saveBusy||draftTransitionBusy} disabled={(pendingLibraryPlay.action==='play'&&!canLibraryPlay)||(!pendingLibraryPlay.saved&&!(draft.name.trim()||guardSaveName.trim()))} onClick={()=>run(saveThenLibraryPlay())}>{tr(saveBusy?'保存中…':pendingLibraryPlay.saved?(pendingLibraryPlay.action==='new'?'重试新建':'重试打开'):pendingLibraryPlay.action==='play'?(saveError?'重试保存后播放':'保存后播放'):pendingLibraryPlay.action==='new'?(saveError?'重试保存后新建':'保存后新建'):(saveError?'重试保存后打开':'保存后打开'))}</Button>
      </>}>
        <p>{tr('先处理「')}<span translate="no">{draft.name||tr('未命名作品')}</span>{pendingLibraryPlay.action==='new'?tr('」的修改，再新建作品。'):<>{tr(pendingLibraryPlay.action==='play'?'」的修改，再播放「':'」的修改，再打开「')}<span translate="no">{pendingLibraryPlay.scene.name}</span>{language==='en'?'”.':'」。'}</>}</p>
        {!draft.name.trim()&&<label className="form-field">{tr('作品名称')}<input aria-label={tr('保存当前草稿名称')} value={guardSaveName} disabled={saveBusy} maxLength={80} onChange={event=>{setGuardSaveName(event.target.value);setSaveError('');}}/></label>}
        <p className="muted">{tr('取消会保留当前草稿和键盘输出。')}</p>
        {saveError&&<div className="overlay-error" role="alert"><CircleAlert size={14}/><span>{tr(saveError)}</span></div>}
      </Modal>}
      {saveOpen&&<Modal title={tr('保存作品')} busy={saveBusy} initialFocus="input" onClose={()=>setSaveOpen(false)} footer={<><Button kind="ghost" disabled={saveBusy} onClick={()=>setSaveOpen(false)}>{tr('取消')}</Button><Button kind="primary" busy={saveBusy} disabled={!saveName.trim()} onClick={()=>run(save())}>{tr(saveBusy?'保存中…':saveError?'重试保存':'保存作品')}</Button></>}>
        <label className="form-field">{tr('作品名称')}<input aria-label={tr('保存作品名称')} aria-invalid={!saveName.trim()&&Boolean(saveError)} value={saveName} disabled={saveBusy} maxLength={80} onChange={event=>{setSaveName(event.target.value);setSaveError('');}} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();run(save());}}}/></label>
        {!saveName.trim()&&<p className="overlay-field-error">{tr('请输入作品名称。')}</p>}
        {draft.id&&<label className="checkbox-field"><input type="checkbox" checked={saveCopy} disabled={saveBusy} onChange={event=>setSaveCopy(event.target.checked)}/>{tr('另存为新作品')}</label>}
        <p className="muted">{tr('图案、颜色、动画与触发规则一起保存。')}</p><p className="muted">{tr('输出亮度是全局设置，不随作品保存。')}</p><p className="muted">{tr('保存到')}{' '}{modelId==='kick75'?'Kick75':'Air75 V3'} · {tr('我的作品')}</p>
        {saveError&&saveName.trim()&&<div className="overlay-error" role="alert"><CircleAlert size={14}/><span>{tr(saveError)}</span></div>}
      </Modal>}
    </div>
    </KeyboardModuleContext.Provider>
  );
}
