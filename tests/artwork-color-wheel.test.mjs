import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from '../ui/node_modules/typescript/lib/typescript.js';
import {blank,airLayout,kickLayout} from '../shared/layout.mjs';
import * as appearance from '../shared/render-animation.mjs';
import * as color from '../shared/color.mjs';
import {Store,validateAnimation} from '../server/storage.mjs';
import {appDraftFixture,scene} from './helpers/app-draft-fixture.mjs';
import {fakeService} from './helpers/fake-service.mjs';

const {applyArtworkAppearance,renderAnimation,animationDuration,scaleColor}=appearance;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const raw=()=>{const colors=blank();colors[31]='#ff0000';colors[32]='#123456';return colors;};
const baseAnimation={effect:'static',direction:'right',speed:4,loop:true};

test('circle-selected RGB replaces only lit source pixels and restores legacy hue without baking the palette',()=>{
  const colors=freeze(raw()),original=applyArtworkAppearance(colors,{hueShift:120});
  const animation=freeze({...baseAnimation,hueShift:120,colorOverride:'#12ABcD'});
  const selected=applyArtworkAppearance(colors,animation);
  assert.equal(selected[31],'#12abcd');assert.equal(selected[32],'#12abcd');assert.equal(selected[30],'#000000');
  assert.deepEqual(renderAnimation(colors,animation,0),selected);
  assert.deepEqual(applyArtworkAppearance(colors,{...animation,colorOverride:undefined}),original);
  assert.equal(animation.hueShift,120);assert.deepEqual(colors,raw());
  assert.equal(Object.hasOwn(validateAnimation({}),'colorOverride'),false);
});

test('selected colour retains pulse envelope, movement destination and artwork brightness exactly once',()=>{
  const colors=freeze(raw()),pulse={...baseAnimation,effect:'pulse',speed:2,colorOverride:'#80c040',brightness:50,hueShift:111};
  const low=renderAnimation(colors,pulse,0),high=renderAnimation(colors,pulse,Math.PI/1.8*1000);
  assert.equal(low[31],scaleColor(scaleColor('#80c040',.12),.5));assert.equal(high[31],'#406020');assert.notDeepEqual(low,high);
  assert.equal(low[30],'#000000');assert.equal(high[30],'#000000');
  const moved=renderAnimation(colors,{...pulse,effect:'move',speed:1},1000);
  assert.equal(moved[31],'#000000');assert.equal(moved[32],'#406020');assert.equal(moved[33],'#406020');
  assert.equal(animationDuration(pulse),animationDuration({...pulse,colorOverride:undefined}));assert.deepEqual(colors,raw());
});

test('frame selection and timing remain intact while every active frame receives selected RGB',()=>{
  const first=raw(),last=blank();last[12]='#00aa88';
  const animation=freeze({...baseAnimation,effect:'frames',loop:false,speed:8,colorOverride:'#2080f0',brightness:50,
    frames:[{colors:first,duration:100},{colors:last,duration:200}]});
  assert.equal(renderAnimation(first,animation,49.9)[31],'#104078');assert.equal(renderAnimation(first,animation,49.9)[12],'#000000');
  assert.equal(renderAnimation(first,animation,50)[12],'#104078');assert.equal(renderAnimation(first,animation,9999)[31],'#000000');
  assert.equal(animationDuration(animation),150);assert.deepEqual(animation.frames[0].colors,raw());assert.equal(animation.frames[1].colors[12],'#00aa88');
});

test('a selected-colour wave stays animated and respects source mask for Air and Kick layouts',()=>{
  const colors=freeze(raw()),animation={...baseAnimation,effect:'wave',colorOverride:'#e04020'};
  for(const layout of[airLayout,kickLayout]){
    const first=renderAnimation(colors,animation,0,layout),next=renderAnimation(colors,animation,1500,layout);
    assert.notDeepEqual(first,next);assert.equal(first[0],'#000000');assert.ok(first[31]!=='#000000');
    assert.deepEqual(first.map((c,i)=>c!=='#000000'?i:null).filter(i=>i!==null),[31,32]);
    assert.ok(first.slice(80).every(c=>c==='#000000'));
  }
  const legacy=renderAnimation(colors,{...baseAnimation,effect:'wave'},173);
  assert.deepEqual(renderAnimation(colors,{...baseAnimation,effect:'wave',colorOverride:undefined},173),legacy);
  assert.ok(legacy[0]!=='#000000','legacy rainbow wave keeps its original whole-board behavior');
});

test('selected black and zero brightness keep the pattern off without erasing the recoverable source',()=>{
  const colors=freeze(raw());
  for(const effect of['static','pulse','move','wave','frames']){
    const animation={...baseAnimation,effect,colorOverride:'#000000',frames:[{colors,duration:300}]};
    assert.ok(renderAnimation(colors,animation,700).every(c=>c==='#000000'));
    assert.ok(renderAnimation(colors,{...animation,colorOverride:'#123456',brightness:0},700).every(c=>c==='#000000'));
  }
  assert.deepEqual(colors,raw());
});

test('selected colour survives save, reopen and JSON import and can be removed without changing source frames',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-colour-wheel-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=await new Store(dir).load(),colors=raw(),frames=[{colors:[...colors],duration:500}];
  const saved=await store.saveScene({name:'Selected colour',colors,animation:{...baseAnimation,effect:'frames',frames,hueShift:37,colorOverride:'#aBcDeF',brightness:42}});
  const reopened=await new Store(dir).load(),restored=reopened.data.scenes[0];
  assert.equal(restored.animation.colorOverride,'#abcdef');assert.equal(restored.animation.hueShift,37);assert.deepEqual(restored.colors,colors);assert.deepEqual(restored.animation.frames,frames);
  await reopened.importScenes(JSON.parse(JSON.stringify([saved])));const imported=reopened.data.scenes.at(-1);assert.equal(imported.animation.colorOverride,'#abcdef');
  await reopened.saveScene({...restored,animation:{...restored.animation,colorOverride:undefined}});
  const reset=(await new Store(dir).load()).data.scenes.find(s=>s.id===restored.id);
  assert.equal(Object.hasOwn(reset.animation,'colorOverride'),false);assert.equal(reset.animation.hueShift,37);assert.deepEqual(reset.colors,colors);assert.deepEqual(reset.animation.frames,frames);
});

test('invalid selected colour never renders or partially saves/imports a library',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-invalid-colour-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=await new Store(dir).load();await store.saveScene({name:'Keep',colors:raw()});const bytes=await readFile(store.file,'utf8');
  for(const colorOverride of[null,true,12,'#abc','blue','#12345z','123456',{},[]]){
    assert.throws(()=>validateAnimation({colorOverride}),/整体颜色/);assert.throws(()=>applyArtworkAppearance(raw(),{colorOverride}),RangeError);
    assert.throws(()=>renderAnimation(raw(),{...baseAnimation,colorOverride},0),RangeError);
    await assert.rejects(store.saveScene({name:'Invalid',colors:raw(),animation:{colorOverride}}));
    await assert.rejects(store.importScenes([{name:'Valid',colors:raw(),animation:{colorOverride:'#123456'}},{name:'Invalid',colors:raw(),animation:{colorOverride}}]));
    assert.equal(await readFile(store.file,'utf8'),bytes);
  }
});

test('actual App marks a colour-only edit dirty and protects it through library navigation',async()=>{
  const saved=scene('Saved',{id:'saved-fixture',colors:raw(),animation:{...baseAnimation,hueShift:31}});
  const f=await appDraftFixture({draft:saved,state:{settings:{language:'zh-CN'},device:{connected:true,armed:true,modelId:'air75-v3'},playback:{mode:'static'},scenes:[saved]}});
  await f.edit({animation:{...saved.animation,colorOverride:'#12abcd'}});await f.click('作品库');f.child('Library').props.onLoad(scene('Other'));await f.flush();
  assert.equal(f.modal()?.props.title,'当前草稿有未保存修改');assert.equal(f.draft().animation.colorOverride,'#12abcd');assert.equal(f.commands.length,0);
  assert.equal(f.parseDraftRecord(JSON.stringify(f.draft())).animation.colorOverride,'#12abcd');
  for(const value of[null,'#abc',123])assert.throws(()=>f.parseDraftRecord(JSON.stringify({...saved,animation:{...saved.animation,colorOverride:value}})));
  await f.click('取消');assert.equal(f.draft().animation.hueShift,31);f.unmount();
});

test('actual service plays and saves selected colour without replacing raw artwork or globally changing brightness',async t=>{
  const f=await fakeService(t),colors=raw(),animation={...baseAnimation,colorOverride:'#20c080',hueShift:120,brightness:50};
  const ok=async body=>{const result=await f.command(body);assert.equal(result.ok,true,JSON.stringify(result));return result.result;};
  await ok({op:'settings',settings:{brightness:100,codexEnabled:false,quotaSideEnabled:false}});
  await ok({op:'play',colors,animation});let state=await f.state();assert.equal(state.colors[31],'#106040');assert.equal(state.colors[0],'#000000');
  const result=await ok({op:'saveScene',scene:{name:'Service colour',colors,animation}});assert.deepEqual(result.savedScene.colors,colors);assert.equal(result.savedScene.animation.colorOverride,'#20c080');assert.equal(result.savedScene.animation.hueShift,120);
  await ok({op:'play',colors,animation:{...animation,colorOverride:undefined}});state=await f.state();assert.equal(state.colors[31],'#008000');assert.equal(state.settings.brightness,100);
});

// Execute the production palette and circle handlers with controlled hooks and
// JSX. This exercises pointer/keyboard selection and restore wiring; no DOM,
// CSS engine, native host, service or real hardware is started by this fixture.
async function paletteFixture(initial){
  const components=new Map(),component=name=>{if(!components.has(name)){const f=function Child(){};f.displayName=name;components.set(name,f);}return components.get(name);};
  let draft=structuredClone(initial),tree;const memory={current:null};
  const react={useRef:()=>memory,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useEffect:fn=>fn(),useId:()=> 'fixture-value'};
  const jsx=(type,props,key)=>({type,props:props??{},key});
  const require=name=>{
    if(name==='react')return react;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:Symbol.for('fixture.Fragment')};
    if(name.endsWith('.css'))return{};if(name==='lucide-react')return new Proxy({},{get:(_t,key)=>component(String(key))});
    if(name==='./i18n')return{t:v=>v};if(name==='./rangeStyle')return{rangeStyle:()=>({})};
    if(name==='../../shared/render-animation.mjs')return appearance;if(name==='../../shared/color.mjs')return color;
    if(name==='./presets')return{DEFAULT_COLOR:'#d07d74'};if(name==='./ColorWheel')return{ColorWheel:component('ColorWheel')};
    if(name==='./primitives')return{Button:component('Button'),Switch:component('Switch'),run:p=>p};
    return new Proxy({},{get:(_t,key)=>component(String(key))});
  };
  const compile=source=>{const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require,Math,Number,Object,Array,String,Boolean,JSON});return exports;};
  const source=await readFile(new URL('../ui/src/Studio.tsx',import.meta.url),'utf8');
  const {TestPalette,TestSignature,TestPageRenderer}=compile(source+'\nexport const TestPalette=AnimationPalette;export const TestSignature=animationContent;export const TestPageRenderer=renderPageAnimation;');
  const walk=(node,out=[])=>{if(Array.isArray(node))node.forEach(n=>walk(n,out));else if(node&&typeof node==='object'&&'type'in node){out.push(node);walk(node.props.children,out);}return out;};
  const text=node=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node.props?.children);
  const render=()=>tree=TestPalette({draft,setAnimation:patch=>{draft={...draft,animation:{...draft.animation,...patch}};}});
  const wheel=()=>walk(tree).find(node=>node.type===components.get('ColorWheel'));
  render();return{render,wheel,walk,text,TestSignature,TestPageRenderer,get draft(){return draft;},get tree(){return tree;},compile,react};
}

test('production palette uses the circle, remembers chosen colour and resets to the saved original hue',async()=>{
  const f=await paletteFixture({name:'Circle',colors:raw(),animation:{...baseAnimation,hueShift:120,brightness:30}}),original=JSON.stringify(f.draft.colors);
  assert.equal(f.wheel().props.color.toLowerCase(),'#00ff00');assert.equal(f.walk(f.tree).some(n=>n.props['aria-label']==='色相偏移'),false);
  const signature=f.TestSignature(f.draft);f.wheel().props.onChange('#ABCDEF');f.render();assert.equal(f.draft.animation.colorOverride,'#abcdef');assert.notEqual(f.TestSignature(f.draft),signature);
  assert.equal(f.wheel().props.color,'#abcdef');assert.equal(f.draft.animation.hueShift,120);assert.equal(f.draft.animation.brightness,30);assert.equal(JSON.stringify(f.draft.colors),original);
  const reset=f.walk(f.tree).find(n=>f.text(n)==='还原配色'&&n.props.onClick);assert.ok(reset);reset.props.onClick();f.render();assert.equal(f.draft.animation.colorOverride,undefined);assert.equal(f.wheel().props.color.toLowerCase(),'#00ff00');
  for(const layout of[airLayout,kickLayout])assert.deepEqual(f.TestPageRenderer(f.draft.colors,{...f.draft.animation,colorOverride:'#123456',effect:'wave'},900,layout),renderAnimation(f.draft.colors,{...f.draft.animation,colorOverride:'#123456',effect:'wave'},900,layout));
});

test('production circle pointer and keyboard handlers select real saturation and keep a visible marker',async()=>{
  const f=await paletteFixture({name:'Pointer',colors:raw(),animation:{...baseAnimation}});
  const {ColorWheel}=f.compile(await readFile(new URL('../ui/src/ColorWheel.tsx',import.meta.url),'utf8'));
  // Each render's hook objects are independent; the actual component receives
  // its HSV memory through the production palette's ref.
  f.react.useRef=initial=>({current:initial});
  const render=()=>ColorWheel(f.wheel().props),nodes=tree=>f.walk(tree),disc=tree=>nodes(tree).find(n=>n.props.role==='slider');
  let tree=render(),capture=null;const target={getBoundingClientRect:()=>({left:0,top:0,width:120,height:120}),focus(){},setPointerCapture(id){capture=id;},releasePointerCapture(){capture=null;}};
  const event=(x,y)=>({button:0,isPrimary:true,pointerId:7,currentTarget:target,clientX:x,clientY:y,preventDefault(){}});
  disc(tree).props.onPointerDown(event(60,60));assert.equal(f.draft.animation.colorOverride,'#ffffff');assert.equal(capture,7);
  disc(tree).props.onPointerMove(event(0,60));assert.equal(f.draft.animation.colorOverride,'#00ffff');
  disc(tree).props.onPointerUp(event(0,60));assert.equal(capture,null);f.render();tree=render();
  const marker=nodes(tree).find(n=>n.props.className==='color-wheel-handle');assert.ok(marker);assert.ok(Math.abs(parseFloat(marker.props.style.left))<.001);assert.equal(marker.props.style.background,'#00FFFF');
  disc(tree).props.onKeyDown({key:'Home',preventDefault(){}});assert.equal(f.draft.animation.colorOverride,'#ffffff');
  assert.deepEqual(f.draft.colors,raw());
});

async function studioFixture(mode){
  const hooks=[],effects=[],timers=new Map(),pending=new Set(),commands=[],components=new Map();let cursor=0,dirty=true,tree,timerId=0;
  const component=name=>{if(!components.has(name)){const f=function Child(){};f.displayName=name;components.set(name,f);}return components.get(name);};
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const react={
    useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,next=>{const value=typeof next==='function'?next(hooks[i].value):next;if(!Object.is(value,hooks[i].value)){hooks[i].value=value;dirty=true;}}];},
    useRef(initial){const i=cursor++;return(hooks[i]??={value:{current:initial}}).value;},
    useMemo(fn,deps){const i=cursor++,old=hooks[i];if(!old||!equal(old.deps,deps))hooks[i]={deps,value:fn()};return hooks[i].value;},
    useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||!equal(old.deps,deps)){hooks[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}},
  };
  const track=promise=>{pending.add(promise);promise.finally(()=>pending.delete(promise));};
  const jsx=(type,props,key)=>({type,props:props??{},key}),exports={};
  const state={device:{connected:true,armed:true,modelId:'air75-v3',connectionSessionId:'fixture-session',capabilities:{perKey:true}},firmware:{compatible:true},settings:{brightness:100},scenes:[],playback:{mode:mode==='paint'?'static':'idle',playing:false},colors:raw()};
  const props={mode,layout:airLayout,state,draft:{name:'Fixture',colors:raw(),animation:{...baseAnimation,effect:'pulse'}},
    setDraft:value=>{props.draft=value;dirty=true;},command:async body=>{commands.push(structuredClone(body));if(body.op==='play')state.playback={mode:'animation',playing:true};if(body.op==='preview'){state.playback={mode:'static',playing:false};state.colors=body.colors;}if(body.op==='pause')state.playback.playing=!state.playback.playing;return{};},notify(){},onSave(){},onBrowsePresets(){},onEditCodexColors(){}};
  const require=name=>{
    if(name==='react')return react;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:Symbol.for('fixture.Fragment')};if(name.endsWith('.css'))return{};
    if(name==='lucide-react')return new Proxy({},{get:(_t,key)=>component(String(key))});if(name==='./i18n')return{t:v=>v};
    if(name==='./rangeStyle')return{rangeStyle:()=>({})};if(name==='../../shared/render-animation.mjs')return appearance;
    if(name==='./useWorkspaceLayout')return{useWorkspaceLayout:()=>({mode:'flow',style:{},headerRef:{},gridRef:{},stageRef:{},keyboardRef:{},auxiliaryRef:{},returnToKeyboard(){}})};
    if(name==='./connection-copy-v7')return{canvasCaption:()=>'',connectionCopy:v=>v?.zh??'',keyboardActionHint:()=>''};
    if(name==='../../shared/device-status.mjs')return{lightingUnavailableMessage:()=>''};
    if(name==='./Keyboard')return{Keyboard:component('Keyboard'),lightingPeak:()=>1};if(name==='./presets')return{DEFAULT_COLOR:'#d07d74',heartColors:()=>raw()};
    if(name==='./types')return{blankColors:blank};if(name==='./primitives')return{Button:component('Button'),Switch:component('Switch'),run:track};
    return new Proxy({},{get:(_t,key)=>component(String(key))});
  };
  const window={matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),setInterval(){return 0;},clearInterval(){}};
  const source=await readFile(new URL('../ui/src/Studio.tsx',import.meta.url),'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require,window,document:{querySelector:()=>null},structuredClone,performance:{now:()=>0},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),Math,Number,Object,Array,String,Boolean,JSON,Set});
  const walk=(node,out=[])=>{if(Array.isArray(node))node.forEach(n=>walk(n,out));else if(node&&typeof node==='object'&&'type'in node){out.push(node);walk(node.props.children,out);}return out;};
  const text=node=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node.props?.children);
  const render=()=>{let attempts=0;do{if(++attempts>30)throw Error('Studio fixture render loop');cursor=0;dirty=false;tree=exports.Studio(props);for(const effect of effects.splice(0))effect();}while(dirty);return tree;};
  const flush=async()=>{for(let i=0;i<20;i++){if(dirty)render();if(pending.size)await Promise.all([...pending]);await Promise.resolve();}render();};
  const button=label=>walk(tree).find(n=>n.props.onClick&&text(n)===label),patch=animation=>{const node=walk(tree).find(n=>['AnimationProperties','AnimationPalette'].includes(n.type?.name));assert.ok(node);node.props.setAnimation(animation);render();};
  render();return{props,state,commands,render,flush,patch,button,walk,get tree(){return tree;},async click(label){const node=button(label);assert.ok(node,'Missing Studio action '+label);node.props.onClick();await flush();},async timers(){const work=[...timers.values()];timers.clear();for(const fn of work)fn();await flush();},unmount(){for(const hook of hooks)hook.cleanup?.();timers.clear();}};
}

test('actual clear-canvas toolbar action preserves scene settings and supports Undo and Redo without sending HID commands',async()=>{
  const f=await studioFixture('paint'),before=structuredClone(f.props.draft);
  assert.equal(f.button('清空画板').props.disabled,false);await f.click('清空画板');
  assert.ok(f.props.draft.colors.every(c=>c==='#000000'));assert.equal(f.button('清空画板').props.disabled,true);
  assert.equal(f.props.draft.name,before.name);assert.deepEqual(f.props.draft.animation,before.animation);assert.deepEqual(f.commands,[]);
  const action=name=>f.walk(f.tree).find(node=>node.props['aria-label']===name&&node.props.onClick);
  action('撤销').props.onClick();await f.flush();assert.deepEqual(f.props.draft.colors,before.colors);
  action('重做').props.onClick();await f.flush();assert.ok(f.props.draft.colors.every(c=>c==='#000000'));assert.deepEqual(f.commands,[]);f.unmount();
});

test('clearing a frame stays in its editor until Apply and leaves the other frames intact',async()=>{
  const f=await studioFixture('animation'),colors=structuredClone(f.props.draft.colors),other=blank();other[12]='#00ff00';
  f.props.draft.animation={...f.props.draft.animation,effect:'frames',frames:[{colors,duration:300},{colors:other,duration:500}]};f.render();
  await f.click('清空当前帧');assert.deepEqual(f.props.draft.animation.frames[0].colors,colors,'no destructive write before Apply');
  await f.click('应用到第 1 帧');assert.ok(f.props.draft.animation.frames[0].colors.every(c=>c==='#000000'));
  assert.deepEqual(f.props.draft.animation.frames[1],{colors:other,duration:500});assert.equal(f.props.draft.animation.frames[0].duration,300);assert.deepEqual(f.commands,[]);f.unmount();
});

test('animation and trigger expose Clear canvas before entering the pattern editor',async()=>{
  for(const mode of ['animation','trigger']){
    const f=await studioFixture(mode),before=structuredClone(f.props.draft);
    assert.ok(f.button('清空画板'));await f.click('清空画板');assert.ok(f.props.draft.colors.every(c=>c==='#000000'));
    assert.deepEqual(f.props.draft.animation,before.animation);assert.deepEqual(f.commands,[]);
    f.walk(f.tree).find(node=>node.props['aria-label']==='撤销'&&node.props.onClick).props.onClick();await f.flush();assert.deepEqual(f.props.draft.colors,before.colors);f.unmount();
  }
});

test('actual Studio colour-only animation edit changes Pause into Update playback and submits the new effect once',async()=>{
  const f=await studioFixture('animation'),original=structuredClone(f.props.draft.colors);await f.click('播放到键盘');assert.ok(f.button('暂停播放'));assert.equal(f.commands.filter(c=>c.op==='play').length,1);
  f.patch({colorOverride:'#00c080'});assert.ok(f.button('更新播放'));assert.equal(f.button('暂停播放'),undefined);assert.equal(f.commands.length,1,'editing alone does not silently restart animation');
  await f.click('更新播放');assert.equal(f.commands.length,2);assert.equal(f.commands[1].op,'play');assert.equal(f.commands[1].animation.colorOverride,'#00c080');assert.deepEqual(f.commands[1].colors,original);assert.ok(f.button('暂停播放'));f.unmount();
});

test('actual Studio paint colour changes use the existing live queue and send only the latest selected colour',async()=>{
  const f=await studioFixture('paint'),original=structuredClone(f.props.draft.colors);
  const toggle=f.walk(f.tree).find(n=>n.type?.displayName==='Switch'&&n.props.label==='绘制时同步到键盘');assert.ok(toggle);toggle.props.onChange(true);f.render();await f.timers();const sent=f.commands.length;
  f.patch({colorOverride:'#123456'});f.patch({colorOverride:'#abcdef'});assert.equal(f.commands.length,sent);
  const keyboard=f.walk(f.tree).find(n=>n.type?.displayName==='Keyboard');assert.equal(keyboard.props.colors[31],'#abcdef','the local keyboard immediately shows selected RGB');
  await f.timers();assert.equal(f.commands.length,sent+1);assert.equal(f.commands.at(-1).op,'preview');assert.equal(f.commands.at(-1).colors[31],'#abcdef');assert.equal(f.commands.at(-1).colors[0],'#000000');assert.deepEqual(f.props.draft.colors,original);f.unmount();
});

test('actual Studio frame thumbnails reflect selected colour and retain legacy raw thumbnails after restore',async()=>{
  const f=await studioFixture('animation'),first=raw(),second=blank();second[12]='#71958b';
  const frames=freeze([{colors:first,duration:200},{colors:second,duration:400}]);
  f.props.draft={...f.props.draft,animation:{...baseAnimation,effect:'frames',frames,hueShift:120,colorOverride:'#20c080',brightness:50}};f.render();
  const thumbnails=()=>f.walk(f.tree).filter(n=>String(n.props.className).startsWith('v5-frame-chip')).map(chip=>f.walk(chip).find(n=>n.type?.displayName==='Keyboard'));
  let views=thumbnails();assert.equal(views.length,2);assert.equal(views[0].props.colors[31],'#106040');assert.equal(views[0].props.colors[0],'#000000');assert.equal(views[1].props.colors[12],'#106040');
  assert.deepEqual(first,raw());assert.equal(second[12],'#71958b');assert.deepEqual(frames.map(frame=>frame.duration),[200,400]);
  f.props.draft={...f.props.draft,animation:{...f.props.draft.animation,colorOverride:undefined}};f.render();views=thumbnails();
  assert.equal(views[0].props.colors,first,'without a new override, the preexisting raw frame-thumbnail behavior stays exact');assert.equal(views[1].props.colors,second);assert.equal(f.props.draft.animation.hueShift,120);f.unmount();
});
