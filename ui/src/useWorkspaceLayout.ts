import {useCallback,useEffect,useRef,useState} from "react";
import type {CSSProperties} from "react";

export type WorkspaceMeasure = {
  viewportWidth:number; viewportHeight:number; documentTop:number; gridWidth:number;
  chromeHeight:number; auxiliaryHeight:number; aspectRatio:number;
};
export function fitWorkspace(value:WorkspaceMeasure) {
  if(!Object.values(value).every(Number.isFinite)||value.aspectRatio<=0)
    return {mode:"flow" as const,availableHeight:0,keyboardWidth:0,keyboardHeight:0};
  const availableHeight=Math.max(0,Math.floor(value.viewportHeight-value.documentTop-32));
  const columnWidth=Math.max(0,value.gridWidth-224-24);
  const remainingHeight=Math.max(0,availableHeight-Math.ceil(value.chromeHeight+value.auxiliaryHeight));
  const keyboardWidth=Math.floor(Math.min(columnWidth,remainingHeight*value.aspectRatio)*100)/100;
  const keyboardHeight=keyboardWidth/value.aspectRatio;
  const split=value.viewportWidth>=1080&&value.viewportHeight>=680
    &&columnWidth>=560&&availableHeight>=440&&keyboardWidth>=560&&keyboardHeight>=200;
  return {mode:split?"split" as const:"flow" as const,availableHeight,keyboardWidth,keyboardHeight};
}

// Read-only local geometry. No draft, settings, playback or output dependencies.
export function useWorkspaceLayout({aspectRatio,enabled=true}:{aspectRatio:number;enabled?:boolean}) {
  const gridRef=useRef<HTMLDivElement>(null),stageRef=useRef<HTMLDivElement>(null);
  const keyboardRef=useRef<HTMLDivElement>(null),auxiliaryRef=useRef<HTMLDivElement>(null);
  const headerRef=useRef<HTMLElement>(null);
  const [layout,setLayout]=useState({mode:"flow" as "split"|"flow",availableHeight:0,keyboardWidth:0,headerHeight:54,previewAway:false});
  const current=useRef(layout);current.current=layout;
  useEffect(()=>{
    const grid=gridRef.current,stage=stageRef.current,keyboard=keyboardRef.current,auxiliary=auxiliaryRef.current;
    if(!enabled||!grid||!stage||!keyboard||!auxiliary)return;
    let frame=0,disposed=false,rejectedEnvironment="";
    const containers=[grid.parentElement,grid.closest('.page-content'),grid.closest('main')].filter(Boolean) as HTMLElement[];
    const measure=()=>{
      frame=0;if(disposed)return;
      const gridRect=grid.getBoundingClientRect(),stageRect=stage.getBoundingClientRect(),keyboardRect=keyboard.getBoundingClientRect();
      const header=headerRef.current?.getBoundingClientRect(),headerHeight=header?.height??54;
      // Absolute document reference: scrolling either pane must not change its cap.
      const documentTop=gridRect.top+window.scrollY;
      const input={viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,documentTop,gridWidth:gridRect.width,
        chromeHeight:Math.max(0,stageRect.height-keyboardRect.height),auxiliaryHeight:auxiliary.getBoundingClientRect().height,aspectRatio};
      const fit=fitWorkspace(input);
      const environment=[input.viewportWidth,input.viewportHeight,Math.round(input.gridWidth),aspectRatio].join(':');
      if(current.current.mode==='split'&&fit.mode==='flow')rejectedEnvironment=environment;
      // A split can wrap tools more than flow. Do not oscillate between both
      // widths; a real resize/content change may try again with fresh geometry.
      const mode:"split"|"flow"=fit.mode==='split'&&rejectedEnvironment!==environment?'split':'flow';
      const visibleTop=header&&header.top<=0?Math.max(0,header.bottom):0;
      const next={mode,availableHeight:fit.availableHeight,keyboardWidth:fit.keyboardWidth,
        headerHeight:Math.ceil(headerHeight),previewAway:mode==='flow'&&keyboardRect.height>0&&keyboardRect.bottom<=visibleTop};
      setLayout(old=>Object.keys(next).every(key=>old[key as keyof typeof old]===next[key as keyof typeof next])?old:next);
    };
    const schedule=()=>{if(!disposed&&!frame)frame=window.requestAnimationFrame(measure);};
    const refresh=()=>{rejectedEnvironment="";schedule();};
    const resize=typeof window.ResizeObserver==='function'?new window.ResizeObserver(schedule):null;
    const observe=()=>{
      [grid,stage,keyboard,auxiliary,headerRef.current].forEach(node=>{if(node)resize?.observe(node);});
      containers.forEach(parent=>{resize?.observe(parent);Array.from(parent.children).forEach(node=>resize?.observe(node));});
    };
    const mutation=typeof window.MutationObserver==='function'?new window.MutationObserver(records=>{
      const changed=records.some(record=>{
        const node=(record.target.nodeType===1?record.target:record.target.parentElement) as Element|null;
        if(node?.closest?.('.keyboard-case,[data-workspace-navigation]'))return false;
        const children=[...Array.from(record.addedNodes),...Array.from(record.removedNodes)];
        if(children.length&&children.every(child=>child.nodeType===1&&(child as Element).hasAttribute('data-workspace-navigation')))return false;
        return true;
      });
      if(changed){observe();refresh();}
    }):null;
    observe();
    mutation?.observe(grid.closest('main')??grid,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['open','lang','class']});
    mutation?.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
    window.addEventListener('resize',refresh);document.addEventListener('scroll',schedule,true);
    document.fonts?.addEventListener('loadingdone',refresh);schedule();
    return()=>{disposed=true;window.cancelAnimationFrame(frame);resize?.disconnect();mutation?.disconnect();
      window.removeEventListener('resize',refresh);document.removeEventListener('scroll',schedule,true);document.fonts?.removeEventListener('loadingdone',refresh);};
  },[aspectRatio,enabled]);
  const returnToKeyboard=useCallback(()=>{
    const stage=stageRef.current;if(!stage)return;
    stage.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    stage.focus({preventScroll:true});
  },[]);
  const style={"--workspace-available-height":`${layout.availableHeight}px`,"--workspace-keyboard-width":`${layout.keyboardWidth}px`,
    "--workspace-header-height":`${layout.headerHeight}px`} as CSSProperties;
  return {...layout,style,gridRef,stageRef,keyboardRef,auxiliaryRef,headerRef,returnToKeyboard};
}
