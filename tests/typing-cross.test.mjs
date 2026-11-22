import test from 'node:test';
import assert from 'node:assert/strict';
import {TypingCross,typingCrossThumbnail,MAX_TYPING_CROSS_WAVES} from '../shared/typing-cross.mjs';
import {airLayout,kickLayout,blank} from '../shared/layout.mjs';
import {TriggerEffect} from '../server/trigger.mjs';
import {validateScene} from '../server/storage.mjs';
import {triggerPlaybackConfig,validateTrigger} from '../shared/trigger.mjs';
import {createPresets} from '../shared/presets.mjs';
const config={effect:'cross',color:'#ffffff',speed:4};
const value=hex=>parseInt(hex.slice(1,3),16);

test('typing cross starts black, lights the pressed position and rays, then stops black',()=>{
  const cross=new TypingCross(airLayout),g=airLayout.find(key=>key.code==='KeyG');
  assert.deepEqual(cross.render(0),blank());
  assert.equal(cross.fire('KeyG',0),true);
  const peak=cross.render(35,config);
  assert.ok(value(peak[g.index])>230);
  assert.ok(peak.every(color=>/^#([0-9a-f]{2})\1\1$/.test(color)));
  const travel=cross.render(125,config);
  assert.ok(airLayout.some(key=>key.y===g.y&&key.code!=='KeyG'&&value(travel[key.index])>30));
  assert.ok(airLayout.some(key=>key.y!==g.y&&value(travel[key.index])>30));
  assert.equal(travel[airLayout.find(key=>key.code==='Escape').index],'#000000','distant diagonal stays dark');
  assert.equal(travel[83],'#000000');
  assert.deepEqual(cross.render(800,config),blank());
  assert.equal(cross.activeWaves,0);
});

test('continuous typing preserves independent earlier tails with bounded overlap',()=>{
  const single=new TypingCross(airLayout),together=new TypingCross(airLayout);
  single.fire('KeyA',0);together.fire('KeyA',0);together.fire('KeyL',250);
  const original=single.render(300),mixed=together.render(300);
  assert.ok(original.every((color,i)=>value(mixed[i])>=value(color)));
  assert.equal(together.activeWaves,2);
  together.render(810);assert.equal(together.activeWaves,1);
  assert.deepEqual(together.render(1050),blank());
  for(let at=0;at<100;at++)together.fire('Space',2000+at);
  assert.equal(together.activeWaves,MAX_TYPING_CROSS_WAVES);
  assert.equal(together.fire('Unidentified',2200),false);
});

test('speed changes expiry and colour channels without lighting phantom positions on either model',()=>{
  for(const keys of [airLayout,kickLayout]){
    const fast=new TypingCross(keys),slow=new TypingCross(keys);
    fast.fire('Space',0);slow.fire('Space',0);
    const red=fast.render(30,{color:'#ff0000',speed:8});
    assert.ok(red.some(color=>value(color)>0));assert.ok(red.every(color=>color.endsWith('0000')));
    assert.deepEqual(fast.render(400,{color:'#ff0000',speed:8}),blank());
    assert.ok(slow.render(900,{speed:2}).some(color=>color!=='#000000'));
    assert.deepEqual(slow.render(1600,{speed:2}),blank());
    for(const frame of [red,typingCrossThumbnail(keys)])
      for(let i=0;i<84;i++)if(!keys.some(key=>key.index===i))assert.equal(frame[i],'#000000');
  }
});

test('cross stays armed after its tail and saved colour/speed match appearance exactly once',()=>{
  const raw={...config,color:'#ff0000',speed:8};
  const scene=validateScene({name:'用户原名',colors:blank(),animation:{effect:'static',brightness:50},trigger:raw});
  assert.deepEqual(scene.trigger,validateTrigger(raw));
  const effective=triggerPlaybackConfig(scene.trigger,scene.animation);
  assert.equal(effective.color,'#800000');assert.equal(effective.speed,8);assert.equal(scene.trigger.color,'#ff0000');
  const effect=new TriggerEffect();effect.start(blank(),effective);
  effect.fire(0,'KeyG');assert.ok(effect.render(25).some(color=>value(color)>0));
  assert.deepEqual(effect.render(400),blank());assert.equal(effect.snapshot().armed,true);
  assert.equal(effect.snapshot().flashing,false);
  assert.equal(effect.fire(5000,'KeyL'),true);
  assert.ok(effect.render(5025).some(color=>color!=='#000000'));
  effect.cancel();assert.deepEqual(effect.render(5030),blank());assert.equal(effect.snapshot().armed,false);
});

test('the typing preset defaults to white and waits for real input',()=>{
  const catalog=createPresets(airLayout),preset=catalog.find(p=>p.id==='typing-cross');
  assert.equal(preset.name,'一石二鸟');assert.equal(preset.trigger.effect,'cross');
  assert.equal(preset.trigger.color,'#ffffff');assert.equal(preset.trigger.speed,4);
  assert.equal(preset.animation.effect,'static');assert.equal(preset.animation.frames.length,0);
  for(const bad of [{...config,color:'red'},{...config,speed:0},{...config,speed:11},{effect:'unknown'}])
    assert.throws(()=>validateTrigger(bad));
});
