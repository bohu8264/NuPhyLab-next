import {useMemo,useState} from 'react';
import {FolderOpen,Search,Plus,Lightbulb,Music2} from 'lucide-react';
import {Library} from './Library';
import {MusicWorks,type WorkSource} from './music/MusicWorks';
import {initialSession} from './music/model';
import {withNewId} from './music/client';
import type {MusicEntry} from './music/MusicLab';
import {useLanguage,t as tr} from './i18n';
import {displayPresetName} from '../../shared/preset-names.mjs';
import {presetCatalog} from './presets';
import {Keyboard} from './Keyboard';
import {getLayoutModel} from '../../shared/layout.mjs';
import {applyArtworkAppearance} from '../../shared/render-animation.mjs';
import {Button,Modal} from './primitives';
import type {Scene} from './types';
import type {ComponentProps} from 'react';
import './unified-library.css';

export type LibraryFilter='all'|'lighting'|'music';
export function UnifiedLibrary({filter,onFilter,initialSource='saved',lightingAdded,musicAdded,onMusicEdit,onBrowse=()=>{},...lighting}:ComponentProps<typeof Library>&{initialSource?:'saved'|'presets';filter:LibraryFilter;onFilter:(value:LibraryFilter)=>void;lightingAdded:boolean;musicAdded:boolean;onMusicEdit:(entry:MusicEntry)=>void|Promise<void>;onBrowse?:()=>void}) {
  const en=useLanguage()==='en';
  const [source,setSource]=useState<WorkSource>(initialSource),[search,setSearch]=useState(''),[musicCount,setMusicCount]=useState(0),[newOpen,setNewOpen]=useState(false),[inspect,setInspect]=useState<Scene|null>(null);
  const query=search.trim().toLowerCase();
  const catalog=useMemo(()=>lighting.layout.length?presetCatalog(lighting.layout):[],[lighting.layout]);
  const lightingCount=source==='presets'?catalog.filter(p=>`${tr(p.name)} ${tr(p.description)}`.toLowerCase().includes(query)).length:(lighting.state?.scenes??[]).filter(s=>displayPresetName(s.name,tr).toLowerCase().includes(query)).length;
  const count=(filter==='music'||source==='deleted'?0:lightingCount)+(filter==='lighting'?0:musicCount);
  const editLabel=lightingAdded?(en?'Continue editing':'继续编辑'):(en?'Add Lighting Studio & edit':'添加灯光创作并编辑');
  function changeFilter(value:LibraryFilter){onBrowse();onFilter(value);setInspect(null);if(value!=='music'&&source==='deleted')setSource('saved');}
  function newMusic(){setNewOpen(false);void onMusicEdit({requestId:crypto.randomUUID(),session:withNewId({...initialSession(),name:en?'My performance':'我的演奏'})});}
  return <section className="unified-library">
    <div className="unified-library-heading"><p>{en?'Lighting and music, together in your library.':'灯光与演奏，统一收藏你的创作。'}</p><Button kind="primary" icon={<Plus size={15}/>} disabled={lighting.transitionBusy} onClick={()=>setNewOpen(true)}>{en?'New work':'新建作品'}</Button></div>
    <div className="unified-library-toolbar"><div className="unified-filter" role="group" aria-label={en?'Work type':'作品类型'}>{(['all','lighting','music'] as const).map((value,i)=><button key={value} aria-pressed={filter===value} onClick={()=>changeFilter(value)}>{(en?['All','Lighting','Music']:['全部','灯光','演奏'])[i]}</button>)}</div><label className="unified-search"><Search size={15}/><input type="search" value={search} onChange={e=>{onBrowse();setSearch(e.target.value);}} placeholder={en?'Search works':'搜索作品'} aria-label={en?'Search works':'搜索作品'}/></label></div>
    <div className="unified-source" role="group" aria-label={en?'Work collection':'作品来源'}>{(['saved','presets',...(filter==='music'?['deleted'] as const:[])] as WorkSource[]).map(value=><button key={value} aria-pressed={source===value} onClick={()=>{onBrowse();setSource(value);}}>{value==='saved'?(en?'My works':'我的作品'):value==='presets'?(en?'Presets':'默认预设'):(en?'Recently deleted':'最近删除')}</button>)}<span>{en?`${count} works`:`${count} 个作品`}</span></div>
    <div className="unified-work-grid">
      {filter!=='music'&&source!=='deleted'&&<Library {...lighting} embedded={{source,search,onSearch:setSearch,onSource:setSource,showTools:filter==='lighting',hideEmpty:true}} editLabel={editLabel} onInspect={setInspect}/>}
      <MusicWorks source={source} search={search} visible={filter!=='lighting'} blocked={Boolean(lighting.transitionBusy)} showTools={filter==='music'} added={musicAdded} onEdit={onMusicEdit} onCount={setMusicCount}/>
    </div>
    {!count&&<div className="unified-empty"><FolderOpen size={32} strokeWidth={1.2}/><h2>{en?(query?'No matching works':'Your next creation starts here'):(query?'没有找到匹配的作品':'从你的下一份创作开始')}</h2><p>{en?'Save lighting or music and it will appear here.':'保存灯光或演奏后，作品就会出现在这里。'}</p>{query&&<Button onClick={()=>setSearch('')}>{en?'Clear search':'清空搜索'}</Button>}</div>}
    {newOpen&&<Modal title={en?'What would you like to create?':'想创作什么？'} onClose={()=>setNewOpen(false)} width={460}><div className="unified-new"><button onClick={()=>{setNewOpen(false);lighting.onNew();}}><Lightbulb size={24}/><strong>{en?'Lighting':'灯光作品'}</strong><span>{en?'Patterns, animations and key effects':'图案、动画与按键灯效'}</span></button><button onClick={newMusic}><Music2 size={24}/><strong>{en?'Music':'演奏作品'}</strong><span>{en?'Melodies, drums and audio clips':'旋律、鼓点与声音片段'}</span></button></div></Modal>}
    {inspect&&<Modal title={displayPresetName(inspect.name,tr)} width={560} onClose={()=>setInspect(null)} footer={<><Button kind="ghost" onClick={()=>setInspect(null)}>{en?'Close':'关闭'}</Button><Button kind="primary" disabled={lighting.transitionBusy} onClick={()=>{setInspect(null);lighting.onLoad(inspect);}}>{editLabel}</Button></>}><div className="unified-lighting-detail"><Keyboard modelId={getLayoutModel()} layout={lighting.layout} colors={applyArtworkAppearance(inspect.colors,inspect.animation)} mini/><p>{en?'Lighting work':'灯光作品'} · {tr(inspect.trigger?'按键触发':inspect.animation.effect==='static'?'绘制':'动画')}</p><p className="muted">{en?'The saved work keeps its pattern, colors, animation and trigger rules.':'作品保留图案、颜色、动画与触发规则。'}</p></div></Modal>}
  </section>;
}
