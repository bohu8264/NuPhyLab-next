import test from 'node:test';
import assert from 'node:assert/strict';
import {windowsDiagnostics} from '../server/platform/windows-diagnostics.mjs';
import {previewServiceFixture} from './helpers/windows-preview-service.mjs';
test('diagnostics use explicit typed fields and exclude arbitrary nested private data',()=>{
  const secret='PRIVATE_TASK_PATH_SERIAL_TOKEN';
  const state={build:{version:'1.2.40',identity:secret},desktop:{capabilities:{audio:true,updates:false,arbitrary:secret}},device:{connected:true,modelId:'air75-v3',firmwareVersion:'2.0.0.7',lightingProfile:1,identityQualification:{status:'qualified',serial:secret},devicePath:secret,error:secret,windowsRecovery:{status:'checking',details:secret}},codex:{tasks:[{title:secret,cwd:secret}]},settings:{token:secret},playback:{mode:'animation',playing:true,error:secret}};
  const report=windowsDiagnostics({state,io:{phase:'ready',paths:secret},arch:'x64',osRelease:'10.0.19045'});
  assert(!JSON.stringify(report).includes(secret));assert.equal(report.device.identityQualified,true);assert.equal(report.device.firmware,'2.0.0.7');assert.equal(report.capabilities.audio,true);assert.equal(report.application.system,'10.0.19045');
  state.build.version=secret;state.device.firmwareVersion=secret;state.device.modelId=secret;state.device.windowsRecovery.status=secret;state.playback.mode=secret;
  const invalid=windowsDiagnostics({state,io:{phase:secret},arch:secret,osRelease:secret});assert(!JSON.stringify(invalid).includes(secret));assert.equal(invalid.device.modelId,null);assert.equal(invalid.device.firmware,null);
});
test('real preview exports diagnostics without starting a lighting lease and rejects external paths',async t=>{
  const f=await previewServiceFixture(t),s=await f.start();
  const result=await s.command({op:'windowsDiagnostics'});assert.equal(result.ok,true);assert.equal(result.result.format,'nuphylab-windows-diagnostics');
  assert.equal((await s.command({op:'windowsDiagnostics',path:'C:\\arbitrary'})).ok,false);
  await s.close();assert(!(await f.operations()).some(x=>x.op==='arm'));
});
