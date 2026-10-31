import { t as tr, language } from "./i18n";
import { createContext, useContext } from "react";
import type { CSSProperties } from "react";
import type { Key } from "./types";
import airGeometry from "./air-key-geometry.json";

export type AirTopRightModule = "rotary" | "keycap";
export const KeyboardModuleContext = createContext<AirTopRightModule>("rotary");
export function lightingPeak(frames: readonly (readonly string[])[]) {
  let peak = 1;
  for (const frame of frames) for (const color of frame)
    for (const start of [1, 3, 5]) peak = Math.max(peak, parseInt(color.slice(start, start + 2), 16) || 0);
  return peak;
}
// Display geometry follows the approved v5 drawing and the vendor's key matrix.
// These coordinates never alter key identities, RGB addresses or game geometry.
function visualKeys(layout: Key[]) {
  if (layout.length !== 80) return layout.map(key => ({...key, ...airGeometry[key.index]}));
  const rowCounts = new Map<number, number>();
  const corrected = layout.map(key => {
    const offset = rowCounts.get(key.y) || 0;
    rowCounts.set(key.y, offset + 1);
    return {...key, x: key.x + offset * .04};
  });
  const padX = (1009 - Math.max(...corrected.map(key => key.x + key.w)) * 55.2) / 2;
  const padY = (440 - Math.max(...corrected.map(key => key.y + 1)) * 55.2) / 2;
  return corrected.map(key => ({...key, x:padX+key.x*55.2+1.5, y:padY+key.y*55.2+1.5, w:key.w*55.2-3, h:52.2}));
}
export function Keyboard({layout, colors, selected=[], mini=false, onKey, onGameKey, onStrokeStart, sideColor, airTopRightModule}: {
  layout:Key[]; colors:string[]; selected?:number[]; mini?:boolean;
  lightPreview?:boolean; lightPreviewPeak?:number;
  onKey?:(index:number)=>void; onGameKey?:(index:number)=>void; onStrokeStart?:()=>void;
  sideColor?:string; airTopRightModule?:AirTopRightModule;
}) {
  const preference = useContext(KeyboardModuleContext);
  const module = airTopRightModule || preference;
  const kick=layout.length===80, width=kick?1009:959, height=kick?440:384;
  const colorAt=(index:number)=>colors[index] || "#000000";
  const positionStyle=({x,y,w,h}:Pick<Key,"x"|"y"|"w"|"h">):CSSProperties=>({left:`${x/width*100}%`,top:`${y/height*100}%`,width:`${w/width*100}%`,height:`${h/height*100}%`});
  const keyStyle=(key:Key):CSSProperties=>{
    const color=colorAt(key.index),lit=!/^#0{3}(0{3})?$/i.test(color);
    const [r,g,b]=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)||0);
    return {...positionStyle(key),"--key-color":lit?color:"#FCFCFC","--key-text":lit&&r*.299+g*.587+b*.114<128?"#ffffff":"#747474"} as CSSProperties;
  };
  const label=(key:Key)=>key.code==="PrintScreen"&&language()==="en"?"PrtSc":key.label==="⌘"?"Cmd":key.label==="⌫"?"Back":tr(key.label);
  const knob=kick||module==="rotary";
  // Kick's dial is not in the 80 RGB keys; Air's replaceable Del shares no known RGB slot.
  const modulePosition=kick?{x:916.688,y:44.032,w:52.2,h:52.2}:{x:881,y:22,w:53,h:50};
  return <div className={`keyboard-case v5-keyboard ${kick?"kick75":"air75-v3"} ${mini?"mini":""}`} data-module={kick?"rotary":module}>
    <div className="keyboard-matrix" style={{aspectRatio:`${width}/${height}`}}
      onPointerDown={event=>{
        if((onKey||onGameKey)&&event.button===0){
          const el=(event.target as HTMLElement).closest<HTMLElement>("[data-led]");
          if(el){event.preventDefault();if(onGameKey)onGameKey(Number(el.dataset.led));else{onStrokeStart?.();onKey?.(Number(el.dataset.led));}}
        }
      }}
      onPointerMove={event=>{if(event.buttons===1&&onKey){const el=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>("[data-led]");if(el&&event.currentTarget.contains(el))onKey(Number(el.dataset.led));}}}>
      {visualKeys(layout).map(key=>mini||(!onKey&&!onGameKey)?<div key={key.index} className="key" style={keyStyle(key)} role={mini?undefined:"img"} aria-label={mini?undefined:`${label(key)} ${colorAt(key.index)}`}><span>{mini?null:label(key)}</span></div>:<button type="button" key={key.index} data-led={key.index} className={`key ${selected.includes(key.index)?"selected":""}`} style={keyStyle(key)} aria-label={`${label(key)} ${colorAt(key.index)}`} title={`${label(key)} · ${colorAt(key.index).toUpperCase()}`}
        onKeyDown={event=>{if((event.key==="Enter"||event.key===" ")&&!event.repeat&&(onKey||onGameKey)){event.preventDefault();if(onGameKey)onGameKey(key.index);else{onStrokeStart?.();onKey?.(key.index);}}}}><span>{label(key)}</span></button>)}
      <div className={`key fixed-keycap ${knob?"rotary-knob":"module-del"}`} style={positionStyle(modulePosition)} role="img" aria-label={tr(knob?"旋钮":"Del 键帽")}><span>{knob?<i className="dial-slot"/>:mini?"":"Del"}</span></div>
      {!kick&&["left","right"].map(side=><div key={side} className={`side-led ${side} ${sideColor?"on":""}`} style={{top:`${34/height*100}%`,height:`${42/height*100}%`,backgroundColor:sideColor||"#CBCBCB"}}/>)}
    </div>
  </div>;
}
