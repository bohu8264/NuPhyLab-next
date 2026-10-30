import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('host and helper observe grant and revocation in the same process when CoreGraphics preflight stays cached',{skip:process.platform!=='darwin'},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-permission-native-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const host=await readFile(new URL('../native/AppHost.swift',import.meta.url),'utf8');
  const helper=await readFile(new URL('../native/HIDBridge.swift',import.meta.url),'utf8');
  const start=helper.indexOf('func permissionSnapshot()');
  const end=helper.indexOf('\nfunc permissionSettingsURL',start);
  assert(start>=0&&end>start);
  // Compile the production readers. Only OS authorization APIs are replaced;
  // no TCC reset, prompt, keyboard access, event tap or shortcut is performed.
  const source=host+'\n'+helper.slice(start,end)+`
var liveListen=kIOHIDAccessTypeDenied, livePost=kIOHIDAccessTypeDenied
var liveAccessibility=false, cachedCG=false, cgCalls=0
func IOHIDCheckAccess(_ request:IOHIDRequestType)->IOHIDAccessType {
    request == kIOHIDRequestTypeListenEvent ? liveListen : livePost
}
func AXIsProcessTrusted()->Bool {liveAccessibility}
func CGPreflightListenEventAccess()->Bool {cgCalls+=1;return cachedCG}
func CGPreflightPostEventAccess()->Bool {cgCalls+=1;return cachedCG}
let app=AppDelegate()
var checks=0
func expect(_ listen:Bool,_ access:Bool,_ post:Bool) {
    for snapshot in [app.nativePermissionSnapshot(),permissionSnapshot()] {
        for (key,value) in [("inputMonitoring",listen),("accessibility",access),("canPostEvents",post),("promptsRequested",false)] {
            precondition(snapshot[key] as? Bool == value,"wrong \\(key)");checks+=1
        }
    }
}
expect(false,false,false)
liveListen=kIOHIDAccessTypeGranted;expect(true,false,false)
livePost=kIOHIDAccessTypeGranted;liveAccessibility=true;expect(true,true,true)
// Revocation must not inherit an old true value either.
cachedCG=true;liveListen=kIOHIDAccessTypeDenied;expect(false,true,true)
livePost=kIOHIDAccessTypeDenied;liveAccessibility=false;expect(false,false,false)
liveListen=kIOHIDAccessTypeUnknown;livePost=kIOHIDAccessTypeUnknown;expect(false,false,false)
liveListen=kIOHIDAccessTypeGranted;livePost=kIOHIDAccessTypeGranted;liveAccessibility=true;expect(true,true,true)
precondition(cgCalls==0,"cached CoreGraphics readers must not gate live authorization")
print("permission-transition-checks=\\(checks)")
`;
  const file=path.join(dir,'main.swift'),binary=path.join(dir,'check');await writeFile(file,source);
  const run=promisify(execFile);
  await run('swiftc',[file,...['AppInstance.swift','AudioCapture.swift'].map(name=>fileURLToPath(new URL('../native/'+name,import.meta.url))),'-o',binary,
    ...['AppKit','WebKit','Carbon','ApplicationServices','IOKit','AVFoundation','CoreAudio','Accelerate'].flatMap(name=>['-framework',name])]);
  assert.match((await run(binary)).stdout,/permission-transition-checks=56/);
});
