// Actual TypeScript geometry hook in a source VM. No browser/service/native/HID.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,plain} from './helpers/source-ui-vm.mjs';

const source=new URL('../ui/src/useWorkspaceLayout.ts',import.meta.url);
const airRatio=959/384,kickRatio=1009/440;
const baseline={viewportWidth:1121,viewportHeight:723,documentTop:204,gridWidth:881,chromeHeight:88,auxiliaryHeight:112,aspectRatio:airRatio};
const pure=async()=>{const env=createVMEnvironment();return (await env.load(source)).exports.fitWorkspace;};

async function fixture(overrides={}) {
  const env=createVMEnvironment(),raf=new Map(),observers=[],mutations=[],navigation=[];
  const geometry={...baseline,scrollY:0,keyboardHeight:253,headerTop:144,headerHeight:54,keyboardTop:292,...overrides};
  let nextFrame=1,result;
  Object.assign(env.window,{innerWidth:geometry.viewportWidth,innerHeight:geometry.viewportHeight,scrollY:geometry.scrollY,
    requestAnimationFrame:fn=>{const id=nextFrame++;raf.set(id,fn);return id;},cancelAnimationFrame:id=>raf.delete(id),
    matchMedia:()=>({matches:Boolean(geometry.reduceMotion)}),
    ResizeObserver:class {constructor(fn){this.fn=fn;this.nodes=new Set();this.live=true;observers.push(this);}observe(node){this.nodes.add(node);}disconnect(){this.live=false;this.nodes.clear();}},
    MutationObserver:class {constructor(fn){this.fn=fn;this.live=true;mutations.push(this);}observe(){}disconnect(){this.live=false;}},
  });
  const node=(name,read)=>({nodeType:1,name,parentElement:null,children:[],getBoundingClientRect:()=>read(),
    closest:selector=>selector==='main'?main:selector==='.page-content'?page:null,
    hasAttribute:()=>false,scrollIntoView:options=>navigation.push({method:'scrollIntoView',options:plain(options)}),focus:options=>navigation.push({method:'focus',options:plain(options)})});
  const main=node('main',()=>({height:1000})),page=node('page',()=>({height:1000})),section=node('section',()=>({height:1000}));
  main.children=[page];page.children=[section];
  const grid=node('grid',()=>({top:geometry.documentTop-env.window.scrollY,width:geometry.gridWidth}));grid.parentElement=section;
  const keyboard=node('keyboard',()=>({top:geometry.keyboardTop-env.window.scrollY,bottom:geometry.keyboardTop-env.window.scrollY+geometry.keyboardHeight,height:geometry.keyboardHeight}));
  const stage=node('stage',()=>({height:geometry.chromeHeight+geometry.keyboardHeight}));
  const auxiliary=node('auxiliary',()=>({height:geometry.auxiliaryHeight}));
  const header=node('header',()=>({top:geometry.headerTop,bottom:geometry.headerTop+geometry.headerHeight,height:geometry.headerHeight}));
  section.children=[header,grid];
  const loaded=await env.load(source);
  const instance=env.mount(props=>{
    result=loaded.exports.useWorkspaceLayout({aspectRatio:geometry.aspectRatio,enabled:props.enabled});
    if(!props.missingRefs){result.gridRef.current=grid;result.stageRef.current=stage;result.keyboardRef.current=keyboard;result.auxiliaryRef.current=auxiliary;result.headerRef.current=header;}
    return result;
  },{enabled:overrides.enabled??true,missingRefs:overrides.missingRefs??false});
  const flush=()=>{let count=0;while(raf.size){if(++count>10)throw new Error('Unbounded layout RAF');const pending=[...raf];raf.clear();for(const [,fn]of pending)fn();instance.render();}return result;};
  const resize=()=>{for(const observer of observers)if(observer.live)observer.fn([]);return flush();};
  const mutation=(target=section,addedNodes=[],removedNodes=[])=>{for(const observer of mutations)if(observer.live)observer.fn([{target,addedNodes,removedNodes}]);return flush();};
  return {env,geometry,instance,raf,observers,mutations,navigation,grid,keyboard,stage,header,section,
    result:()=>result,flush,resize,mutation,sha256:loaded.sha256};
}

test('1121×723 contains the complete Air and Kick keyboard plus measured auxiliary content',async()=>{
  const fit=await pure();
  for(const aspectRatio of [airRatio,kickRatio]){
    const value=fit({...baseline,aspectRatio});assert.equal(value.mode,'split');
    assert.ok(value.keyboardWidth<=633);assert.ok(value.keyboardHeight+200<=487);
    assert.ok(Math.abs(value.keyboardWidth/value.keyboardHeight-aspectRatio)<1e-9);
  }
});
test('1080×720 may split; 1080×640 and 720×520 always flow',async()=>{
  const fit=await pure();
  assert.equal(fit({...baseline,viewportWidth:1080,viewportHeight:720,gridWidth:840}).mode,'split');
  for(const [viewportWidth,viewportHeight]of [[1080,640],[720,520]])assert.equal(fit({...baseline,viewportWidth,viewportHeight}).mode,'flow');
});
test('measured width, workspace height and keyboard/auxiliary budget independently protect flow',async()=>{
  const fit=await pure();
  assert.equal(fit({...baseline,gridWidth:807}).mode,'flow');
  assert.equal(fit({...baseline,documentTop:252}).mode,'flow');
  assert.equal(fit({...baseline,auxiliaryHeight:230}).mode,'flow');
  assert.equal(fit({...baseline,chromeHeight:300}).mode,'flow');
});
test('height-constrained contain shrinks width while preserving the real model ratio',async()=>{
  const fit=await pure(),value=fit({...baseline,gridWidth:1100,auxiliaryHeight:160});
  assert.equal(value.mode,'split');assert.ok(value.keyboardWidth<852);
  assert.ok(value.keyboardHeight<=239);assert.ok(value.keyboardHeight+248<=487);
});
test('invalid / missing geometry gives finite safe flow values',async()=>{
  const fit=await pure();
  for(const patch of [{aspectRatio:0},{viewportWidth:NaN},{documentTop:Infinity}]){
    const value=fit({...baseline,...patch});assert.equal(value.mode,'flow');
    for(const key of ['availableHeight','keyboardWidth','keyboardHeight'])assert.ok(Number.isFinite(value[key]));
  }
});
test('actual hook measures document top; scrolling main or inspector cannot expand its cap',async()=>{
  const h=await fixture();h.flush();assert.equal(h.result().mode,'split');const original=h.result().availableHeight;
  h.env.window.scrollY=180;h.env.document.dispatchEvent({type:'scroll'});h.flush();assert.equal(h.result().availableHeight,original);
  h.env.document.dispatchEvent({type:'scroll'});h.flush();assert.equal(h.result().availableHeight,original);
  assert.equal(h.env.timers.size,0);
});
test('dynamic notice and auxiliary growth fall back; content mutation allows recovery',async()=>{
  const h=await fixture();h.flush();assert.equal(h.result().mode,'split');
  h.geometry.documentTop+=90;h.mutation();assert.equal(h.result().mode,'flow');
  h.geometry.documentTop-=90;h.mutation();assert.equal(h.result().mode,'split');
  h.geometry.auxiliaryHeight=300;h.resize();assert.equal(h.result().mode,'flow');
  h.geometry.auxiliaryHeight=112;h.mutation();assert.equal(h.result().mode,'split');
});
test('split-induced wrap fails safely without split/flow oscillation until a meaningful change',async()=>{
  const h=await fixture();h.flush();assert.equal(h.result().mode,'split');
  h.geometry.chromeHeight=320;h.resize();assert.equal(h.result().mode,'flow');
  h.geometry.chromeHeight=88;h.resize();assert.equal(h.result().mode,'flow');
  h.env.document.dispatchEvent({type:'scroll'});h.flush();assert.equal(h.result().mode,'flow');
  h.env.window.dispatchEvent({type:'resize'});h.flush();assert.equal(h.result().mode,'split');
});
test('flow return link appears when preview has scrolled above sticky work actions',async()=>{
  const h=await fixture({viewportWidth:720,viewportHeight:520,gridWidth:480,headerTop:0});
  h.flush();assert.equal(h.result().previewAway,false);
  h.env.window.scrollY=600;h.env.document.dispatchEvent({type:'scroll'});h.flush();assert.equal(h.result().previewAway,true);
  h.env.window.scrollY=0;h.env.document.dispatchEvent({type:'scroll'});h.flush();assert.equal(h.result().previewAway,false);
});
test('initial preview below the viewport does not show an upward return link',async()=>{
  const h=await fixture({viewportWidth:720,viewportHeight:520,keyboardTop:900});h.flush();assert.equal(h.result().previewAway,false);
});
test('initial flow already scrolled to a pending error shows return without a previous visible measurement',async()=>{
  const h=await fixture({documentTop:300,keyboardTop:360,keyboardHeight:346,scrollY:817,headerTop:0});
  h.flush();assert.equal(h.result().mode,'flow');assert.equal(h.result().previewAway,true);
  assert.deepEqual(h.navigation,[]);assert.equal(h.env.timers.size,0);
});
test('initial zero-height preview does not flash return; measured nonzero offscreen preview then enables it',async()=>{
  const h=await fixture({documentTop:300,keyboardTop:360,keyboardHeight:0,scrollY:817,headerTop:0});
  h.flush();assert.equal(h.result().mode,'flow');assert.equal(h.result().previewAway,false);
  h.geometry.keyboardHeight=346;h.resize();assert.equal(h.result().previewAway,true);
  assert.deepEqual(h.navigation,[]);assert.equal(h.env.timers.size,0);
});
test('navigation is scroll/focus only; RM changes smooth to immediate without writing artwork/output',async()=>{
  const h=await fixture();h.flush();
  h.result().returnToKeyboard();h.geometry.reduceMotion=true;h.result().returnToKeyboard();
  assert.deepEqual(h.navigation,[
    {method:'scrollIntoView',options:{block:'start',behavior:'smooth'}},{method:'focus',options:{preventScroll:true}},
    {method:'scrollIntoView',options:{block:'start',behavior:'auto'}},{method:'focus',options:{preventScroll:true}},
  ]);assert.equal(h.env.storage.size,0);assert.equal(h.env.timers.size,0);
});
test('only actual user navigation can focus; resize / notices / media-independent measurements never focus',async()=>{
  const h=await fixture();h.flush();h.resize();h.mutation();h.env.window.dispatchEvent({type:'resize'});h.flush();
  assert.deepEqual(h.navigation,[]);assert.deepEqual(h.env.asyncErrors,[]);
});
test('unmount cancels pending RAF and disconnects observers/listeners',async()=>{
  const h=await fixture();assert.equal(h.raf.size,1);h.instance.unmount();assert.equal(h.raf.size,0);
  assert.ok(h.observers.every(observer=>!observer.live));assert.ok(h.mutations.every(observer=>!observer.live));
  h.env.window.dispatchEvent({type:'resize'});h.env.document.dispatchEvent({type:'scroll'});assert.equal(h.raf.size,0);
});
test('game / missing-ref boundaries create no observers or RAF',async()=>{
  for(const overrides of [{enabled:false},{missingRefs:true}]){
    const h=await fixture(overrides);assert.equal(h.raf.size,0);assert.equal(h.observers.length,0);assert.equal(h.result().mode,'flow');
  }
});
