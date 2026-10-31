import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,CircleAlert,X} from 'lucide-react';
import {t} from './i18n';
export function FeedbackToast({message,kind,onClose}:{message:string;kind:'success'|'error';onClose:()=>void}) {
  const [top,setTop]=useState(12);
  const [hovered,setHovered]=useState(false),[focused,setFocused]=useState(false),remaining=useRef(4000),close=useRef(onClose);
  close.current=onClose;
  useEffect(()=>{
    const place=()=>{const header=document.querySelector('.lab-page-header')?.getBoundingClientRect();setTop(innerWidth<=900&&header&&header.bottom>0?Math.max(12,Math.min(innerHeight-72,header.bottom+12)):12);};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[]);
  useEffect(()=>{
    if(kind==='error'||hovered||focused)return;
    const start=performance.now(),timer=window.setTimeout(()=>close.current(),remaining.current);
    return()=>{window.clearTimeout(timer);remaining.current=Math.max(0,remaining.current-(performance.now()-start));};
  },[hovered,focused,kind]);
  return createPortal(<div style={{top}} className={`toast overlay-toast ${kind}`} role={kind==='error'?'alert':'status'} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocus={()=>setFocused(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false);}}>
    {kind==='success'?<Check size={16}/>:<CircleAlert size={16}/>}<span title={t(message)}>{t(message)}</span><button onClick={onClose} aria-label={t('关闭提示')}><X size={16}/></button>
  </div>,document.body);
}
