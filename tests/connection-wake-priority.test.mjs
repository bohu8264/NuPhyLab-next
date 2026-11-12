import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeService,until} from './helpers/fake-service.mjs';

const identity={transport:'USB',vendorId:0x19f5,productId:0x1028,ledCount:104,keyLedCount:84,protocolReady:true};
const settings={autoConnect:true,codexEnabled:true,codexKeyAdaptation:true,claudeEnabled:false,
  quotaSideEnabled:false,lightDurationMs:0,lightIdleMs:0};
// Test the automatic connection itself; do not inject a legacy binding edit
// through fakeService after the welcome has already started.
const control={freshLibrary:true,skipInitialConnect:true,modelId:'air75-v3',firmwareVersion:'1.0.23.6',
  readProbeVerified:true,connectionWake:true,outputIdentity:identity,storedSettings:settings,
  permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true},
  tasks:[{id:'priority-a',title:'Isolated task A',status:'running'},
    {id:'priority-b',title:'Isolated task B',status:'completed'}]};

test('automatic USB takeover commits its initial black frame before Bluetooth/key maintenance, then enables shortcuts during wake',async t=>{
  const service=await fakeService(t,control);
  const operations=await until(service.operations,ops=>ops.some(op=>op.op==='readKeymap'),
    'USB shortcut maintenance did not run after takeover',2500);
  const connect=operations.findIndex(op=>op.op==='connect');
  const blackout=operations.findIndex(op=>op.op==='paint');
  const bluetooth=operations.findIndex(op=>op.op==='bluetoothDevices');
  const keymap=operations.findIndex(op=>op.op==='readKeymap');
  assert.ok(connect>=0&&blackout>connect);
  assert.ok(blackout<bluetooth,'Bluetooth discovery must not delay the initial USB black frame');
  assert.ok(blackout<keymap,'USB key adaptation follows the verified black frame');
  assert.ok(operations[blackout].colors.every(color=>color==='#000000'));
  const active=await service.state();
  assert.equal(active.connectionWake.active,true,'input maintenance must run during wake, without waiting 4.4 seconds');
  assert.equal(active.codex.keys.enabled,true);
  const action=await service.command({op:'codexKey',code:'F2'});
  assert.equal(action.ok,true,JSON.stringify(action));
  assert.equal((await service.operations()).filter(op=>op.op==='shortcut').at(-1).threadId,'priority-b');
  assert.equal((await service.state()).connectionWake.active,true);
});

test('slow key maintenance keeps wake at its black starting barrier and preserves the opening corner frame',async t=>{
  const service=await fakeService(t,{...control,keymapDelayMs:750,recordVisibleWrites:true});
  const pendingOperations=await until(service.operations,ops=>ops.some(op=>op.event==='simulatedKeymapPending'),
    'slow key maintenance did not reach its pending barrier',2500);
  const pending=pendingOperations.find(op=>op.event==='simulatedKeymapPending');
  const preparing=await service.state();
  const sampledOperations=await service.operations();
  assert.equal(sampledOperations.some(op=>op.event==='simulatedKeymapAck'&&op.id===pending.id),false,
    'the starting-state sample must precede the maintenance acknowledgement');
  assert.equal(preparing.connectionWake.status,'starting');
  assert.equal(preparing.connectionWake.elapsedMs,0,'input preparation cannot consume the opening 800 ms stage');
  assert.equal(preparing.connectionWake.active,true);
  assert.ok(preparing.colors.every(color=>color==='#000000'));
  assert.equal(preparing.device.state[10],0,'side lighting stays muted while keys initialize');
  const preparedFrame=sampledOperations.filter(op=>op.event==='simulatedVisibleWrite').at(-1);
  assert.equal(preparedFrame.colors.length,104);
  assert.ok(preparedFrame.colors.every(color=>color==='#000000'),'both main and side zones remain black at the barrier');
  assert.equal(sampledOperations.some(op=>op.op==='paint'&&op.colors.some(color=>color!=='#000000')),false);

  const visibleOperations=await until(service.operations,ops=>ops.some(op=>op.op==='paint'&&op.colors.some(color=>color!=='#000000')),
    'wake did not render its first visible frame after maintenance',2500);
  const acknowledgement=visibleOperations.find(op=>op.event==='simulatedKeymapAck'&&op.id===pending.id);
  const openingIndex=visibleOperations.findIndex(op=>op.op==='paint'&&op.colors.some(color=>color!=='#000000'));
  const opening=visibleOperations[openingIndex].colors;
  assert.ok(acknowledgement);
  assert.ok(acknowledgement.at-pending.at>=750,'the fixture must exercise a real delayed maintenance acknowledgement');
  assert.ok(visibleOperations.indexOf(acknowledgement)<openingIndex,'visible wake starts after input maintenance');
  const power=opening.map(color=>parseInt(color.slice(1,3),16));
  const peak=Math.max(...power);
  assert.ok(peak>0);
  assert.equal(power[0],peak,'the first visible top wave must still start at Esc');
  assert.equal(power[82],peak,'the first visible bottom wave must still start at the right arrow');
  assert.ok(opening.slice(15,73).every(color=>color==='#000000'),'middle rows must not replace the opening corner stage');
  assert.ok(opening.every(color=>/^#([0-9a-f]{2})\1\1$/i.test(color)),'opening pixels contain only white intensity');
  const playing=await service.state();
  assert.equal(playing.connectionWake.status,'playing');
  assert.equal(playing.codex.keys.enabled,true);
  const action=await service.command({op:'codexKey',code:'F2'});
  assert.equal(action.ok,true,JSON.stringify(action));
  assert.equal((await service.operations()).filter(op=>op.op==='shortcut').at(-1).threadId,'priority-b');
  assert.equal((await service.state()).connectionWake.active,true);
});

for(const [label,patch] of [['absent',{present:false}],['read-only',{readOnly:true}]])
test(`${label} USB discovery still performs input maintenance after its priority probe`,async t=>{
  const service=await fakeService(t,{...control,...patch,
    bluetoothDevices:[{model:'Air75 V3',transport:'bluetooth',id:'12345'}]});
  const operations=await until(service.operations,ops=>ops.some(op=>op.op==='bluetoothDevices'),
    'input discovery was skipped after the USB probe',2500);
  const connect=operations.findIndex(op=>op.op==='connect');
  const bluetooth=operations.findIndex(op=>op.op==='bluetoothDevices');
  assert.ok(connect>=0&&connect<bluetooth,'an eligible USB probe takes priority over input discovery');
  assert.equal(operations.some(op=>['arm','armConnectionWake','paint'].includes(op.op)),false,'an unavailable USB route must not paint');
  const state=await until(service.state,current=>current.bluetooth.connected===true,
    'Bluetooth input discovery did not finish after the USB probe',2500);
  assert.equal(state.connectionWake.active,false);
  if(label==='absent')assert.equal(state.codex.keys.enabled,true,'Bluetooth task shortcuts remain available');
});
