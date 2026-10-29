import {readFile,mkdir,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(await readFile(path.join(root,'config/updates.json'),'utf8'));
export const sparkleDirectory=path.join(root,'vendor/sparkle');
export async function ensureSparkle() {
  const archive=path.join(root,`vendor/Sparkle-${config.sparkleVersion}.tar.xz`);
  await mkdir(path.dirname(archive),{recursive:true});
  let data;
  try {data=await readFile(archive);} catch {
    const response=await fetch(`https://github.com/sparkle-project/Sparkle/releases/download/${config.sparkleVersion}/Sparkle-${config.sparkleVersion}.tar.xz`,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(`Sparkle download failed: ${response.status}`);
    data=Buffer.from(await response.arrayBuffer());
  }
  if(createHash('sha256').update(data).digest('hex')!==config.sparkleSHA256)throw new Error('Sparkle checksum mismatch');
  await writeFile(archive,data);
  await mkdir(sparkleDirectory,{recursive:true});
  execFileSync('/usr/bin/tar',['-xJf',archive,'-C',sparkleDirectory]);
  await access(path.join(sparkleDirectory,'Sparkle.framework/Sparkle'));
  return sparkleDirectory;
}
