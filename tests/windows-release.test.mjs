import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRelease,sidecarNames} from '../scripts/windows/release.mjs';
const fixture=()=>{
  const raw=Buffer.alloc(42,1);raw.write('Ed');
  const config={version:1,enabled:true,channel:'beta',pubkey:Buffer.from('untrusted comment: public key\n'+raw.toString('base64')).toString('base64'),endpoints:['https://updates.example/beta.json'],allowedDownloadHosts:['releases.example'],trustedSignerThumbprints:['A'.repeat(40)]};
  const env={NUPHYLAB_CERT_THUMBPRINT:'A'.repeat(40),TAURI_SIGNING_PRIVATE_KEY:'test-only-never-a-real-key',NUPHYLAB_TIMESTAMP_URL:'https://timestamps.example',NUPHYLAB_DOWNLOAD_BASE:'https://releases.example/windows/beta/'};
  return {config,env};
};
test('signed Windows release requires both signing schemes and an exact HTTPS publication scope',()=>{
  const {config,env}=fixture();assert.deepEqual(validateRelease(config,env),{thumbprint:'A'.repeat(40),timestampUrl:'https://timestamps.example',downloadBase:'https://releases.example/windows/beta'});
  assert.equal(sidecarNames.length,5);
  for(const property of ['NUPHYLAB_CERT_THUMBPRINT','TAURI_SIGNING_PRIVATE_KEY','NUPHYLAB_TIMESTAMP_URL','NUPHYLAB_DOWNLOAD_BASE'])assert.throws(()=>validateRelease(config,{...env,[property]:''}));
  for(const changes of [{enabled:false},{pubkey:'not-a-key'},{pubkey:undefined},{endpoints:['http://updates.example']},{trustedSignerThumbprints:['bad']},{allowedDownloadHosts:['*.example']}])assert.throws(()=>validateRelease({...config,...changes},env));
  for(const value of ['https://releases.example.evil/app','http://releases.example/app','https://user@releases.example/app','https://releases.example:8443/app','https://releases.example/app?redirect=bad'])assert.throws(()=>validateRelease(config,{...env,NUPHYLAB_DOWNLOAD_BASE:value}));
});
