import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveAgentLightingView,renderAgentLightingPreview} from '../shared/agent-lighting-view.mjs';
import {CodexLights} from '../shared/codex-lighting.mjs';
import {ClaudeLights} from '../shared/claude-lighting.mjs';
import {airLayout,kickLayout,setLayoutModel} from '../shared/layout.mjs';
import {codexBindings} from '../shared/codex-keys.mjs';
import {claudeBindings} from '../shared/claude-keys.mjs';

const blank=()=>Array(84).fill('#000000');
const tasks=[{id:'a',title:'Running task',status:'running'},{id:'b',title:'Idle task',status:'idle'}];
function state(source='codex',patch={}) {
  return {settings:{agentSource:source,[`${source}Enabled`]:true,[`${source}LightMode`]:'keys'},
    device:{connected:true,armed:true,connectionSessionId:'fixture-session:1',capabilities:{perKey:true}},playback:{mode:'agent'},
    [source]:{available:true,taskSource:{available:true},tasks,slots:tasks,lighting:{selectedId:'a',ownsOutput:true,outputOwner:{source,connectionSessionId:'fixture-session:1',transportEpoch:0,mode:'keys',bindingEpoch:1,frameCommittedAt:100},pausedReason:null}},...patch};
}

test('preview preserves USB palette, time and bindings without global LED dimming',()=>{
  for(const [model,layout] of [['air75-v3',airLayout],['kick75',kickLayout]]) {
    setLayoutModel(model);
    for(const source of ['codex','claude']) {
      const settings={brightness:27,[`${source}Brightness`]:50,[`${source}Ambient`]:true,[`${source}SelectedPulse`]:false};
      const bindings=(source==='codex'?codexBindings:claudeBindings)(settings);
      let now=0;const engine=new (source==='codex'?CodexLights:ClaudeLights)(()=>now);engine.select('a');
      const first=renderAgentLightingPreview(source,tasks,settings,tasks,'a',0);
      for(const at of [0,170,900]) {
        now=at;
        assert.deepEqual(renderAgentLightingPreview(source,tasks,settings,tasks,'a',at),engine.render(blank(),tasks,settings,tasks));
      }
      const next=renderAgentLightingPreview(source,tasks,settings,tasks,'a',170);
      const commands=bindings.slice(6).map(binding=>binding.ledIndex).filter(index=>index!==null);
      assert.notDeepEqual(commands.map(index=>first[index]),commands.map(index=>next[index]));
      assert.equal(first[bindings[6].ledIndex],'#18287f');
      const pulsing={...settings,[`${source}Ambient`]:false,[`${source}SelectedPulse`]:true};
      assert.notDeepEqual(renderAgentLightingPreview(source,tasks,pulsing,tasks,'a',0),renderAgentLightingPreview(source,tasks,pulsing,tasks,'a',900));
      const whole=renderAgentLightingPreview(source,tasks,{...settings,[`${source}LightMode`]:'whole'},tasks,'a',0);
      assert.equal(new Set(layout.map(key=>whole[key.index])).size,1);
      assert.equal(whole[layout[0].index],first[bindings[0].ledIndex]);
      const mapped=new Set(layout.map(key=>key.index));
      assert.ok(whole.every((color,index)=>mapped.has(index)||color==='#000000'));
    }
  }
  setLayoutModel('air75-v3');
});

test('ambient preview is off by default, needs a bound control task and preserves non-running semantics',()=>{
  for(const source of ['codex','claude']) {
    const bindings=(source==='codex'?codexBindings:claudeBindings)({});
    const commandFrame=(settings,selectedId,at=0)=>bindings.slice(6).map(key=>renderAgentLightingPreview(source,tasks,settings,tasks,selectedId,at)[key.ledIndex]);
    assert.deepEqual(commandFrame({},'a'),Array(6).fill('#000000'));
    assert.deepEqual(commandFrame({[`${source}Ambient`]:true},''),Array(6).fill('#000000'));
    assert.deepEqual(commandFrame({[`${source}Ambient`]:true},'missing'),Array(6).fill('#000000'));
    const settings={[`${source}Ambient`]:true,[`${source}SelectedPulse`]:false};
    const nonRunning=tasks.map(task=>({...task,status:source==='claude'?'awaitingInput':'completed'}));
    const one=renderAgentLightingPreview(source,nonRunning,settings,nonRunning,'a',0),two=renderAgentLightingPreview(source,nonRunning,settings,nonRunning,'a',170);
    assert.deepEqual(bindings.slice(6).map(key=>one[key.ledIndex]),Array(6).fill('#00a631'));
    assert.deepEqual(one,two);
    const absent=renderAgentLightingPreview(source,[tasks[1]],settings,tasks,'a',170);
    assert.ok(bindings.slice(6).every(key=>absent[key.ledIndex]==='#000000'));
  }
});

test('whole preview follows sole, selected or explicit task without silently selecting another task',()=>{
  for(const source of ['codex','claude']) {
    const settings={[`${source}LightMode`]:'whole',[`${source}SelectedPulse`]:false};
    assert.ok(renderAgentLightingPreview(source,tasks,settings,tasks).every(color=>color==='#000000'));
    assert.equal(renderAgentLightingPreview(source,[tasks[0]],settings,[tasks[0]])[0],'#304ffe');
    assert.equal(renderAgentLightingPreview(source,tasks,settings,tasks,'a')[0],'#304ffe');
    assert.ok(renderAgentLightingPreview(source,tasks,{...settings,[`${source}WholeTaskId`]:'missing'},tasks,'a').every(color=>color==='#000000'));
    assert.equal(resolveAgentLightingView(source,state(source,{settings:{...settings,[`${source}WholeTaskId`]:'missing'}})).wholeTask,null);
  }
});

test('presentation accepts only a current committed source receipt and rejects protected output',()=>{
  for(const source of ['codex','claude']) {
    const own=state(source);assert.equal(resolveAgentLightingView(source,own).showing,true);
    for(const mode of ['static','animation','paused','audio'])
      assert.equal(resolveAgentLightingView(source,{...own,playback:{mode}}).ownsOutput,true,'committed overlay on '+mode);
    for(const mode of ['game','trigger'])
      assert.equal(resolveAgentLightingView(source,{...own,playback:{mode}}).ownsOutput,false,'protected '+mode);
    assert.equal(resolveAgentLightingView(source,{...own,settings:{...own.settings,agentSource:source==='codex'?'claude':'codex'}}).ownsOutput,false);
    assert.equal(resolveAgentLightingView(source,{...own,settings:{...own.settings,[`${source}Enabled`]:false}}).ownsOutput,false);
    for(const patch of [{connected:false},{armed:false},{capabilities:{perKey:false}},{readOnly:true}])
      assert.equal(resolveAgentLightingView(source,{...own,device:{...own.device,...patch}}).ownsOutput,false);
    assert.equal(resolveAgentLightingView(source,{...own,firmware:{compatible:false}}).blockedReason,'unsupported');
    assert.equal(resolveAgentLightingView(source,own,{serviceUnknown:true}).ownsOutput,false);
    const sleeping=resolveAgentLightingView(source,{...own,lightPower:{sleeping:true}});
    assert.equal(sleeping.ownsOutput,true);assert.equal(sleeping.showing,true);assert.equal(sleeping.sleeping,false);assert.equal(sleeping.backgroundSleeping,true);
    for(const patch of [{ownsOutput:false},{outputOwner:null},{pausedReason:'recording'},{pausedReason:'waitingOutput'},
      {outputOwner:{...own[source].lighting.outputOwner,source:source==='codex'?'claude':'codex'}},
      {outputOwner:{...own[source].lighting.outputOwner,connectionSessionId:'old-session'}},
      {outputOwner:{...own[source].lighting.outputOwner,mode:'whole'}},
      {outputOwner:{...own[source].lighting.outputOwner,frameCommittedAt:null}}]){
      const changed={...own,[source]:{...own[source],lighting:{...own[source].lighting,...patch}}};
      assert.equal(resolveAgentLightingView(source,changed).ownsOutput,false,JSON.stringify(patch));
    }
    const oldSnapshot={...own,[source]:{...own[source],lighting:{selectedId:'a'}}};
    assert.equal(resolveAgentLightingView(source,oldSnapshot).ownsOutput,false,'mode=agent by itself is not a fresh output receipt');
  }
  assert.equal(resolveAgentLightingView('codex',null).blockedReason,'serviceUnknown');
});

test('unavailable and empty integrations are distinct from valid color output and do not choose tasks',()=>{
  for(const source of ['codex','claude']) {
    const own=state(source);
    assert.equal(resolveAgentLightingView(source,{...own,[source]:{...own[source],available:false}}).blockedReason,'integrationUnavailable');
    const empty=resolveAgentLightingView(source,{...own,[source]:{available:true,tasks:[],slots:[],lighting:{selectedId:''}}});
    assert.equal(empty.ready,true);assert.equal(empty.tasks.length,0);assert.equal(empty.animated,false);
    const unset=resolveAgentLightingView(source,{...own,[source]:{...own[source],lighting:{selectedId:''}}});
    assert.equal(unset.selectedTask,null);assert.equal(unset.ambientTask,null);assert.equal(unset.animated,false);
    const bound=resolveAgentLightingView(source,own);assert.equal(bound.animated,true);
    assert.equal(resolveAgentLightingView(source,{...own,settings:{...own.settings,[`${source}SelectedPulse`]:false}}).animated,false);
  }
});

test('preview leaves tasks, source palette and settings unchanged; zero brightness explicitly stays dark',()=>{
  const frozenTasks=Object.freeze(tasks.map(task=>Object.freeze({...task})));
  const settings=Object.freeze({codexAmbient:true,codexLightMode:'whole',codexWholeTaskId:'a',codexBrightness:100,brightness:0});
  assert.ok(renderAgentLightingPreview('codex',frozenTasks,settings,frozenTasks,'a',500).every(color=>color==='#000000'));
  assert.deepEqual(frozenTasks,tasks);assert.equal(settings.brightness,0);
});
