// Prepare only. Publishing assets and then the feed is a separate release step.
import {readFile,mkdir,copyFile,writeFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const [artifactArg,directoryArg]=process.argv.slice(2);
if(!artifactArg||!directoryArg)throw new Error('Usage: node scripts/prepare-appcast.mjs <notarized.dmg> <new-output-directory>');
const artifact=path.resolve(artifactArg),directory=path.resolve(directoryArg);
if(path.extname(artifact)!=='.dmg')throw new Error('Expected a signed, notarized DMG');
const config=JSON.parse(await readFile(path.join(root,'config/updates.json'),'utf8'));
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Release version must be stable semver');
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
run('/usr/bin/codesign',['--verify','--strict',artifact]);
run('/usr/bin/xcrun',['stapler','validate',artifact]);
await mkdir(directory,{recursive:false});
const local=path.join(directory,path.basename(artifact));await copyFile(artifact,local);
try {await access(path.join(root,'updates/appcast.xml'));await copyFile(path.join(root,'updates/appcast.xml'),path.join(directory,'appcast.xml'));} catch(error) {if(error.code!=='ENOENT')throw error;}
const bin=path.join(root,'vendor/sparkle/bin');
const prefix=`https://github.com/${config.repository}/releases/download/v${version}/`;
run(path.join(bin,'generate_appcast'),['--account',config.keychainAccount,'--download-url-prefix',prefix,
  '--maximum-deltas','0','--maximum-versions','1','--link',`https://github.com/${config.repository}`,'--versions',version,directory]);
const feed=path.join(directory,'appcast.xml');
run(path.join(bin,'sign_update'),['--account',config.keychainAccount,'--verify',feed]);
const xml=await readFile(feed,'utf8');
if(!xml.includes(prefix)||!xml.includes(`<sparkle:version>${version}</sparkle:version>`))throw new Error('Generated feed is missing this release');
const bytes=await readFile(artifact);
await writeFile(path.join(directory,'FEED_VERIFICATION.json'),JSON.stringify({version,feedURL:config.feedURL,
  downloadPrefix:prefix,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
  signedFeedVerified:true,published:false},null,2)+'\n');
console.log(`Prepared verified update feed: ${feed}`);
