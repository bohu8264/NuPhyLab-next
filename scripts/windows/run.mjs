import {createRequire} from 'node:module';
import {prepare} from './prepare.mjs';
import {root,desktop,requireWindows,run} from './common.mjs';
import path from 'node:path';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import releaseConfig from '../../shared/contracts/windows-release.json' with {type:'json'};
import {validateRelease,signSidecars,writeReleaseArtifacts} from './release.mjs';

let temporary;
try{
  requireWindows();
  const action=process.argv[2];if(!['dev','build'].includes(action))throw new Error('请选择 dev 或 build');
  const signed=process.argv.includes('--signed'),offline=process.argv.includes('--offline-installer');
  if((signed||offline)&&action!=='build')throw Error('签名与离线安装包选项仅用于 build');
  const release=signed?validateRelease(releaseConfig):null;
  const config={};
  if(offline||signed){
    config.bundle={...(signed?{createUpdaterArtifacts:true}:{}),windows:{...(offline?{webviewInstallMode:{type:'offlineInstaller',silent:true}}:{}),
      ...(signed?{certificateThumbprint:release.thumbprint,digestAlgorithm:'sha256',timestampUrl:release.timestampUrl}:{})}};
    temporary=await mkdtemp(path.join(tmpdir(),'NuPhy Windows build '));await writeFile(path.join(temporary,'config.json'),JSON.stringify(config));
  }
  await prepare();
  if(signed)await signSidecars(release);
  // Execute the JS entry directly: .cmd launchers need shell parsing on Windows.
  const require=createRequire(import.meta.url);
  await run(process.execPath,[path.join(root,'ui/node_modules/typescript/bin/tsc'),'-b'],{cwd:path.join(root,'ui')});
  await run(process.execPath,[path.join(root,'ui/node_modules/vite/bin/vite.js'),'build'],{cwd:path.join(root,'ui')});
  await run(process.execPath,[require.resolve('@tauri-apps/cli/tauri.js'),action,...(action==='build'?['--target','x86_64-pc-windows-msvc']:[]),...(temporary?['--config',path.join(temporary,'config.json')]:[])],{cwd:desktop});
  if(signed)await writeReleaseArtifacts(releaseConfig,release);
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
