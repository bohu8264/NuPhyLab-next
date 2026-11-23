import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Hardware} from '../../server/hardware.mjs';
import {NATIVE_READONLY} from '../../server/native-contract.mjs';
import {binaries,resources,target,requireWindows} from './common.mjs';

let hardware,directory,timer;
try{
  requireWindows();
  const command=path.join(binaries,`nuphylab-hid-${target}.exe`),args=['--models',path.join(resources,'models.json')];
  if(!process.argv.includes('--connect')){
    const {stdout}=await promisify(execFile)(command,[...args,'--enumerate'],{windowsHide:true,timeout:15000,maxBuffer:NATIVE_READONLY.maxLineBytes});
    const value=JSON.parse(stdout);console.log(JSON.stringify(value,null,2));if(value.ok!==true)process.exitCode=1;
  }else{
    directory=await mkdtemp(path.join(tmpdir(),'nuphylab-readonly-probe-'));
    hardware=new Hardware({command,args,protocol:NATIVE_READONLY.profile},path.join(directory,'unused-backup.json'));
    timer=setTimeout(()=>{hardware.child?.kill();process.exitCode=1;console.error('只读探针超时');},15000);
    const result=await hardware.request('connect');
    console.log(JSON.stringify({ok:true,bridge:hardware.bridgeStatus(),result},null,2));
  }
}catch(error){console.error(error.code?`${error.code}: ${error.message}`:error.message);process.exitCode=1;}
finally{
  try{if(hardware){await hardware.close();if(hardware.shutdownResult)console.log(JSON.stringify(hardware.shutdownResult,null,2));}}
  catch(error){console.error(error.message);process.exitCode=1;}
  clearTimeout(timer);if(directory)await rm(directory,{recursive:true,force:true});
}
