import test from 'node:test';
import assert from 'node:assert/strict';
import {FIRMWARE_URL} from '../server/firmware.mjs';
import firmwareLinks from '../shared/contracts/firmware-links.json' with {type:'json'};
import {createVMEnvironment} from './helpers/source-ui-vm.mjs';

const expected='https://drive.nuphy.io/#/setting';
async function fixture(reply){
 const requests=[];
 const ui=createVMEnvironment({'lucide-react':{},'./codexKeys':{nativeCodexRequest:async request=>{requests.push(request);return reply;}},
  './i18n':{},'./primitives':{},'../../shared/permission-refresh.mjs':{},'../../shared/firmware-onboarding.mjs':{}});
 return {...(await ui.load(new URL('../ui/src/StartupGuide.tsx',import.meta.url))).exports,requests};
}
test('official website handoff and browser fallback retain the exact NuPhyIO settings hash route',async()=>{
 assert.equal(FIRMWARE_URL,expected);
 assert.equal(firmwareLinks.officialDriverUrl,expected);
 for(const available of [true,false]){
  const f=await fixture(available?{available:true,result:{opened:true,url:expected}}:{available:false});
  assert.equal(f.OFFICIAL_DRIVER_URL,expected);
  assert.equal((await f.openOfficialDriver()).url,expected);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)),[{kind:'openOfficialDriver'}]);
 }
});
test('official handoff rejects old hosts, missing or changed routes and external URLs',async()=>{
 for(const url of ['https://drive.nuphy.io/?lang=zh-CN','https://drive.nuphyio.com/','https://drive.nuphyio.com/#/device',
  'https://drive.nuphyio.com/?lang=en#/setting','https://example.com/#/setting','https://user@drive.nuphyio.com/#/setting']){
  const f=await fixture({available:true,result:{opened:true,url}});
  await assert.rejects(f.openOfficialDriver(),/Invalid official firmware update address/);
 }
});
