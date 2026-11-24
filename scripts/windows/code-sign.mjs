import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {root,desktop,target,run,requireWindows,cargoOutputDirectory} from './common.mjs';
const require=createRequire(import.meta.url);
export function prepareNsisMain(bytes){
  const result=Buffer.from(bytes),unknown=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'),fixed=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
  const first=result.indexOf(unknown);
  if(first<0){if(result.indexOf(fixed)<0)throw Error('缺少 Tauri NSIS 标记');return result;}
  if(result.indexOf(unknown,first+unknown.length)>=0)throw Error('Tauri NSIS 标记重复');
  fixed.copy(result,first);return result;
}
export function bundleConfiguration(directory){
  const relative=value=>path.relative(path.join(desktop,'src-tauri'),path.join(directory,'payload',value)).replaceAll('\\','/');
  return {bundle:{createUpdaterArtifacts:false,externalBin:['node','hid','desktop-io','agent-probe','sqlite'].map(name=>relative('nuphylab-'+name)),resources:{[relative('runtime')+'/']:'runtime/'},windows:{certificateThumbprint:null,signCommand:null,timestampUrl:null}}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    requireWindows();const [command,directory]=process.argv.slice(2);
    if(command==='paths')console.log(JSON.stringify({release:path.join(await cargoOutputDirectory(),target,'release'),binaries:path.join(desktop,'src-tauri/binaries'),resources:path.join(desktop,'resources'),version:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version}));
    else if(command==='build')await run(process.execPath,[path.join(root,'scripts/windows/run.mjs'),'build','--no-bundle']);
    else if(command==='marker')await writeFile(directory,prepareNsisMain(await readFile(directory)));
    else if(command==='bundle'){
      const reset=path.join(directory,'resources-reset.json'),config=path.join(directory,'bundle.json');
      await writeFile(reset,JSON.stringify({bundle:{resources:null}}));await writeFile(config,JSON.stringify(bundleConfiguration(directory)));
      await run(process.execPath,[require.resolve('@tauri-apps/cli/tauri.js'),'bundle','--target',target,'--bundles','nsis','--config',reset,'--config',config,'--no-sign','--no-binary-patching'],{cwd:desktop});
    }else throw Error('未知签名构建阶段');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
