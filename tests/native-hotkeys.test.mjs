import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('native F row handles secondaryFn, ignores modified typing, deduplicates and restores pass-through when off',{skip:process.platform!=='darwin'},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-hotkey-unit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=await readFile(new URL('../native/AppHost.swift',import.meta.url),'utf8');
  // Compile the production handler without starting NSApplication, installing
  // any event tap, posting events or reaching a downstream app/network.
  const body=source+`
let host=AppDelegate()
host.hotkeysEnabled=true;host.keyConfiguration=[("F11",103)]
func event(_ code:CGKeyCode=103,_ flags:CGEventFlags = .maskSecondaryFn,_ repeatValue:Int64=0)->CGEvent {
 let e=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:true)!
 e.flags=flags;e.setIntegerValueField(.keyboardEventAutorepeat,value:repeatValue);return e
}
func check(_ result:Bool,_ message:String){if !result{fatalError(message)}}
check(host.handleReservedKey(.keyDown,event()),"physical Fn-marked F11 captured")
check(host.handleReservedKey(.keyDown,event()),"duplicate delivery consumed")
check(host.handleReservedKey(.keyDown,event(103,.maskSecondaryFn,1)),"repeat consumed")
check(host.keyEventQueue.count==1,"one down only")
check(host.handleReservedKey(.keyUp,event(103,.maskControl)),"release even if modifier changed")
check(host.keyEventQueue.count==2 && host.heldHotkeys.isEmpty,"one complete gesture")
check(host.keyEventQueue.map{$0["phase"] as? String} == ["down","up"],"down then up")
check(host.keyEventQueue[0]["gestureId"] as? String == host.keyEventQueue[1]["gestureId"] as? String,"release retains original gesture identity")
for flags:CGEventFlags in [.maskCommand,.maskControl,.maskAlternate,.maskShift] {
 check(!host.handleReservedKey(.keyDown,event(103,flags)),"modified shortcut left intact")
}
check(!host.handleReservedKey(.keyDown,event(0)),"ordinary typing left intact")
host.keyConfiguration=[("KeyA",0)]
check(!host.handleReservedKey(.keyDown,event()),"unbound F11 restored")
host.keyConfiguration=[("F11",103)]
_ = host.handleReservedKey(.keyDown,event())
host.setHotkeysEnabled(false)
check(host.heldHotkeys.isEmpty && host.keyEventQueue.last?["phase"] as? String == "up","suspension releases hold")
check(!host.handleReservedKey(.keyDown,event()),"disabled capture passes through")
for (keyCode,code) in functionKeyCodes {
 host.keyEventQueue.removeAll();host.keyConfiguration=[(code,keyCode)];host.hotkeysEnabled=true
 check(host.handleReservedKey(.keyDown,event(CGKeyCode(keyCode))),"every configured F key is captured")
 check(host.handleReservedKey(.keyDown,event(CGKeyCode(keyCode),.maskSecondaryFn,1)),"held F key does not repeat")
 check(host.handleReservedKey(.keyUp,event(CGKeyCode(keyCode))),"F release is consumed")
 check(host.keyEventQueue.count==2 && host.keyEventQueue[0]["code"] as? String == code,"one action per configured F key")
 host.setHotkeysEnabled(false)
 check(!host.handleReservedKey(.keyDown,event(CGKeyCode(keyCode))),"mode off passes original F key through")
 check(!host.handleReservedKey(.keyUp,event(CGKeyCode(keyCode))),"mode off passes original F release through")
 check(host.keyEventQueue.count==2,"no command when mode is off")
}
// Exact original stamps survive release; a delayed targeted copy cannot open a
// newly selected task. These calls do not install taps, post keys or open apps.
let cross=AppDelegate();cross.hotkeysEnabled=true;cross.keyConfiguration=[("F2",120)]
func deliver(_ source:NativeKeyEventSource,_ down:Bool,_ stamp:UInt64,_ repeatValue:Bool=false){
 _ = cross.handleFunctionKey(120,down:down,repeated:repeatValue,modified:false,source:source,eventTime:Double(stamp)/1_000_000_000,timestampNS:stamp)
}
deliver(.eventTap,true,1_000_000_000);deliver(.eventTap,false,1_100_000_000)
let firstGesture=cross.keyEventQueue[0]["gestureId"] as? String
deliver(.local,true,1_000_000_000);deliver(.local,false,1_100_000_000)
check(cross.keyEventQueue.count==2,"up followed by late same-event local down does not dispatch twice")
deliver(.eventTap,true,1_101_000_000)
check(cross.keyEventQueue.count==3 && cross.keyEventQueue[2]["gestureId"] as? String != firstGesture,"fast new original stamp gets a new identity without 250ms debounce")
let heldIdentity=cross.keyEventQueue[2]["gestureId"] as? String
cross.setHotkeysEnabled(false)
check(cross.keyEventQueue.last?["gestureId"] as? String == heldIdentity && cross.keyEventQueue.last?["phase"] as? String == "up","disable emits matching structured release")
cross.hotkeysEnabled=true;deliver(.local,true,1_101_000_000)
check(cross.keyEventQueue.count==4,"disable/re-enable retains seen event identities")
let carbon=AppDelegate();carbon.hotkeysEnabled=true;carbon.keyConfiguration=[("F2",120)]
carbon.carbonRegisteredCodes=["F2"]
carbon.eventTapOwnershipOverride={true}
check(carbon.handleCarbonHotKey(1,down:true,eventTime:4),"live tap consumes Carbon duplicate")
check(carbon.handleCarbonHotKey(1,down:false,eventTime:4.2),"live tap consumes Carbon release")
check(carbon.keyEventQueue.isEmpty,"Carbon is not a second F-row owner while tap is live")
carbon.eventTapOwnershipOverride={false}
_ = carbon.handleCarbonHotKey(1,down:true,eventTime:5)
_ = carbon.handleCarbonHotKey(1,down:false,eventTime:5.01)
check(carbon.keyEventQueue.count==2 && carbon.keyEventQueue[0]["eventSource"] as? String == "carbon","Carbon fallback remains available without a tap")
check(carbon.keyEventQueue[0]["gestureId"] as? String == carbon.keyEventQueue[1]["gestureId"] as? String,"Carbon fallback release has original identity")
carbon.setHotkeysEnabled(false)
let late=AppDelegate();late.hotkeysEnabled=true;late.keyConfiguration=[("F2",120)]
late.eventTapOwnershipOverride={true}
func lateEvent(_ down:Bool,_ stamp:UInt64,_ source:NativeKeyEventSource = .eventTap,_ repeated:Bool=false){
 _ = late.handleFunctionKey(120,down:down,repeated:repeated,modified:false,source:source,eventTime:Double(stamp)/1_000_000_000,timestampNS:stamp)
}
lateEvent(true,20_000_000_000);lateEvent(false,20_100_000_000);lateEvent(true,20_200_000_000)
let nextHeldID=late.keyEventQueue.last?["gestureId"] as? String
lateEvent(false,20_100_000_000,.local);lateEvent(true,20_200_000_000,.eventTap,true)
check(late.keyEventQueue.count==3 && late.heldHotkeys.contains(1),"old delayed up cannot release or relabel the newer held gesture")
lateEvent(false,20_300_000_000)
check(late.keyEventQueue.count==4 && late.keyEventQueue.last?["gestureId"] as? String == nextHeldID && late.heldHotkeys.isEmpty,"new gesture releases only with its own later key-up")
late.setHotkeysEnabled(false)
var identityGate=NativeKeyGestureGate(hostID:"offline-test")
let g1=identityGate.press(keyCode:120,code:"F2",source:.eventTap,eventTime:10,timestampNS:10_000_000_000)!
_ = identityGate.release(keyCode:120,eventTime:10.0000001,timestampNS:10_000_000_100)
check(identityGate.press(keyCode:120,code:"F2",source:.local,eventTime:10.0000005,timestampNS:10_000_000_500)==nil,"sub-microsecond cross-source conversion alias is retained")
let g2=identityGate.press(keyCode:120,code:"F2",source:.eventTap,eventTime:10.0000005,timestampNS:10_000_000_500)!
check(g2.id != g1.id,"same-source genuinely new stamp is not merged by alias tolerance")
_ = identityGate.releaseAll()
let missing=identityGate.press(keyCode:120,code:"F2",source:.local,eventTime:0,timestampNS:0)!
check(missing.id.contains("fallback-") && missing.packet(phase:"down")["eventTime"]==nil,"invalid clock gets explicit unique fallback rather than fake physical time")
check(identityGate.press(keyCode:120,code:"F2",source:.local,eventTime:nil)==nil,"fallback still obeys held-key gate")
check(identityGate.releaseAll().first?.id==missing.id,"fallback release retains identity")
let missing2=identityGate.press(keyCode:120,code:"F2",source:.local,eventTime:nil)!
check(missing2.id != missing.id,"a new invalid-clock gesture is not silently merged")
// No tap: Carbon is the only down owner when registration succeeded. Local
// events can have unrelated stamps and arrive before/after the Carbon pair.
let noTap=AppDelegate();noTap.hotkeysEnabled=true;noTap.keyConfiguration=[("F2",120)];noTap.carbonRegisteredCodes=["F2"];noTap.eventTapOwnershipOverride={false}
func localF2(_ host:AppDelegate,_ down:Bool,_ stamp:UInt64,_ repeated:Bool=false){
 check(host.handleFunctionKey(120,down:down,repeated:repeated,modified:false,source:.local,eventTime:Double(stamp)/1_000_000_000,timestampNS:stamp),"local F2 consumed without generic fallthrough")
}
localF2(noTap,true,30_000_000_000);localF2(noTap,false,30_100_000_000)
check(noTap.keyEventQueue.isEmpty,"local is not a second no-tap Carbon owner")
_ = noTap.handleCarbonHotKey(1,down:true,eventTime:30.00001);_ = noTap.handleCarbonHotKey(1,down:false,eventTime:30.10001)
localF2(noTap,true,30_000_000_000);localF2(noTap,false,30_100_000_000)
check(noTap.keyEventQueue.count==2,"independently timed late local copies cannot double dispatch")
_ = noTap.handleCarbonHotKey(1,down:true,eventTime:30.10002);_ = noTap.handleCarbonHotKey(1,down:false,eventTime:30.10003)
check(noTap.keyEventQueue.count==4,"fast new Carbon gesture does not hit a time debounce")
let localOnly=AppDelegate();localOnly.hotkeysEnabled=true;localOnly.keyConfiguration=[("F2",120)];localOnly.eventTapOwnershipOverride={false}
localF2(localOnly,true,40_000_000_000);localF2(localOnly,false,40_100_000_000)
_ = localOnly.handleCarbonHotKey(1,down:true,eventTime:40.00001);_ = localOnly.handleCarbonHotKey(1,down:false,eventTime:40.10001)
check(localOnly.keyEventQueue.count==2,"failed Carbon registration leaves a local-only owner")
check(localOnly.functionKeyCaptureDiagnostics()["localOnly"] as? [String] == ["F2"],"local-only fallback is explicit diagnostics")
// A new tap may consume a Carbon-owned key-up: it must release that original ID.
var tapAvailable=false
let restart=AppDelegate();restart.hotkeysEnabled=true;restart.keyConfiguration=[("F2",120)];restart.carbonRegisteredCodes=["F2"];restart.eventTapOwnershipOverride={tapAvailable}
_ = restart.handleCarbonHotKey(1,down:true,eventTime:50)
let carbonHeldID=restart.keyEventQueue[0]["gestureId"] as? String
tapAvailable=true
_ = restart.handleFunctionKey(120,down:false,repeated:false,modified:false,source:.eventTap,eventTime:50.1,timestampNS:50_100_000_000)
check(restart.keyEventQueue.count==2 && restart.keyEventQueue.last?["gestureId"] as? String == carbonHeldID,"tap restart releases the Carbon-owned hold")
_ = restart.handleCarbonHotKey(1,down:false,eventTime:50.10001)
check(restart.keyEventQueue.count==2,"late old-owner up is not sent twice")
// Tap loss cannot strand a command hold or turn its Carbon repeat into a press.
_ = restart.handleFunctionKey(120,down:true,repeated:false,modified:false,source:.eventTap,eventTime:51,timestampNS:51_000_000_000)
let interruptedID=restart.keyEventQueue.last?["gestureId"] as? String
tapAvailable=false
_ = restart.reconcileFunctionKeyTap()
check(restart.keyEventQueue.count==4 && restart.keyEventQueue.last?["phase"] as? String == "up" && restart.keyEventQueue.last?["gestureId"] as? String == interruptedID,"tap loss sends matching up immediately")
_ = restart.handleCarbonHotKey(1,down:true,eventTime:51.00001)
check(restart.keyEventQueue.count==4,"uncertain held Carbon delivery waits for physical up")
localF2(restart,false,51_100_000_000)
_ = restart.handleCarbonHotKey(1,down:true,eventTime:51.00001)
check(restart.keyEventQueue.count==4,"completed physical up boundary rejects late old down despite different clocks")
_ = restart.handleCarbonHotKey(1,down:true,eventTime:51.10001);_ = restart.handleCarbonHotKey(1,down:false,eventTime:51.10002)
check(restart.keyEventQueue.count==6,"new Carbon gesture works immediately after release")
// A genuine new raw press can recover after a missed up; autorepeat cannot.
tapAvailable=true
_ = restart.handleFunctionKey(120,down:true,repeated:false,modified:false,source:.eventTap,eventTime:52,timestampNS:52_000_000_000)
tapAvailable=false;_ = restart.reconcileFunctionKeyTap();tapAvailable=true
_ = restart.handleFunctionKey(120,down:true,repeated:true,modified:false,source:.eventTap,eventTime:52.1,timestampNS:52_100_000_000)
let afterRepeat=restart.keyEventQueue.count
_ = restart.handleFunctionKey(120,down:true,repeated:false,modified:false,source:.eventTap,eventTime:52.2,timestampNS:52_200_000_000)
check(restart.keyEventQueue.count==afterRepeat+1,"fresh nonrepeat raw event recovers without blind timeout")
restart.setHotkeysEnabled(false);noTap.setHotkeysEnabled(false);localOnly.setHotkeysEnabled(false)
var longHeld=NativeKeyGestureGate(hostID:"bounded-alias")
_ = longHeld.press(keyCode:120,code:"F2",source:.carbon,eventTime:60,timestampNS:60_000_000_000)
for index in 1...10000 {_ = longHeld.press(keyCode:120,code:"F2",source:.carbon,eventTime:60+Double(index)/1_000_000,timestampNS:60_000_000_000+UInt64(index)*1000)}
check(longHeld.activeCount==1 && longHeld.maximumAliasCount<=8,"long held aliases have a small per-source upper bound")
// Reproduce launch-before-permission: Carbon accepted F11, but its capture
// failed. Granting access later must retry and clear the stale failure.
host.hotkeysEnabled=true;host.keyConfiguration=[("F3",99),("F11",103)]
host.carbonRegisteredCodes=["F3","F11"]
var captureAllowed=false;var attempts=0
host.captureAttemptOverride={attempts+=1;return captureAllowed}
let now=Date(timeIntervalSince1970:100)
host.refreshReservedKeyCapture(force:true,now:now)
check(host.failedCodes==["F11"] && host.registeredCodes==["F3"],"failed capture never also reports ready")
captureAllowed=true
host.refreshReservedKeyCapture(now:now.addingTimeInterval(1))
check(attempts==1,"failed capture retry is bounded")
host.refreshReservedKeyCapture(now:now.addingTimeInterval(3))
check(host.failedCodes.isEmpty && host.registeredCodes==["F3","F11"],"grant automatically recovers F11")
check(attempts==2,"grant retried without mode toggle")
host.setHotkeysEnabled(false)
var recovery=WorkerRestartPolicy()
check(recovery.nextDelay(now:0)==0.5,"first unexpected exit retries quietly")
check(recovery.nextDelay(now:1)==1.5,"repeat failure backs off")
check(recovery.nextDelay(now:3)==4.0,"last bounded retry")
check(recovery.nextDelay(now:8)==nil,"permanent crash does not loop")
check(recovery.nextDelay(now:64)==0.5,"stable later session gets its own retry window")
let pending=PendingAppUpdate(targetVersion:"1.2.1",createdAt:100)
check(pending.needsGUIRelaunch(version:"1.2.1",arguments:[],now:101),"installed update reopens in the user's GUI session")
check(!pending.needsGUIRelaunch(version:"1.2.0",arguments:[],now:101),"cancelled or incomplete install cannot relaunch old app")
check(!pending.needsGUIRelaunch(version:"1.2.1",arguments:[PendingAppUpdate.relaunchArgument],now:101),"relaunch is bounded to one attempt")
check(!pending.needsGUIRelaunch(version:"1.2.1",arguments:[],now:100+86400),"expired update marker cannot change ordinary startup")
check(!pending.needsGUIRelaunch(version:"1.2.1",arguments:[],now:99),"future-dated marker is ignored")
print("native-hotkeys-passed")
`;
  const file=path.join(dir,'main.swift'),binary=path.join(dir,'check');await writeFile(file,body);
  await promisify(execFile)('swiftc',['-module-cache-path',path.join(dir,'module-cache'),file,...['AppInstance.swift','AudioCapture.swift','KeyGestureGate.swift'].map(name=>decodeURIComponent(new URL('../native/'+name,import.meta.url).pathname)),'-o',binary,'-framework','AppKit','-framework','WebKit','-framework','Carbon','-framework','AVFoundation','-framework','CoreAudio','-framework','Accelerate']);
  assert.match((await promisify(execFile)(binary,[])).stdout,/native-hotkeys-passed/);
});
