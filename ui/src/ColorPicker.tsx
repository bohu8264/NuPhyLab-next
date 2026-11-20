import {useCallback, useEffect, useRef, useState} from 'react';
import {Pipette, X} from 'lucide-react';
import {Button, Switch} from './primitives';
import {t, useLanguage} from './i18n';
import './color-picker.css';

type PickerState = {
  enabled: boolean;
  shortcutLabel?: string;
  sampling: boolean;
  needsAccess: boolean;
  issue?: string;
};
type PickerBridge = {postMessage:(body:Record<string,unknown>)=>Promise<PickerState>};
function bridge() {
  return (window as unknown as {webkit?:{messageHandlers?:{colorPicker?:PickerBridge}}}).webkit?.messageHandlers?.colorPicker;
}

export function ColorPicker({onPermissions}:{onPermissions:()=>void}) {
  const en=useLanguage()==='en';
  const [state,setState]=useState<PickerState|null>(null);
  const [error,setError]=useState(''), [pending,setPending]=useState('');
  const page=useRef(0), sequence=useRef(0), writing=useRef(false), recorderOpen=useRef(false);
  const send=useCallback((op:string,values:Record<string,unknown>={})=>{
    const host=bridge();
    if(!host) return Promise.reject(new Error(t('请在 Mac 应用中打开取色器。')));
    return host.postMessage({op,language:en?'en':'zh-CN',...values});
  },[en]);
  const refresh=useCallback(async()=>{
    if(writing.current)return;
    const ticket=++sequence.current, epoch=page.current;
    try {
      const value=await send('state');
      if(page.current===epoch && ticket===sequence.current) setState(value);
    } catch(reason) {
      if(page.current===epoch && ticket===sequence.current) setError(reason instanceof Error?reason.message:String(reason));
    }
  },[send]);
  useEffect(()=>{
    ++page.current;
    void refresh();
    const changed=()=>{void refresh();};
    window.addEventListener('nuphylab:color-picker',changed);
    return ()=>{
      ++page.current;
      window.removeEventListener('nuphylab:color-picker',changed);
      if(recorderOpen.current) void send('cancelRecording').catch(()=>{});
    };
  },[refresh,send]);

  async function act(op:string,values:Record<string,unknown>={}) {
    if(writing.current)return;
    const epoch=page.current;
    ++sequence.current;
    writing.current=true;
    recorderOpen.current=op==='record';
    setPending(op);
    setError('');
    try {
      const value=await send(op,values);
      if(page.current===epoch)setState(value);
    } catch(reason) {
      if(page.current===epoch)setError(reason instanceof Error?reason.message:String(reason));
    } finally {
      writing.current=false;
      recorderOpen.current=false;
      setPending('');
      void refresh();
    }
  }
  const disabled=!state || !!pending || state.sampling;
  const recording=pending==='record';
  return <section className="color-picker-page">
    <div className="color-picker-action">
      <p>{t('点选屏幕上的颜色，HEX 色号会复制到剪贴板。')}</p>
      <Button kind="primary" icon={<Pipette size={16}/>} disabled={disabled} onClick={()=>void act('pick')}>
        {state?.sampling?t('正在取色…'):t('开始取色')}
      </Button>
    </div>
    <div className="color-picker-shortcuts">
      <header><Switch voiceId="color-picker" label={t('全局快捷键')} checked={state?.enabled??false}
        disabled={disabled} onChange={enabled=>void act('enable',{enabled})}/></header>
      <div className="color-picker-binding">
        <div className="color-picker-binding-label">
          <strong>{t('取色快捷键')}</strong>
          <p aria-live="polite">{recording?t('按下并松开单键、组合键或鼠标侧键。'):t('点击键位可录制单键、组合键或鼠标侧键。')}</p>
        </div>
        <button type="button" className="color-picker-key" disabled={disabled}
          aria-label={state?.shortcutLabel?t('更改快捷键 ')+state.shortcutLabel:t('设置取色快捷键')} onClick={()=>void act('record')}>
          {recording?t('等待按键…'):state?.shortcutLabel||t('未设置')}
        </button>
        {recording?<Button kind="ghost" onClick={()=>void send('cancelRecording').catch(()=>{})}>{t('取消')}</Button>
          :state?.shortcutLabel&&<button type="button" className="color-picker-remove" disabled={disabled}
            aria-label={t('清除取色快捷键')} title={t('清除取色快捷键')} onClick={()=>void act('remove')}><X size={15}/></button>}
      </div>
    </div>
    {(error||state?.issue)&&<div className="color-picker-feedback" role="alert"><span>{error||state?.issue}</span>
      {state?.needsAccess&&<Button kind="ghost" onClick={onPermissions}>{t('查看权限')}</Button>}</div>}
  </section>;
}

