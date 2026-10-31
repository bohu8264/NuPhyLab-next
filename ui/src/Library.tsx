import { t as tr, dateLocale } from "./i18n";
import "./library-native-v5.css";
import "./library-closeout-v6.css";
import './library-play-edit-v8.css';
import {lightingUnavailableMessage} from '../../shared/device-status.mjs';
import type {ConnectionDisplay} from '../../shared/connection-display.mjs';
import {connectionCopy} from './connection-copy-v7';
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  Download,
  Eye,
  FolderOpen,
  Import,
  MoreHorizontal,
  Pencil,
  Play,
  Pause,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { exportScenes } from "./api";
import { Keyboard, lightingPeak } from "./Keyboard";
import { Button, Empty, Modal, run } from "./primitives";
import { presetCatalog } from "./presets";
import { applyArtworkAppearance, renderAnimation } from "../../shared/render-animation.mjs";
import type { Preset } from "../../shared/presets.mjs";
import type { AppState, Command, Key, Notify, Scene } from "./types";
const effectNames: Record<string, string> = {
  static: "静态",
  move: "移动",
  pulse: "呼吸",
  wave: "波浪",
  frames: "逐帧",
};
export function Library({
  state,
  layout,
  display,
  serviceError='',
  transitionBusy=false,
  onLoad,
  onNew,
  command,
  notify,
}: {
  state: AppState | null;
  layout: Key[];
  display?: ConnectionDisplay;
  serviceError?: string;
  transitionBusy?: boolean;
  onLoad: (scene: Scene, options?:{play?:boolean}) => void;
  onNew: () => void;
  command: Command;
  notify: Notify;
}) {
  const [search, setSearch] = useState(""),
    [rename, setRename] = useState<Scene | null>(null),
    [name, setName] = useState(""),
    [deleting, setDeleting] = useState<Scene | null>(null),
    [menu, setMenu] = useState<string | undefined>(),
    [busy, setBusy] = useState(false),
    [formError,setFormError]=useState(""),[menuFlip,setMenuFlip]=useState(false);
  const menuAnchor=useRef<HTMLButtonElement|null>(null),dialogAnchor=useRef<HTMLElement|null>(null),menuFocus=useRef<"first"|"last">("first"),busyLock=useRef(false);
  const closeMenu=(restore=false)=>{setMenu(undefined);if(restore)menuAnchor.current?.focus();};
  const openMenu=(id:string|undefined,anchor:HTMLButtonElement,last=false)=>{menuAnchor.current=anchor;menuFocus.current=last?"last":"first";setMenuFlip(anchor.getBoundingClientRect().bottom+130>window.innerHeight);setMenu(menu===id?undefined:id);};
  const [source, setSource] = useState<"saved" | "presets">("presets");
  const [category, setCategory] = useState<"all" | "pattern" | "motion">("all");
  const [previewId, setPreviewId] = useState<string>();
  const outputBlocked=Boolean(serviceError)||!state?.device.connected||state.device.readOnly===true
    ||state.device.capabilities?.perKey===false||state.firmware?.compatible===false;
  const outputReason=serviceError?tr('本地服务未响应，暂不可播放到键盘。')
    :!state?tr('正在读取连接状态。')
    :outputBlocked?(connectionCopy(display?.workTitle)||tr(state.firmware?.compatible===false?'当前固件暂不支持逐键输出。':lightingUnavailableMessage(state))):'';
  const transitionBlocked=busy||transitionBusy;
  const triggerPlayReason=(scene:Scene)=>{
    if(!scene.trigger)return '';
    if(!layout.some(key=>scene.colors[key.index]?.toLowerCase()!=='#000000'))return tr('图案中还没有亮起的按键，先编辑图案。');
    if((scene.animation.brightness??100)===0)return tr('作品亮度为 0%，调高后可启用按键触发。');
    if(!applyArtworkAppearance(scene.colors,scene.animation).some((color,index)=>layout.some(key=>key.index===index)&&color.toLowerCase()!=='#000000'))return tr('当前设置下图案没有亮起的按键，请调整颜色或作品亮度。');
    return '';
  };
  const playFromLibrary=(scene:Scene)=>{
    if(outputBlocked||transitionBlocked||Boolean(triggerPlayReason(scene)))return;
    setPreviewId(undefined);onLoad(scene,{play:true});
  };
  const catalog = useMemo(() => layout.length ? presetCatalog(layout) : [], [layout]);
  const matchingPresets = catalog.filter((preset) =>
    (category === "all" || preset.category === category) &&
    `${tr(preset.name)} ${tr(preset.description)} ${tr(preset.name)}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  useEffect(() => { setPreviewId(undefined); }, [source, category, search]);
  useEffect(() => { setPreviewId(undefined); setRename(null); setDeleting(null); setMenu(undefined); }, [layout]);
  useEffect(() => {
    const hide = () => { if (document.hidden) setPreviewId(undefined); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!(event.target as Element).closest(".lab-library-menu")) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") {event.preventDefault();closeMenu(true);} };
    document.addEventListener("pointerdown",outside); document.addEventListener("keydown",escape);
    return () => {document.removeEventListener("pointerdown",outside); document.removeEventListener("keydown",escape);};
  },[menu]);
  useEffect(()=>{if(menu){const items=document.querySelectorAll<HTMLButtonElement>('.lab-library-dropdown [role="menuitem"]:not([disabled])');(menuFocus.current==="last"?items[items.length-1]:items[0])?.focus();}},[menu]);
  const requestExport=(list:Scene[],filename:string)=>{try{exportScenes(list,filename);notify("已请求导出，请到下载文件夹检查。","success");}catch(error){notify(error instanceof Error?error.message:"无法请求导出，请重试。");}};
  const openPreset = (preset: Preset, play=false) => {
    if(transitionBlocked)return;
    setPreviewId(undefined);
    // Preset identity belongs to the catalog; each saved edit gets a fresh scene ID.
    const scene={ name: tr(preset.name), colors: preset.colors, animation: preset.animation };
    if(play)playFromLibrary(scene);else onLoad(scene);
  };
  const fileInput = useRef<HTMLInputElement>(null),searchInput = useRef<HTMLInputElement>(null);
  const clearSearch = () => { setSearch(""); searchInput.current?.focus(); };
  const scenes = state?.scenes || [],
    filtered = scenes.filter((scene) =>
      scene.name.toLowerCase().includes(search.toLowerCase()),
    );
  const importFile = async (file?: File) => {
    if (!file||busyLock.current) return;
    busyLock.current=true;setBusy(true);
    try {
      const value = JSON.parse(await file.text());
      const list = Array.isArray(value)
        ? value
        : Array.isArray(value.scenes)
          ? value.scenes
          : value.colors
            ? [value]
            : null;
      if (!list) throw new Error("文件里没有可导入的作品");
      await command({ op: "importScenes", scenes: list },{silent:true});
      setSource("saved");
      setSearch("");
      setPreviewId(undefined);
      notify(`已导入 ${list.length} 个作品`, "success");
    } catch (error) {
      if (error instanceof SyntaxError)
        notify("无法读取 JSON 文件，请检查文件格式");
      else if (error instanceof Error) notify(error.message);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
      busyLock.current=false;setBusy(false);
    }
  };
  const renameScene = async () => {
    if(!rename||busyLock.current)return;
    if(!name.trim()){setFormError("请输入作品名称。");return;}
    busyLock.current=true;setFormError("");
    setBusy(true);
    try {
      await command({
        op: "saveScene",
        scene: { ...rename, name: name.trim() },
      },{silent:true});
      setRename(null);
      notify("作品已重命名", "success");
    } catch(error){setFormError(tr("名称未能保存。已保留输入，请重试。")+(error instanceof Error?` ${tr(error.message)}`:""));
    } finally {
      busyLock.current=false;
      setBusy(false);
    }
  };
  const deleteScene=async()=>{
    if(!deleting||busyLock.current)return;
    busyLock.current=true;setBusy(true);setFormError('');
    try{await command({op:'deleteScene',id:deleting.id},{silent:true});setDeleting(null);notify('作品已删除','success');}
    catch(error){setFormError(tr('作品尚未删除，请重试。')+(error instanceof Error?` ${tr(error.message)}`:''));}
    finally{busyLock.current=false;setBusy(false);}
  };
  return (
    <section className="lab-library-page library-play-edit-v8">
      <div className="lab-library-tabs" role="tablist" aria-label={tr("作品来源")}>
        <button role="tab" aria-selected={source === "presets"} onClick={() => {setSource("presets"); setSearch("");}}>{tr("默认预设")}</button>
        <button role="tab" aria-selected={source === "saved"} onClick={() => {setSource("saved"); setSearch("");}}>{tr("我的作品")}</button>
      </div>
      <input ref={fileInput} type="file" aria-label={tr("导入")} accept=".json,application/json" className="visually-hidden" onChange={event => run(importFile(event.target.files?.[0]))}/>
      <div className="lab-library-toolbar">
        <label className="lab-library-search"><input ref={searchInput} aria-label={tr(source === "presets" ? "搜索预设" : "搜索作品")} placeholder={tr(source === "presets" ? "搜索图案或灯效" : "搜索作品名称")} value={search} onChange={event => setSearch(event.target.value)}/><Search size={16} strokeWidth={1.5}/></label>
        <div className="lab-library-actions"><Button kind="ghost" icon={<Import size={16}/>} disabled={busy} onClick={() => fileInput.current?.click()}>{tr("导入")}</Button><Button kind="ghost" icon={<Download size={16}/>} disabled={!scenes.length} onClick={() => requestExport(scenes,tr("NuPhy Lab-作品.json"))}>{tr("导出全部")}</Button><Button kind="primary" icon={<Plus size={16}/>} disabled={transitionBlocked} onClick={onNew}>{tr("新建作品")}</Button></div>
      </div>
      {source === "presets" ? <section className="lab-preset-library" aria-label={tr("默认预设")}>
        <div className="lab-library-categories" role="group" aria-label={tr("预设分类")}>{([["all","全部"],["pattern","动态图形"],["motion","氛围灯效"]] as const).map(([id,label]) => <button key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>{tr(label)}</button>)}</div>
        {!layout.length ? <Empty icon={<FolderOpen size={28}/>} title={tr("正在读取键盘布局")}>{tr("布局就绪后显示预设图案。")}</Empty> : matchingPresets.length ? <div className="lab-library-grid">{matchingPresets.map(preset => <article className="lab-library-item" key={preset.id}>
          <button className="lab-library-art" disabled={transitionBlocked} aria-label={tr(`打开预设 ${tr(preset.name)}`)} onClick={() => openPreset(preset)}><PresetKeyboard preset={preset} layout={layout} active={previewId === preset.id}/></button>
          <div className="lab-library-item-info"><div className="lab-library-item-meta"><h3>{tr(preset.name)}</h3><p>{tr(effectNames[preset.animation.effect] || preset.animation.effect)}</p></div><div className="lab-library-item-actions"><button className="lab-library-preview" aria-pressed={previewId === preset.id} aria-label={tr(`${previewId === preset.id ? "停止页面预览" : "仅页面预览"} ${tr(preset.name)}`)} onClick={() => setPreviewId(previewId === preset.id ? undefined : preset.id)}>{previewId === preset.id ? <Pause size={14}/> : <Eye size={14}/>}<span>{tr(previewId === preset.id ? "停止页面预览" : "仅页面预览")}</span></button><Button kind="ghost" disabled={transitionBlocked} onClick={() => openPreset(preset)} aria-label={tr(`使用预设 ${tr(preset.name)}`)}>{tr("打开编辑")}</Button><Button className="lab-library-play-v8" icon={<Play size={14}/>} disabled={outputBlocked||transitionBlocked} aria-describedby={outputReason?"library-play-reason":undefined} onClick={()=>openPreset(preset,true)} aria-label={tr(`播放预设 ${tr(preset.name)} 到键盘`)}>{tr("播放到键盘")}</Button></div></div>
          <details className="lab-preset-description"><summary>{tr("效果说明")}</summary><p>{tr(preset.description)}</p></details>
        </article>)}</div> : <div className="lab-library-empty-v6"><Empty title={tr("没有匹配的预设")} actions={<Button kind="primary" onClick={clearSearch}>{tr("清空搜索")}</Button>}>{tr("换个关键词或分类试试。")}</Empty></div>}
        <p className="lab-library-footnote">{tr("页面预览仅在屏幕显示；播放到键盘后可继续编辑。")}</p>
      </section> : !state ? <Empty icon={<FolderOpen size={28}/>} title={tr("正在读取作品")}>{tr("作品库就绪后显示已保存的作品。")}</Empty> : filtered.length ? <><div className="lab-library-grid lab-saved-grid">{filtered.map(scene => <article key={scene.id} className="lab-library-item">
        <button className="lab-library-art" disabled={transitionBlocked} onClick={() => onLoad(scene)} aria-label={tr(`打开作品 ${scene.name}`)}><Keyboard layout={layout} colors={applyArtworkAppearance(scene.colors,scene.animation)} mini/></button>
        <div className="lab-library-item-info"><div className="lab-library-item-meta"><h3 translate="no">{scene.name}</h3><p>{tr(scene.trigger ? "按键触发" : scene.animation.effect === "static" ? "绘制" : "动画")}{!scene.trigger && scene.animation.effect === "frames" ? tr(` · ${scene.animation.frames?.length || 0} 帧`) : ""}{scene.updatedAt ? ` · ${new Date(scene.updatedAt).toLocaleDateString(dateLocale(),{month:"numeric",day:"numeric"})}` : ""}</p></div>
          <div className="lab-library-item-actions"><Button kind="ghost" disabled={transitionBlocked} onClick={() => onLoad(scene)}>{tr("打开编辑")}</Button><Button className="lab-library-play-v8" icon={<Play size={14}/>} disabled={outputBlocked||transitionBlocked||Boolean(Boolean(triggerPlayReason(scene)))} aria-describedby={outputReason?"library-play-reason":triggerPlayReason(scene)?`library-trigger-reason-${scene.id}`:undefined} onClick={()=>playFromLibrary(scene)} aria-label={tr(scene.trigger?`启用作品 ${scene.name} 的按键触发`:`播放作品 ${scene.name} 到键盘`)}>{tr(scene.trigger?"启用按键触发":"播放到键盘")}</Button><div className="lab-library-menu"><Button kind="ghost" className="icon-button" icon={<MoreHorizontal size={18}/>} aria-label={tr(`作品 ${scene.name} 的更多操作`)} aria-expanded={menu === scene.id} disabled={busy} onClick={event=>openMenu(scene.id,event.currentTarget)} onKeyDown={event=>{if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();openMenu(scene.id,event.currentTarget,event.key==="ArrowUp");}}}/>
          {menu === scene.id && <div className="lab-library-dropdown" role="menu" data-flip={menuFlip} aria-label={tr('作品操作')} onKeyDown={event=>{
            if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));const index=items.indexOf(document.activeElement as HTMLButtonElement);const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();}
            else if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();event.stopPropagation();closeMenu(true);}
          }}><button role="menuitem" disabled={busy} onClick={() => {dialogAnchor.current=menuAnchor.current;setFormError("");setRename(scene); setName(scene.name); setMenu(undefined);}}><Pencil size={15}/>{tr("重命名")}</button><button role="menuitem" disabled={busy} onClick={() => {requestExport([scene],`${scene.name}.json`); closeMenu(true);}}><Download size={15}/>{tr("导出作品")}</button><button role="menuitem" disabled={busy} className="danger-text" onClick={() => {dialogAnchor.current=menuAnchor.current;setFormError("");setDeleting(scene); setMenu(undefined);}}><Trash2 size={15}/>{tr("删除作品")}</button></div>}
          </div></div>
        </div>
        {triggerPlayReason(scene)&&<p id={`library-trigger-reason-${scene.id}`} className="lab-library-play-reason-v8">{triggerPlayReason(scene)}</p>}
      </article>)}</div><p className="lab-library-footnote">{tr(`${filtered.length} 个作品`)} · {layout.length === 80 ? "Kick75" : "Air75 V3"}</p></> : <div className="lab-library-empty-v6"><Empty title={tr(search ? "没有找到作品" : "还没有保存的作品")} actions={search ? <Button kind="primary" onClick={clearSearch}>{tr("清空搜索")}</Button> : <Button kind="primary" disabled={transitionBlocked} onClick={onNew}>{tr("新建作品")}</Button>}>{tr(search ? "换一个名称，或清空搜索。" : "在「灯光创作」保存作品后，会显示在这里。")}</Empty></div>}
      {outputReason&&<p id="library-play-reason" className="lab-library-play-reason-v8" role="status">{outputReason}</p>}
      {rename&&<Modal title={tr('重命名作品')} width={424} busy={busy} initialFocus="input" returnFocus={dialogAnchor.current} onClose={()=>setRename(null)} footer={<><Button kind="ghost" disabled={busy} onClick={()=>setRename(null)}>{tr('取消')}</Button><Button kind="primary" busy={busy} disabled={!name.trim()} onClick={()=>run(renameScene())}>{tr(busy?'保存中…':'保存名称')}</Button></>}>
        <label className="form-field">{tr('作品名称')}<input aria-label={tr('作品名称')} aria-invalid={!name.trim()} value={name} maxLength={80} disabled={busy} onChange={event=>{setName(event.target.value);setFormError('');}} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();run(renameScene());}}}/></label>
        {!name.trim()&&<p className="overlay-field-error">{tr('请输入作品名称。')}</p>}
        <p className="muted">{tr('仅修改名称，图案和灯效保持原样。')}</p>
        {formError&&name.trim()&&<div className="overlay-error" role="alert"><CircleAlert/><span>{tr(formError)}</span></div>}
      </Modal>}
      {deleting&&<Modal title={tr('删除作品')} width={424} busy={busy} initialFocus="cancel" returnFocus={dialogAnchor.current} onClose={()=>setDeleting(null)} footer={<><Button kind="ghost" data-modal-cancel disabled={busy} onClick={()=>setDeleting(null)}>{tr('取消')}</Button><Button kind="danger" busy={busy} onClick={()=>run(deleteScene())}>{tr(busy?'删除中…':'删除作品')}</Button></>}>
        <p>{tr('删除「')}<span translate="no">{deleting.name}</span>{tr('」？')}</p><p className="muted">{tr('该作品将从这台 Mac 的作品库移除。已导出的文件会保留。')}</p>
        {formError&&<div className="overlay-error" role="alert"><CircleAlert/><span>{tr(formError)}</span></div>}
      </Modal>}
    </section>
  );
}

function PresetKeyboard({ preset, layout, active }: { preset: Preset; layout: Key[]; active: boolean }) {
  const [colors, setColors] = useState(preset.colors);
  const [reducedMotion,setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    const update=() => setReducedMotion(media.matches);
    media.addEventListener('change',update);update();
    return () => media.removeEventListener('change',update);
  }, []);
  const peak = useMemo(() => lightingPeak([preset.colors, ...preset.animation.frames.map(frame => frame.colors)]), [preset]);
  useEffect(() => {
    if (!active) return;
    const start = performance.now();
    const update = () => setColors(renderAnimation(preset.colors, preset.animation, performance.now() - start));
    update();
    if (reducedMotion) return;
    const timer = window.setInterval(update, 60);
    return () => window.clearInterval(timer);
  }, [active, preset, reducedMotion]);
  return <Keyboard layout={layout} colors={active ? colors : applyArtworkAppearance(preset.colors,preset.animation)} lightPreview lightPreviewPeak={peak} mini />;
}
