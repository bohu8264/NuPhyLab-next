import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
const exec = promisify(execFile);
// Inspect open writer handles only. Never acquire, alter or remove Codex's locks.
export async function readLiveWriters(home, ids) {
  let directory;
  try {
    const candidate=path.join(await realpath(home),'thread-writer-locks');
    try { await lstat(candidate); }
    catch(error){return error?.code==='ENOENT'?new Map():null;}
    directory=await realpath(candidate);
    if(!(await stat(directory)).isDirectory())return null;
  } catch { return null; }
  let uncertain=false;
  const files = (await Promise.all(ids.map(async id => {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return null;
    const file = path.join(directory,`${id}.lock`);
    try {
      const info=await lstat(file);
      if(!info.isFile()||info.isSymbolicLink()){uncertain=true;return null;}
      return await realpath(file);
    } catch (error) { if(error?.code!=='ENOENT')uncertain=true;return null; }
  }))).filter(Boolean);
  if(uncertain)return null;
  if (!files.length) return new Map();
  let stdout;
  try {
    const result=await exec("/usr/sbin/lsof",["-nP","-Fpcn",...files],{timeout:2000,maxBuffer:262144});
    if(result.stderr?.trim())return null;
    stdout=result.stdout;
  }
  catch (error) {
    // lsof can return 1 when only some requested files still have open handles.
    if (error.code !== 1 || error.stderr?.trim()) return null;
    stdout = error.stdout || "";
  }
  const handles = []; let pid=null, command=null;
  for (const line of stdout.split("\n")) {
    if (line[0]==="p") { pid=Number(line.slice(1)); command=null; }
    else if (line[0]==="c") command=line.slice(1);
    else if (line[0]==="n" && command === "codex") {
      if(!files.includes(line.slice(1)) || !Number.isInteger(pid))return null;
      handles.push({id:path.basename(line.slice(1),".lock"),pid});
    }
  }
  if (!handles.length) return new Map();
  const pids=[...new Set(handles.map(h=>h.pid))].filter(Number.isInteger);
  try {
    const result=await exec("/bin/ps",["-p",pids.join(","),"-o","pid=,lstart="],{timeout:1000,maxBuffer:65536,env:{...process.env,LC_ALL:"C"}});
    const started = new Map(result.stdout.trim().split("\n").flatMap(line=> {
      const match=/^\s*(\d+)\s+(.+)$/.exec(line); const time=Date.parse(match?.[2] ?? "");
      return match && Number.isFinite(time) ? [[Number(match[1]),time]] : [];
    }));
    if(result.stderr?.trim() || pids.some(pid=>!started.has(pid)))return null;
    return new Map(handles.filter(h=>started.has(h.pid)).map(h=>[h.id,{startedAt:started.get(h.pid)}]));
  } catch { return null; }
}
