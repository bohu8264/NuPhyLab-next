import test from 'node:test';
import assert from 'node:assert/strict';
import {PhysicalPressGate} from '../server/codex-shortcuts.mjs';
import {fakeService,until} from './helpers/fake-service.mjs';

const gesture=(code,id,phase='down',eventSource='eventTap')=>({op:'codexKey',code,phase,gestureId:id,eventSource,eventTime:123.456});
const tasks=Array.from('abcdef',id=>({id,title:'Fixture '+id,status:'running'}));
const shortcuts=async service=>(await service.operations()).filter(op=>op.op==='shortcut');

test('F1/F2/F3 gesture identity survives late delivery and reset without dropping fast complete presses',()=>{
 for(const code of ['F1','F2','F3']){
  let now=1000;const gate=new PhysicalPressGate(()=>now);
  assert.equal(gate.down(code,'host:'+code+':1'),true);
  assert.equal(gate.down(code,'host:'+code+':1'),false,'held duplicate');
  assert.equal(gate.up(code,'host:'+code+':1'),true);
  now+=5000;assert.equal(gate.down(code,'host:'+code+':1'),false,'late duplicate after release');
  assert.equal(gate.down(code,'host:'+code+':2'),true,'new gesture does not use a cooldown');
  assert.equal(gate.up(code,'host:'+code+':1'),false,'old release cannot release new gesture');
  assert.equal(gate.up(code),false,'unidentified release cannot release identified gesture');
  assert.equal(gate.down(code,'host:'+code+':3'),false,'new gesture cannot replace a held gesture');
  assert.equal(gate.up(code,'host:'+code+':2'),true);
  now+=1;assert.equal(gate.down(code,'host:'+code+':4'),true,'fast distinct press accepted');
  gate.reset();assert.equal(gate.down(code,'host:'+code+':4'),false,'reset does not resurrect old gesture');
  assert.equal(gate.down(code,'host:'+code+':5'),true);
 }
});

test('legacy unidentified press keeps its prior cooldown and structured history is bounded',()=>{
 let now=1000;const gate=new PhysicalPressGate(()=>now);
 assert.equal(gate.down('F11'),true);gate.up('F11');now+=30;assert.equal(gate.down('F11'),false);gate.up('F11');
 now+=300;assert.equal(gate.down('F11'),true);gate.reset();
 for(let i=0;i<2100;i++){assert.equal(gate.down('F1','host:'+i),true);gate.up('F1','host:'+i);}
 assert.equal(gate.gestures.size,2048);
 for(const id of ['',null,'contains spaces','a'.repeat(161)])assert.throws(()=>gate.down('F1',id),/手势/);
});

test('real fake service F1/F2/F3 single, hold, release and fast successive gestures open once per identity',async t=>{
 const service=await fakeService(t,{tasks});
 await service.command({op:'settings',settings:{codexEnabled:true,codexSelectedPulse:false}});
 for(const [i,code]of ['F1','F2','F3'].entries()){
  const id='fixture:'+code+':1';
  assert.equal((await service.command(gesture(code,id))).ok,true);
  assert.equal((await service.command(gesture(code,id))).result.reason,'duplicate-press');
  assert.equal((await service.command(gesture(code,id,'up'))).ok,true);
  assert.equal((await service.command(gesture(code,id,'down','local'))).result.reason,'duplicate-press');
  assert.equal((await service.command(gesture(code,id+':next'))).ok,true);
  await service.command(gesture(code,id+':next','up'));
  assert.deepEqual((await shortcuts(service)).slice(i*2,i*2+2).map(x=>x.threadId),[tasks[i].id,tasks[i].id]);
 }
 assert.equal((await shortcuts(service)).length,6);
});

test('F2 late duplicate keeps its first captured target after a replacement frame and new gesture opens the replacement',async t=>{
 const service=await fakeService(t,{tasks});
 await service.command({op:'settings',settings:{codexEnabled:true,codexSelectedPulse:false}});
 await service.command(gesture('F2','fixture:F2:first'));await service.command(gesture('F2','fixture:F2:first','up'));
 assert.equal((await shortcuts(service))[0].threadId,'b');
 await service.configure({tasks:[{id:'g',title:'Fixture replacement',status:'running'},...tasks.filter(x=>x.id!=='b'),tasks[1]]});
 await until(service.state,s=>s.codex.slots[1]?.id==='g','replacement target not published');
 const late=await service.command(gesture('F2','fixture:F2:first','down','local'));
 assert.equal(late.result.reason,'duplicate-press');assert.equal((await shortcuts(service)).length,1);
 const trace=(await service.state()).codex.keys.gestureTrace;
 assert.equal(trace.filter(x=>x.stage==='received'&&x.gestureId==='fixture:F2:first').at(-1).targetId,'b');
 await service.command(gesture('F2','fixture:F2:second'));await service.command(gesture('F2','fixture:F2:second','up'));
 assert.deepEqual((await shortcuts(service)).map(x=>x.threadId),['b','g']);
});

test('stale structured or legacy release cannot release the next held command gesture',async t=>{
 const service=await fakeService(t,{tasks,codexKeybindings:[{command:'globalDictationHold',key:'Ctrl+Shift+D'}]});
 await service.command({op:'settings',settings:{codexEnabled:true}});
 await service.command(gesture('F9','fixture:dictation:1'));await service.command(gesture('F9','fixture:dictation:1','up'));
 await service.command(gesture('F9','fixture:dictation:2'));
 assert.equal((await service.command(gesture('F9','fixture:dictation:1','up'))).result.reason,'stale-release');
 assert.equal((await service.command({op:'codexKey',code:'F9',phase:'up'})).result.reason,'stale-release');
 assert.equal((await service.state()).codex.keys.held.source,'F9');
 await service.command(gesture('F9','fixture:dictation:2','up'));
 assert.equal((await service.state()).codex.keys.held,null);
 assert.deepEqual((await shortcuts(service)).map(x=>x.phase),['down','up','down','up']);
});

test('gesture metadata rejects invalid input and trace contains only bounded F-key metadata',async t=>{
 const service=await fakeService(t,{tasks});await service.command({op:'settings',settings:{codexEnabled:true}});
 for(const change of [{gestureId:'bad id'},{eventSource:'not-a-source'},{phase:'tap'},{eventTime:-1}])assert.equal((await service.command({...gesture('F1','fixture:valid'),...change})).ok,false);
 assert.equal((await shortcuts(service)).length,0);
 await service.command({...gesture('F1','fixture:valid'),gestureId:undefined,eventSource:'do-not-record-source-text',eventTime:'do-not-record-time-text'});
 const trace=(await service.state()).codex.keys.gestureTrace;assert.ok(trace.length<=64);
 assert.equal(JSON.stringify(trace).includes('do-not-record'),false);
 const allowed=new Set(['at','stage','code','source','phase','gestureId','eventTime','accepted','reason','targetId']);
 for(const row of trace){assert.match(row.code,/^F(?:[1-9]|1[0-2])$/);assert.ok(Object.keys(row).every(k=>allowed.has(k)));}
});
