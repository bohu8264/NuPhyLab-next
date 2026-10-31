import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';

// Compile only the production dependency-injected task diagnostic helper.
// No HIDBridge main, NSWorkspace, IOHID, CGEvent, permissions or App execution.
test('actual native task diagnostic helper opens once and preserves rejected/unknown handler paths',{skip:process.platform!=='darwin'},async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'nuphy-task-open-fixture-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=await readFile(new URL('../native/HIDBridge.swift',import.meta.url),'utf8');
  const start=source.indexOf('struct TaskOpenHandlerSnapshot {'),end=source.indexOf('\nfinal class KeyHooks {',start);
  assert.ok(start>=0&&end>start,'production native diagnostic helper missing');
  const fixture=String.raw`
let url=URL(string:"codex://threads/fixture-b")!
let id="task-open:"+String(repeating:"a",count:32)
var checks=0
func check(_ yes:Bool,_ message:String){precondition(yes,message);checks += 1}
func run(_ diagnosticId:String?,_ accepted:Bool,_ available:Bool)->[[String:Any]] {
  var calls=[String](),events=[[String:Any]]()
  let result=TaskOpenDiagnostics.deliver(url:url,threadId:"fixture-b",diagnosticId:diagnosticId,
    handler:{u in calls.append("lookup");check(u==url,"handler gets exact URL");return TaskOpenHandlerSnapshot(available:available,bundleId:available ? "com.openai.codex":nil,version:available ? "26.1021.31345":nil,build:available ? "21828":nil)},
    open:{u in calls.append("open");check(u==url,"single exact open URL");return accepted},now:{123456},report:{e in calls.append("report");events.append(e)})
  check(result==accepted,"preserve original OS result")
  check(calls.filter{$0=="open"}.count==1,"exactly one open, no retry")
  if diagnosticId==id {
    check(calls==["lookup","open","report"],"snapshot before open and event after result")
    check(events.count==1,"one event")
    check(events[0]["osAccepted"] as? Bool==accepted,"event preserves OS result")
    check(events[0]["uri"] as? String==url.absoluteString,"event final URI")
  }else{check(calls==["open"]&&events.isEmpty,"legacy/invalid diagnostic id does not add lookup/event")}
  return events
}
_ = run(id,true,true)
_ = run(id,false,true)
let unavailable=run(id,true,false)
check((unavailable[0]["handler"] as? [String:Any])?["available"] as? Bool==false,"missing handler does not block open")
_ = run(nil,true,true)
_ = run("forged prompt value",true,true)
let safe=TaskOpenHandlerSnapshot(available:true,bundleId:"com.openai.codex",version:"DO NOT RECORD",build:String(repeating:"x",count:81)).json
check(safe["version"] is NSNull&&safe["build"] is NSNull,"native handler fields are bounded and whitelisted")
print("TASK_OPEN_NATIVE_CHECKS=\(checks)")
`;
  await writeFile(path.join(dir,'probe.swift'),'import Foundation\n'+source.slice(start,end)+'\n'+fixture);
  const run=promisify(execFile);
  await run('xcrun',['swiftc',path.join(dir,'probe.swift'),'-o',path.join(dir,'probe')],{timeout:60000});
  const result=await run(path.join(dir,'probe'),[],{timeout:10000});
  assert.match(result.stdout,/TASK_OPEN_NATIVE_CHECKS=\d+/);
});
