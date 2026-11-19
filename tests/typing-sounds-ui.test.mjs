import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVMEnvironment,walkAll,textOf,plain,deferred} from './helpers/source-ui-vm.mjs';
import {appDraftFixture} from './helpers/app-draft-fixture.mjs';
import {translate} from '../shared/i18n.mjs';

// Execute production React source with a deterministic bridge double. No real
// input monitoring, audio, WebKit, user preferences, service or hardware.
const catalog=JSON.parse(await readFile(new URL('../assets/typing-sounds/catalog.json',import.meta.url),'utf8'));
const defaults=()=>({preferences:{enabled:false,pack:'mahjong-crisp',volume:50,muted:false,release:70,variation:true,gains:{space:100,enter:100,backspace:100,shiftLeft:100,shiftRight:100,tab:100,caps:100},favorites:[]},state:'off',reason:'',inputMonitoring:false,previewing:false,catalog:{categories:catalog.categories,packs:catalog.packs},issue:''});
const nodes=(tree,predicate)=>walkAll(tree,predicate);
const byLabel=(tree,label)=>nodes(tree,n=>n.props?.['aria-label']===label)[0];
const button=(tree,label)=>nodes(tree,n=>n.type==='button'&&textOf(n).trim()===label)[0];
const cards=tree=>nodes(tree,n=>n.type==='article'&&n.props['data-sound']);
async function ticks(instance){for(let i=0;i<35;i++){await Promise.resolve();instance?.render();}}
async function fixture(t,{language='en',missing=false,initial,handle}={}){
  const ui=createVMEnvironment({'lucide-react':new Proxy({},{get:()=>()=>null})});
  ui.document.documentElement.lang=language;
  const state=initial??defaults(),calls=[];
  if(!missing)ui.window.webkit={messageHandlers:{typingSounds:{postMessage(body){
    body=plain(body);calls.push(body);
    const request=Promise.resolve().then(async()=>{
      const custom=await handle?.(body,state);if(custom!==undefined)return custom;
      if(body.op==='save'){
        Object.assign(state.preferences,body.patch);
        state.state=!state.preferences.enabled?'off':state.inputMonitoring?'ready':'permission';
      }
      if(body.op==='preview')state.previewing=true;
      if(body.op==='stopPreview')state.previewing=false;
      return structuredClone(state);
    });
    ui.track(request.catch(()=>{}));return request;
  }}}};
  const {exports}=await ui.load(new URL('../ui/src/TypingSounds.tsx',import.meta.url));
  const instance=ui.mount(exports.TypingSounds);
  await ticks(instance);await ui.settle(instance);
  t.after(async()=>{instance.unmount();await ticks();});
  async function click(node){assert.ok(node,'Control exists');assert.ok(!node.props.disabled,'Control is enabled');node.props.onClick();await ticks(instance);await ui.settle(instance);}
  return {ui,instance,exports,state,calls,click,get tree(){return instance.tree;}};
}

test('no native bridge never claims readiness or enables playback controls',async t=>{
  const f=await fixture(t,{missing:true});
  assert.match(textOf(f.tree),/Unavailable/);
  assert.doesNotMatch(textOf(f.tree),/sounds are ready/);
  assert.equal(byLabel(f.tree,'Enable typing sounds').props.disabled,true);
  assert.equal(button(f.tree,'Preview').props.disabled,true);
  assert.equal(f.ui.storage.size,0);
});

test('enable saves only the requested preference; preview needs no permission; permission is explicit',async t=>{
  const f=await fixture(t);
  await f.click(byLabel(f.tree,'Enable typing sounds'));
  assert.deepEqual(f.calls.at(-1),{op:'save',patch:{enabled:true}});
  assert.match(textOf(f.tree),/Permission needed/);
  assert.equal(f.calls.some(c=>c.op==='permission'),false);
  await f.click(button(f.tree,'Preview'));
  assert.deepEqual(f.calls.at(-1),{op:'preview',pack:'mahjong-crisp'});
  assert.equal(f.state.inputMonitoring,false);
  await f.click(button(f.tree,'Open System Settings'));
  assert.equal(f.calls.filter(c=>c.op==='permission').length,1);
  assert.equal(f.state.preferences.enabled,true);
});

for(const language of ['zh-CN','en'])test(`18 catalog sounds, six filters, search and favorites work in ${language}`,async t=>{
  const f=await fixture(t,{language}),en=language==='en';
  assert.deepEqual(cards(f.tree).map(n=>n.props['data-sound']),['mahjong-crisp','wood-bamboo','soft-velvet']);
  await f.click(button(f.tree,en?'Sound library':'声音库'));
  assert.equal(cards(f.tree).length,18);
  for(const category of catalog.categories){
    await f.click(button(f.tree,en?category.en:category.zh));
    assert.equal(cards(f.tree).length,3);
    assert.ok(cards(f.tree).every(n=>catalog.packs.find(p=>p.id===n.props['data-sound']).category===category.id));
  }
  await f.click(button(f.tree,en?'All':'全部'));
  byLabel(f.tree,en?'Search sounds or character':'搜索声音或听感').props.onChange({target:{value:'Bamboo'}});f.instance.render();
  assert.deepEqual(cards(f.tree).map(n=>n.props['data-sound']),['wood-bamboo']);
  const pack=catalog.packs.find(p=>p.id==='wood-bamboo');
  await f.click(byLabel(f.tree,(en?'Favorite ':'收藏 ')+pack.names[en?'en':'zh']));
  assert.deepEqual(f.state.preferences.favorites,['wood-bamboo']);
  await f.click(button(f.tree,en?'Favorites':'收藏'));
  assert.equal(cards(f.tree).length,1);
  await f.click(byLabel(f.tree,(en?'Favorite ':'收藏 ')+pack.names[en?'en':'zh']));
  assert.equal(cards(f.tree).length,0);
  await f.click(button(f.tree,en?'Clear filters':'清除筛选'));
  assert.equal(cards(f.tree).length,18);
});

test('preview leaves chosen pack unchanged; choosing a pack never starts playback',async t=>{
  const f=await fixture(t),wood=()=>cards(f.tree).find(n=>n.props['data-sound']==='wood-bamboo');
  await f.click(button(wood(),'Preview'));
  assert.deepEqual(f.calls.at(-1),{op:'preview',pack:'wood-bamboo'});
  assert.equal(f.state.preferences.pack,'mahjong-crisp');
  const count=f.calls.filter(c=>c.op==='preview').length;
  await f.click(byLabel(wood(),'Use Bamboo Knock'));
  assert.deepEqual(f.calls.at(-1),{op:'save',patch:{pack:'wood-bamboo'}});
  assert.equal(f.calls.filter(c=>c.op==='preview').length,count);
});

test('eight key previews and seven gains keep large-key settings independent',async t=>{
  const f=await fixture(t),groups=['regular','space','enter','backspace','shiftLeft','shiftRight','tab','caps'];
  await f.click(button(f.tree,'Key tuning'));
  const keyButtons=nodes(f.tree,n=>n.type==='button'&&n.props['aria-label']?.startsWith('Preview '));
  assert.equal(keyButtons.length,8);
  for(let i=0;i<keyButtons.length;i++){
    await f.click(keyButtons[i]);
    assert.deepEqual(f.calls.at(-1),{op:'preview',pack:'mahjong-crisp',group:groups[i]});
  }
  const ranges=nodes(f.tree,n=>n.type===f.exports.SoundRange&&n.props.max===150);
  assert.equal(ranges.length,7);
  // Both callbacks run before React paints; the second must merge the first's result.
  ranges.find(n=>n.props.label==='Space').props.onCommit(130);
  ranges.find(n=>n.props.label==='Return').props.onCommit(85);
  await ticks(f.instance);await f.ui.settle(f.instance);
  assert.deepEqual(f.state.preferences.gains,{space:130,enter:85,backspace:100,shiftLeft:100,shiftRight:100,tab:100,caps:100});
  await f.click(button(f.tree,'Reset all'));
  assert.deepEqual(Object.values(f.state.preferences.gains),Array(7).fill(100));
});

test('release, variation and mute save isolated fields',async t=>{
  const f=await fixture(t),range=nodes(f.tree,n=>n.type===f.exports.SoundRange&&n.props.label==='Release strength')[0];
  range.props.onCommit(33);await ticks(f.instance);await f.ui.settle(f.instance);
  assert.deepEqual(f.calls.at(-1),{op:'save',patch:{release:33}});
  await f.click(byLabel(f.tree,'Natural variation'));
  assert.deepEqual(f.calls.at(-1),{op:'save',patch:{variation:false}});
  await f.click(byLabel(f.tree,'Mute output'));
  assert.deepEqual(f.calls.at(-1),{op:'save',patch:{muted:true}});
  assert.equal(f.state.preferences.volume,50);
  assert.equal(f.state.preferences.enabled,false);
});

test('permission, pause, preparing, mute and errors never appear as ready',async t=>{
  const f=await fixture(t),s=defaults();s.preferences.enabled=true;s.inputMonitoring=true;
  for(const reason of ['secureInput','session','recording','dictationUnconfirmed','listener']){
    s.state='paused';s.reason=reason;
    for(const en of [true,false])assert.equal(f.exports.typingReadiness(s,en).label,en?'Paused':'已暂停');
  }
  s.state='preparing';assert.equal(f.exports.typingReadiness(s,true).label,'Preparing');
  s.state='ready';s.inputMonitoring=false;assert.equal(f.exports.typingReadiness(s,true).label,'Permission needed');
  s.inputMonitoring=true;s.preferences.muted=true;assert.equal(f.exports.typingReadiness(s,true).label,'Output muted');
  s.preferences.muted=false;s.preferences.volume=0;assert.equal(f.exports.typingReadiness(s,true).label,'Output muted');
  s.preferences.volume=50;assert.equal(f.exports.typingReadiness(s,true).label,'On');
  assert.equal(f.exports.typingReadiness(s,true,true).label,'Status unconfirmed');
  s.state='error';s.issue='configuration';assert.match(f.exports.typingReadiness(s,true).detail,/library could not load/);
});

test('unconfirmed dictation stays paused and gives explicit bilingual recovery instructions',async t=>{
  for(const language of ['zh-CN','en']){
    const state=defaults();state.preferences.enabled=true;state.inputMonitoring=true;state.state='paused';state.reason='dictationUnconfirmed';
    const f=await fixture(t,{language,initial:state}),en=language==='en';
    const statusText=textOf(nodes(f.tree,n=>n.props?.role==='status')[0]);
    assert.ok(statusText.includes(en?'Dictation could not be confirmed stopped. Stop dictation in Codex, then turn Typing Sounds off and on.':'听写结束状态未确认。请先在 Codex 停止听写，再关闭并重新开启模拟声浪。'));
    assert.equal(byLabel(f.tree,en?'Enable typing sounds':'开启模拟声浪').props['aria-checked'],true);
    assert.deepEqual(f.calls.map(c=>c.op),['status']);
    await f.click(button(f.tree,en?'Check again':'重新检查'));
    assert.equal(f.state.state,'paused');
    assert.equal(f.calls.some(c=>c.op==='save'),false);
    state.reason='recording';
    assert.match(f.exports.typingReadiness(state,en).detail,en ? /shortcut recording/ : /录制快捷键/);
  }
});

test('native error codes have friendly bilingual text and failed saves preserve confirmed values',async t=>{
  const f=await fixture(t,{handle:body=>{if(body.op==='save')throw Error('settings');}});
  await f.click(byLabel(f.tree,'Enable typing sounds'));
  assert.equal(byLabel(f.tree,'Enable typing sounds').props['aria-checked'],false);
  assert.match(textOf(nodes(f.tree,n=>n.props?.role==='alert')[0]),/Settings could not be saved/);
  for(const code of ['configuration','audio','settings','cancelled','unavailable','unsupported','unknown']){
    assert.match(f.exports.typingIssue(code,false),/[\u4e00-\u9fff]/);
    assert.notEqual(f.exports.typingIssue(code,true),code);
  }
});

test('malformed native snapshot is rejected and cannot enable controls',async t=>{
  const f=await fixture(t,{handle:()=>({state:'ready'})});
  assert.equal(byLabel(f.tree,'Enable typing sounds').props.disabled,true);
  assert.doesNotMatch(textOf(f.tree),/sounds are ready/);
  const invalid=defaults();invalid.preferences.gains.space=151;
  assert.throws(()=>f.exports.parseTypingStatus(invalid),/invalidStatus/);
});

test('a pending poll is serialized before save and cannot restore stale preferences',async t=>{
  let hold=false;const gate=deferred();
  const f=await fixture(t,{handle:async(body,state)=>{if(body.op==='status'&&hold)return gate.promise;}});
  hold=true;const before=structuredClone(f.state);
  f.ui.window.dispatchEvent({type:'focus'});await ticks(f.instance);
  byLabel(f.tree,'Enable typing sounds').props.onClick();await ticks(f.instance);
  assert.equal(f.calls.filter(c=>c.op==='save').length,0);
  gate.resolve(before);await ticks(f.instance);await f.ui.settle(f.instance);
  assert.equal(f.state.preferences.enabled,true);
  assert.equal(byLabel(f.tree,'Enable typing sounds').props['aria-checked'],true);
});

test('leaving during a preview queues stop after completion and preserves global enabled state',async t=>{
  const state=defaults();state.preferences.enabled=true;state.inputMonitoring=true;state.state='ready';
  const gate=deferred();
  const f=await fixture(t,{initial:state,handle:async(body,s)=>{if(body.op==='preview'){await gate.promise;s.previewing=true;return structuredClone(s);}}});
  button(f.tree,'Preview').props.onClick();await ticks(f.instance);
  f.instance.unmount();await ticks();
  assert.equal(f.calls.at(-1).op,'preview');
  gate.resolve();await ticks();
  assert.equal(f.calls.at(-1).op,'stopPreview');
  assert.equal(f.state.previewing,false);
  assert.equal(f.state.preferences.enabled,true);
  assert.equal(f.calls.some(c=>c.op==='save'),false);
});

test('a preview queued behind a save never starts after leaving',async t=>{
  const gate=deferred();let holding=false;
  const f=await fixture(t,{handle:async body=>{if(body.op==='save'&&holding)await gate.promise;}});
  holding=true;
  byLabel(f.tree,'Enable typing sounds').props.onClick();
  button(f.tree,'Preview').props.onClick();
  await ticks(f.instance);f.instance.unmount();gate.resolve();await ticks();
  assert.equal(f.calls.some(c=>c.op==='preview'),false);
  assert.equal(f.calls.at(-1).op,'stopPreview');
  assert.equal(f.state.preferences.enabled,true);
});

test('range debounces changes, flushes once on completion, and rolls back failed persistence',async t=>{
  const f=await fixture(t),commits=[],props={label:'Volume',value:50,disabled:false,onCommit:v=>commits.push(v)};
  const range=f.ui.mount(f.exports.SoundRange,props),input=()=>nodes(range.tree,n=>n.type==='input')[0];
  for(const value of [51,60,72])input().props.onChange({target:{value:String(value)}});
  range.render();assert.deepEqual(commits,[]);assert.equal(input().props.value,72);
  input().props.onPointerUp();input().props.onBlur();input().props.onKeyUp();
  assert.deepEqual(commits,[72]);
  range.update({...props,disabled:true});assert.equal(input().props.value,72);
  range.update(props);assert.equal(input().props.value,50);
  input().props.onChange({target:{value:'61'}});range.render();
  const pending=[...f.ui.timers.values()].at(-1);pending();
  assert.deepEqual(commits,[72,61]);
  input().props.onChange({target:{value:'64'}});range.render();range.unmount();
  assert.deepEqual(commits,[72,61,64]);
});

test('formal navigation places Typing Sounds below Lighting Games and opens its independent page',async()=>{
  const app=await appDraftFixture({state:{settings:{sidebarFeatures:['studio','game','typing-sounds']}}});
  const nav=app.nodes().filter(n=>n.type==='button').map(n=>app.text(n));
  assert.ok(nav.indexOf('模拟声浪')>nav.indexOf('灯光游戏'));
  await app.click('模拟声浪');assert.ok(app.child('TypingSounds'));
  assert.equal(app.child('SelectionLab'),undefined);
  assert.equal(translate('en','模拟声浪'),'Typing Sounds');
  app.unmount();
});
