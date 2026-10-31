import test from 'node:test';import assert from 'node:assert/strict';
import{appDraftFixture,scene,deferred}from'./helpers/app-draft-fixture.mjs';
const key='air-studio-draft-v1',copy=v=>JSON.parse(JSON.stringify(v));
const target=()=>scene('Target artwork',{id:'target-fixture',colors:Array(84).fill('#77aa88'),animation:{effect:'wave',direction:'left',speed:7,loop:true}});
async function library(f){await f.click('作品库');return f.child('Library');}
async function request(f,kind){const lib=await library(f);if(kind==='new')lib.props.onNew();else lib.props.onLoad(target(),kind==='play'?{play:true}:undefined);await f.flush();assert.equal(f.modal()?.props.title,'当前草稿有未保存修改');}
const guardPrimary=f=>f.nodes().find(n=>n.type?.displayName==='Button'&&n.props.kind==='primary');
const alerts=f=>f.nodes().filter(n=>n.props.role==='alert').map(n=>f.text(n)).join('\n');

for(const kind of['open','new','play'])test(`actual App dirty ${kind}: cancel preserves draft/output/storage and emits no stop/save`,async()=>{
 const f=await appDraftFixture();const before=copy(f.draft()),stored=f.storage.get(key);await request(f,kind);assert.deepEqual(copy(f.draft()),before);assert.equal(f.commands.length,0);assert.equal(f.storage.get(key),stored);await f.click('取消');assert.equal(f.modal(),undefined);assert.deepEqual(copy(f.draft()),before);assert.equal(f.storage.get(key),stored);assert.equal(f.commands.length,0);f.unmount();
});
for(const kind of['open','new'])test(`actual App dirty ${kind}: stop failure retains saved canvas and retry does not save duplicate ID`,async()=>{
 let stop=0;const f=await appDraftFixture({onCommand:async(body,{state})=>{if(body.op==='saveScene'){const saved={...copy(body.scene),updatedAt:'saved'};state.scenes.push(saved);return{savedScene:saved};}if(body.op==='stop'&&++stop===1)throw Error('fixture stop failed');return{ok:true};}});const before=copy(f.draft());await request(f,kind);await f.click(guardPrimary(f));assert.equal(f.commands.filter(x=>x.op==='saveScene').length,1);assert.equal(f.commands.filter(x=>x.op==='stop').length,1);assert.ok(f.modal());assert.ok(alerts(f).includes('当前画布未替换'));assert.deepEqual(copy(f.draft()).colors,before.colors);assert.ok(f.draft().id);const savedId=f.draft().id;await f.click(guardPrimary(f));assert.equal(f.commands.filter(x=>x.op==='saveScene').length,1);assert.equal(f.commands.filter(x=>x.op==='stop').length,2);assert.equal(f.state.scenes.length,1);assert.equal(f.state.scenes[0].id,savedId);assert.equal(f.modal(),undefined);assert.equal(f.draft().name,kind==='new'?'未命名作品':'Target artwork');f.unmount();
});
test('actual App save failure retains draft and retry reuses the same new scene identity',async()=>{
 let saves=0;const f=await appDraftFixture({onCommand:async(body,{state})=>{if(body.op==='saveScene'){if(++saves===1)throw Error('fixture save failed');const saved=copy(body.scene);state.scenes.push(saved);return{savedScene:saved};}return{ok:true};}});const before=copy(f.draft());await request(f,'open');await f.click(guardPrimary(f));assert.equal(f.commands.some(c=>c.op==='stop'),false);assert.deepEqual(copy(f.draft()),before);assert.ok(f.modal());assert.ok(alerts(f).includes('已保留名称和画布'));await f.click(guardPrimary(f));const savesSent=f.commands.filter(c=>c.op==='saveScene');assert.equal(savesSent.length,2);assert.equal(savesSent[0].scene.id,savesSent[1].scene.id);assert.equal(f.state.scenes.length,1);assert.equal(f.draft().name,'Target artwork');f.unmount();
});
test('actual App open/new transition locks concurrent requests and adopts only after stop succeeds once',async()=>{
 const wait=deferred();const f=await appDraftFixture({onCommand:body=>body.op==='stop'?wait.promise:Promise.resolve({ok:true})});await request(f,'open');const before=copy(f.draft()),discard=f.button('放弃修改并打开');discard.props.onClick();discard.props.onClick();await f.flush();assert.equal(f.commands.filter(c=>c.op==='stop').length,1);assert.deepEqual(copy(f.draft()),before);assert.ok(f.modal());wait.resolve({ok:true});await f.flush();assert.equal(f.modal(),undefined);assert.equal(f.draft().name,'Target artwork');assert.equal(f.commands.length,1);f.unmount();
});
test('actual App explicit play adopts once with no ordinary-load stop; request is consumed without new request',async()=>{
 const f=await appDraftFixture();await request(f,'play');const lib=f.child('Library');lib.props.onLoad(scene('Ignored second target'),{play:true});await f.click('放弃修改并播放');const studio=f.child('Studio'),requestId=studio.props.playRequestId,session=studio.key;assert.ok(requestId);assert.equal(f.draft().name,'Target artwork');assert.equal(f.commands.length,0);studio.props.onPlayRequestHandled();studio.props.onPlayRequestHandled();await f.flush();assert.equal(f.child('Studio').props.playRequestId,null);assert.equal(f.child('Studio').key,session);f.child('Studio').props.onPlayRequestFinished();await f.flush();assert.equal(f.commands.length,0);f.unmount();
});
test('actual App damaged stored draft is never overwritten by fallback or edits; read retry cancel preserves repaired record',async()=>{
 const damaged='{broken';const f=await appDraftFixture({storage:{[key]:damaged}});assert.ok(alerts(f).includes('原记录已保留'));assert.equal(f.storage.get(key),damaged);assert.equal(f.writes.length,0);await f.edit({name:'Edited fallback'});assert.equal(f.storage.get(key),damaged);assert.equal(f.writes.length,0);const recovered=scene('Recovered draft');const raw=JSON.stringify(recovered);f.storage.set(key,raw);await f.click('重试读取');assert.ok(f.modal());assert.equal(f.commands.length,0);await f.click('取消');assert.equal(f.storage.get(key),raw);assert.equal(f.draft().name,'Edited fallback');assert.ok(alerts(f).includes('原记录已保留'));await f.click('重试读取');await f.click('放弃修改并打开');assert.equal(f.draft().name,'Recovered draft');assert.equal(f.commands.filter(c=>c.op==='stop').length,0,'restoreKey adoption never stops old output');assert.equal(alerts(f),'');f.unmount();
});
test('actual App empty-name valid draft is restored and guard accepts an explicit recovery name',async()=>{
 const draft=scene('',{animation:{effect:'frames',direction:'right',speed:4,loop:true,frames:[]}});const f=await appDraftFixture({draft});assert.equal(f.draft().name,'');assert.deepEqual(copy(f.draft()).animation.frames,[]);await request(f,'new');assert.equal(guardPrimary(f).props.disabled,true);const input=f.nodes().find(n=>n.props['aria-label']==='保存当前草稿名称');assert.ok(input);input.props.onChange({target:{value:'Named recovered draft'}});await f.flush();await f.click(guardPrimary(f));assert.equal(f.commands.find(c=>c.op==='saveScene').scene.name,'Named recovered draft');assert.equal(f.state.scenes.length,1);assert.equal(f.draft().name,'未命名作品');f.unmount();
});
test('actual App quota failure keeps latest in-window draft and alert through repeated retry until storage succeeds',async()=>{
 const f=await appDraftFixture({quota:true});assert.ok(alerts(f).includes('草稿自动保存失败'));await f.edit({name:'Latest unsaved',colors:Array(84).fill('#123456')});for(let i=0;i<2;i++){await f.click('重试自动保存');assert.ok(alerts(f).includes('草稿自动保存失败'));assert.equal(f.draft().name,'Latest unsaved');}assert.equal(f.commands.length,0);f.setQuota(false);await f.click('重试自动保存');assert.equal(alerts(f),'');assert.deepEqual(JSON.parse(f.storage.get(key)),copy(f.draft()));assert.equal(f.commands.length,0);f.unmount();
});
test('actual production draft parser rejects invalid structures but retains empty name and unfinished empty frames',async()=>{
 const f=await appDraftFixture();for(const bad of['not JSON',JSON.stringify({}),JSON.stringify(scene('bad',{colors:['#000000']})),JSON.stringify(scene('bad',{animation:{effect:'wave',direction:'right',speed:99,loop:true}})),JSON.stringify(scene('bad',{animation:{effect:'wave',direction:'right',speed:4,loop:true,brightness:101}}))])assert.throws(()=>f.parseDraftRecord(bad));const valid=scene('',{animation:{effect:'frames',direction:'right',speed:4,loop:true,frames:[]}});assert.equal(f.parseDraftRecord(JSON.stringify(valid)).name,'');f.unmount();
});

test('actual App storage read throws: editing fallback never overwrites the inaccessible original record',async()=>{
 const original=JSON.stringify(scene('Stored original'));const f=await appDraftFixture({storage:{[key]:original},readFailure:true});assert.ok(alerts(f).includes('原记录已保留'));assert.equal(f.writes.length,0);await f.edit({name:'Fallback edits'});await f.click('重试读取');assert.equal(f.storage.get(key),original);assert.equal(f.writes.length,0);assert.equal(f.commands.length,0);assert.equal(f.draft().name,'Fallback edits');assert.ok(alerts(f).includes('原记录已保留'));f.unmount();
});

test('actual App save transport error with matching readback acknowledges one identity instead of duplicating',async()=>{
 const f=await appDraftFixture({onCommand:async(body,{state})=>{if(body.op==='saveScene'){state.scenes.push(copy(body.scene));throw Error('fixture reply lost after commit');}return{ok:true};}});await request(f,'open');await f.click(guardPrimary(f));assert.equal(f.commands.filter(c=>c.op==='saveScene').length,1);assert.equal(f.commands.filter(c=>c.op==='stop').length,1);assert.equal(f.state.scenes.length,1);assert.equal(f.draft().name,'Target artwork');assert.equal(f.modal(),undefined);f.unmount();
});

for(const phase of['save','stop'])for(const change of['disconnect','model'])test(`actual App pending ${phase} then ${change}: late response cannot adopt stale target, and transition locks release`,async()=>{
 const wait=deferred();let stops=0;const f=await appDraftFixture({onCommand:async(body,{state})=>{
  if(body.op==='saveScene'){await wait.promise;const saved=copy(body.scene);state.scenes.push(saved);return{savedScene:saved};}
  if(body.op==='stop'&&++stops===1&&phase==='stop')await wait.promise;
  return{ok:true};
 }});await request(f,'open');if(phase==='save')guardPrimary(f).props.onClick();else f.button('放弃修改并打开').props.onClick();await f.flush();const original=copy(f.draft());
 if(change==='disconnect'){f.state.device.connected=false;f.api.serviceError='fixture service unavailable';}
 else{f.storage.set('nuphylab-draft-kick75-v1',JSON.stringify(scene('Kick retained draft',{colors:Array(84).fill('#abcdef')})));f.api.layout=f.layout.slice(0,80);}
 f.render();await f.flush();assert.equal(f.modal(),undefined);const afterChange=copy(f.draft());wait.resolve({ok:true});await f.flush();assert.notEqual(f.draft().name,'Target artwork');assert.equal(f.draft().name,change==='model'?'Kick retained draft':original.name);assert.deepEqual(copy(f.draft()).colors,afterChange.colors);if(phase==='save')assert.equal(f.commands.some(c=>c.op==='stop'),false,'stale save cannot dispatch ordinary-load stop');
 if(change==='disconnect'){f.state.device.connected=true;f.api.serviceError='';f.render();await f.flush();}
 await f.click('灯光创作');await f.edit({name:'New context unsaved edit'});await request(f,'open');await f.click('放弃修改并打开');assert.equal(f.modal(),undefined);assert.equal(f.draft().name,'Target artwork','new context action succeeds after old lock finally releases');assert.equal(f.commands.filter(c=>c.op==='stop').length,phase==='stop'?2:1);f.unmount();
});

async function createExplicitNew(f,{quota=false}={}){
 await request(f,'new');if(quota)f.setQuota(true);await f.click('放弃修改并新建');assert.equal(f.modal(),undefined);assert.equal(f.draft().name,'未命名作品');assert.ok(f.draft().colors.every(c=>c==='#000000'));return copy(f.draft());
}

test('FR05 explicit new, successfully adopted and never edited, bypasses the next open/new/play guard',async()=>{
 for(const action of['open','new','play']){
  const f=await appDraftFixture();await createExplicitNew(f);const previousSession=f.child('Studio').key,lib=await library(f);
  if(action==='new')lib.props.onNew();else lib.props.onLoad(target(),action==='play'?{play:true}:undefined);
  await f.flush();assert.equal(f.modal(),undefined,action+' must not guard untouched explicit creation');assert.equal(f.commands.some(c=>c.op==='saveScene'),false);assert.equal(f.child('Studio').key,previousSession+1);
  if(action==='new')assert.equal(f.draft().name,'未命名作品');else assert.equal(f.draft().name,'Target artwork');if(action==='play')assert.ok(f.child('Studio').props.playRequestId);f.unmount();
 }
});

test('FR05 any Studio edit consumes explicit-new provenance even after clearing or undoing back to baseline',async()=>{
 const f=await appDraftFixture(),baseline=await createExplicitNew(f);await f.edit({colors:Array(84).fill('#ff0000')});await f.edit({colors:baseline.colors});await f.edit({animation:{...baseline.animation,brightness:50}});await f.edit({animation:baseline.animation});assert.deepEqual(copy(f.draft()),baseline);await request(f,'open');assert.ok(f.modal());assert.deepEqual(copy(f.draft()),baseline);f.unmount();
});

test('FR05 restored blank with no explicit-new provenance still requires the dirty guard',async()=>{
 const f=await appDraftFixture({draft:scene('未命名作品',{colors:Array(84).fill('#000000')})});await request(f,'open');assert.ok(f.modal());assert.equal(f.commands.length,0);assert.equal(f.draft().name,'未命名作品');f.unmount();
});

test('FR05 explicit new with an unresolved quota failure still requires the dirty guard',async()=>{
 const f=await appDraftFixture();const baseline=await createExplicitNew(f,{quota:true});assert.ok(alerts(f).includes('草稿自动保存失败'));await request(f,'open');assert.ok(f.modal());assert.deepEqual(copy(f.draft()),baseline);assert.equal(f.commands.some(c=>c.op==='saveScene'),false);f.unmount();
});
