import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('real Sparkle delegate compiles; reminder and signed version-specific language decisions are deterministic',{skip:process.platform!=='darwin',timeout:120000},async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'nuphy-updater-unit-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const source=await readFile(new URL('../native/AppHost.swift',import.meta.url),'utf8');
 const checks=`
if let expected = UserDefaults.standard.string(forKey:"ExpectedInterfaceLanguage") {
    precondition(AppDelegate.systemInterfaceLanguage == expected)
}
let reminder=AppUpdateReminder(version:"2.0.0",remindAfter:86400)
precondition(!reminder.allows(version:"2.0.0",userInitiated:false,now:86399))
precondition(reminder.allows(version:"2.0.0",userInitiated:false,now:86400))
precondition(reminder.allows(version:"2.0.0",userInitiated:true,now:1))
precondition(reminder.allows(version:"2.0.1",userInitiated:false,now:1))
precondition(AppUpdateReminder.delay == 86400)
let notes="NUPHY-RELEASE-NOTES 1\\nversion:2.0.0\\n[zh-CN]\\n版本说明\\n[en]\\nRelease notes\\n"
precondition(localizedAppReleaseNotes(notes,version:"2.0.0",english:false) == "版本说明")
precondition(localizedAppReleaseNotes(notes,version:"2.0.0",english:true) == "Release notes")
precondition(localizedAppReleaseNotes(notes,version:"2.0.1",english:true) == nil)
precondition(localizedAppReleaseNotes(notes.replacingOccurrences(of:"Release notes",with:""),version:"2.0.0",english:true) == nil)
precondition(localizedAppReleaseNotes("Legacy release notes",version:"2.0.0",english:true) == nil)
precondition(LabUpdateUserDriver.instancesRespond(to:NSSelectorFromString("showUpdateFoundWithAppcastItem:state:reply:")))
precondition(AppDelegate.instancesRespond(to:NSSelectorFromString("updater:userDidMakeChoice:forUpdate:state:")))
precondition(AppDelegate.instancesRespond(to:NSSelectorFromString("updater:shouldProceedWithUpdate:updateCheck:error:")))
if !CommandLine.arguments.contains("--update-ui-qa") {print("{\\"checks\\":13,\\"network\\":false,\\"hardware\\":false}")}
`;
 const main=path.join(directory,'main.swift'),binary=path.join(directory,'check'),framework=fileURLToPath(new URL('../vendor/sparkle',import.meta.url));
 const presentationChecks=await readFile(new URL('./fixtures/native-update-ui-checks.swift',import.meta.url),'utf8');
 await writeFile(main,source+'\n'+checks+'\n'+presentationChecks);
 const run=promisify(execFile);await run('swiftc',[main,...['../tests/fixtures/selection-host-boundary.swift','AppInstance.swift','UpdateUserDriver.swift','AudioCapture.swift','KeyGestureGate.swift'].map(name=>fileURLToPath(new URL('../native/'+name,import.meta.url))),'-o',binary,'-F',framework,'-framework','Sparkle','-Xlinker','-rpath','-Xlinker',framework,...['AppKit','WebKit','Carbon','AVFoundation','CoreAudio','Accelerate'].flatMap(name=>['-framework',name])]);
 for (const [preferred, expected] of [
   ['(en-GB,zh-Hans)', 'en'], ['(ja,zh-Hant,en)', 'zh-CN'], ['(fr,ja)', 'en']
 ]) {
   const result = await run(binary,['-AppleLanguages',preferred,'-ExpectedInterfaceLanguage',expected]);
   assert.deepEqual(JSON.parse(result.stdout.trim()),{checks:13,network:false,hardware:false});
 }
 // An argument-domain locale only affects this temporary child process. No
 // defaults command or persisted AppleLanguages preference is ever written.
 const snapshotArgs=process.env.NUPHY_UPDATE_QA_SCREENSHOTS?['--update-layout-snapshots',process.env.NUPHY_UPDATE_QA_SCREENSHOTS]:[];
 const simulated=JSON.parse((await run(binary,['--update-ui-qa',...snapshotArgs,'-AppleLanguages','(zh-Hans)','-AppleLocale','zh_CN'])).stdout.trim());
 assert.equal(simulated.simulatedSystemChinese,true);assert.equal(simulated.appEnglish,true);assert.equal(simulated.presentations,32);
 assert.equal(simulated.GUIOpened,false);assert.equal(simulated.network,false);assert.equal(simulated.hardware,false);
});
