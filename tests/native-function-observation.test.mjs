import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('native F2 candidate observations are bounded metadata and preserve actual key routing',{skip:process.platform!=='darwin'},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nuphylab-function-observation-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=await readFile(new URL('../native/AppHost.swift',import.meta.url),'utf8');
  const fixture=source+`
// These are synthetic in-memory events only. No NSApplication, event tap,
// process, window, posted input, HTTP request or application-data log is started.
var checks=0
func check(_ result:Bool,_ message:String){checks+=1;if !result{fatalError(message)}}
let fields:Set<String>=["seq","source","vk","phase","uptimeSeconds","uptimeNS","modifiers","repeat","consumed"]
var pure=NativeFunctionKeyObservations()
let stamp:UInt64=9_007_199_254_740_993
let first=pure.record(source:.eventTap,keyCode:120,phase:"down",uptimeSeconds:9.25,timestampNS:stamp,
    flags:[.maskCommand,.maskSecondaryFn,.maskAlphaShift],repeated:true,consumed:false)!
check(Set(first.keys)==fields,"closed metadata fields")
check(first["seq"] as? Int==1 && first["source"] as? String=="eventTap" && first["vk"] as? UInt32==120,"original source and key code")
check(first["uptimeNS"] as? String=="9007199254740993","nanoseconds preserve precision as a string")
check(first["modifiers"] as? [String]==["command","function","capsLock"],"only named modifier bits")
check(first["repeat"] as? Bool==true && first["consumed"] as? Bool==false,"repeat and actual consumption are separate")
for code:UInt32 in [0,18,122,103,65535] {
    check(pure.record(source:.eventTap,keyCode:code,phase:"down",uptimeSeconds:1,timestampNS:1,
        flags:[],repeated:false,consumed:false)==nil,"ordinary or unrelated keys are never observed")
}
check(pure.record(source:.carbon,keyCode:120,phase:"down",uptimeSeconds:1,timestampNS:1,flags:[],repeated:false,consumed:true)==nil,"Carbon is not mislabelled as raw input")
check(pure.record(source:.local,keyCode:120,phase:"other",uptimeSeconds:1,timestampNS:1,flags:[],repeated:false,consumed:true)==nil,"only down and up phases")
let invalidClock=pure.record(source:.local,keyCode:107,phase:"up",uptimeSeconds:Double.nan,timestampNS:0,
    flags:CGEventFlags(rawValue:1),repeated:false,consumed:false)!
check(invalidClock["uptimeSeconds"] is NSNull && invalidClock["uptimeNS"] is NSNull,"invalid clocks are explicitly unavailable")
check(invalidClock["modifiers"] as? [String]==[],"unrecognized flag bits do not add data")
let f15=pure.record(source:.local,keyCode:113,phase:"down",uptimeSeconds:3,timestampNS:3,
    flags:[.maskControl,.maskAlternate,.maskShift],repeated:false,consumed:false)!
check(f15["modifiers"] as? [String]==["control","option","shift"],"modified candidates remain observable")
let line=NativeFunctionKeyObservations.logLine(first)!
let prefix=Data("[FunctionKeyObservation] ".utf8)
check(line.starts(with:prefix) && line.last==10,"one existing-log JSONL record")
let decoded=try! JSONSerialization.jsonObject(with:line.dropFirst(prefix.count).dropLast()) as! [String:Any]
check(Set(decoded.keys)==fields && decoded["uptimeNS"] as? String=="9007199254740993","log has the same closed metadata")
while pure.rows.count < NativeFunctionKeyObservations.limit {
    _=pure.record(source:.local,keyCode:120,phase:"down",uptimeSeconds:1,timestampNS:1,flags:[],repeated:false,consumed:true)
}
let frozen=try! JSONSerialization.data(withJSONObject:pure.rows,options:.sortedKeys)
for _ in 0..<1024 {
    check(pure.record(source:.eventTap,keyCode:113,phase:"up",uptimeSeconds:2,timestampNS:2,
        flags:[],repeated:true,consumed:false)==nil,"runtime cap stops logging rather than evicting and appending")
}
check(pure.rows.count==128 && (pure.rows.first?["seq"] as? Int)==1 && (pure.rows.last?["seq"] as? Int)==128,"runtime records remain bounded")
check((try! JSONSerialization.data(withJSONObject:pure.rows,options:.sortedKeys))==frozen,"capped records do not mutate")

func cg(_ code:CGKeyCode,_ down:Bool=true,_ flags:CGEventFlags=[],_ repeated:Int64=0,_ stamp:UInt64=1_000_000_000)->CGEvent {
    let event=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down)!
    event.flags=flags;event.timestamp=stamp;event.setIntegerValueField(.keyboardEventAutorepeat,value:repeated)
    return event
}
func rows(_ host:AppDelegate)->[[String:Any]] {host.functionKeyCaptureDiagnostics()["functionKeyObservations"] as! [[String:Any]]}
let tap=AppDelegate();tap.hotkeysEnabled=true;tap.keyConfiguration=[("F2",120)];tap.eventTapOwnershipOverride={true}
check(tap.worker==nil && tap.baseURL==nil,"offline host has no worker or HTTP destination")
check(tap.handleReservedKey(.keyDown,cg(120)),"bare F2 still consumed")
check(tap.handleReservedKey(.keyDown,cg(120,true,[],1)),"F2 repeat still consumed")
check(tap.handleReservedKey(.keyUp,cg(120,false,.maskCommand,0,1_100_000_000)),"held F2 release still consumed after modifier change")
check(tap.keyEventQueue.count==2,"observation cannot duplicate command delivery")
for code:CGKeyCode in [107,113] {
    check(!tap.handleReservedKey(.keyDown,cg(code,true,[],0,2_000_000_000)),"unmapped alias still passes through")
    check(rows(tap).last?["consumed"] as? Bool==false,"pass-through alias is visible before unknown-key early guard")
}
check(!tap.handleReservedKey(.keyDown,cg(120,true,.maskCommand,0,3_000_000_000)),"modified F2 still passes through")
check(rows(tap).last?["modifiers"] as? [String]==["command"] && rows(tap).last?["consumed"] as? Bool==false,"actual modified pass-through is observed")
let beforeOrdinary=rows(tap).count
check(!tap.handleReservedKey(.keyDown,cg(0)),"ordinary typing still passes through")
check(!tap.handleReservedKey(.flagsChanged,cg(120)) && rows(tap).count==beforeOrdinary,"ordinary and non-key events produce no metadata")
tap.hotkeysEnabled=false
check(!tap.handleReservedKey(.keyDown,cg(120)) && rows(tap).count==beforeOrdinary,"disabled integration does not observe candidates")

func local(_ code:UInt16,_ down:Bool=true,_ modifiers:NSEvent.ModifierFlags=[],_ repeated:Bool=false,_ time:Double=10)->NSEvent {
    NSEvent.keyEvent(with:down ? .keyDown:.keyUp,location:.zero,modifierFlags:modifiers,timestamp:time,
        windowNumber:0,context:nil,characters:"not-observable-characters",charactersIgnoringModifiers:"not-observable-characters",
        isARepeat:repeated,keyCode:code)!
}
let localHost=AppDelegate();localHost.hotkeysEnabled=true;localHost.keyConfiguration=[("F2",120)];localHost.eventTapOwnershipOverride={false}
check(localHost.handleLocalKey(local(120))==nil && localHost.handleLocalKey(local(120,false,[],false,10.1))==nil,"actual local-only F2 route still consumes the pair")
check(localHost.keyEventQueue.count==2 && rows(localHost).allSatisfy{$0["consumed"] as? Bool==true},"local observation uses the final consumed outcome")
for code:UInt16 in [107,113] {
    let event=local(code)
    check(localHost.handleLocalKey(event)===event,"local F14/F15 remains pass-through")
    check(rows(localHost).last?["consumed"] as? Bool==false,"local pass-through is observed")
}
let modified=local(120,true,[.command,.shift])
check(localHost.handleLocalKey(modified)===modified && rows(localHost).last?["modifiers"] as? [String]==["command","shift"],"local modifier metadata does not consume the shortcut")
let generic=AppDelegate();generic.hotkeysEnabled=true;generic.keyConfiguration=[("custom",107)]
check(generic.handleLocalKey(local(107))==nil && generic.keyEventQueue.count==1 && rows(generic).last?["consumed"] as? Bool==true,"local generic fallback keeps its original dispatch and final consumed value")
let privateJson=String(data:try! JSONSerialization.data(withJSONObject:rows(localHost)),encoding:.utf8)!
check(!privateJson.contains("not-observable") && rows(localHost).allSatisfy{Set($0.keys)==fields},"event characters never enter observations")
let finalCount=rows(localHost).count
localHost.hotkeysEnabled=false
let off=local(113)
check(localHost.handleLocalKey(off)===off && rows(localHost).count==finalCount,"local mode-off leaves input and metadata untouched")
check(NSApp==nil && tap.worker==nil && localHost.worker==nil && generic.worker==nil,"test never starts NSApplication or a worker/log transport")
print("native-function-observation-passed checks=\\(checks)")
`;
  const main=path.join(directory,'main.swift'),binary=path.join(directory,'check');
  await writeFile(main,fixture);
  const run=promisify(execFile);
  await run('swiftc',['-module-cache-path',path.join(directory,'module-cache'),main,
    ...['AppInstance.swift','AudioCapture.swift','KeyGestureGate.swift'].map(name=>decodeURIComponent(new URL('../native/'+name,import.meta.url).pathname)),
    '-o',binary,...['AppKit','WebKit','Carbon','AVFoundation','CoreAudio','Accelerate'].flatMap(name=>['-framework',name])]);
  assert.match((await run(binary)).stdout,/native-function-observation-passed checks=\d+/);
});
