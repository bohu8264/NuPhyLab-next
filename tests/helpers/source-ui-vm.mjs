// Isolated source QA utilities. No browser, network, service, native bridge or HID.
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import ts from '../../ui/node_modules/typescript/lib/typescript.js';

export const plain=value=>JSON.parse(JSON.stringify(value));
export function walkAll(node,predicate,out=[]){
  if(node==null||typeof node!=='object')return out;
  if(Array.isArray(node)){for(const child of node)walkAll(child,predicate,out);return out;}
  if(predicate(node))out.push(node);
  walkAll(node.props?.children,predicate,out);
  return out;
}
export function textOf(node){
  if(node==null||typeof node==='boolean')return '';
  if(typeof node==='string'||typeof node==='number')return String(node);
  if(Array.isArray(node))return node.map(textOf).join('');
  return textOf(node.props?.children);
}
export function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const sameDeps=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));

export function createVMEnvironment(modules={},options={}){
  const sessionStorage=new Map(Object.entries(options.sessionStorage??{}));
  const pending=new Set(),asyncErrors=[],storage=new Map(Object.entries(options.localStorage??{})),windowEvents=new Map(),documentEvents=new Map(),timers=new Map();
  let active=null,nextTimer=1,nextUUID=0;
  const track=promise=>{
    const settled=Promise.resolve(promise).catch(error=>{asyncErrors.push(error);});
    pending.add(settled);settled.then(()=>pending.delete(settled));return settled;
  };
  const hook=kind=>{
    if(!active)throw new Error('Hook called without an active component: '+kind);
    const index=active.cursor++;
    if(active.hooks[index]&&active.hooks[index].kind!==kind)throw new Error('Hook order changed at '+index);
    return {instance:active,index,old:active.hooks[index]};
  };
  const react={
    useState(initial){const {instance,index,old}=hook('state');if(!old){const entry={kind:'state',value:typeof initial==='function'?initial():initial};entry.setter=next=>{const value=typeof next==='function'?next(entry.value):next;if(!Object.is(value,entry.value)){entry.value=value;instance.dirty=true;}};instance.hooks[index]=entry;}const entry=instance.hooks[index];return [entry.value,entry.setter];},
    useRef(initial){const {instance,index,old}=hook('ref');if(!old)instance.hooks[index]={kind:'ref',value:{current:initial}};return instance.hooks[index].value;},
    useMemo(fn,deps){const {instance,index,old}=hook('memo');if(!old||!sameDeps(old.deps,deps))instance.hooks[index]={kind:'memo',deps,value:fn()};return instance.hooks[index].value;},
    useCallback(fn,deps){return react.useMemo(()=>fn,deps);},
    useEffect(fn,deps){const {instance,index,old}=hook('effect');if(!old||!sameDeps(old.deps,deps)){instance.hooks[index]={kind:'effect',deps,cleanup:old?.cleanup};instance.effects.push(()=>{instance.hooks[index].cleanup?.();const result=fn();instance.hooks[index].cleanup=typeof result==='function'?result:undefined;});}},
    createContext(value){return {Provider:'ContextProvider',_currentValue:value};},
    useContext(context){return context._currentValue;},
    useSyncExternalStore(_subscribe,snapshot){return snapshot();},
    useId(){const ref=react.useRef(null);if(ref.current===null)ref.current='vm-id-'+(++nextUUID);return ref.current;},
  };
  const jsx=(type,props,key)=>({type,props:props??{},key});
  const eventTarget=events=>({addEventListener(type,fn){if(!events.has(type))events.set(type,new Set());events.get(type).add(fn);},removeEventListener(type,fn){events.get(type)?.delete(fn);},dispatchEvent(event){for(const fn of events.get(event.type)??[])fn(event);return true;}});
  const window={...eventTarget(windowEvents),__AIR_EXITING__:false,innerWidth:1080,innerHeight:720};
  const document={...eventTarget(documentEvents),documentElement:{lang:'zh-CN'},hidden:false,activeElement:null,querySelector:()=>null,querySelectorAll:()=>[]};
  const timer=(fn,_delay)=>{const id=nextTimer++;timers.set(id,fn);return id;};
  Object.assign(window,{setTimeout:timer,clearTimeout:id=>timers.delete(id),setInterval:timer,clearInterval:id=>timers.delete(id)});
  const globals={console,structuredClone,JSON,Error,TypeError,SyntaxError,RangeError,URL,Blob,AbortSignal,Promise,Date,performance:{now:()=>1000},crypto:{randomUUID:()=>`vm-scene-${++nextUUID}`},window,document,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},setTimeout:timer,clearTimeout:id=>timers.delete(id),fetch:()=>{throw new Error('Network disabled in source-only QA.');},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},Element:class{},HTMLElement:class{}};
  globals.sessionStorage={getItem:key=>sessionStorage.get(key)??null,setItem:(key,value)=>sessionStorage.set(key,String(value)),removeItem:key=>sessionStorage.delete(key)};
  const dependencies={react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},...modules};
  const load=async(path)=>{
    const source=await readFile(path,'utf8');
    const module={exports:{}};
    const compiled=ts.transpileModule(source,{fileName:String(path),compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    vm.runInNewContext(compiled,{...globals,module,exports:module.exports,require:id=>{if(id.endsWith('.css'))return{};if(Object.hasOwn(dependencies,id))return dependencies[id];throw new Error('Unmocked dependency: '+id);}},{filename:String(path)});
    return {exports:module.exports,sha256:createHash('sha256').update(source).digest('hex')};
  };
  const mount=(component,props={})=>{
    const instance={hooks:[],effects:[],cursor:0,dirty:true,tree:null,component,props};
    instance.render=()=>{
      let iterations=0;
      do{
        if(++iterations>30)throw new Error('Source-hook rendering did not settle.');
        instance.dirty=false;instance.cursor=0;instance.effects=[];
        const previous=active;active=instance;
        try{instance.tree=instance.component(instance.props);}finally{active=previous;}
        for(const effect of instance.effects)effect();
      }while(instance.dirty);
      return instance.tree;
    };
    instance.update=next=>{instance.props=next;return instance.render();};
    instance.unmount=()=>{for(const entry of instance.hooks)if(entry?.kind==='effect')entry.cleanup?.();};
    instance.render();return instance;
  };
  const settle=async(instance)=>{
    for(let i=0;i<30;i++){
      const work=[...pending];if(work.length)await Promise.all(work);
      instance?.render();await Promise.resolve();
      if(!pending.size&&!instance?.dirty)return;
    }
    throw new Error('Source promises did not settle.');
  };
  return {react,load,mount,settle,track,pending,asyncErrors,storage,sessionStorage,window,document,timers,modules:dependencies};
}
