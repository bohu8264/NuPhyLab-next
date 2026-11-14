import {useState} from 'react';
import {Lightbulb,Folder,SquareTerminal,Gamepad2,AudioLines,Music2,ScanLine,Files,Archive,Plus,Minus,ArrowUpRight,Search} from 'lucide-react';
import {useLanguage} from './i18n';
import type {FeatureId} from '../../shared/sidebar-features.mjs';
import './feature-center.css';

export const features = [
  {id:'studio',zh:'灯光创作',en:'Lighting Studio',icon:Lightbulb,description:['绘制图案、编排动画，让键盘呈现你的灯光。','Draw patterns and create animations for your keyboard.']},
  {id:'library',zh:'作品库',en:'Library',icon:Folder,description:['灯光与演奏作品，统一保存、预览和继续编辑。','Keep, preview and edit your lighting and music in one place.']},
  {id:'codex',zh:'AI 助手',en:'AI Assistant',icon:SquareTerminal,description:['用键盘切换 AI 任务、执行快捷操作和查看状态。','Switch AI tasks, run shortcuts and follow their status.']},
  {id:'game',zh:'灯光游戏',en:'Lighting Games',icon:Gamepad2,description:['在键盘上玩反应、记忆和街机小游戏。','Play reaction, memory and arcade games on your keyboard.']},
  {id:'typing-sounds',zh:'模拟声浪',en:'Typing Sounds',icon:AudioLines,description:['为打字搭配喜欢的声音，单独调节大键音量。','Give your typing a new sound, with separate levels for larger keys.']},
  {id:'music',zh:'演奏模式',en:'Music Mode',icon:Music2,description:['把键盘变成乐器，录制旋律、鼓点与声音片段。','Turn your keyboard into an instrument. Record melodies, drums and clips.']},
  {id:'selection-question',zh:'智能框选',en:'Smart Selection',icon:ScanLine,description:['框选内容，快速翻译、总结、解释或起草回复。','Select anything to translate, summarize, explain or draft a reply.']},
  {id:'drag-convert',zh:'拖拽转换',en:'Drag Convert',icon:Files,description:['拖动文件，完成格式转换、压缩与解压。','Convert, compress and extract files with a drag.']},
  {id:'keyboard-pocket',zh:'键盘口袋',en:'Keyboard Pocket',icon:Archive,description:['随手收纳文字、图片与文件，用快捷键取用。','Keep text, images and files ready to use with a shortcut.']},
] satisfies {id:FeatureId;zh:string;en:string;icon:typeof Folder;description:string[]}[];

export function FeatureCenter({added,busy,onToggle,onOpen}:{added:FeatureId[];busy:boolean;onToggle:(id:FeatureId)=>void;onOpen:(id:FeatureId)=>void}) {
  const en=useLanguage()==='en', [search,setSearch]=useState('');
  const visible=features.filter(feature=>[feature.zh,feature.en,...feature.description].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="feature-center">
    <div className="feature-center-intro"><div><h2>{en?'Your tools, your sidebar':'把常用功能留在手边'}</h2><p>{en?'Add the tools you use. Removing an entry keeps its content and settings.':'添加你常用的功能。移除入口后，内容和设置仍会保留。'}</p></div><span>{en?`${added.length} added`:`已添加 ${added.length} 项`}</span></div>
    <label className="feature-search"><Search size={16}/><input type="search" value={search} onChange={event=>setSearch(event.target.value)} aria-label={en?'Search features':'搜索功能'} placeholder={en?'Search features':'搜索功能'}/></label>
    <div className="feature-grid">{visible.map(feature=>{const Icon=feature.icon,on=added.includes(feature.id),name=en?feature.en:feature.zh;return <article key={feature.id} className="feature-card" data-feature={feature.id}><div className="feature-card-heading"><span className="feature-icon"><Icon size={22} strokeWidth={1.5}/></span><h3>{name}</h3>{on&&<span className="feature-added">{en?'Added':'已添加'}</span>}</div><p>{feature.description[en?1:0]}</p><div className="feature-card-actions">{on&&<button disabled={busy} onClick={()=>onOpen(feature.id)} aria-label={(en?'Open ':'打开')+name}>{en?'Open':'打开'}<ArrowUpRight size={14}/></button>}<button className={on?'feature-remove':'feature-add'} disabled={busy} aria-label={(on?(en?'Remove ':'移除'):(en?'Add ':'添加'))+name} onClick={()=>onToggle(feature.id)}>{on?<Minus size={14}/>:<Plus size={14}/>} {on?(en?'Remove':'移除'):(en?'Add':'添加')}</button></div></article>;})}</div>
    {!visible.length&&<p className="feature-empty">{en?'No matching features. Try another search.':'没有找到匹配的功能，换个关键词试试。'}</p>}
  </section>;
}
