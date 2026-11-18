import test from 'node:test';
import assert from 'node:assert/strict';
import {availableFirmwareUpdate} from '../shared/firmware-onboarding.mjs';
import {createVMEnvironment,walkAll,textOf,plain} from './helpers/source-ui-vm.mjs';
import {appDraftFixture} from './helpers/app-draft-fixture.mjs';

const old=()=>({settings:{language:'en'},device:{connected:true,armed:true,modelId:'air75-v3',firmware:'1.0.16.6'},firmware:{modelId:'air75-v3',modelName:'Air75 V3',current:'1.0.16.6',latest:'1.0.23.6',latestConfirmed:true,updateAvailable:true,status:'updateAvailable',stale:false}});
test('firmware notification requires a verified update for the actual current keyboard',()=>{
  assert.equal(availableFirmwareUpdate(old()).target,'1.0.23.6');
  for(const patch of [
    {firmware:{latestConfirmed:false}},{firmware:{updateAvailable:false}},{firmware:{status:'unavailable'}},{firmware:{stale:true}},
    {firmware:{modelId:'kick75'}},{firmware:{current:'unknown'}},{firmware:{latest:'1.0.16.6'}},
    {device:{connected:false}},{device:{modelId:'kick75'}},{device:{firmware:'1.0.23.6'}},
  ]){
    const state=old();for(const [key,value] of Object.entries(patch))Object.assign(state[key],value);
    assert.equal(availableFirmwareUpdate(state),null,JSON.stringify(patch));
  }
  const readOnly=old();Object.assign(readOnly.device,{connected:false,identified:true,firmwareDetectionAvailable:true,readOnly:true,capabilities:{perKey:false}});
  assert.ok(availableFirmwareUpdate(readOnly));assert.equal(readOnly.device.capabilities.perKey,false);
});

test('actual App settings dot opens Updates and clears after firmware changes or disconnect',async()=>{
  const f=await appDraftFixture({state:old()});
  const dots=()=>f.nodes().filter(node=>node.props?.className==='settings-update-dot');
  assert.equal(dots().length,1);assert.equal(dots()[0].props['aria-label'],'Keyboard firmware update available');
  await f.click('设置');assert.equal(f.child('Settings').props.initialTab,'updates');assert.equal(dots().length,1,'opening settings does not acknowledge an unapplied update');
  Object.assign(f.state.firmware,{status:'current',updateAvailable:false,current:'1.0.23.6'});f.state.device.firmware='1.0.23.6';f.render();
  assert.equal(dots().length,0);
  Object.assign(f.state.firmware,old().firmware);Object.assign(f.state.device,old().device);f.render();assert.equal(dots().length,1);
  f.state.device.connected=false;f.render();assert.equal(dots().length,0);f.unmount();
});

for(const language of ['zh-CN','en'])test(`actual Updates panel shows precise firmware target and native manual check in ${language}`,async()=>{
  const commands=[],nativeCalls=[],Button=Object.defineProperty(()=>null,'name',{value:'Button'}),Driver=()=>null;
  const ui=createVMEnvironment({
    './primitives':{Button,run:p=>ui.track(p)},'./codexKeys':{nativeCodexKeys:async body=>{nativeCalls.push(plain(body));return true;}},
    './StartupGuide':{useStartupCopy:()=> (zh,en)=>language==='en'?en:zh,OFFICIAL_DRIVER_URL:'https://drive.nuphy.io/#/setting',OfficialDriverAccess:Driver},
    '../../shared/firmware-onboarding.mjs':{availableFirmwareUpdate},'../../package.json':{default:{version:'fixture-version'}},
  });
  const Component=(await ui.load(new URL('../ui/src/UpdatePreferences.tsx',import.meta.url))).exports.UpdatePreferences;
  const state=old(),panel=ui.mount(Component,{state,command:async body=>commands.push(plain(body))});
  assert.match(textOf(panel.tree),/1\.0\.23\.6/);assert.match(textOf(panel.tree),/1\.0\.16\.6/);
  assert.equal(walkAll(panel.tree,node=>node.type==='a')[0].props.href,'https://drive.nuphy.io/#/setting');
  assert.equal(walkAll(panel.tree,node=>node.type===Driver).length,1,'reuse the native safe USB handoff');
  assert.ok(textOf(panel.tree).includes(language==='en'?'24 hours':'24 小时'));
  if(language==='en')assert.doesNotMatch(textOf(panel.tree),/[\u3400-\u9fff]/);
  const buttons=walkAll(panel.tree,node=>node.type===Button);
  buttons[0].props.onClick();await ui.settle(panel);assert.deepEqual(nativeCalls,[{kind:'checkForUpdates'}]);
  buttons[1].props.onClick();await ui.settle(panel);assert.deepEqual(commands,[{op:'checkFirmware'}]);
  state.device.connected=false;panel.render();assert.equal(walkAll(panel.tree,node=>node.type===Driver).length,0);
  assert.equal(walkAll(panel.tree,node=>node.type===Button)[1].props.disabled,true);
  panel.unmount();
});
