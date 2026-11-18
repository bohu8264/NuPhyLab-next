import {useLayoutEffect,useRef,useState} from 'react';
import type {CSSProperties} from 'react';

// Read-only previews can shrink below the interactive editor's key-size limit.
// Measure their document position so scrolling never makes the keyboard grow.
export function useAgentPreviewFit(aspectRatio:number) {
  const ref=useRef<HTMLDivElement>(null);
  const [maxWidth,setMaxWidth]=useState<number|null>(null);
  useLayoutEffect(()=>{
    const root=ref.current;
    if(!root)return;
    let frame=0,disposed=false;
    const measure=()=>{
      frame=0;
      if(disposed)return;
      const keyboard=root.querySelector<HTMLElement>('.keyboard-viewport');
      if(!keyboard)return;
      let top=keyboard.getBoundingClientRect().top+window.scrollY;
      for(let parent=keyboard.parentElement;parent&&parent!==document.body&&parent!==document.documentElement;parent=parent.parentElement)top+=parent.scrollTop;
      const height=Math.max(100,window.innerHeight-top-24);
      const next=Math.floor((height-8)*aspectRatio+8);
      setMaxWidth(old=>old===next?old:next);
    };
    const schedule=()=>{if(!disposed&&!frame)frame=requestAnimationFrame(measure);};
    const resize=new ResizeObserver(schedule);
    const observe=()=>{
      resize.observe(root);
      const main=root.closest('main');
      if(main){resize.observe(main);main.querySelectorAll('.lab-page-header,.agent-tabbar,.agent-light-controls,.agent-light-heading,.agent-live-status,.agent-side-page>header,.agent-side-status,.agent-feedback-v6').forEach(node=>resize.observe(node));}
    };
    const mutation=new MutationObserver(records=>{
      if(records.some(record=>!(record.target instanceof Element?record.target:record.target.parentElement)?.closest('.keyboard-case'))){observe();schedule();}
    });
    observe();
    mutation.observe(root.closest('.agent-v5')??root,{subtree:true,childList:true,characterData:true});
    window.addEventListener('resize',schedule);
    document.fonts?.addEventListener('loadingdone',schedule);
    measure();
    return()=>{disposed=true;cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();window.removeEventListener('resize',schedule);document.fonts?.removeEventListener('loadingdone',schedule);};
  },[aspectRatio]);
  return {ref,style:{'--agent-preview-max-width':maxWidth===null?'100%':`${maxWidth}px`} as CSSProperties};
}
