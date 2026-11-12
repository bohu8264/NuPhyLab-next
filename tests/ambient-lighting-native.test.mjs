import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('native sensor lifecycle: invalid values, cancelled samples, sleep/wake and bounded read-only sampling',{skip:process.platform!=='darwin'},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nuphy-ambient-lifecycle-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const main=path.join(dir,'main.swift'),binary=path.join(dir,'probe');
  await writeFile(main,`import Foundation
import AppKit
for value in [-1.0,Double.nan,Double.infinity,200001] { precondition(AmbientLightReading.measured(value).status == "unavailable") }
precondition(AmbientLightReading.measured(0).status == "ready")
var samples=[[String:Any]]()
let monitor=AmbientLightMonitor()
monitor.onSample={ samples.append($0) }
func pump(_ seconds:Double) { RunLoop.main.run(until:Date().addingTimeInterval(seconds)) }
monitor.sync(enabled:true);monitor.stop();pump(0.2)
precondition(samples.isEmpty,"late sample after disabling")
monitor.sync(enabled:true);pump(1.3)
precondition(!samples.isEmpty,"no sample or unavailable report")
NSWorkspace.shared.notificationCenter.post(name:NSWorkspace.willSleepNotification,object:nil)
let sleepCount=samples.count
precondition(samples.last?["status"] as? String == "sleeping")
pump(1.2);precondition(samples.count == sleepCount,"sampled while asleep")
NSWorkspace.shared.notificationCenter.post(name:NSWorkspace.didWakeNotification,object:nil)
pump(1.2);precondition(samples.count > sleepCount,"did not resume after wake")
monitor.stop();let stopped=samples.count;pump(0.2)
precondition(samples.count == stopped,"sample arrived after stop")
let sequences=samples.compactMap{$0["sequence"] as? Int}
precondition(zip(sequences,sequences.dropFirst()).allSatisfy{$0 < $1})
print(String(data:try! JSONSerialization.data(withJSONObject:["samples":samples,"lifecyclePassed":true],options:.sortedKeys),encoding:.utf8)!)
`);
  execFileSync('swiftc',['native/AmbientLight.swift',main,'-o',binary,'-framework','AppKit','-framework','IOKit'],{timeout:60000});
  const result=JSON.parse(execFileSync(binary,[],{encoding:'utf8',timeout:15000}));
  assert.equal(result.lifecyclePassed,true);
  assert.ok(result.samples.some(x=>['ready','unavailable','lidClosed'].includes(x.status)));
  assert.ok(result.samples.length<=6,'sampling stays at one hertz');
});
