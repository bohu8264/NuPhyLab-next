import AppKit
import ApplicationServices
guard (5...7).contains(CommandLine.arguments.count),CommandLine.arguments.dropFirst().prefix(4).allSatisfy({Double($0) != nil}) else{exit(2)}
let v=CommandLine.arguments.dropFirst().prefix(4).map{Double($0)!},a=CGPoint(x:v[0],y:v[1]),b=CGPoint(x:v[2],y:v[3])
let system=AXUIElementCreateSystemWide()
func field(_ e:AXUIElement,_ key:String)->CFTypeRef?{var v:CFTypeRef?;_=AXUIElementCopyAttributeValue(e,key as CFString,&v);return v}
var src:AXUIElement?,underDestination:AXUIElement?;AXUIElementCopyElementAtPosition(system,Float(a.x),Float(a.y),&src);AXUIElementCopyElementAtPosition(system,Float(b.x),Float(b.y),&underDestination)
guard let src else{exit(3)}
let dest=underDestination ?? system
var pid:pid_t=0;AXUIElementGetPid(src,&pid)
let parent=getppid()
func geometry(_ p:CGPoint)->[(pid_t,Int,CGRect)] {
    let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
    return windows.compactMap{w in
    guard let box=w[kCGWindowBounds as String] as? [String:CGFloat],let x=box["X"],let y=box["Y"],let width=box["Width"],let height=box["Height"],let owner=w[kCGWindowOwnerPID as String] as? pid_t,let layer=w[kCGWindowLayer as String] as? Int else{return nil}
    let rect=CGRect(x:x,y:y,width:width,height:height)
    guard rect.contains(p),(w[kCGWindowAlpha as String] as? Double ?? 1)>0.01 else{return nil}
    return (owner,layer,rect)
} }
func dropControl(_ e:AXUIElement)->Bool{
    var current:AXUIElement?=e
    for _ in 0..<6 {guard let c=current else{break}
        if field(c,"AXTitle") as? String=="Fixture Drop Target" || field(c,"AXDescription") as? String=="Fixture Drop Target" {return true}
        if let next=field(c,"AXParent"),CFGetTypeID(next)==AXUIElementGetTypeID(){current=(next as! AXUIElement)}else{break}
    };return false
}
let atSource=geometry(a)
var destPid:pid_t=0;AXUIElementGetPid(dest,&destPid)
let destApp=AXUIElementCreateApplication(destPid)
let browser=NSRunningApplication(processIdentifier:destPid)
let fixtureFront=browser?.bundleIdentifier=="com.google.Chrome" && browser?.isActive==true
let focus=field(destApp,"AXFocusedWindow").flatMap{CFGetTypeID($0)==AXUIElementGetTypeID() ? ($0 as! AXUIElement):nil}
let fixtureTitle=focus.flatMap{field($0,"AXTitle") as? String}?.contains("NuPhy R54 fixture")==true
let receiver=CommandLine.arguments.dropFirst(5).first ?? "chrome"
let isFinder=receiver.hasPrefix("NuPhy-R54-receive-") && browser?.bundleIdentifier=="com.apple.finder" && browser?.isActive==true && focus.flatMap{field($0,"AXTitle") as? String}==receiver
let fixturePage=(receiver=="chrome" && fixtureFront && fixtureTitle) || isFinder


let topShelf=atSource.first.map{$0.0==parent} ?? false
print("controlled drag guard",parent,pid,atSource.prefix(3),field(dest,"AXRole") as? String ?? "-",fixtureFront,fixtureTitle,dropControl(dest))
if receiver=="chrome-source" {
    let app=NSRunningApplication(processIdentifier:pid)
    let owner=AXUIElementCreateApplication(pid)
    let win=field(owner,"AXFocusedWindow").flatMap{CFGetTypeID($0)==AXUIElementGetTypeID() ? ($0 as! AXUIElement):nil}
    let valid=win.flatMap{field($0,"AXTitle") as? String}?.contains("NuPhy R54 fixture")==true
    let screen=CGDisplayBounds(CGMainDisplayID())
    var node:AXUIElement?=src, link=false
    for _ in 0..<8{guard let n=node else{break}
        if field(n,"AXTitle") as? String=="Shelf Source" || field(n,"AXDescription") as? String=="Shelf Source"{link=true;break}
        node=field(n,"AXParent").flatMap{CFGetTypeID($0)==AXUIElementGetTypeID() ? ($0 as! AXUIElement):nil}
    }
    let file=URL(fileURLWithPath:CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("browser-events")
    let samples=(try? String(contentsOf:file,encoding:.utf8))?.split(separator:"\n").suffix(16) ?? []
    let fixtureCoordinates=samples.contains{line in
        guard let data=try? JSONSerialization.jsonObject(with:Data(line.utf8)) as? [String:Any],data["k"] as? String=="source-point",
              let q=data["v"] as? [Double],q.count==2 else{return false}
        return abs(a.x-q[0])<1 && abs(a.y-q[1])<1
    }
    guard app?.bundleIdentifier=="com.google.Chrome",app?.isActive==true,valid,link || fixtureCoordinates,
          abs(b.x-screen.midX)<15,b.y>=screen.minY,b.y<screen.minY+35 else{exit(4)}
} else if receiver.hasPrefix("finder-source:NuPhy-R54-receive-") {
    let targetName = String(receiver.dropFirst("finder-source:".count))
    let app = NSRunningApplication(processIdentifier:pid)
    let owner = AXUIElementCreateApplication(pid)
    let win = field(owner,"AXFocusedWindow").flatMap { CFGetTypeID($0)==AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    var node: AXUIElement? = src
    var fixtureFile = false
    for _ in 0..<10 {
        guard let n = node else { break }
        let names = ["AXTitle","AXDescription","AXValue"].compactMap { field(n,$0) as? String }
        if names.contains("QA original.txt") || names.contains("QA original") { fixtureFile = true; break }
        node = field(n,"AXParent").flatMap { CFGetTypeID($0)==AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    }
    let screen = CGDisplayBounds(CGMainDisplayID())
    guard app?.bundleIdentifier == "com.apple.finder",app?.isActive == true,
          win.flatMap({field($0,"AXTitle") as? String}) == targetName,fixtureFile,
          abs(b.x - screen.midX)<15, b.y >= screen.minY, b.y < screen.minY+35 else { exit(4) }
} else {
    guard (pid==parent || topShelf),fixturePage else {exit(4)}
}
func ev(_ type:CGEventType,_ p:CGPoint){let e=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:p,mouseButton:.left);e?.post(tap:.cghidEventTap)}
ev(.mouseMoved,a);usleep(180000);ev(.leftMouseDown,a);usleep(200000)
if CommandLine.arguments.last == "shake" {
    for cycle in 0..<8 {
        let direction: CGFloat = cycle.isMultiple(of: 2) ? 1 : -1
        for step in 1...10 { ev(.leftMouseDragged,CGPoint(x:a.x+direction*CGFloat(step)*3,y:a.y+2));usleep(12000) }
    }
    for down in [true,false] { CGEvent(keyboardEventSource:nil,virtualKey:53,keyDown:down)?.post(tap:.cghidEventTap) }
    usleep(180000);ev(.leftMouseUp,a);exit(0)
}
for i in 1...38{let t=Double(i)/38;ev(.leftMouseDragged,CGPoint(x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t));usleep(28000)}
usleep(240000)
if CommandLine.arguments.last=="cancel" {
    for down in [true,false]{CGEvent(keyboardEventSource:nil,virtualKey:53,keyDown:down)?.post(tap:.cghidEventTap)}
    usleep(150000)
}
if receiver=="chrome-source" || receiver.hasPrefix("finder-source:") {
    // Enter the physical notch, then release over the visible drop surface just below the camera.
    let surface=CGPoint(x:b.x,y:b.y+52)
    for step in 1...8 {ev(.leftMouseDragged,CGPoint(x:b.x,y:b.y+52*Double(step)/8));usleep(25000)}
    usleep(350000)
    if CommandLine.arguments.last != "cancel" {
        let shelfLevel = NSWindow.Level.statusBar.rawValue + 1
        let panels = geometry(surface).filter { $0.1 == shelfLevel }
        guard panels.first?.0 == parent, panels.allSatisfy({ $0.0 == parent }) else {
            // Another copy of Lab can also offer a shelf during the same drag.
            for down in [true, false] { CGEvent(keyboardEventSource:nil,virtualKey:53,keyDown:down)?.post(tap:.cghidEventTap) }
            usleep(180000)
            ev(.leftMouseUp,surface)
            exit(5)
        }
    }
    ev(.leftMouseUp,surface)
} else {
    ev(.leftMouseUp,b)
}
