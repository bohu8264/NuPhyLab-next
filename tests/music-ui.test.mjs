import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {createVMEnvironment,walkAll,textOf,plain,deferred} from './helpers/source-ui-vm.mjs';
const icon=new Proxy({},{get:()=>()=>null});
async function setup(t,{control,fetchResponse}={}){
 let stored,fail=false,gate=null,conflict=false;const calls=[],audio={init:0,play:0,loadGate:null,loadClipGate:null,importGate:null,instances:[]};const lang={value:'en'};
 class Engine{constructor(s){this.session=s;this.held=new Map;this.clipLoops=new Map;audio.instances.push(this);this.context={resume:async()=>{},suspend:async()=>{}};}update(s){this.session=s;}async init(){audio.init++;await audio.loadGate?.promise;this.graph={};}async loadClips(){await audio.loadClipGate?.promise;}async loadClip(){await audio.loadClipGate?.promise;}play(){audio.play++;this.playing=true;}stop(){this.playing=false;}releaseKeys(){}pedal(){}noteOff(){}async importClip(){await audio.importGate?.promise;if(this.closed)throw Error('closed during import');return 'data:audio/wav;base64,UklGRg==';}async close(){this.closed=true;}clipDuration(){return 1;}}

 const ui=createVMEnvironment({'lucide-react':icon,'../primitives':{Button:function Button(){},Modal:function Modal(){}},'../i18n':{language:()=>lang.value,useLanguage:()=>lang.value,dateLocale:()=>lang.value==='en'?'en-US':'zh-CN'},'./engine':{MusicEngine:Engine},'./MusicPanelGraphics':{DrumIcon:()=>null,PresetCover:()=>null,drumIconNames:Array(8).fill('kick')},'./LibraryView':{LibraryView:()=>null}},{globals:{Event:class{constructor(type){this.type=type;}},crypto:{randomUUID},requestAnimationFrame:()=>0,cancelAnimationFrame:()=>{},fetch:async(url,opts)=>{calls.push({url,method:opts.method});if(fetchResponse){const response=await fetchResponse(url,opts,stored);if(response)return response;}if(opts.method==='POST'){if(gate)await gate.promise;if(fail)throw Error('disk unavailable');if(conflict){conflict=false;return {ok:false,status:409,json:async()=>({ok:false,code:'MUSIC_WORK_CHANGED'})};}stored=JSON.parse(opts.body);}return {ok:true,json:async()=>({ok:true,session:stored?structuredClone(stored):null,works:[]})};}}});
 const load=async(name)=>{const x=await ui.load(new URL('../ui/src/music/'+name,import.meta.url));ui.modules['./'+name.replace(/\.[^.]+$/,'')]=x.exports;return x.exports;};
 if(control)ui.window.webkit={messageHandlers:{musicControl:{postMessage:control}}};
 const model=await load('model.ts');stored={...model.initialSession(),name:'Original',projectId:randomUUID()};
 await load('presets-v1.ts');await load('presets.ts');ui.modules['./messages.json']={default:JSON.parse(await readFile(new URL('../ui/src/music/messages.json',import.meta.url)))};
 await load('i18n.ts');const persistence=await load('persistence.ts');await load('client.ts');const {MusicLab}=await load('MusicLab.tsx');
 const tick=async i=>{for(let n=0;n<80;n++){await Promise.resolve();i?.render();}};const mounts=[];
 const mount=(props={})=>{const i=ui.mount(MusicLab,props);mounts.push(i);return i;};
 const unmount=i=>{i.unmount();mounts.splice(mounts.indexOf(i),1);};
 t.after(async()=>{gate?.resolve();fail=false;for(const i of mounts)i.unmount();await tick();await persistence.flushMusic().catch(e=>{if(e.code!=='MUSIC_WORK_CHANGED')throw e;});});
 return {ui,model,persistence,calls,audio,tick,mount,unmount,load,mountWorks:async(props)=>{const {MusicWorks}=await load('MusicWorks.tsx');const i=ui.mount(MusicWorks,props);mounts.push(i);return i;},setGate:v=>gate=v,setFail:v=>fail=v,setConflict:v=>conflict=v,get stored(){return stored;}};
}
const byLabel=(i,label)=>walkAll(i.tree,n=>n.props?.['aria-label']===label)[0];
test('real MusicLab does not autosave its initial read and waits for final old-mount save on fast navigation',async t=>{const f=await setup(t);let first=f.mount();await f.tick(first);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 byLabel(first,'Performance name').props.onChange({target:{value:'Newest recording'}});first.render();const gate=deferred();f.setGate(gate);f.unmount(first);const before=f.calls.filter(c=>c.method==='GET').length;const second=f.mount();await f.tick(second);assert.equal(f.calls.filter(c=>c.method==='GET').length,before);assert.equal(byLabel(second,'Performance name').props.disabled,true);
 gate.resolve();await f.tick(second);assert.equal(byLabel(second,'Performance name').props.value,'Newest recording');assert.equal(f.stored.name,'Newest recording');
});
test('failed unmount write blocks stale read, retains latest snapshot, and retries without losing edits',async t=>{const f=await setup(t);const first=f.mount();await f.tick(first);byLabel(first,'Performance name').props.onChange({target:{value:'Keep this edit'}});first.render();f.setFail(true);f.unmount(first);const second=f.mount();await f.tick(second);assert.equal(byLabel(second,'Performance name').props.disabled,true);assert.equal(f.stored.name,'Original');f.setFail(false);const retry=walkAll(second.tree,n=>n.type==='button'&&textOf(n)==='Retry loading')[0];assert(retry);retry.props.onClick();await f.tick(second);assert.equal(byLabel(second,'Performance name').props.value,'Keep this edit');});

const toggle=i=>walkAll(i.tree,n=>n.type?.name==='Toggle'&&textOf(n)==='Enable performance')[0];
test('native recording denial prevents audio initialization and preview scheduling',async t=>{const f=await setup(t,{control:async()=>({allowed:false,blocked:true})});const i=f.mount();await f.tick(i);await toggle(i).props.onClick();await f.tick(i);assert.equal(f.audio.init,0);assert.equal(f.audio.play,0);const library=walkAll(i.tree,n=>n.props?.role==='tab'&&textOf(n)==='Library')[0];library.props.onClick();await f.tick(i);const view=walkAll(i.tree,n=>typeof n.props?.onPreview==='function')[0];view.props.onPreview({id:'test',name:'Test',bpm:100,bars:4,events:[],steps:Array.from({length:8},()=>Array(16).fill(false))});await f.tick(i);assert.equal(f.audio.play,0);});
test('a late permission grant after blur cannot enable or initialize audio',async t=>{const gate=deferred(),sent=[];const f=await setup(t,{control:async body=>{sent.push(body);return body.request?gate.promise:{allowed:true}}});const i=f.mount();await f.tick(i);toggle(i).props.onClick();await f.tick(i);f.ui.window.dispatchEvent({type:'blur'});gate.resolve({allowed:true});await f.tick(i);assert.equal(f.audio.init,0);assert.equal(f.audio.play,0);assert.equal(sent.at(-1).active,false);});
test('an interrupted initialization releases its provisional typing-sound pause',async t=>{const sent=[],f=await setup(t,{control:async body=>{sent.push(body);return {allowed:true}}});f.audio.loadGate=deferred();const i=f.mount();await f.tick(i);toggle(i).props.onClick();await f.tick(i);assert.equal(f.audio.init,1);f.ui.window.dispatchEvent({type:'blur'});f.audio.loadGate.resolve();await f.tick(i);assert.equal(f.audio.play,0);assert.equal(sent.at(-1).active,false);assert(toggle(i));});

test('switching projects locks the editor before asynchronous clip preparation',async t=>{const f=await setup(t),i=f.mount();await f.tick(i);toggle(i).props.onClick();await f.tick(i);walkAll(i.tree,n=>n.props?.role==='tab'&&textOf(n)==='Library')[0].props.onClick();await f.tick(i);f.audio.loadClipGate=deferred();const preset=f.ui.modules['./presets'].songPresets[0];walkAll(i.tree,n=>typeof n.props?.onCreate==='function')[0].props.onCreate(preset);await f.tick(i);assert.equal(i.tree.props.inert,true);assert.equal(byLabel(i,'Performance name').props.disabled,true);byLabel(i,'Performance name').props.onChange({target:{value:'must not be accepted'}});await f.tick(i);assert.notEqual(byLabel(i,'Performance name').props.value,'must not be accepted');f.audio.loadClipGate.resolve();await f.tick(i);assert.notEqual(f.stored.name,'must not be accepted');});
test('navigation waits for an in-flight audio import before closing its engine or saving',async t=>{const f=await setup(t),first=f.mount();await f.tick(first);toggle(first).props.onClick();await f.tick(first);walkAll(first.tree,n=>n.props?.role==='tab'&&textOf(n)==='Clips')[0].props.onClick();await f.tick(first);const settings=walkAll(first.tree,n=>n.props?.['aria-label']==='Clip settings 1')[0];assert(settings);settings.props.onClick();await f.tick(first);const file=walkAll(first.tree,n=>n.type==='input'&&n.props?.accept==='audio/*,.wav,.mp3,.m4a')[0];assert(file);f.audio.importGate=deferred();file.props.onChange({target:{files:[{name:'Delayed.wav'}],value:'x'}});await f.tick(first);f.unmount(first);const second=f.mount();await f.tick(second);assert.notEqual(f.audio.instances[0].closed,true);assert.equal(byLabel(second,'Performance name').props.disabled,true);f.audio.importGate.resolve();await f.tick(second);assert.equal(f.stored.clips[0].name,'Delayed');assert.equal(f.audio.instances[0].closed,true);assert.equal(f.stored.clips[0].audio,'data:audio/wav;base64,UklGRg==');});

test('a lifecycle conflict blocks manual save, Quit and remount retries without discarding the editor',async t=>{
 const sent=[],f=await setup(t,{control:async b=>{sent.push(b);return {allowed:true};}}),i=f.mount();await f.tick(i);
 byLabel(i,'Performance name').props.onChange({target:{value:'Unsent draft'}});i.render();f.setConflict(true);
 const save=walkAll(i.tree,n=>n.type==='button'&&n.props?.title==='Save to My works')[0];assert(save);await save.props.onClick();await f.tick(i);
 assert.equal(f.stored.name,'Original');assert.equal(byLabel(i,'Performance name').props.value,'Unsent draft');
 const alert=walkAll(i.tree,n=>n.props?.role==='alert')[0];assert.match(textOf(alert),/Saving is paused/);assert.doesNotMatch(textOf(alert),/[\u3400-\u9fff]/);
 const count=f.calls.filter(c=>c.method==='POST').length;assert.equal(count,1);
 await assert.rejects(f.persistence.flushMusic(),e=>e.code==='MUSIC_WORK_CHANGED');await save.props.onClick();await f.tick(i);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,count);assert(!sent.some(b=>b.saveHealthy));
 const exportButton=walkAll(i.tree,n=>n.type==='button'&&textOf(n)==='Export')[0];assert(exportButton);exportButton.props.onClick();await f.tick(i);
 assert(walkAll(i.tree,n=>n.type==='button'&&textOf(n).includes('Export project')).some(n=>!n.props.disabled));
 f.unmount(i);const next=f.mount();await f.tick(next);assert.equal(byLabel(next,'Performance name').props.disabled,false);assert.equal(byLabel(next,'Performance name').props.value,'Unsent draft');assert.match(textOf(next.tree),/Saving paused/);assert.equal(f.calls.filter(c=>c.method==='POST').length,count);assert.equal(f.stored.name,'Original');
 byLabel(next,'Performance name').props.onChange({target:{value:'Temporary edit'}});next.render();assert.match(textOf(next.tree),/Saving paused/);
 byLabel(next,'Performance name').props.onChange({target:{value:'Unsent draft'}});next.render();assert.match(textOf(next.tree),/Saving paused/);assert.equal(f.calls.filter(c=>c.method==='POST').length,count);
 await assert.rejects(f.persistence.flushMusic(),e=>e.code==='MUSIC_WORK_CHANGED');
});

test('project export stays disabled until a real or retained project is available',async t=>{
 const f=await setup(t),i=f.mount();const exportButton=()=>walkAll(i.tree,n=>n.type==='button'&&textOf(n)==='Export')[0];assert.equal(exportButton().props.disabled,true);await f.tick(i);assert.equal(exportButton().props.disabled,false);
});

test('new unified-library entry cannot replace the retained draft after a lifecycle conflict',async t=>{
 const f=await setup(t),first=f.mount();await f.tick(first);
 byLabel(first,'Performance name').props.onChange({target:{value:'Retain before choosing new work'}});first.render();f.setConflict(true);
 const save=walkAll(first.tree,n=>n.type==='button'&&n.props?.title==='Save to My works')[0];await save.props.onClick();await f.tick(first);f.unmount(first);
 const next=f.mount({entry:{requestId:'new-entry',session:{...f.model.initialSession(),projectId:randomUUID(),name:'Must not replace draft'}}});await f.tick(next);
 assert.equal(byLabel(next,'Performance name').props.value,'Retain before choosing new work');assert.equal(f.stored.name,'Original');
});
test('an explicit saved work opens without reading an unrelated broken current snapshot',async t=>{
 const f=await setup(t,{fetchResponse:async(url,opts,stored)=>{if(url==='/api/music/session'&&opts.method==='GET')throw Error('broken current');if(url.startsWith('/api/music/works/'))return {ok:true,json:async()=>({ok:true,work:{session:stored}})};}});
 const i=f.mount({entry:{requestId:'explicit',workId:f.stored.projectId}});await f.tick(i);assert.equal(byLabel(i,'Performance name').props.value,'Original');assert.equal(byLabel(i,'Performance name').props.disabled,false);assert(!f.calls.some(c=>c.url==='/api/music/session'&&c.method==='GET'));
});
test('a new preset entry is marked saved only after its POST succeeds',async t=>{
 const f=await setup(t),gate=deferred();f.setGate(gate);const i=f.mount({entry:{requestId:'new-preset',session:{...f.model.initialSession(),projectId:randomUUID(),name:'New preset'}}});await f.tick(i);assert(!textOf(i.tree).includes('Saved to library'));
 for(const [id,fn] of [...f.ui.timers]){f.ui.timers.delete(id);fn();}await f.tick(i);assert(!textOf(i.tree).includes('Saved to library'));assert.equal(f.stored.name,'Original');gate.resolve();await f.tick(i);assert.equal(f.stored.name,'New preset');assert(textOf(i.tree).includes('Saved to library'));
});
test('leaving the editor during a library navigation save prevents a late navigation callback',async t=>{
 let navigated=0;const f=await setup(t),i=f.mount({onLibrary:()=>navigated++});await f.tick(i);const gate=deferred();f.setGate(gate);walkAll(i.tree,n=>n.props?.role==='tab'&&textOf(n)==='Library')[0].props.onClick();await f.tick(i);f.unmount(i);gate.resolve();await f.tick();assert.equal(navigated,0);
});
test('changing the editor tab cancels an older pending library navigation',async t=>{
 let navigated=0;const f=await setup(t),i=f.mount({onLibrary:()=>navigated++});await f.tick(i);const gate=deferred();f.setGate(gate);walkAll(i.tree,n=>n.props?.role==='tab'&&textOf(n)==='Library')[0].props.onClick();await f.tick(i);walkAll(i.tree,n=>n.props?.role==='tab'&&textOf(n)==='Drums')[0].props.onClick();await f.tick(i);gate.resolve();await f.tick(i);assert.equal(navigated,0);
});
test('browsing the library is passive and a native release cancels a delayed preview permit',async t=>{
 const gate=deferred(),sent=[];const f=await setup(t,{control:async body=>{sent.push(body);return body.request?gate.promise:{allowed:true}}});const i=await f.mountWorks({source:'presets',search:'',visible:true,showTools:false,added:true,onEdit:()=>{},onCount:()=>{}});await f.tick(i);assert.equal(sent.length,0);
 walkAll(i.tree,n=>n.type==='button'&&n.props?.['aria-label']?.startsWith('Preview '))[0].props.onClick();await f.tick(i);assert(sent.some(x=>x.request));f.ui.window.dispatchEvent({type:'nuphylab:music-release'});gate.resolve({allowed:true});await f.tick(i);assert.equal(f.audio.play,0);assert.equal(sent.at(-1).active,false);
});
test('a retained conflict still allows reading the saved library',async t=>{
 const f=await setup(t);assert.throws(()=>f.persistence.markMusicWriteConflict());const i=await f.mountWorks({source:'saved',search:'',visible:true,showTools:false,added:true,onEdit:()=>{},onCount:()=>{}});await f.tick(i);assert(f.calls.some(c=>c.url==='/api/music/works'&&c.method==='GET'));assert(!textOf(i.tree).includes('Loading music'));
});
