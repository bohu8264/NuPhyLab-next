import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('host SIGKILL leaves the real service restoring its fake keyboard and exiting without a second app launch',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-host-crash-'));
  const helperURL=new URL('./helpers/fake-service.mjs',import.meta.url).href;
  const hostFile=path.join(dir,'host.mjs');
  await writeFile(hostFile,`
import {fakeService} from ${JSON.stringify(helperURL)};
process.env.AIR_STUDIO_PARENT_PID=String(process.pid);
const s=await fakeService({after(){}},{permissions:{inputMonitoring:true,accessibility:true,canPostEvents:true},tasks:[{id:'fixture',status:'running'}],codexKeybindings:[{command:'globalDictationHold',key:'Ctrl+Shift+D'},{command:'globalDictationSingleTap',key:null}]});
for(const body of [{op:'settings',settings:{codexAmbient:false,codexSelectedPulse:false,lightDurationMs:0,lightIdleMs:0}},{op:'agentMode',source:'codex',enabled:true},{op:'preview',colors:Array(84).fill('#ff0000')},{op:'codexKey',code:'F9',phase:'down'}]){const r=await s.command(body);if(!r.ok)throw Error(JSON.stringify(r));}
process.stdout.write(JSON.stringify({pid:s.child.pid,dataDir:s.dataDir})+'\\n');
setInterval(()=>{},1000);
`);
  const host=spawn(process.execPath,[hostFile],{stdio:['ignore','pipe','pipe']});let servicePid,dataDir;
  t.after(async()=>{
    if(host.exitCode===null&&host.signalCode===null)host.kill('SIGKILL');
    if(servicePid)try{process.kill(servicePid,'SIGTERM');}catch{}
    if(dataDir)await rm(path.dirname(dataDir),{recursive:true,force:true});
    await rm(dir,{recursive:true,force:true});
  });
  const result=await new Promise((resolve,reject)=>{
    let output='',errors='';const timeout=setTimeout(()=>reject(new Error('Synthetic host startup timeout: '+errors)),10000);
    host.stderr.on('data',b=>{errors+=b;});host.stdout.on('data',b=>{output+=b;if(output.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(output.split('\n')[0]));}});
    host.once('exit',code=>{clearTimeout(timeout);reject(new Error('Synthetic host exited: '+code+' '+errors));});
  });
  servicePid=result.pid;dataDir=result.dataDir;
  const ops=async()=>((await readFile(path.join(path.dirname(dataDir),'operations.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse));
  const before=await ops();assert.ok(before.some(r=>r.op==='paint'));assert.ok(before.some(r=>r.op==='shortcut'&&r.phase==='down'));
  const exit=once(host,'exit');host.kill('SIGKILL');await exit;
  let all=[];
  for(let i=0;i<120;i++){all=await ops();if(all.some(r=>r.op==='quit'))break;await wait(25);}
  const cleanup=all.slice(before.length),names=cleanup.map(r=>r.op);
  assert.ok(names.includes('restoreKeys'),'scoped OS mappings are released');
  assert.ok(names.includes('restore'),'original lighting is restored');
  assert.ok(names.includes('quit'),'the helper is asked to exit');
  assert.ok(names.indexOf('restore')<names.indexOf('quit'),'restoration precedes closing the HID process');
  assert.ok(cleanup.some(r=>r.op==='shortcut'&&r.phase==='up'),'held shortcut released after host crash');
  for(let i=0;i<80;i++){try{process.kill(servicePid,0);}catch{servicePid=null;break;}await wait(25);}
  assert.equal(servicePid,null,'no orphan worker remains');
});
