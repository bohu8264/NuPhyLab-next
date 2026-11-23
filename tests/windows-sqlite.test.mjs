import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {extractWindowsSQLite} from '../scripts/windows/fetch-sqlite.mjs';

const execute=promisify(execFile);
function storedZip(files){
 const chunks=[],central=[];let offset=0;
 for(const [name,text] of Object.entries(files)){
  const filename=Buffer.from(name),data=Buffer.from(text);
  let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
  const index=Buffer.alloc(46);index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt32LE(crc,16);index.writeUInt32LE(data.length,20);index.writeUInt32LE(data.length,24);index.writeUInt16LE(filename.length,28);index.writeUInt32LE(offset,42);
  chunks.push(local,filename,data);central.push(index,filename);offset+=local.length+filename.length+data.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...chunks,directory,end]);
}
async function fixture(t,files){
 const root=await mkdtemp(path.join(tmpdir(),'NuPhy SQLite 解压 0 '));t.after(()=>rm(root,{recursive:true,force:true}));
 const zip=path.join(root,'tools with 空格.zip'),output=path.join(root,'output with 空格');
 await writeFile(zip,storedZip(files));return {root,zip,output};
}
test('SQLite extraction selects only sqlite3.exe and preserves paths with spaces and Unicode',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t,{'sqlite3.exe':'verified SQLite fixture','other-tool.exe':'not required'});
 await extractWindowsSQLite(f.zip,f.output);
 assert.deepEqual(await readdir(f.output),['sqlite3.exe']);
 assert.equal(await readFile(path.join(f.output,'sqlite3.exe'),'utf8'),'verified SQLite fixture');
});
test('SQLite extraction works when the inherited Archive command requires an unavailable three-argument overload',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t,{'sqlite3.exe':'runtime compatibility fixture'});
 await extractWindowsSQLite(f.zip,f.output,{execute:async(command,args,options)=>{
  const ps=Buffer.from(args.at(-1),'base64').toString('utf16le');
  const incompatible="function Expand-Archive {throw 'Cannot find an overload for ExtractToDirectory with 3 arguments'}; ";
  return execute(command,[...args.slice(0,-1),Buffer.from(incompatible+ps,'utf16le').toString('base64')],options);
 }});
 assert.equal(await readFile(path.join(f.output,'sqlite3.exe'),'utf8'),'runtime compatibility fixture');
});
test('SQLite extraction rejects an archive without the expected executable',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t,{'other.exe':'not SQLite'});
 await assert.rejects(extractWindowsSQLite(f.zip,f.output),/sqlite3\.exe/i);
});
test('SQLite extraction distinguishes timeout from a nonzero exit and preserves the original error',async()=>{
 for(const failure of [Object.assign(new Error('fixture timeout'),{killed:true,signal:'SIGTERM'}),Object.assign(new Error('fixture failed'),{code:1,stderr:'fixture extraction error'})]){
  await assert.rejects(extractWindowsSQLite('unused.zip','unused',{execute:async()=>{throw failure;}}),error=>{
   assert.equal(error.cause,failure);assert.match(error.message,/SQLite/);
   assert.match(error.message,failure.killed?/超时/:/fixture extraction error/);return true;
  });
 }
});
