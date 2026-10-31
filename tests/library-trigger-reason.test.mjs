import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from '../ui/node_modules/typescript/lib/typescript.js';
import * as appearance from '../shared/render-animation.mjs';

// Full production Library TSX, including the nested triggerPlayReason and JSX
// disabled/description expressions. Effects/child rendering/API are controlled:
// this does not execute React DOM, CSS, WebKit, a service, native code or HID.
const source=await readFile(new URL('../ui/src/Library.tsx',import.meta.url),'utf8');
const scene=(id,patch={})=>({id,name:id,colors:Array(84).fill('#d07d74'),animation:{effect:'static',direction:'right',speed:4,loop:true},trigger:{code:'Space',count:3,intervalMs:600},...patch});
function fixture(scenes,{connected=true,serviceError='',display,otherState={}}={}){
  const hooks=[],components=new Map(),loads=[];let cursor=0,tree;
  const component=name=>{if(!components.has(name)){const c=function Child(){};c.displayName=name;components.set(name,c);}return components.get(name);};
  const react={useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;}];},useRef(value){const i=cursor++;return(hooks[i]??={value:{current:value}}).value;},useMemo:fn=>fn(),useEffect(){}};
  const jsx=(type,props,key)=>({type,props:props??{},key}),exports={};
  const props={layout:Array.from({length:84},(_,index)=>({index})),state:{device:{connected,capabilities:{perKey:true}},firmware:{compatible:true},settings:{brightness:100},scenes,...otherState},display,serviceError,onLoad:(...args)=>loads.push(args),onNew(){},command(){throw Error('Unexpected real/API action');},notify(){}};
  const require=name=>{
    if(name==='react')return react;
    if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:Symbol.for('fixture.Fragment')};
    if(name.endsWith('.css'))return{};
    if(name==='lucide-react')return new Proxy({},{get:(_t,key)=>component(String(key))});
    if(name==='./i18n')return{t:v=>v,dateLocale:()=> 'zh-CN'};
    if(name==='./connection-copy-v7')return{connectionCopy:pair=>pair?.zh??''};
    if(name==='../../shared/device-status.mjs')return{lightingUnavailableMessage:()=> 'Fixture USB unavailable'};
    if(name==='../../shared/render-animation.mjs')return appearance;
    if(name==='./primitives')return{Button:component('Button'),Empty:component('Empty'),Modal:component('Modal'),run:p=>{void p.catch(()=>{});}};
    if(name==='./presets')return{presetCatalog:()=>[]};
    if(name==='./Keyboard')return{Keyboard:component('Keyboard'),lightingPeak:()=>1};
    if(name==='./api')return{exportScenes(){throw Error('Unexpected export');}};
    throw Error('Unexpected Library import '+name);
  };
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require,window:{innerHeight:825},Error,Date,JSON,Array,Object,Math});
  const render=()=>{cursor=0;tree=exports.Library(props);return tree;};
  function walk(node,out=[]){if(Array.isArray(node)){node.forEach(n=>walk(n,out));}else if(node&&typeof node==='object'&&'type'in node){out.push(node);walk(node.props.children,out);walk(node.props.footer,out);}return out;}
  const text=node=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node.props?.children);
  render();const saved=walk(tree).find(n=>n.type==='button'&&text(n)==='我的作品');assert.ok(saved);saved.props.onClick();render();
  const article=id=>walk(tree).find(n=>n.type==='article'&&n.key===id),nodes=id=>walk(article(id));
  const play=id=>nodes(id).find(n=>n.props.className==='lab-library-play-v8');
  const open=id=>nodes(id).find(n=>n.type===components.get('Button')&&text(n)==='打开编辑');
  const described=node=>walk(tree).find(n=>n.props.id===node.props['aria-describedby']);
  return{props,loads,render,play,open,described,text,nodes};
}

for(const[id,patch,expected]of[
  ['empty',{colors:Array(84).fill('#000000')},'图案中还没有亮起的按键，先编辑图案。'],
  ['zero',{animation:{effect:'static',direction:'right',speed:4,loop:true,brightness:0}},'作品亮度为 0%，调高后可启用按键触发。'],
  ['rounded-black',{colors:Array(84).fill('#010101'),animation:{effect:'static',direction:'right',speed:4,loop:true,brightness:1}},'当前设置下图案没有亮起的按键，请调整颜色或作品亮度。'],
])test(`production Library trigger ${id}: disabled play links its own reason while Open stays usable`,()=>{
  const value=scene(id,patch),f=fixture([value]),play=f.play(id),open=f.open(id);
  assert.equal(play.props.disabled,true);assert.equal(play.props['aria-describedby'],`library-trigger-reason-${id}`);assert.equal(f.text(f.described(play)),expected);
  assert.equal(open.props.disabled,false);open.props.onClick();assert.equal(f.loads.length,1);assert.equal(f.loads[0][0],value);assert.equal(f.loads[0][1],undefined);
  play.props.onClick();assert.equal(f.loads.length,1,'handler also blocks an unusable trigger, not just JSX');
});

test('production Library normal trigger is playable and has no false description',()=>{
  const value=scene('normal'),f=fixture([value]),play=f.play('normal');assert.equal(play.props.disabled,false);assert.equal(play.props['aria-describedby'],undefined);play.props.onClick();assert.equal(f.loads.length,1);assert.equal(f.loads[0][0],value);assert.equal(f.loads[0][1]?.play,true);assert.equal(Object.keys(f.loads[0][1]).length,1);assert.equal(f.open('normal').props.disabled,false);
});

test('production Library connection/service reason takes description priority over per-scene trigger reason',()=>{
  for(const options of[{connected:false,display:{workTitle:{zh:'连接未就绪',en:'Connection not ready'}}},{serviceError:'fixture failure'}]){
    const value=scene('blocked',{colors:Array(84).fill('#000000')}),f=fixture([value],options),play=f.play('blocked');assert.equal(play.props.disabled,true);assert.equal(play.props['aria-describedby'],'library-play-reason');assert.equal(f.text(f.described(play)),options.serviceError?'本地服务未响应，暂不可播放到键盘。':'连接未就绪');
    assert.equal(f.open('blocked').props.disabled,false);play.props.onClick();assert.equal(f.loads.length,0);f.open('blocked').props.onClick();assert.equal(f.loads.length,1);
  }
});

test('production Library evaluates each saved scene independently of another scene or active draft brightness',()=>{
  const empty=scene('other-empty',{colors:Array(84).fill('#000000')}),normal=scene('current-normal');
  const f=fixture([empty,normal],{otherState:{animation:{brightness:0},colors:Array(84).fill('#000000'),playback:{mode:'animation',animation:{brightness:0}}}});
  assert.equal(f.play('other-empty').props.disabled,true);assert.equal(f.play('current-normal').props.disabled,false);assert.equal(f.play('current-normal').props['aria-describedby'],undefined);
  f.props.state.scenes=[normal,empty];f.props.state.animation.brightness=1;f.render();assert.equal(f.play('current-normal').props.disabled,false);assert.equal(f.play('other-empty').props['aria-describedby'],'library-trigger-reason-other-empty');
});

test('production Library trigger-only reasons do not disable ordinary blank/zero-brightness artwork',()=>{
  const value=scene('ordinary',{trigger:undefined,colors:Array(84).fill('#000000'),animation:{effect:'static',direction:'right',speed:4,loop:true,brightness:0}}),f=fixture([value]);assert.equal(f.play('ordinary').props.disabled,false);assert.equal(f.play('ordinary').props['aria-describedby'],undefined);assert.equal(f.open('ordinary').props.disabled,false);
});
