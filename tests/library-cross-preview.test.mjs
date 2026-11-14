import test from 'node:test';
import assert from 'node:assert/strict';
import {createVMEnvironment,plain,walkAll,textOf} from './helpers/source-ui-vm.mjs';
import {airLayout} from '../shared/layout.mjs';
import * as appearance from '../shared/render-animation.mjs';
import * as triggers from '../shared/trigger.mjs';
import * as typing from '../shared/typing-cross.mjs';

const animation={effect:'static',direction:'right',speed:4,loop:true,frames:[]};
const preset=()=>({id:'typingCross',name:'一石二鸟',category:'pattern',description:'Fixture cross',
  colors:Array(84).fill('#ffffff'),animation:{...animation,colorOverride:'#80c040',brightness:50},
  trigger:{code:'Space',count:3,intervalMs:600,effect:'cross',color:'#ffffff',speed:4}});

async function fixture(catalog=[preset()],scenes=[]){
  const commands=[],loads=[],plays=[],frames=new Map(),listeners=new Set();let now=1000,nextFrame=1,prevented=0;
  const Keyboard='FixtureKeyboard';
  const env=createVMEnvironment({
    './i18n':{t:value=>value,useLanguage:()=> 'zh-CN',dateLocale:()=> 'zh-CN'},
    'lucide-react':new Proxy({},{get:(_target,key)=>'Icon:'+String(key)}),
    './api':{exportScenes(){throw Error('Unexpected export');}},
    './Keyboard':{Keyboard,lightingPeak:()=>255},
    './primitives':{Button:'Button',Empty:'Empty',Modal:'Modal',run:promise=>env.track(promise)},
    './presets':{presetCatalog:()=>catalog},
    './connection-copy-v7':{connectionCopy:pair=>pair?.zh??''},
    '../../shared/device-status.mjs':{lightingUnavailableMessage:()=>''},
    '../../shared/render-animation.mjs':appearance,
    '../../shared/trigger.mjs':triggers,
    '../../shared/typing-cross.mjs':typing,
  });
  env.window.performance={now:()=>now};
  env.window.requestAnimationFrame=callback=>{const id=nextFrame++;frames.set(id,callback);return id;};
  env.window.cancelAnimationFrame=id=>frames.delete(id);
  env.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  const add=env.window.addEventListener,remove=env.window.removeEventListener;
  env.window.addEventListener=(kind,callback)=>{if(kind==='keydown')listeners.add(callback);add(kind,callback);};
  env.window.removeEventListener=(kind,callback)=>{if(kind==='keydown')listeners.delete(callback);remove(kind,callback);};
  const Library=(await env.load(new URL('../ui/src/Library.tsx',import.meta.url))).exports.Library;
  const props={layout:airLayout,state:{device:{connected:true,capabilities:{perKey:true}},settings:{brightness:100},
    firmware:{compatible:true},scenes},command:async body=>commands.push(body),
  onLoad:value=>loads.push(value),onPlay:value=>plays.push(value),onNew(){},notify(){}};
  const library=env.mount(Library,props);
  const nodes=()=>walkAll(library.tree,()=>true);
  const article=id=>nodes().find(node=>node.type==='article'&&node.key===id);
  const previewNode=id=>walkAll(article(id),node=>typeof node.type==='function'&&node.type.name==='PresetKeyboard')[0];
  const first=previewNode(catalog[0].id),preview=env.mount(first.type,first.props);
  const updatePreview=()=>{library.render();const node=previewNode(catalog[0].id);preview.update(node.props);};
  const toggle=()=>{const button=walkAll(article(catalog[0].id),node=>node.props?.className==='lab-library-preview')[0];button.props.onClick();updatePreview();};
  const key=(code,{repeat=false,at=now}={})=>{now=at;env.window.dispatchEvent({type:'keydown',code,repeat,preventDefault(){prevented++;}});preview.render();};
  const frame=at=>{now=at;const work=[...frames.values()];frames.clear();for(const callback of work)callback(at);preview.render();};
  return{env,props,library,preview,nodes,article,toggle,key,frame,frames,listeners,commands,loads,plays,
    colors:()=>plain(preview.tree.props.colors),prevented:()=>prevented,
    unmount(){preview.unmount();library.unmount();}};
}

test('Library cross Eye waits for real keys, ignores repeats, layers independent waves and never writes hardware',async()=>{
  const f=await fixture();
  assert.deepEqual(f.colors(),typing.typingCrossThumbnail(airLayout,'#406020'));
  f.toggle();
  assert.ok(textOf(f.library.tree).includes('等待按键 · 每次按键产生独立光波'));
  assert.ok(f.colors().every(color=>color==='#000000'));
  assert.equal(f.frames.size,0,'waiting for keys must not start an automatic animation loop');
  assert.equal(f.listeners.size,1);
  f.frame(1000);assert.ok(f.colors().every(color=>color==='#000000'));
  const reference=new typing.TypingCross(airLayout);
  f.key('KeyA',{at:1000});reference.fire('KeyA',1000);
  f.frame(1030);assert.deepEqual(f.colors(),reference.render(1030,{color:'#406020',speed:4}));
  assert.ok(f.colors().some(color=>color!=='#000000'));
  f.key('KeyL',{at:1050});reference.fire('KeyL',1050);
  f.key('KeyL',{at:1060,repeat:true});f.key('MediaPlayPause',{at:1070});
  f.frame(1120);
  assert.deepEqual(f.colors(),reference.render(1120,{color:'#406020',speed:4}));
  const onlyLast=new typing.TypingCross(airLayout);onlyLast.fire('KeyL',1050);
  assert.notDeepEqual(f.colors(),onlyLast.render(1120,{color:'#406020',speed:4}),'the second press must retain the first wave tail');
  assert.equal(f.prevented(),0,'typing must retain its normal browser behavior');
  assert.deepEqual(f.commands,[]);assert.deepEqual(f.loads,[]);assert.deepEqual(f.plays,[]);
  f.frame(2000);assert.ok(f.colors().every(color=>color==='#000000'));assert.equal(f.frames.size,0);
  f.frame(3000);assert.ok(f.colors().every(color=>color==='#000000'));
  f.key('Space',{at:3000});assert.equal(f.frames.size,1,'a new key can start another independent wave');
  f.toggle();assert.equal(f.frames.size,0);assert.equal(f.listeners.size,0);
  assert.deepEqual(f.colors(),typing.typingCrossThumbnail(airLayout,'#406020'));
  f.key('KeyA',{at:3100});assert.equal(f.frames.size,0);
  f.unmount();
});

test('cross preview applies effective speed and removes pending frames/listeners on unmount',async()=>{
  const value=preset();value.trigger.speed=8;
  const f=await fixture([value]);f.toggle();f.key('Space',{at:1000});f.frame(1120);
  const reference=new typing.TypingCross(airLayout);reference.fire('Space',1000);
  assert.deepEqual(f.colors(),reference.render(1120,{color:'#406020',speed:8}));
  f.frame(1401);assert.ok(f.colors().every(color=>color==='#000000'));assert.equal(f.frames.size,0);
  f.key('KeyA',{at:1500});assert.equal(f.frames.size,1);
  f.unmount();assert.equal(f.frames.size,0);assert.equal(f.listeners.size,0);
});

test('saved cross thumbnails use the edited trigger colour, hue and artwork brightness instead of a fixed white canvas',async()=>{
  const saved={...preset(),id:'saved-red-cross',name:'My edited cross',
    animation:{...animation,hueShift:120,brightness:50},trigger:{...preset().trigger,color:'#ff0000'}};
  const f=await fixture([preset()],[saved]);
  f.nodes().find(node=>node.type==='button'&&textOf(node)==='我的作品').props.onClick();f.library.render();
  const keyboard=walkAll(f.article(saved.id),node=>node.type==='FixtureKeyboard')[0];
  assert.deepEqual(plain(keyboard.props.colors),typing.typingCrossThumbnail(airLayout,'#008000'));
  assert.ok(keyboard.props.colors.some(color=>color!=='#000000'));
  assert.ok(keyboard.props.colors.every(color=>/^#00[0-9a-f]{2}00$/.test(color)));
  assert.deepEqual(f.commands,[]);f.unmount();
});

test('ordinary preset Eye retains its existing automatic page-only animation',async()=>{
  const ordinary={...preset(),id:'ordinary',trigger:undefined,animation:{...animation,effect:'pulse'},colors:Array(84).fill('#ff0000')};
  const f=await fixture([ordinary]);f.toggle();
  assert.equal(f.listeners.size,0);assert.equal(f.frames.size,0);
  assert.equal(f.env.timers.size,1);assert.ok(f.colors().some(color=>color!=='#000000'));
  f.toggle();assert.equal(f.env.timers.size,0);assert.deepEqual(f.commands,[]);f.unmount();
});
