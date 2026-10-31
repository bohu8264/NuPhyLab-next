import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {watchNativeParent} from '../server/parent-lifetime.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('a native worker stops once after host death and safely absorbs closed log pipes during restoration',async()=>{
  const stdout=new EventEmitter(),stderr=new EventEmitter();let parent=1234,lost=0;
  const stop=watchNativeParent({parentPid:'1234',getParentPid:()=>parent,streams:[stdout,stderr],onLost:()=>lost++,intervalMs:10});
  try {
    await wait(20);assert.equal(lost,0);
    parent=1;await wait(30);assert.equal(lost,1);
    stdout.emit('error',Object.assign(new Error('closed host'),{code:'EPIPE'}));
    stderr.emit('error',Object.assign(new Error('closed host'),{code:'EPIPE'}));
    await wait(20);assert.equal(lost,1);
  } finally {stop();}
});
test('a closed host pipe starts cleanup without waiting for PID polling',async()=>{
  const output=new EventEmitter();let lost=0;
  const stop=watchNativeParent({parentPid:1234,getParentPid:()=>1234,streams:[output],onLost:()=>lost++,intervalMs:1000});
  try {output.emit('error',Object.assign(new Error('gone'),{code:'EPIPE'}));assert.equal(lost,1);await wait(5);assert.equal(lost,1);}finally{stop();}
});
test('standalone services stay independent while invalid or already-lost native parents fail closed',async()=>{
  const output=new EventEmitter();let lost=0;
  const stop=watchNativeParent({streams:[output],onLost:()=>lost++});await wait(5);assert.equal(output.listenerCount('error'),0);assert.equal(lost,0);stop();
  for(const parentPid of ['bad','0','1','999999999999999999999','1234']){
    const dispose=watchNativeParent({parentPid,getParentPid:()=>1,streams:[output],onLost:()=>lost++});
    const before=lost;await wait(5);assert.equal(lost,before+1);dispose();
  }
});
