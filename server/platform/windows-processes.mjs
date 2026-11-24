import {execFile} from 'node:child_process';
const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(s);
export class WindowsProcessProbe {
  constructor(command,{run}={}){this.command=command;this.run=run??((request,env)=>new Promise((resolve,reject)=>{
    const child=execFile(command,[],{windowsHide:true,timeout:4500,maxBuffer:262144,env:{...process.env,...env}},(error,stdout)=>{
      if(error){reject(error);return;}
      try{const v=JSON.parse(stdout);if(v.protocolVersion!==1||v.ok!==true||!v.result)throw Error('Invalid native process evidence');resolve(v.result);}catch(e){reject(e);}
    });child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request)+'\n');
  }));}
  async starts(pids){
    const unique=[...new Set(pids)].filter(n=>Number.isInteger(n)&&n>0&&n<=0xffffffff).slice(0,128);
    if(!unique.length)return new Map();
    try{const result=await this.run({op:'processStarts',pids:unique});
      if(!Array.isArray(result.processes)||result.processes.length>unique.length)throw Error('Invalid process list');
      const entries=result.processes.map(p=>{if(!unique.includes(p.pid)||!Number.isSafeInteger(p.startedAt)||p.startedAt<=0||typeof p.executable!=='string'||p.executable.length>256)throw Error('Invalid process identity');return [p.pid,p.startedAt];});
      if(new Map(entries).size!==entries.length)throw Error('Duplicate process evidence');return new Map(entries);
    }catch{return null;}
  }
  async writers(home,ids){
    if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!validId(id)))return null;
    try{const r=await this.run({op:'writers',ids},{CODEX_HOME:home});
      if(!Array.isArray(r.writers)||r.writers.length>ids.length)throw Error('Invalid writer list');
      const entries=r.writers.map(w=>{if(!ids.includes(w.id)||!Number.isSafeInteger(w.startedAt)||w.startedAt<=0)throw Error('Invalid writer');return [w.id,{startedAt:w.startedAt}];});
      if(new Map(entries).size!==entries.length)throw Error('Duplicate writer evidence');return new Map(entries);
    }catch{return null;}
  }
  async codexTarget(home,id){
    if(typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))return null;
    try{
      const r=await this.run({op:'writerTargets',ids:[id]},{CODEX_HOME:home});
      if(!Array.isArray(r.writers)||r.writers.length!==1)throw Error('Ambiguous task owner');
      const target=r.writers[0];
      if(!target||target.id!==id||!Number.isInteger(target.pid)||target.pid<=0||target.pid>=0xffffffff||
        typeof target.createdTicks!=='string'||!/^[0-9a-f]{16}$/.test(target.createdTicks)||
        !Number.isSafeInteger(target.startedAt)||target.startedAt<=0||typeof target.executable!=='string'||target.executable.length>4096)throw Error('Invalid task owner');
      const ticks=BigInt('0x'+target.createdTicks);
      if(ticks<=116444736000000000n||Number((ticks-116444736000000000n)/10000n)!==target.startedAt)throw Error('Inconsistent task identity');
      return {id,pid:target.pid,createdTicks:target.createdTicks,startedAt:target.startedAt,executable:target.executable};
    }catch{return null;}
  }
}
