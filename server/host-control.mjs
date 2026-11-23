import {timingSafeEqual} from 'node:crypto';
import {WINDOWS_HOST} from './host-shutdown.mjs';

// A private stdin pipe belongs to the native host. It is never an HTTP command.
export function watchHostControl({input,secret,onShutdown,onLost,onHello=()=>{},timeoutMs=WINDOWS_HOST.heartbeatTimeoutMs}) {
  if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))throw new Error('Invalid host control secret');
  let buffer=Buffer.alloc(0),closed=false,lastMessage=Date.now();
  const finish=callback=>{if(!closed){closed=true;clearInterval(timer);callback();}};
  const fail=()=>finish(onLost);
  const timer=setInterval(()=>{if(Date.now()-lastMessage>timeoutMs)fail();},Math.min(1000,timeoutMs));
  timer.unref?.();
  const data=bytes=>{
    if(closed)return;
    buffer=Buffer.concat([buffer,bytes]);
    // Control messages are tiny; a host must never queue arbitrary work here.
    if(buffer.length>4096){fail();return;}
    let end;
    while((end=buffer.indexOf(10))>=0&&!closed){
      const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
      let value;try{value=JSON.parse(line.toString('utf8'));}catch{fail();return;}
      if(!value||typeof value!=='object'||Array.isArray(value)){fail();return;}
      if(typeof value.secret!=='string'||!/^[a-f0-9]{64}$/.test(value.secret)||!timingSafeEqual(Buffer.from(secret),Buffer.from(value.secret))){fail();return;}
      if(value.op==='hello'){lastMessage=Date.now();onHello();}
      else if(value.op==='ping')lastMessage=Date.now();
      else if(value.op==='shutdown'){
        if(value.shutdownId!==undefined&&(typeof value.shutdownId!=='string'||!/^[a-f0-9]{64}$/.test(value.shutdownId))){fail();return;}
        finish(()=>onShutdown(value));
      }
      else fail();
    }
  };
  input.on('data',data);input.on('end',fail);input.on('error',fail);
  return ()=>{closed=true;clearInterval(timer);input.off('data',data);input.off('end',fail);input.off('error',fail);};
}
