import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {Hardware} from '../../server/hardware.mjs';

export async function nativeContractFixture(t,configuration={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'nuphy-contract-'));
  const helper=path.join(directory,'pipe-only.mjs'),control=path.join(directory,'control.json'),log=path.join(directory,'operations.jsonl');
  await writeFile(control,JSON.stringify(configuration));
  await writeFile(helper,`
import {createInterface} from 'node:readline';
import {readFileSync,appendFileSync} from 'node:fs';
import {NATIVE_READONLY} from ${JSON.stringify(new URL('../../server/native-contract.mjs',import.meta.url).href)};
const config=()=>JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
const log=value=>appendFileSync(${JSON.stringify(log)},JSON.stringify({...value,pid:process.pid})+'\\n');
const input=createInterface({input:process.stdin});let sessionId=null,sequence=0;
const reply=(id,result)=>({id,ok:true,result});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
input.on('line',line=>{
  const request=JSON.parse(line),{id,op}=request,c=config();log({op});
  if(op==='hello'){
    sessionId=request.sessionId;if(c.noHello)return;
    return send(reply(id,{...NATIVE_READONLY,readOnly:true,sessionId,implementationVersion:'1.2.40',...c.hello}));
  }
  if(op==='quit'){send(reply(id,{quitting:true,noMutation:true}));input.close();return;}
  if(op==='restoreKeys'){send(reply(id,{restored:true,verified:true,noMutation:true}));return;}
  const result={connected:false,armed:false,readOnly:true,...c.result};
  if(c.invalidReply){process.stdout.write(c.invalidReply);return;}
  if(c.badEvent){
    const event={event:'disconnected',needsRestore:false,sessionId,eventSequence:++sequence};
    if(c.badEvent==='session')event.sessionId='old-session';
    if(c.badEvent==='sequence')event.eventSequence++;
    send(event);if(c.badEvent==='replay')send(event);
  }
  if(c.oldReply)send(reply(id-1,{connected:true,armed:true,readOnly:false}));
  setTimeout(()=>send(reply(id,result)),c.delayMs??0);
});
input.on('close',()=>{
  log({event:'exited'});
  const finish=()=>process.exit(0);
  if(config().missingShutdown)return finish();
  process.stdout.write(JSON.stringify({event:'shutdownComplete',sessionId,eventSequence:++sequence,noMutation:true,lightingRestored:true,keysRestored:true})+'\\n',finish);
});
`);
  const hardware=new Hardware({command:process.execPath,args:[helper],...(configuration.legacy?{}:{protocol:'windows-readonly-v1'})},path.join(directory,'unused.json'));
  t.after(async()=>{
    try{
      if(hardware.child){
        const child=hardware.child,closed=once(child,'close');child.stdin.end();
        const timer=setTimeout(()=>child.kill(),1000);
        try{await closed;}finally{clearTimeout(timer);}
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  return {hardware,configure:patch=>writeFile(control,JSON.stringify({...configuration,...patch})),
    operations:async()=>(await readFile(log,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
}
