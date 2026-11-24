import {useCallback, useEffect, useRef, useState} from 'react';
import {Plus, X} from 'lucide-react';
import {Button, Switch} from './primitives';
import {useLanguage} from './i18n';
import './screen-replay.css';

type Feature = 'screen-awareness' | 'smart-clipboard';
type Shortcut = {shortcutLabel:string;shortcutReady:boolean;shortcutIssue:string};
type Settings = {enabled:boolean;shortcuts:Record<string,Shortcut>;excluded:string[];appNames?:Record<string,string>;days:number;limit:number;screenPermission:boolean;accessibility:boolean;issue:string};
type Bridge = {postMessage:(value:Record<string,unknown>)=>Promise<Settings>};
export function AssistSettings({feature,onPermissions,onModels}:{feature:Feature;onPermissions:()=>void;onModels:()=>void}) {
  const en=useLanguage()==='en', screen=feature==='screen-awareness';
  const t=(zh:string,english:string)=>en?english:zh;
  const [state,setState]=useState<Settings>(),[pending,setPending]=useState(''),[error,setError]=useState('');
  const live=useRef(false),lock=useRef(''),revision=useRef(0);
  const send=useCallback((op:string,values:Record<string,unknown>={})=>{
    const bridge=(window as unknown as {webkit?:{messageHandlers?:{assistTools?:Bridge}}}).webkit?.messageHandlers?.assistTools;
    if(!bridge)return Promise.reject(new Error(en?'Open this feature in the Mac app.':'请在 Mac 应用中打开此功能。'));
    return bridge.postMessage({feature,op,language:en?'en':'zh-CN',...values});
  },[en,feature]);
  useEffect(()=>{
    live.current=true;
    const refresh=()=>{if(lock.current)return;const n=++revision.current;send('state').then(v=>{if(live.current&&n===revision.current){setState(v);setError('');}}).catch(err=>{if(live.current&&n===revision.current)setError(String(err.message??err));});};
    refresh();window.addEventListener('focus',refresh);
    return ()=>{live.current=false;++revision.current;window.removeEventListener('focus',refresh);if(lock.current.startsWith('key-'))void send('cancel',{key:lock.current.slice(4)}).catch(()=>{});};
  },[send]);
  const act=async(op:string,values:Record<string,unknown>={},name=op)=>{
    if(lock.current)return;const n=++revision.current;lock.current=name;setPending(name);setError('');
    try{const v=await send(op,values);if(live.current&&n===revision.current)setState(v);}
    catch(err){if(live.current&&n===revision.current)setError(err instanceof Error?err.message:String(err));}
    finally{lock.current='';if(live.current)setPending('');}
  };
  const shortcut=screen?{id:'screen',label:t('打开或收起屏幕感知','Show or hide Screen Awareness')}:{id:'history',label:t('打开或收起历史','Show or hide history')};
  const key=state?.shortcuts[shortcut.id], recording=pending==='key-'+shortcut.id;
  const name=screen?t('AI 屏幕感知','Screen Awareness'):t('智能剪贴板','Smart Clipboard');
  return <section className="screen-replay" aria-label={name}>
    <div className="replay-controls">
      <div className="replay-head"><Switch voiceId={feature} label={screen?name:t('记录剪贴板历史','Record clipboard history')} checked={!!state?.enabled} disabled={!state||!!pending} onChange={value=>void act('enable',{value})}/>
        <p>{screen?t('用快捷键读取鼠标所在屏幕的可见内容，也可以只框选一块区域。确认范围后再提问。','Use the shortcut to capture the whole display under the pointer, or select an area. Review the capture before asking.'):t('点选一条历史记录即可复制，再到目标应用粘贴。文字、链接、图片和文件引用都保存在这台 Mac 上。','Click a history entry to copy it, then paste in your app. Text, links, images and file references stay on this Mac.')}</p></div>
      <div className="replay-row"><div className="replay-actions">
        <Button kind="primary" disabled={!state?.enabled||!!pending} onClick={()=>void act('open')}>{screen?t('读取整个屏幕','Capture full screen'):t('打开历史','Open history')}</Button>
        {screen&&<Button disabled={!state?.enabled||!!pending} onClick={()=>void act('region')}>{t('框选区域','Select area')}</Button>}</div></div>
      <div className="replay-row"><div><strong>{shortcut.label}</strong>{key?.shortcutIssue&&<p>{key.shortcutIssue}</p>}</div><div className="replay-actions">
        <button className="replay-key" disabled={!state||!!pending} onClick={()=>void act('record',{key:shortcut.id},'key-'+shortcut.id)} aria-label={t('设置','Set')+' '+shortcut.label}>{recording?t('请按键或鼠标侧键…','Press keys or a side button…'):key?.shortcutLabel||t('设置快捷键','Set shortcut')}</button>
        {recording?<button className="replay-clear" aria-label={t('取消','Cancel')} onClick={()=>void send('cancel',{key:shortcut.id}).catch(()=>{})}><X size={16}/></button>:key?.shortcutLabel&&<button className="replay-clear" disabled={!!pending} aria-label={t('清空','Clear')+' '+shortcut.label} onClick={()=>void act('clear',{key:shortcut.id})}><X size={16}/></button>}</div></div>
      {!screen&&state&&<div className="replay-row"><div><strong>{t('历史保留','History retention')}</strong><p>{t('收藏的记录保留至手动删除。','Pinned entries stay until you delete them.')}</p></div><div className="replay-actions">
        <select aria-label={t('保存天数','Days to keep')} disabled={!!pending} value={state.days} onChange={e=>void act('retention',{days:Number(e.target.value),limit:state.limit})}>{[1,7,30,90,365].map(n=><option key={n} value={n}>{n} {t('天','days')}</option>)}</select>
        <select aria-label={t('数量上限','Entry limit')} disabled={!!pending} value={state.limit} onChange={e=>void act('retention',{days:state.days,limit:Number(e.target.value)})}>{[50,100,300,1000].map(n=><option key={n} value={n}>{n} {t('条','entries')}</option>)}</select></div></div>}
    </div>
    <div className="replay-controls"><div className="replay-row"><div><strong>{t('排除的应用','Excluded apps')}</strong><p>{screen?t('整屏识别时会遮盖这些应用。框选范围包含这些应用时会跳过本次识别。','These apps are masked in full-screen captures. Regions overlapping them are skipped.'):t('跳过来自这些应用的复制。macOS 未标明来源时，按复制时的前台应用判断。','Copies from these apps are skipped. When macOS provides no source, the active app is used.')}</p></div>
      <Button kind="ghost" icon={<Plus size={15}/>} disabled={!state||!!pending} onClick={()=>void act('exclude')}>{t('选择应用','Choose app')}</Button></div>
      {state?.excluded.map(id=><div className="replay-row" key={id}><span title={id}>{state.appNames?.[id]??id}</span><button className="replay-clear" disabled={!!pending} aria-label={t('取消排除','Remove exclusion')+' '+id} onClick={()=>void act('unexclude',{bundle:id})}><X size={15}/></button></div>)}</div>
    <div className="replay-controls"><div className="replay-row"><div><strong>{t('模型与 API','Model & API')}</strong><p>{screen?t('模型支持图片时，可在浮窗选择附上画面。','Include the image in the panel when your model supports it.'):t('AI 搜索只发送搜索句。AI 处理只发送你选中的那条内容。','AI search sends only the search phrase. AI actions send only the entry you choose.')}</p></div><Button kind="ghost" onClick={onModels}>{t('设置','Settings')}</Button></div>
      {screen&&state&&!state.screenPermission&&<div className="replay-row"><span>{t('读取整屏和框选画面需要录屏权限。','Allow Screen Recording to capture the display or a selected area.')}</span><Button kind="ghost" onClick={()=>void act('screenPermission')}>{t('授权','Allow')}</Button></div>}
      {state&&!state.accessibility&&<div className="replay-row"><span>{t('全局快捷键需要辅助功能权限。','Allow Accessibility to use global shortcuts.')}</span><Button kind="ghost" onClick={onPermissions}>{t('查看权限','View permissions')}</Button></div>}</div>
    {(error||state?.issue)&&<p role="alert">{error||state?.issue}</p>}
  </section>;
}
