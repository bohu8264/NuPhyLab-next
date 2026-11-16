import ts from '../../ui/node_modules/typescript/lib/typescript.js';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const clone=x=>JSON.parse(JSON.stringify(x));
export async function voiceFixture({language='zh-CN',onRequest}={}){
 const presets=JSON.parse(await readFile(new URL('../../assets/voice-input/service-presets.json',import.meta.url),'utf8'));
 const defaultCleanupPrompt=await readFile(new URL('../../assets/voice-input/cleanup-prompt.txt',import.meta.url),'utf8');
 const state={defaultCleanupPrompt,enabled:true,phase:'idle',message:'',hotkeyReady:true,shortcutRecording:false,shortcutLabel:'右 Option',settings:{...presets[0].settings,shortcutKeyCode:61,shortcutModifiers:0,dictionary:['NuPhy'],microphoneUID:''},servicePresets:presets,microphones:{defaultName:'Fixture Mic',devices:[{uid:'fixture-mic',name:'Fixture Mic'}]},permissions:{microphone:'authorized',accessibility:true},hasASRKey:true,hasCleanupKey:true,rawText:'',cleanedText:'',delivery:'',elapsed:0,level:0,timings:{}};
 const hooks=[],effects=[],events=new Map(),requests=[];let cursor=0,dirty=true,tree,disposed=false;
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
 const react={useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,next=>{const value=typeof next==='function'?next(hooks[i].value):next;if(!Object.is(hooks[i].value,value)){hooks[i].value=value;dirty=true;}}];},useRef(initial){const i=cursor++;return(hooks[i]??={ref:{current:initial}}).ref;},useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||!equal(old.deps,deps)){hooks[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}}};
 const postMessage=async body=>{requests.push(clone(body));const custom=await onRequest?.(body,state);if(custom)return clone(custom);
  if(body.action==='requestKeyStatus')return {...clone(state),keyStatusReply:{requestID:body.requestID,keys:{hasASRKey:true,hasCleanupKey:true}}};
  if(body.action==='setMicrophone'){state.settings.microphoneUID=body.uid;state.microphoneSaved=true;}
  if(body.action==='saveDictionary'){state.settings.dictionary=body.dictionary;state.dictionarySaved=true;}
  if(body.action==='savePrompt'){if(body.prompt===state.defaultCleanupPrompt)delete state.settings.customCleanupPrompt;else state.settings.customCleanupPrompt=body.prompt;state.promptSaved=true;}
  if(body.action==='saveSettings'){Object.assign(state.settings,body.settings);state.settingsSaved=true;}
  if(body.action==='enabled')state.enabled=body.enabled;
  if(body.action==='recordShortcut')state.shortcutRecording=true;
  if(['cancelShortcut','leave'].includes(body.action))state.shortcutRecording=false;
  return clone(state);
 };
 const host={webkit:{messageHandlers:{voiceInput:{postMessage}}},addEventListener:(type,fn)=>events.set(type,fn),removeEventListener:type=>events.delete(type)};
 const jsx=(type,props)=>({type,props:props??{}}),exports={};
 const source=await readFile(new URL('../../ui/src/VoiceInput.tsx',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,window:host,URL,Error,console,require(name){if(name==='react')return react;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'fragment'};if(name==='./i18n')return{useLanguage:()=>language};if(name==='lucide-react')return new Proxy({},{get:(_,key)=>'icon-'+String(key)});if(name.endsWith('.css'))return{};throw Error(name);}});
 async function flush(){for(let i=0;i<50;i++){if(dirty&&!disposed){cursor=0;dirty=false;tree=exports.VoiceInput();for(const fn of effects.splice(0))fn();}await Promise.resolve();}if(dirty)throw Error('UI did not settle');}
 function walk(n,list=[]){if(Array.isArray(n))for(const c of n)walk(c,list);else if(n&&typeof n==='object'&&'type'in n){list.push(n);walk(n.props.children,list);}return list;}
 const text=n=>n==null||typeof n==='boolean'?'':typeof n==='string'||typeof n==='number'?String(n):Array.isArray(n)?n.map(text).join(''):text(n.props?.children);
 const nodes=()=>walk(tree),button=label=>nodes().find(n=>n.type==='button'&&(text(n).trim()===label||n.props['aria-label']===label));
 const field=label=>{const direct=nodes().find(n=>n.props['aria-label']===label);if(direct)return direct;const parent=nodes().find(n=>n.type==='label'&&walk(n).some(x=>x.type==='span'&&text(x)===label));return parent&&walk(parent).find(n=>['input','select','textarea'].includes(n.type));};
 async function click(label){const n=button(label);if(!n||n.props.disabled)throw Error('button unavailable '+label);n.props.onClick?.();await flush();}
 async function change(label,value){const n=field(label);if(!n||n.props.disabled)throw Error('field unavailable '+label);n.props.onChange({target:{value,checked:value}});await flush();}
 async function key(label,key,{isComposing=false,keyCode=0}={}){let prevented=false;const n=field(label);n.props.onKeyDown?.({key,keyCode,nativeEvent:{isComposing},preventDefault(){prevented=true;}});await flush();return prevented;}
 async function emit(patch){Object.assign(state,patch);events.get('nuphylab:voice-input-state')?.({detail:clone(state)});await flush();}
 await flush();return{state,requests,presets,exports,nodes,text,button,field,click,change,key,flush,emit,setLanguage:async value=>{language=value;dirty=true;await flush();},unmount:()=>{disposed=true;for(const h of hooks)h?.cleanup?.();}};
}
