import AppKit
import Carbon

@main enum KeyBuddyChecks {
    static func main() throws {
        let args=CommandLine.arguments
        let layoutURL=URL(fileURLWithPath:args[1]), out=URL(fileURLWithPath:args[2])
        let suite="NuPhyLab.KeyBuddyQA."+UUID().uuidString
        let defaults=UserDefaults(suiteName:suite)!
        defer { defaults.removePersistentDomain(forName:suite) }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let buddy=KeyBuddy(defaults:defaults,layoutURL:layoutURL)
        var passed=[String]()
        func check(_ name:String,_ value:Bool) throws {
            guard value else {throw NSError(domain:"Key Buddy: "+name,code:1)}
            passed.append(name)
        }
        func state(_ op:String="status",_ value:Any?=nil)->[String:Any] {
            var b:[String:Any]=["op":op],result=[String:Any]()
            if let value {b["value"]=value}
            buddy.handle(b){r,_ in result=r as? [String:Any] ?? [:]}
            return result
        }
        func spin(_ seconds:Double) {
            let end=Date().addingTimeInterval(seconds)
            while Date()<end { RunLoop.current.run(until:min(end,Date().addingTimeInterval(0.01))) }
        }
        func panel()->NSWindow?{NSApp.windows.first{$0.title=="NuPhy Lab · Key Buddy" && $0.isVisible}}
        func image(_ view: NSView,_ name:String) throws {
            view.displayIfNeeded()
            let rep=view.bitmapImageRepForCachingDisplay(in:view.bounds)!
            view.cacheDisplay(in:view.bounds,to:rep)
            try rep.representation(using:.png,properties:[:])!.write(to:out.appendingPathComponent(name))
        }
        try check("not added",state().isEmpty)
        buddy.setAdded(true)
        try check("off by default",state()["enabled"] as? Bool == false)
        _=state("enable",true);_=state("size","large")
        guard let p=panel(),let view=p.contentView as? KeyBuddyView else {throw NSError(domain:"missing panel",code:2)}
        try check("click through",p.ignoresMouseEvents && !p.canBecomeKey && !p.canBecomeMain)
        try check("exactly 80 individual keycaps",view.centers.count==80 && Set(view.centers.keys)==Set(KeyBuddy.keys.values))
        let centers=view.centers
        let esc=centers["Escape"]!, space=centers["Space"]!, enter=centers["Enter"]!
        try check("cat-facing layout: space near the chest, function row towards viewer",space.y<enter.y && enter.y<esc.y)
        try check("cat's right paw at mouse on viewer's left", KeyBuddyMotion.mouseRest.x+27 < centers.values.map(\.x).min()!)
        try checkMouseClearance(view, check:check)
        let restingFace=view.eyesInView.x/view.bounds.width*480
        let extremes=centers.values.map(\.x)
        let middle=(extremes.min()!+extremes.max()!)/2
        try check("face sits over the middle of the KICK75",abs(restingFace-middle)<18)
        for (i,code) in ["Escape","ArrowUp"].enumerated() {
            let t=Double(i)+1
            view.motion.key(code,down:true,now:t)
            _=view.tick(now:t+0.01,pointer:.zero,buttons:0);_=view.tick(now:t+0.21,pointer:.zero,buttons:0)
            try check("typing on an outer key keeps the head facing forward: "+code,
                      view.eyesInView.x/view.bounds.width*480==restingFace && view.motion.pose.mouseLean==0)
            view.motion.key(code,down:false,now:t+0.23)
        }
        view.reset()
        try checkSeatedSilhouette(layoutURL, check:check)
        try checkVisibleWrist(layoutURL, check:check)
        try check("red dial and Esc occupy opposite corners of the function row",view.keyboard.dial.x<space.x && esc.x>space.x && abs(view.keyboard.dial.y-esc.y)<7)
        try checkTwoPaws(centers: centers, check: check)
        for pos in KeyBuddy.positions {
            _=state("position",pos)
            guard let rect=p.screen?.visibleFrame else {throw NSError(domain:"missing screen",code:3)}
            try check("on screen "+pos,rect.contains(p.frame) && ((pos.hasSuffix("Left") ? p.frame.minX-rect.minX : rect.maxX-p.frame.maxX)-8).magnitude<2)
        }
        _=state("position","bottomRight")
        let big=p.frame.width;_=state("size","small");try check("resizes",p.frame.width < big);_=state("size","large")
        for key in view.centers.keys {
            view.motion.key(key,down:true,now:ProcessInfo.processInfo.systemUptime)
            guard view.held==[key] else {throw NSError(domain:"per cap down",code:4)}
            view.motion.key(key,down:false,now:ProcessInfo.processInfo.systemUptime)
            guard view.held.isEmpty else {throw NSError(domain:"per cap up",code:5)}
        }
        passed.append("80 separate down and up pairs")
        spin(0.4);try image(view,"buddy-idle.png")
        view.motion.key("Space",down:true,now:ProcessInfo.processInfo.systemUptime);spin(0.35)
        try check("left paw lands on the animated space bar",hypot(view.motion.pose.left.x-space.x,view.motion.pose.left.y-space.y)<2)
        try image(view,"buddy-space.png");view.reset()
        _=state("visibility");try check("hide releases observer",panel()==nil && state()["listening"] as? Bool==false)
        _=state("visibility");try check("show restores panel",panel() != nil)
        buddy.setSessionAvailable(false);try check("lock stops overlay",panel()==nil && state()["listening"] as? Bool==false)
        buddy.setSessionAvailable(true);try check("resume restores overlay",panel() != nil)
        if args.count>3,let pid=Int32(args[3]) {
            guard let live=panel()?.contentView as? KeyBuddyView else {throw NSError(domain:"missing live view",code:6)}
            let target=NSRunningApplication(processIdentifier:pid)!
            func foreground()->Bool {NSWorkspace.shared.frontmostApplication?.processIdentifier==pid}
            try Data().write(to:out.appendingPathComponent("focus-fixture"))
            _=target.activate(options:[.activateIgnoringOtherApps])
            let activateBy=Date().addingTimeInterval(2)
            while !foreground() && Date()<activateBy {spin(0.04)}
            try check("independent fixture retained focus",foreground())
            if state()["listening"] as? Bool==true {
                spin(0.35)
                func key(_ code:CGKeyCode,_ down:Bool)throws {
                    guard foreground() else {throw NSError(domain:"test target lost focus before fixture code "+String(code),code:7)}
                    let ev=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down)!
                    ev.post(tap:.cghidEventTap)
                    spin(0.11)
                    if !IsSecureEventInputEnabled(), let expected = KeyBuddy.keys[Int64(code)] {
                        let end = Date().addingTimeInterval(0.3)
                        while live.held.contains(expected) != down && foreground() && Date() < end { spin(0.01) }
                    }
                }
                for (n,k) in [(0,"KeyA"),(53,"Escape"),(36,"Enter"),(49,"Space"),(123,"ArrowLeft")] {
                    try key(CGKeyCode(n),true)
                    let hit=live.held.contains(k)
                    if !hit { fputs("fixture did not light \(k), secure=\(IsSecureEventInputEnabled()), listener=\(state()["listening"] ?? "?")\n",stderr) }
                    try key(CGKeyCode(n),false)
                    try check("external "+k, hit && live.held.isEmpty && foreground())
                }
                try key(56,true);try key(7,true)
                let chord=live.held.contains("KeyX") && live.held.contains("ShiftLeft")
                try key(7,false);try key(56,false)
                try check("external chord",chord && live.held.isEmpty)
                try key(3,true); try key(38,true)
                try check("external F + J lands both paws on their own caps",
                          live.motion.pose.left == live.centers["KeyF"] && live.motion.pose.right == live.centers["KeyJ"])
                try key(38,false); try key(3,false)
                let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]]
                guard let record=windows?.first(where:{($0[kCGWindowOwnerPID as String] as? Int32)==pid && ($0[kCGWindowLayer as String] as? Int)==0}),
                      let bounds=record[kCGWindowBounds as String] as? [String:CGFloat],
                      let x=bounds["X"], let y=bounds["Y"],foreground() else {throw NSError(domain:"missing safe click target",code:8)}
                let cursor=CGEvent(source:nil)?.location
                let loc=CGPoint(x:x+40,y:y+70)
                let lead=CGPoint(x:loc.x+28,y:loc.y)
                CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:lead,mouseButton:.left)?.post(tap:.cghidEventTap)
                spin(0.04)
                guard foreground() else {throw NSError(domain:"mouse fixture lost focus before movement",code:9)}
                CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:loc,mouseButton:.left)?.post(tap:.cghidEventTap)
                spin(0.35)
                let moved=live.motion.pose
                try check("movement alone hands the paw from typing to the mouse",
                          moved.right == KeyBuddyMotion.grip(on:moved.mouse,click:moved.click))
                guard foreground() else {throw NSError(domain:"mouse fixture lost focus",code:9)}
                CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:loc,mouseButton:.left)?.post(tap:.cghidEventTap)
                spin(0.06)
                let pressed = live.motion.pose.click > 0.45
                CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:loc,mouseButton:.left)?.post(tap:.cghidEventTap)
                spin(0.27) // Allow the return arc to finish even if this click had no preceding movement.
                let mousePose = live.motion.pose
                let primaryButton = KeyBuddyMotion.grip(on:mousePose.mouse,click:mousePose.click)
                let returnedToMouse = hypot(mousePose.right.x-primaryButton.x, mousePose.right.y-primaryButton.y) < 1.2
                if let cursor { _=CGWarpMouseCursorPosition(cursor) }
                spin(0.06)
                try check("external mouse click and release",pressed && live.motion.pose.click < 0.02 && foreground())
                try check("typing paw returns to the physical mouse",returnedToMouse)
                spin(1.35)
                let idle=live.motion.pose
                try check("after the mouse stops both paws return to an upright rest",
                          idle.right == KeyBuddyMotion.restingRight && idle.left == KeyBuddyMotion.restingLeft &&
                          idle.mouseGrip==0 && idle.mouseLean==0)
                try key(37,true); try key(37,false)
                if !live.motion.reduceMotion {
                    try check("a letter is still floating before secure entry",live.motion.pose.floating.contains{$0.code == "KeyL"})
                }
                try Data().write(to:out.appendingPathComponent("secure"));spin(0.15)
                try check("secure entry clears an existing floating character",live.motion.pose.floating.isEmpty)
                try check("system secure input active",IsSecureEventInputEnabled())
                try key(11,true)
                let blocked = live.held.isEmpty && live.motion.pose.floating.isEmpty && live.motion.pose.pressures.isEmpty
                try key(11,false)
                try check("protected field suppressed",blocked)
                try FileManager.default.removeItem(at:out.appendingPathComponent("secure"));spin(0.25)
                try key(0,true);let resumed=live.held.contains("KeyA");try key(0,false);try check("resumes after secure entry",resumed)
            }
        }
        buddy.setAdded(false)
        try check("removal releases observer and closes panel",panel()==nil)
        buddy.setAdded(true);try check("re-add remains off",state()["enabled"] as? Bool==false)
        let restarted=KeyBuddy(defaults:defaults,layoutURL:layoutURL);restarted.setAdded(true)
        restarted.handle(["op":"status"]){r,_ in if (r as? [String:Any])?["size"] as? String=="large" {passed.append("size persists across relaunch")}}
        try JSONSerialization.data(withJSONObject:["passed":passed,"inputPermission":CGPreflightListenEventAccess()],options:.prettyPrinted).write(to:out.appendingPathComponent("checks.json"))
        try Data().write(to:out.appendingPathComponent("done"))
        print("Passed",passed.count,"checks.")
    }

    static func deskPixels(_ draw: () -> Void) throws -> [UInt8] {
        let width=480, height=302
        let flags=CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        guard let bitmap=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,
                                   space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:flags),
              let pixels=bitmap.data?.assumingMemoryBound(to:UInt8.self) else {throw NSError(domain:"Desk bitmap",code:1)}
        bitmap.translateBy(x:0,y:CGFloat(height));bitmap.scaleBy(x:1,y:-1)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current=NSGraphicsContext(cgContext:bitmap,flipped:true)
        draw()
        NSGraphicsContext.restoreGraphicsState()
        bitmap.flush()
        return Array(UnsafeBufferPointer(start:pixels,count:width*height*4))
    }

    static func checkSeatedSilhouette(_ layout: URL, check: (String, Bool) throws -> Void) throws {
        guard let view = KeyBuddyView(layoutURL:layout) else {throw NSError(domain:"Cat silhouette",code:1)}
        func checkFlanks(_ label: String) throws {
            // Measure the contiguous torso beneath the eyes. The free tail and active paws
            // have their own silhouettes and may legitimately reach farther on either side.
            let pixels = try deskPixels { view.drawDeskBehindPaws() }
            let axis = Int(view.eyesInView.x.rounded()), eyes = Int(view.eyesInView.y.rounded())
            var balanced = true
            for y in (eyes+35)...(eyes+90) {
                func opaque(_ x: Int) -> Bool { pixels[(y*480+x)*4+3] > 180 }
                var left = axis, right = axis
                while left > 0 && opaque(left-1) { left -= 1 }
                while right < 480 && opaque(right) { right += 1 }
                let a = axis-left, b = right-axis
                if min(a,b) < 44 || abs(a-b) > 2 { balanced = false; break }
            }
            try check("seated flanks match about the eyes " + label, balanced)
        }
        for preset in BuddyAppearance.presets {
            view.reset()
            view.catStyle = preset.style
            try checkFlanks("at rest: " + preset.id)
            for key in ["KeyF","KeyJ"] { view.motion.key(key,down:true,now:1) }
            _ = view.tick(now:1.10,pointer:.zero,buttons:0)
            try checkFlanks("while typing: " + preset.id)
            for key in ["KeyF","KeyJ"] { view.motion.key(key,down:false,now:1.16) }
            for frame in 0...120 {
                _ = view.tick(now:2+Double(frame)/60,pointer:.zero,buttons:frame<20 ? 1:0)
            }
            try checkFlanks("after releasing the mouse: " + preset.id)
        }
    }

    static func checkVisibleWrist(_ layout:URL, check:(String,Bool)throws->Void) throws {
        guard let view=KeyBuddyView(layoutURL:layout) else {throw NSError(domain:"Cat artwork",code:1)}
        for preset in BuddyAppearance.presets {
            view.reset(); view.catStyle=preset.style
            _=view.tick(now:-0.60,pointer:.zero,cursor:.zero,buttons:0)
            for t in [-0.50,-0.30,-0.10] {
                _=view.tick(now:t,pointer:.zero,cursor:.init(x:20,y:0),buttons:0)
            }
            var lowest=Int.max
            var fewestRows=Int.max
            var shoulderDelta=0
            for frame in 0..<35 {
                let t=Double(frame)/60
                if frame==2 || frame==25 {
                    for code in ["KeyF","KeyJ"] {view.motion.key(code,down:true,now:t)}
                }
                if frame==10 {
                    for code in ["KeyF","KeyJ"] {view.motion.key(code,down:false,now:t)}
                    view.motion.click(now:t)
                }
                _=view.tick(now:t,pointer:.zero,buttons:frame==11 ? 1:0)
                let ground=try deskPixels{view.drawDeskBehindPaws()}
                let scene=try deskPixels{view.draw(view.bounds)}
                let shoulder=view.mouseSideShoulder,tip=view.motion.pose.right
                let distance=max(1,hypot(tip.x-shoulder.x,tip.y-shoulder.y))
                let ux=(tip.x-shoulder.x)/distance, uy=(tip.y-shoulder.y)/distance
                var visible=0
                var visibleRows=Set<Int>()
                // The shoulder blends into the chest. Check the contour further along the leg
                // where it crosses the torso, through every frame of the handover.
                for row in Int(min(shoulder.y,tip.y)-16)...Int(max(shoulder.y,tip.y)+16) {
                    for column in Int(min(shoulder.x,tip.x)-16)...Int(max(shoulder.x,tip.x)+16) {
                        let i=(row*480+column)*4
                        guard ground[i+3]>247 else {continue}
                        let dx=CGFloat(column)-shoulder.x,dy=CGFloat(row)-shoulder.y
                        let delta=(0..<3).map {abs(Int(ground[i+$0])-Int(scene[i+$0]))}.max()!
                        if frame==0 && hypot(dx,dy)<4.5 {shoulderDelta=max(shoulderDelta,delta)}
                        let along=dx*ux+dy*uy
                        if along>=10 && along<=distance*0.7 && abs(dy*ux-dx*uy)<=15 && delta>=5 {
                            visible+=1
                            visibleRows.insert(row)
                        }
                    }
                }
                lowest=min(lowest,visible)
                fewestRows=min(fewestRows,visibleRows.count)
            }
            try check("resting shoulder meets its own coat without a lighter patch: "+preset.id,shoulderDelta<=3)
            try check("front foreleg contour crosses the coat in every frame, mouse to keys and back: "+preset.id,
                      lowest>=12 && fewestRows>=4)
        }
    }

    static func checkMouseClearance(_ view: KeyBuddyView, check: (String, Bool) throws -> Void) throws {
        func visibleColumns(_ draw: () -> Void) throws -> ClosedRange<Int> {
            let width=480, height=302
            let pixels=try deskPixels(draw)
            func occupied(_ x:Int) -> Bool {(0..<height).contains {y in pixels[(y*width+x)*4+3]>8}}
            guard let lo=(0..<width).first(where:occupied),let hi=(0..<width).last(where:occupied) else {
                throw NSError(domain:"Empty desk silhouette",code:2)
            }
            return lo...hi
        }
        let board=try visibleColumns{view.keyboard.draw(pressures:[:])}
        try check("KICK75 occupies less than half of the desktop illustration",board.count < 480/2)
        let model=KeyBuddyMotion(centers:view.centers)!
        model.reduceMotion=true
        model.establishPointerOrigin(.zero)
        model.movedPointer(to:.init(x:12,y:0),at:1)
        for x in [-1.0,0,1,3] {
            for y in [-1.0,0,1] {
                for button in [0,1] {
                    model.tick(now:1,pointer:.init(x:x,y:y),cursor:nil,buttons:button)
                    let pose=model.pose
                    let mouse=try visibleColumns{view.drawMouse(at:pose.mouse,press:pose.click)}
                    try check("at least ten points of desk between the mouse and case at medium size (\(x),\(y),\(button))",
                              CGFloat(board.lowerBound-mouse.upperBound-1)*335/480 >= 10)
                    try check("upper button stays under the resting paw (\(x),\(y),\(button))",
                              pose.right == KeyBuddyMotion.grip(on:pose.mouse,click:pose.click))
                }
            }
        }
    }

    static func checkTwoPaws(centers: [String: CGPoint], check: (String, Bool) throws -> Void) throws {
        let m = KeyBuddyMotion(centers: centers)!
        let neutral = CGPoint(x: 300, y: 240)
        func sample(_ t: Double, _ cursor: CGPoint? = nil, buttons: Int = 0) {
            m.tick(now: t, pointer: .zero, cursor: cursor ?? neutral, buttons: buttons)
        }
        sample(9.4,CGPoint(x:260,y:240)); sample(9.6); sample(9.9); sample(10)
        m.key("KeyF", down:true, now:10.01)
        m.key("KeyJ", down:true, now:10.01)
        sample(10.01); sample(10.046)
        try check("mouse paw unfolds during the reach to the keyboard",m.pose.mouseGrip>0 && m.pose.mouseGrip<1)
        sample(10.14)
        try check("mouse grip is fully released on the keys",m.pose.mouseGrip==0)
        try check("opposite hands land on a simultaneous F and J", m.pose.left == centers["KeyF"] && m.pose.right == centers["KeyJ"])
        try check("both keyboard contacts persist during a hold",m.pose.leftContact > 0.99 && m.pose.rightContact > 0.99)
        let caps = m.pose.floating
        try check("chord raises one upright legend from each key",Set(caps.map(\.code)) == ["KeyF","KeyJ"] && caps.allSatisfy { $0.opacity > 0.9 && $0.point.y < centers[$0.code]!.y - 20 })
        try check("key repeat does not restart the attack",!m.key("KeyJ",down:true,now:10.15))
        m.key("KeyJ",down:false,now:10.16)
        sample(10.31); sample(10.54)
        try check("releasing J leaves F down and the other paw ready",m.pose.left == centers["KeyF"] && m.pose.right != centers["KeyJ"] && m.pose.right != KeyBuddyMotion.grip(on:m.pose.mouse,click:m.pose.click) && m.pose.pressures == ["KeyF":1])

        m.reset(); sample(15)
        m.key("KeyF",down:true,now:15.086); m.key("KeyJ",down:true,now:15.090)
        let beforeKeys = CGPoint(x:345, y:242)
        m.tick(now:15.092, pointer:.zero, cursor:beforeKeys, mouseMovedAt:15.080, buttons:0)
        m.tick(now:15.30, pointer:.zero, cursor:beforeKeys, mouseMovedAt:15.080, buttons:0)
        try check("mouse move sampled late cannot steal first F/J chord",m.pose.left == centers["KeyF"] && m.pose.right == centers["KeyJ"])

        m.reset(); sample(16)
        m.click(now:16.01); sample(16.015,buttons:1)
        m.key("KeyF",down:true,now:16.034); m.key("KeyJ",down:true,now:16.035)
        sample(16.036); sample(16.13)
        try check("first typing after a click releases the mouse despite its visual pulse",m.pose.left == centers["KeyF"] && m.pose.right == centers["KeyJ"])
        m.reset(); sample(20)
        m.key("KeyA",down:true,now:20.01); m.key("KeyS",down:true,now:20.01)
        sample(20.01); sample(20.13)
        try check("adjacent same-hand keys use separate uncrossed paws",m.pose.left == centers["KeyA"] && m.pose.right == centers["KeyS"])
        let neighbours = m.pose.floating
        try check("adjacent simultaneous floating legends have separate lanes",neighbours.count == 2 && abs(neighbours[1].point.x - neighbours[0].point.x) > 26)
        m.key("Enter",down:true,now:20.14); sample(20.14); sample(20.26)
        try check("all three chord caps stay pressed with two paws",Set(m.pose.pressures.keys) == ["KeyA","KeyS","Enter"] && m.pose.pressures.values.allSatisfy{$0==1} && m.pose.right == centers["Enter"])
        m.key("Enter",down:false,now:20.27); sample(20.41); sample(20.55)
        try check("releasing a third key returns to the remaining chord",m.pose.left == centers["KeyA"] && m.pose.right == centers["KeyS"])

        for (i,code) in ["KeyD","KeyF","KeyG","KeyL","KeyO"].enumerated() {
            m.key(code,down:true,now:21+Double(i)*0.012)
        }
        sample(21.12)
        try check("fast typing shows only four recent keycaps",m.pose.floating.map(\.code) == ["KeyF","KeyG","KeyL","KeyO"])
        sample(21.7)
        try check("held keys do not keep floating legends alive",m.pose.floating.isEmpty && m.held.contains("KeyO"))

        m.reset(); sample(30)
        m.key("ShiftLeft",down:true,now:30.01)
        m.key("KeyK",down:true,now:30.05); m.key("KeyK",down:false,now:30.055)
        sample(30.06); sample(30.15)
        try check("short tap between frames lands beside a held modifier",m.pose.left == centers["ShiftLeft"] && m.pose.right == centers["KeyK"] && (m.pose.pressures["KeyK"] ?? 0)>0.95)
        sample(30.42); sample(30.64)
        try check("short tap rebounds and the modifier stays held",m.held == ["ShiftLeft"] && m.pose.pressures == ["ShiftLeft":1] && m.pose.left == centers["ShiftLeft"])
        m.key("KeyJ",down:true,now:30.66); sample(30.66)
        sample(30.80, CGPoint(x:302,y:238))
        try check("pointer jitter does not interrupt typing",m.pose.right == centers["KeyJ"])
        let moved = CGPoint(x:325,y:253)
        sample(30.83, moved); sample(30.90, moved)
        try check("mouse grip returns gradually on approach",m.pose.mouseGrip>0 && m.pose.mouseGrip<1)
        sample(31.04, moved)
        try check("mouse grip settles on the button",m.pose.mouseGrip==1)
        try check("intentional pointer movement retrieves mouse",m.pose.right == KeyBuddyMotion.grip(on:m.pose.mouse,click:m.pose.click) && m.held == ["ShiftLeft","KeyJ"])
        m.click(now:31.10); m.key("KeyK",down:true,now:31.11)
        sample(31.11,moved,buttons:1); sample(31.26,moved,buttons:1)
        try check("mouse drag leaves the other paw free to type",m.pose.left == centers["KeyK"] && m.pose.right == KeyBuddyMotion.grip(on:m.pose.mouse,click:m.pose.click) && m.pose.click>0.95)
        m.key("KeyK",down:false,now:31.28); m.key("KeyJ",down:false,now:31.28)
        m.key("Enter",down:true,now:31.30); sample(31.30,moved); sample(31.48,moved)
        try check("next keyboard stroke re-engages the mouse paw",m.pose.left == centers["ShiftLeft"] && m.pose.right == centers["Enter"])
        m.reset()
        try check("reset clears both targets and cap feedback",m.held.isEmpty && m.pose == KeyBuddyMotion.Pose())

        sample(36)
        let startBreath = m.pose.breath
        sample(36.8)
        try check("idle breathing uses the slow timer with both paws at the chest",
                  m.pose.breath != startBreath && !m.needsFrames && m.pose.mouseLean==0 &&
                  m.pose.right == KeyBuddyMotion.restingRight && m.pose.left == KeyBuddyMotion.restingLeft)
        m.key("KeyF",down:true,now:37);m.key("KeyJ",down:true,now:37)
        sample(37);sample(37.13)
        m.key("KeyF",down:false,now:37.15);m.key("KeyJ",down:false,now:37.15)
        sample(37.30);sample(37.55)
        try check("between strikes both paws gather in front of the chest",
                  abs(m.pose.left.x-KeyBuddyMotion.restingLeft.x)<6 && abs(m.pose.right.x-KeyBuddyMotion.restingRight.x)<6 &&
                  (147...164).contains(m.pose.left.y) && (147...164).contains(m.pose.right.y))
        m.reset()
        m.reduceMotion = true
        sample(40)
        m.key("KeyA",down:true,now:40.01); m.key("Enter",down:true,now:40.01)
        sample(40.01)
        try check("Reduce Motion suppresses floating legends",m.pose.floating.isEmpty)
        try check("Reduce Motion preserves immediate two-paw contact",m.pose.left == centers["KeyA"] && m.pose.right == centers["Enter"] && m.pose.nod == 0 && m.pose.posture == 0)
        sample(40.12)
        try check("steady held pose can return to idle frame rate",!m.needsFrames && m.pose.breath == 0)
        m.reset(); sample(41)
        let shifted=CGPoint(x:312,y:249)
        sample(41.1,shifted)
        try check("movement reaches the button without a click in Reduce Motion",
                  m.pose.mouseGrip==1 && m.pose.mouseLean==0 && m.pose.click==0)
        sample(43,shifted,buttons:1); sample(45,shifted,buttons:1)
        try check("a held mouse button keeps its grip past the idle delay",m.pose.mouseGrip==1 && m.pose.click==1)
        sample(46,shifted)
        try check("stationary pointer releases the mouse and stays seated",m.pose.right==KeyBuddyMotion.restingRight && m.pose.mouseGrip==0)
    }

}
