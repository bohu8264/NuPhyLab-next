func check(_ condition:Bool,_ text:String){if !condition{fatalError(text)}}
let chrome:AppDelegate.DriverBrowser=(URL(fileURLWithPath:"/fixture/Google Chrome.app"),"com.google.Chrome")
let edge:AppDelegate.DriverBrowser=(URL(fileURLWithPath:"/fixture/Microsoft Edge.app"),"com.microsoft.edgemac")
let safari:AppDelegate.DriverBrowser=(URL(fileURLWithPath:"/fixture/Safari.app"),"com.apple.Safari")
var checks=0
func verify(_ condition:Bool,_ text:String){check(condition,text);checks+=1}
func run(_ browsers:[AppDelegate.DriverBrowser],_ responses:[Bool],terminating:Bool=false,doubleReply:Bool=false)->([String:Any]?,String?,[URL],Int){
 let host=AppDelegate();host.terminating=terminating
 host.driverKeyboardReleaseOverride={completion in completion(true,nil)}
 host.driverBrowserCandidatesOverride={browsers}
 var requested=[URL](),applications=[URL](),replies=0,index=0
 var result:[String:Any]?,error:String?
 host.driverBrowserOpenOverride={url,app,completion in
  requested.append(url);applications.append(app)
  let success=responses[index];index+=1
  completion(success,success ? nil : "simulated launch failure")
  if doubleReply{completion(false,"duplicate callback")}
 }
 host.openOfficialDriver{value,problem in result=value;error=problem;replies+=1}
 if !browsers.isEmpty && !terminating{verify(replies==0,"opening does not claim success before completion")}
 let end=Date().addingTimeInterval(2)
 while replies==0 && Date()<end{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
 RunLoop.current.run(until:Date().addingTimeInterval(0.02))
 verify(replies==1,"one completion only")
 verify(requested.allSatisfy{$0.absoluteString=="https://drive.nuphy.io/?lang=zh-CN"},"only fixed official URL reaches browser")
 return(result,error,applications,replies)
}
let c=run([chrome,edge,safari],[true])
verify(c.0?["opened"] as? Bool==true && c.0?["browserBundleId"] as? String==chrome.bundleID,"Chrome confirmation is returned")
verify(c.0?["browserSupportsUSB"] as? Bool==true && c.0?["needsSupportedBrowser"] as? Bool==false,"Chrome is suitable for IO USB")
verify(c.2==[chrome.url],"successful Chrome never launches an extra browser")
verify(c.0?["safeReleased"] as? Bool==true && c.0?["prepareError"]==nil,"successful release is reported separately from browser opening")
let e=run([chrome,edge,safari],[false,true])
verify(e.0?["opened"] as? Bool==true && e.0?["browserBundleId"] as? String==edge.bundleID,"failed Chrome falls back to Edge")
verify(e.2==[chrome.url,edge.url],"browser attempt order is preserved")
let s=run([chrome,edge,safari],[false,false,true])
verify(s.0?["opened"] as? Bool==true && s.0?["needsSupportedBrowser"] as? Bool==true,"default browser is distinct from an upgrade-ready browser")
verify(!(s.0?["message"] as? String ?? "").isEmpty,"default browser has visible upgrade guidance")
let f=run([chrome,edge],[false,false])
verify(f.0==nil && f.1?.contains("https://drive.nuphy.io/")==true,"all browser failures explain a manual official URL")
let n=run([],[])
verify(n.0==nil && n.1?.contains("https://drive.nuphy.io/")==true && n.2.isEmpty,"no installed browser returns an explicit error")
let q=run([chrome],[true],terminating:true)
verify(q.0==nil && q.1 != nil && q.2.isEmpty,"quitting never opens a browser")
let d=run([chrome,edge],[true],doubleReply:true)
verify(d.2==[chrome.url] && d.3==1,"late callbacks cannot double-open fallbacks")
// A blocked restore must not hide the official site, and its error must not be
// mistaken for a successful USB handoff.
let blocked=AppDelegate();blocked.driverBrowserCandidatesOverride={[chrome]}
var blockedReleaseCount=0,blockedOpens=0,blockedReplies=0
var blockedResult:[String:Any]?,blockedError:String?
blocked.driverKeyboardReleaseOverride={completion in
 blockedReleaseCount+=1;completion(false,"original F4 journal needs confirmation")
 completion(true,nil)
}
blocked.driverBrowserOpenOverride={_,_,completion in blockedOpens+=1;completion(true,nil)}
blocked.openOfficialDriver{value,error in blockedResult=value;blockedError=error;blockedReplies+=1}
let blockedEnd=Date().addingTimeInterval(2)
while blockedReplies==0 && Date()<blockedEnd{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
verify(blockedResult?["opened"] as? Bool==true && blockedError==nil,"release failure never blocks website opening")
verify(blockedResult?["safeReleased"] as? Bool==false && blockedResult?["prepareError"] as? String=="original F4 journal needs confirmation","blocked restore remains visible in the native reply")
verify(blockedReleaseCount==1 && blockedOpens==1 && blockedReplies==1,"duplicate release callbacks cannot double-open")

// Two UI paths can request the page at once (button plus an ordinary link).
// They share one restore and browser launch, and both receive the same result.
let delayed=AppDelegate();delayed.driverBrowserCandidatesOverride={[chrome]}
var releaseCallback:((Bool,String?)->Void)?,delayedReleaseCount=0,delayedOpens=0,delayedReplies=0
var delayedResults=[[String:Any]]()
delayed.driverKeyboardReleaseOverride={completion in delayedReleaseCount+=1;releaseCallback=completion}
delayed.driverBrowserOpenOverride={_,_,completion in delayedOpens+=1;completion(true,nil)}
for _ in 0..<2 {delayed.openOfficialDriver{value,_ in delayedReplies+=1;if let value=value{delayedResults.append(value)}}}
verify(delayedReleaseCount==1 && delayedOpens==0 && delayedReplies==0,"browser waits for the shared keyboard release completion")
releaseCallback?(true,nil)
let delayedEnd=Date().addingTimeInterval(2)
while delayedReplies<2 && Date()<delayedEnd{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
verify(delayedOpens==1 && delayedReplies==2,"overlapping requests coalesce one release and one browser launch")
verify(delayedResults.count==2 && delayedResults.allSatisfy{$0["safeReleased"] as? Bool==true},"all callers receive confirmed release state")

// A hung local service still leaves the official website reachable, and a
// late service callback can neither change the reply nor launch it twice.
let timeout=AppDelegate();timeout.driverBrowserCandidatesOverride={[chrome]};timeout.driverReleaseTimeoutOverride=0.02
var lateRelease:((Bool,String?)->Void)?,timeoutOpens=0,timeoutReplies=0
var timeoutResult:[String:Any]?
timeout.driverKeyboardReleaseOverride={completion in lateRelease=completion}
timeout.driverBrowserOpenOverride={_,_,completion in timeoutOpens+=1;completion(true,nil)}
timeout.openOfficialDriver{value,_ in timeoutResult=value;timeoutReplies+=1}
let timeoutEnd=Date().addingTimeInterval(2)
while timeoutReplies==0 && Date()<timeoutEnd{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
verify(timeoutResult?["opened"] as? Bool==true && timeoutResult?["safeReleased"] as? Bool==false,"release timeout opens the site without claiming safe USB release")
verify(!(timeoutResult?["prepareError"] as? String ?? "").isEmpty,"release timeout includes a visible recovery error")
lateRelease?(true,nil);RunLoop.current.run(until:Date().addingTimeInterval(0.02))
verify(timeoutOpens==1 && timeoutReplies==1 && timeoutResult?["safeReleased"] as? Bool==false,"late release completion cannot change a timed-out result or reopen the site")

let quitDuringRelease=AppDelegate();quitDuringRelease.driverBrowserCandidatesOverride={[chrome]}
var quitRelease:((Bool,String?)->Void)?,quitOpens=0,quitReplies=0
var quitError:String?
quitDuringRelease.driverKeyboardReleaseOverride={completion in quitRelease=completion}
quitDuringRelease.driverBrowserOpenOverride={_,_,completion in quitOpens+=1;completion(true,nil)}
quitDuringRelease.openOfficialDriver{_,error in quitError=error;quitReplies+=1}
quitDuringRelease.terminating=true;quitRelease?(true,nil)
let quitEnd=Date().addingTimeInterval(2)
while quitReplies==0 && Date()<quitEnd{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
verify(quitOpens==0 && quitReplies==1 && quitError != nil,"quitting during release does not launch the browser")
// A successful handoff reconnects only after the user leaves NuPhyLab and
// explicitly returns. Background timers and repeated activation cannot compete
// with the trusted website's WebHID client or reopen the browser.
func drain(){RunLoop.current.run(until:Date().addingTimeInterval(0.03))}
let returned=AppDelegate();var returnedActive=true,returnedOpens=0
returned.driverApplicationIsActiveOverride={returnedActive}
returned.driverBrowserCandidatesOverride={[chrome]}
returned.driverKeyboardReleaseOverride={completion in completion(true,nil)}
returned.driverBrowserOpenOverride={_,_,completion in returnedOpens+=1;completion(true,nil)}
var returnedCommands=[String](),connectReply:((Bool,String?)->Void)?,checkReply:((Bool,String?)->Void)?
returned.driverReturnCommandOverride={op,reply in
 returnedCommands.append(op)
 if op=="connect"{connectReply=reply}else{checkReply=reply}
}
returned.openOfficialDriver{_,_ in };drain()
verify(returned.driverReturnPending && !returned.driverReturnSawInactive,"opening a site does not pretend the user already returned")
returned.resumeAfterOfficialDriverIfNeeded();drain()
verify(returnedCommands.isEmpty,"foreground launch completion cannot reconnect immediately")
returnedActive=false;returned.applicationDidResignActive(Notification(name:NSApplication.didResignActiveNotification));returned.resumeAfterOfficialDriverIfNeeded();drain()
verify(returned.driverReturnSawInactive && returnedCommands.isEmpty,"no reconnect while the browser is foreground")
returnedActive=true;returned.applicationDidBecomeActive(Notification(name:NSApplication.didBecomeActiveNotification));drain()
verify(returnedCommands==["connect"] && returned.driverReturnInFlight,"return starts one keyboard connection")
returned.applicationDidBecomeActive(Notification(name:NSApplication.didBecomeActiveNotification));drain()
verify(returnedCommands==["connect"],"repeated app activation coalesces during reconnect")
connectReply?(true,nil);connectReply?(true,nil);drain()
verify(returnedCommands==["connect","checkFirmware"],"firmware check waits for a successful connection and cannot duplicate")
checkReply?(true,nil);drain()
verify(!returned.driverReturnInFlight && !returned.driverReturnPending,"successful return consumes the handoff")
for _ in 0..<3{returned.applicationDidBecomeActive(Notification(name:NSApplication.didBecomeActiveNotification))};drain()
verify(returnedCommands==["connect","checkFirmware"] && returnedOpens==1,"a current or still-old firmware cannot loop reconnect or reopen the browser")

let failedReturn=AppDelegate();var failedActive=false,failedCommands=[String](),failedOpens=0
failedReturn.driverApplicationIsActiveOverride={failedActive};failedReturn.driverBrowserCandidatesOverride={[chrome]}
failedReturn.driverKeyboardReleaseOverride={completion in completion(true,nil)}
failedReturn.driverBrowserOpenOverride={_,_,completion in failedOpens+=1;completion(true,nil)}
failedReturn.driverReturnCommandOverride={op,reply in failedCommands.append(op);reply(false,"fixture connection failure")}
failedReturn.openOfficialDriver{_,_ in };drain();failedActive=true
failedReturn.applicationDidBecomeActive(Notification(name:NSApplication.didBecomeActiveNotification));drain()
verify(failedCommands==["connect"] && !failedReturn.driverReturnInFlight,"failed connect does not issue a firmware command")
failedReturn.applicationDidBecomeActive(Notification(name:NSApplication.didBecomeActiveNotification));drain()
verify(failedCommands==["connect"] && failedOpens==1,"failed return remains an ordinary retry without automatic relaunch")

let departed=AppDelegate();var departedActive=false,departedCommands=[String](),departedConnect:((Bool,String?)->Void)?
departed.driverApplicationIsActiveOverride={departedActive};departed.driverBrowserCandidatesOverride={[chrome]}
departed.driverKeyboardReleaseOverride={completion in completion(true,nil)}
departed.driverBrowserOpenOverride={_,_,completion in completion(true,nil)}
departed.driverReturnCommandOverride={op,reply in departedCommands.append(op);departedConnect=reply}
departed.openOfficialDriver{_,_ in };drain();departedActive=true;departed.resumeAfterOfficialDriverIfNeeded();drain()
departedActive=false;departedConnect?(true,nil);drain()
verify(departedCommands==["connect"] && !departed.driverReturnInFlight,"leaving the app during reconnect suppresses follow-up activity")

let exitingReturn=AppDelegate();var exitingActive=false,exitingCommands=[String](),exitingConnect:((Bool,String?)->Void)?
exitingReturn.driverApplicationIsActiveOverride={exitingActive};exitingReturn.driverBrowserCandidatesOverride={[chrome]}
exitingReturn.driverKeyboardReleaseOverride={completion in completion(true,nil)}
exitingReturn.driverBrowserOpenOverride={_,_,completion in completion(true,nil)}
exitingReturn.driverReturnCommandOverride={op,reply in exitingCommands.append(op);exitingConnect=reply}
exitingReturn.openOfficialDriver{_,_ in };drain();exitingActive=true;exitingReturn.resumeAfterOfficialDriverIfNeeded();drain()
exitingReturn.terminating=true;exitingConnect?(true,nil);drain()
verify(exitingCommands==["connect"] && !exitingReturn.driverReturnInFlight,"quitting during reconnect suppresses follow-up work")
exitingReturn.driverReturnPending=true;exitingReturn.resumeAfterOfficialDriverIfNeeded();drain()
verify(exitingCommands==["connect"],"quitting can never start a return connection")

let stale=AppDelegate();var staleActive=false,staleCommands=[String](),staleConnect:((Bool,String?)->Void)?
stale.driverApplicationIsActiveOverride={staleActive};stale.driverBrowserCandidatesOverride={[chrome]}
stale.driverKeyboardReleaseOverride={completion in completion(true,nil)}
stale.driverBrowserOpenOverride={_,_,completion in completion(true,nil)}
stale.driverReturnCommandOverride={op,reply in staleCommands.append(op);staleConnect=reply}
stale.openOfficialDriver{_,_ in };drain();staleActive=true;stale.resumeAfterOfficialDriverIfNeeded();drain()
stale.openOfficialDriver{_,_ in };drain();staleConnect?(true,nil);drain()
verify(staleCommands==["connect"] && stale.driverReturnPending && !stale.driverReturnInFlight,"a newer handoff invalidates the previous connection callback")
print("{\"passed\":true,\"checks\":\(checks),\"browserOpened\":false,\"GUIOpened\":false}")
