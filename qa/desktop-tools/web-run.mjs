import {fakeService} from '../../tests/helpers/fake-service.mjs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
for (const language of ['zh-CN','en']){
 const home=await mkdtemp(path.join(tmpdir(),'layout-wk-data-'));
 const jobs=[];
 try {
  const service=await fakeService({after:f=>jobs.push(f)}, {freshLibrary:true,skipInitialConnect:true,present:false,firmwareOffline:true,storedSettings:{language,sidebarFeatures:['studio']}},{environment:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,TMPDIR:home},uiDir:path.join(root,'ui/dist')});
  for (const settings of [{language},{sidebarFeatures:['studio']}]) if (!(await service.command({op:'settings',settings})).ok) throw Error('Unable to set fixture');
  const result=await new Promise((resolve,reject)=>{const p=spawn(process.env.NUPHY_QA_EXECUTABLE,[process.env.NUPHY_QA_STAGE,'web',service.url,language],{stdio:'inherit'});p.on('error',reject);p.on('close',resolve)});
  if (result!==0) throw Error('WKWebView failed '+language);
 }finally{for(const stop of jobs.reverse())await stop();await rm(home,{recursive:true,force:true});}
}
