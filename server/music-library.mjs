import {validateSession} from '../shared/music-model.mjs';
import {readFile,writeFile,mkdir,rename,readdir,stat,lstat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const validID=id=>typeof id==='string'&&/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|legacy-[0-9a-f]{24})$/.test(id);
export function checkSession(s){if(typeof s?.name!=='string'||s.name.length>80||JSON.stringify(s).length>48*1024*1024)throw Error('演奏工程格式不正确');validateSession(s);}
const meaningful=s=>s.events?.length>0||s.drumEnabled||s.clips?.some(c=>c.audio)||s.name&&s.name!=='我的演奏';
export async function safeMusicDirectories(dataDir,create=false){
 for(const dir of [dataDir,path.join(dataDir,'music-works'),path.join(dataDir,'music-works/deleted')]){
  try{if(!(await lstat(dir)).isDirectory())throw Error('音乐作品目录无效，原文件已保留');}
  catch(e){if(e.code!=='ENOENT')throw e;if(create)await mkdir(dir,{recursive:true});}
 }
}
export class MusicLibrary {
 constructor(dataDir){this.dataDir=dataDir;this.root=path.join(dataDir,'music-works');this.trash=path.join(this.root,'deleted');this.current=path.join(dataDir,'music-session.json');}
 async safeFile(file){await safeMusicDirectories(this.dataDir);try{if(!(await lstat(file)).isFile())throw Error('音乐作品文件无效，原文件已保留');}catch(e){if(e.code!=='ENOENT')throw e;}}
 async atomic(file,value){await safeMusicDirectories(this.dataDir,true);await this.safeFile(file);const tmp=file+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(tmp,file);}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
 file(id,deleted=false){if(!validID(id))throw Error('作品编号无效');return path.join(deleted?this.trash:this.root,id+'.json');}
 meta(record){const s=record.session;return {id:record.id,name:s.name,createdAt:record.createdAt,updatedAt:record.updatedAt,deletedAt:record.deletedAt??null,bpm:s.bpm,bars:s.bars,eventCount:s.events.length,instrument:s.instrument,sourcePreset:s.sourcePreset??null,preview:s.events.slice(0,48).map(e=>({kind:e.kind,beat:e.beat,duration:e.duration,value:e.value})),drumPreview:s.drumEnabled?s.steps.map(row=>row.map(Boolean)):[],hasAudio:s.clips.some(c=>Boolean(c.audio)),seconds:Math.round(s.bars*4*60/s.bpm)};}
 async putRecord(record,deleted=false){checkSession(record.session);const metadata=this.meta(record);const f=this.file(record.id,deleted);await this.safeFile(f);await this.safeFile(f+'.meta');await this.atomic(f,record);await this.atomic(f+'.meta',metadata);return metadata;}
 async get(id,deleted=false){const file=this.file(id,deleted);await this.safeFile(file);const record=JSON.parse(await readFile(file,'utf8'));checkSession(record.session);return record;}
 async exists(file){try{await this.safeFile(file);await stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 async migrate(){await this.safeFile(this.current);const marker=path.join(this.root,'migration-v1');if(await this.exists(marker))return;let s,raw;try{raw=await readFile(this.current,'utf8');s=JSON.parse(raw);checkSession(s);}catch(e){if(e.code==='ENOENT')return;throw Error('无法读取原演奏，原文件已保留');}
  if(meaningful(s)&&!s.projectId){const id='legacy-'+createHash('sha256').update(raw).digest('hex').slice(0,24);if(!await this.exists(this.file(id))&&!await this.exists(this.file(id,true))){const now=new Date().toISOString();await this.putRecord({id,session:{...s,projectId:id},createdAt:now,updatedAt:now});}await this.atomic(marker,{projectId:id});}
  else await this.atomic(marker,{projectId:s.projectId??null});
 }
 async readCurrent(){await this.migrate();let s;try{s=JSON.parse(await readFile(this.current,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error('无法读取演奏工程，原文件保留');}if(!s.projectId){try{const m=JSON.parse(await readFile(path.join(this.root,'migration-v1'),'utf8'));if(m.projectId)s={...s,projectId:m.projectId};}catch{}}if(s.projectId&&await this.exists(this.file(s.projectId,true)))return null;if(s.projectId){try{const record=await this.get(s.projectId);checkSession(record.session);return record.session;}catch(e){if(e.code!=='ENOENT')throw e;}}checkSession(s);return s;}
 async save(s,current=true){checkSession(s);if(current)await this.safeFile(this.current);if(!validID(s.projectId))throw Error('作品编号无效，请重新打开');if(await this.exists(this.file(s.projectId,true)))throw Error('作品已移到最近删除，请先恢复');let old;try{old=await this.get(s.projectId);}catch(e){if(e.code!=='ENOENT')throw e;}
  const now=new Date().toISOString();const meta=await this.putRecord({id:s.projectId,session:s,createdAt:old?.createdAt??now,updatedAt:now});if(current)await this.atomic(this.current,s);return meta;
 }
 async list(deleted=false){await this.migrate();const dir=deleted?this.trash:this.root;await safeMusicDirectories(this.dataDir,true);const names=(await readdir(dir)).filter(n=>n.endsWith('.json')&&validID(n.slice(0,-5)));const out=[];let unreadable=0;
  for(const name of names){try{const f=path.join(dir,name),m=f+'.meta';await this.safeFile(f);await this.safeFile(m);let meta;try{const [a,b]=await Promise.all([stat(f),stat(m)]);if(b.mtimeMs<a.mtimeMs)throw Error('stale');meta=JSON.parse(await readFile(m,'utf8'));if(!Array.isArray(meta.preview))throw Error('preview cache upgrade');}catch{meta=this.meta(JSON.parse(await readFile(f,'utf8')));await this.atomic(m,meta).catch(()=>{});}out.push(meta);}catch{unreadable++;}}
  return {works:out.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))),unreadable};
 }
 async remove(id){const r=await this.get(id);r.deletedAt=new Date().toISOString();const from=this.file(id),to=this.file(id,true);for(const f of [from,from+'.meta',to,to+'.meta'])await this.safeFile(f);await this.atomic(from,r);await mkdir(this.trash,{recursive:true});await rename(from,to);try{await rename(from+'.meta',to+'.meta');}catch(e){if(e.code!=='ENOENT')throw e;}await this.atomic(to+'.meta',this.meta(r));return this.meta(r);}
 async restore(id){if(await this.exists(this.file(id)))throw Error('作品已存在');const r=await this.get(id,true);delete r.deletedAt;r.updatedAt=new Date().toISOString();const from=this.file(id,true),to=this.file(id);for(const f of [from,from+'.meta',to,to+'.meta'])await this.safeFile(f);await this.atomic(from,r);await rename(from,to);try{await rename(from+'.meta',to+'.meta');}catch(e){if(e.code!=='ENOENT')throw e;}await this.atomic(to+'.meta',this.meta(r));return this.meta(r);}
}
