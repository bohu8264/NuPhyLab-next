import {useCallback, useEffect, useRef, useState} from 'react';
import {Camera, Check} from 'lucide-react';
import {Button, Switch} from './primitives';
import {useLanguage} from './i18n';
import './screen-replay.css';
import './key-buddy.css';

type BuddyState = {
  enabled:boolean; visible:boolean; permission:boolean; listening:boolean; size:string; position:string;
  cat:string; preview?:string; hasCustom:boolean; hasDraft:boolean; photo?:string; generating:boolean;
  model?:string; service?:string; modelScope?:string; imageConfirmed:boolean; portraits?:Record<string,string>;
};
type Bridge = {postMessage(body:unknown):Promise<BuddyState>};
function bridge() {
  return (window as unknown as {webkit?:{messageHandlers?:{keyBuddy?:Bridge}}}).webkit?.messageHandlers?.keyBuddy;
}
const cats = [
  ['black','黑猫','Black cat'],['tabby','橘虎斑','Ginger tabby'],['tuxedo','黑白猫','Tuxedo'],
  ['calico','三花','Calico'],['siamese','暹罗','Siamese'],['custom','我家的猫','My cat']
] as const;

export function KeyBuddySettings({onModels}:{onModels:()=>void}) {
  const en=useLanguage()==='en';
  const language=en?'en':'zh';
  const t=(zh:string,english:string)=>en?english:zh;
  const [state,setState]=useState<BuddyState>(),[portraits,setPortraits]=useState<Record<string,string>>({});
  const [error,setError]=useState(''),[busy,setBusy]=useState(''),[editor,setEditor]=useState(false);
  const [confirmedScope,confirm]=useState<string>();
  const epoch=useRef(0),lock=useRef(false);
  const update=useCallback((s:BuddyState)=>{
    setState(s);
    if(s.portraits)setPortraits(s.portraits);
  },[]);
  useEffect(()=>{
    let active=true;
    const refresh=()=>{
      const seq=epoch.current;
      if(!lock.current)bridge()?.postMessage({op:'catalog',language}).then(s=>{
        if(active&&seq===epoch.current&&!lock.current)update(s);
      }).catch(e=>{if(active)setError(e.message??String(e))});
    };
    refresh();window.addEventListener('focus',refresh);
    return ()=>{
      active=false;epoch.current++;lock.current=false;
      window.removeEventListener('focus',refresh);
      bridge()?.postMessage({op:'dismiss',language}).catch(()=>{});
    };
  },[language,update]);
  async function change(op:string,value?:unknown) {
    if(lock.current&&op!=='dismiss')return;
    const seq=++epoch.current;
    lock.current=true;setBusy(op);setError('');
    try {
      const b=bridge();
      if(!b)throw new Error(t('请在 Mac 应用里打开。','Open this feature in the Mac app.'));
      let s=await b.postMessage({op,value,language,modelScope:state?.modelScope,
        confirmed:!!state?.modelScope&&confirmedScope===state.modelScope});
      if(seq!==epoch.current)return;
      if(op==='apply'||op==='generate')s=await b.postMessage({op:'catalog',language});
      if(seq!==epoch.current)return;
      update(s);
      if(op==='apply'||op==='dismiss'){setEditor(false);confirm(undefined)}
    } catch(e) {
      if(seq===epoch.current)setError(e instanceof Error?e.message:String(e));
    } finally {
      if(seq===epoch.current){lock.current=false;setBusy('')}
    }
  }
  const pending=!!busy||!state;
  const choices=cats.filter(([id])=>id!=='custom'||state?.hasCustom);
  const label=(id:string)=>{const c=cats.find(([v])=>v===id);return c?t(c[1],c[2]):t('我家的猫','My cat')};
  const visionOK=state?.imageConfirmed|| (!!state?.modelScope&&state.modelScope===confirmedScope);
  const title=t('键盘搭子','Key Buddy');
  return <section className="screen-replay buddy-settings" aria-label={title}>
    <div className="replay-controls">
      <div className="replay-head"><Switch voiceId="key-buddy" label={title} checked={!!state?.enabled} disabled={pending} onChange={v=>void change('enable',v)}/></div>
      <div className="replay-row"><strong>{t('桌面位置','Desktop position')}</strong><select disabled={pending} value={state?.position??'bottomRight'} onChange={e=>void change('position',e.target.value)}>
        {([['bottomRight','右下角','Bottom right'],['bottomLeft','左下角','Bottom left'],['topRight','右上角','Top right'],['topLeft','左上角','Top left']]).map(([id,zh,english])=><option value={id} key={id}>{t(zh,english)}</option>)}</select></div>
      <div className="replay-row"><strong>{t('桌宠大小','Pet size')}</strong><select disabled={pending} value={state?.size??'medium'} onChange={e=>void change('size',e.target.value)}>
        {([['small','小','Small'],['medium','中','Medium'],['large','大','Large']]).map(([id,zh,english])=><option value={id} key={id}>{t(zh,english)}</option>)}</select></div>
      {state?.enabled&&<div className="replay-row"><strong>{t('桌宠','Desktop pet')}</strong><Button disabled={pending} onClick={()=>void change('visibility')}>{state.visible?t('隐藏','Hide'):t('显示','Show')}</Button></div>}
      {state?.enabled&&!state.permission&&<div className="replay-row"><div><strong>{t('输入监控权限','Input Monitoring')}</strong><p>{t('允许后，小猫就能跟随其他应用中的按键。','Allow access so the cat can react while you type in other apps.')}</p></div><Button disabled={pending} onClick={()=>void change('permission')}>{t('允许输入监控','Allow Input Monitoring')}</Button></div>}
    </div>
    <div className="replay-controls buddy-gallery">
      <div className="replay-row buddy-gallery-title"><strong>{t('选择猫咪','Choose a cat')}</strong>
        <Button disabled={pending||editor} onClick={()=>{setEditor(true);setError('')}}><Camera size={15}/>{t('生成我家的猫','Create my cat')}</Button></div>
      <div className="buddy-cats">{choices.map(([id,zh,english])=><button key={id} type="button" className="buddy-cat"
        aria-pressed={(state?.preview??state?.cat)===id} disabled={pending}
        onClick={()=>{setEditor(false);void change('preview',id)}}>
        {portraits[id]&&<img src={portraits[id]} alt=""/>}<span>{t(zh,english)}{state?.cat===id&&<Check size={13} aria-label={t('正在使用','In use')}/>}</span>
      </button>)}</div>
      {state?.preview&&(!editor||state.preview==='draft')&&<div className="replay-row buddy-preview" aria-live="polite">
        <div>{state.preview==='draft'&&portraits.draft&&<img src={portraits.draft} alt=""/>}<strong>{t('桌面预览','Desktop preview')} · {label(state.preview)}</strong></div>
        <div className="replay-actions"><Button disabled={pending} onClick={()=>void change('dismiss')}>{t('取消','Cancel')}</Button>
          <Button disabled={pending} onClick={()=>void change('apply')}>{state.preview==='draft'?(state.hasCustom?t('替换并使用','Replace & use'):t('保存并使用','Save & use')):t('使用这只猫','Use this cat')}</Button></div>
      </div>}
      {editor&&<div className="buddy-editor">
        <div className="buddy-editor-title"><strong>{t('生成我家的猫','Create my cat')}</strong><Button onClick={()=>void change('dismiss')}>{t('关闭','Close')}</Button></div>
        <div className="replay-row"><div><strong>{state?.model||t('选择看图模型','Choose a vision model')}</strong>
          {state?.service&&<p>{state.service}</p>}</div><Button disabled={pending} onClick={onModels}>{t('模型设置','Model settings')}</Button></div>
        <div className="replay-row buddy-photo"><div>{state?.photo&&<img src={state.photo} alt={t('选中的照片','Selected photo')}/>}
          <span>{t('点击生成时，照片才会发给上面的模型。保存后可离线使用。','Generate sends the selected photo to the model above. Your saved cat works offline.')}</span></div>
          <Button disabled={pending} onClick={()=>void change('choosePhoto')}>{state?.photo?t('换一张照片','Change photo'):t('选择照片','Choose photo')}</Button></div>
        <div className="replay-row">{state?.modelScope&&!state.imageConfirmed&&<label className="buddy-confirm"><input type="checkbox" checked={!!visionOK}
          disabled={pending} onChange={e=>confirm(e.target.checked?state.modelScope:undefined)}/>{t('我已确认此模型支持图片','I confirm this model accepts images')}</label>}
          <Button disabled={pending||!state?.photo||!state.modelScope||!visionOK} onClick={()=>void change('generate')}>
            {busy==='generate'?t('正在生成…','Generating…'):state?.hasDraft?t('重新生成','Generate again'):t('生成','Generate')}</Button></div>
      </div>}
    </div>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
