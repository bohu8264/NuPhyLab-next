// Executes the production App.tsx and draftPersistence.ts. Child rendering,
// React scheduling, API and browser storage are controlled; never React DOM,
// WebKit, the production service, user storage, native host or hardware.
import ts from '../../ui/node_modules/typescript/lib/typescript.js';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {validateTrigger} from '../../shared/trigger.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const defaultAnimation={effect:'static',direction:'right',speed:4,loop:true};
export const scene=(name='Unsaved canvas',patch={})=>({name,colors:Array(84).fill('#d07d74'),animation:{...defaultAnimation},...patch});
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
export async function appDraftFixture(options={}){
  const source=await readFile(new URL('../../ui/src/App.tsx',import.meta.url),'utf8');
  const helperSource=await readFile(new URL('../../ui/src/draftPersistence.ts',import.meta.url),'utf8');
  const typesSource=await readFile(new URL('../../ui/src/types.ts',import.meta.url),'utf8');
  const hooks=[],effects=[],components=new Map(),commands=[],writes=[],reads=[],events=new Map(),errors=[];
  const storage=new Map(Object.entries(options.storage??{'air-studio-draft-v1':JSON.stringify(options.draft??scene())}));
  const layout=Array.from({length:84},(_,index)=>({index,code:index?'Key'+index:'Escape',label:String(index),x:index,y:0,w:1,h:1}));
  const state={settings:{language:'zh-CN'},device:{connected:true,armed:true,modelId:'air75-v3',connectionSessionId:'fixture-session',capabilities:{perKey:true}},firmware:{compatible:true},playback:{mode:'animation',playing:true},game:{status:'idle'},scenes:[],...options.state};
  let cursor=0,dirty=true,tree,uuid=0,renderCount=0,quota=Boolean(options.quota),readFailure=Boolean(options.readFailure),disposed=false;
  const component=name=>{if(!components.has(name)){const fn=function FixtureChild(){};fn.displayName=name;components.set(name,fn);}return components.get(name);};
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const react={
    useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={kind:'state',value:typeof initial==='function'?initial():initial};return[hooks[i].value,next=>{const value=typeof next==='function'?next(hooks[i].value):next;if(!Object.is(value,hooks[i].value)){hooks[i].value=value;dirty=true;}}];},
    useRef(initial){const i=cursor++;return(hooks[i]??={kind:'ref',value:{current:initial}}).value;},
    useCallback(fn,deps){const i=cursor++,old=hooks[i];if(!old||!equal(old.deps,deps))hooks[i]={kind:'callback',deps,value:fn};return hooks[i].value;},
    useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||!equal(old.deps,deps)){hooks[i]={kind:'effect',deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}},
  };
  const localStorage={getItem(key){reads.push(key);if(readFailure)throw new Error('fixture storage read unavailable');return storage.get(key)??null;},setItem(key,value){writes.push({key,value});if(quota)throw new DOMException('fixture full','QuotaExceededError');storage.set(key,String(value));}};
  const command=async body=>{commands.push(clone(body));if(options.onCommand)return options.onCommand(body,{state,commands});if(body.op==='saveScene'){const saved={...clone(body.scene),updatedAt:'fixture-saved'};const index=state.scenes.findIndex(s=>s.id===saved.id);if(index<0)state.scenes.push(saved);else state.scenes[index]=saved;return{savedScene:clone(saved)};}return{ok:true};};
  const readState=async()=>{if(options.onReadState)return options.onReadState({state,commands});return clone(state);};
  const api={state,layout,serviceError:'',command,readState,refresh:async()=>{},exiting:false};
  const host={addEventListener(type,fn){if(!events.has(type))events.set(type,new Set());events.get(type).add(fn);},removeEventListener(type,fn){events.get(type)?.delete(fn);},dispatchEvent(e){events.get(e.type)?.forEach(fn=>fn(e));}};
  const jsx=(type,props,key)=>({type,props:props??{},key});
  const sandbox={console:{log(){},warn(){},error(...x){errors.push(x);}},Error,DOMException,Date,JSON,Array,Set,Map,Promise,Number,String,Boolean,Math,Object,crypto:{randomUUID:()=>`fixture-uuid-${++uuid}`},window:host,localStorage,performance:{now:()=>0},requestAnimationFrame:fn=>{fn();return 1;},cancelAnimationFrame(){},CustomEvent:class{constructor(type,options={}){this.type=type;Object.assign(this,options);}}};
  const compile=(text,requireFn)=>{const exports={};vm.runInNewContext(ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{...sandbox,exports,require:requireFn});return exports;};
  const types=compile(typesSource,name=>{throw Error('Unexpected types import '+name);});
  const persistence=compile(helperSource,name=>name==='./types'?types:name==='../../shared/trigger.mjs'?{validateTrigger}:(()=>{throw Error('Unexpected persistence import '+name);})());
  const requireApp=name=>{
    if(name==='react')return react;
    if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:Symbol.for('fixture.Fragment')};
    if(name.endsWith('.css'))return{};
    if(name==='lucide-react')return new Proxy({}, {get:(_t,key)=>component('icon:'+String(key))});
    if(name==='./api')return{useAirApi:()=>api};
    if(name==='./draftPersistence')return persistence;
    if(name==='./types')return types;
    if(name==='./i18n')return{t:value=>value,useLanguage:()=>api.state.settings.language,setLanguage(){}};
    if(name==='./presets')return{presets:()=>[scene('Fallback preset',{colors:Array(84).fill('#234567')})]};
    if(name==='./codexKeys')return{useCodexKeys(){}};
    if(name==='./TriggerPanel')return{useTriggerKeys(){}};
    if(name==='./AgentSourceSwitch')return{agentSource:s=>s?.settings.agentSource==='claude'?'claude':'codex'};
    if(name==='./Keyboard')return{KeyboardModuleContext:{Provider:component('Provider')}};
    if(name==='./KeyRecoveryPanel')return{keyRecoveryProblem:()=>null,friendlyConnectionError:value=>value};
    if(name==='../../shared/device-status.mjs')return{nativeLightingOnly:()=>false};
    if(name==='../../shared/connection-display.mjs')return{deriveConnectionDisplay:()=>({stateId:'connected'})};
    if(name==='./connection-copy-v7')return{presentConnectionDisplay:v=>v,connectionCopy:v=>v.zh,connectionHeader:()=>'',connectionSidebar:()=>''};
    if(name==='./primitives')return{Button:component('Button'),Modal:component('Modal'),run:promise=>{void promise.catch(()=>{});}};
    const child=name.match(/^\.\/(FeedbackToast|AudioPanel|AudioPendingNotice|NativeLighting|Studio|Library|Codex|ClaudeCode|Device|Settings|StartupGuide)$/)?.[1];
    if(child)return{[child]:component(child)};
    throw Error('Unexpected App import '+name);
  };
  const App=compile(source,requireApp).default;
  function render(){if(disposed)throw Error('fixture disposed');if(++renderCount>500)throw Error('fixture render loop');cursor=0;tree=App();const work=effects.splice(0);dirty=false;for(const effect of work)effect();return tree;}
  async function flush(){for(let i=0;i<40;i++){if(dirty)render();await Promise.resolve();}if(dirty)throw Error('fixture did not settle');return tree;}
  function walk(value,result=[]){if(Array.isArray(value)){for(const v of value)walk(v,result);}else if(value&&typeof value==='object'&&'type'in value){result.push(value);walk(value.props.children,result);walk(value.props.footer,result);}return result;}
  const nodes=()=>walk(tree),text=node=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node.props?.children);
  const child=name=>nodes().find(n=>n.type===components.get(name));
  const modal=()=>child('Modal');
  const button=label=>nodes().find(n=>(n.type==='button'||n.type===components.get('Button'))&&(text(n)===label||n.props['aria-label']===label));
  async function click(label,{raw=false}={}){const node=typeof label==='string'?button(label):label;if(!node)throw Error('Missing button '+label);if(!raw&&(node.props.disabled||node.props.busy))throw Error('Disabled button '+text(node));node.props.onClick?.();await flush();return node;}
  async function edit(patch){const studio=child('Studio');if(!studio)throw Error('Studio not rendered');studio.props.setDraft(current=>({...current,...clone(patch)}));await flush();}
  const draft=()=>hooks.find(h=>h?.kind==='state'&&h.value&&typeof h.value==='object'&&Array.isArray(h.value.colors)&&h.value.animation)?.value;
  await flush();
  return{source,helperSource,typesSource,api,state,layout,commands,storage,writes,reads,errors,render,flush,nodes,text,child,modal,button,click,edit,draft,parseDraftRecord:persistence.parseDraftRecord,setQuota:value=>{quota=value;},setReadFailure:value=>{readFailure=value;},get tree(){return tree;},unmount(){disposed=true;for(const h of hooks)if(h?.kind==='effect')h.cleanup?.();}};
}
