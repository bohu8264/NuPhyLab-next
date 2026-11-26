import AppKit
import ApplicationServices

// The UI checks run only against a generated Chrome test page and a Finder window containing generated fixtures.
@main struct DesktopToolsChecks {
    @MainActor static var results:[String:Bool]=[:], metrics:[String:Double]=[:], details:[String:String]=[:]
    static var base:URL{URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)}
    static func pause(_ seconds:Double) async {try? await Task.sleep(nanoseconds:UInt64(seconds*1e9))}
    @MainActor static func wait(_ timeout:Double=4,_ f:()->Bool) async->Bool{
        let deadline=Date().addingTimeInterval(timeout)
        while Date()<deadline{if f(){return true};await pause(0.04)};return f()
    }
    @MainActor static func check(_ name:String,_ value:Bool){results[name]=value;print(value ? "PASS":"FAIL",name);fflush(stdout);report()}
    @MainActor static func report(){
        let doc:[String:Any]=["checks":results,"metrics":metrics,"details":details]
        if let data=try? JSONSerialization.data(withJSONObject:doc,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:base.appendingPathComponent("checks.json"),options:.atomic)}
    }
    static func event(_ name:String)->[[String:Any]]{
        ((try? String(contentsOf:base.appendingPathComponent("browser-events"))) ?? "").split(separator:"\n").compactMap{(try? JSONSerialization.jsonObject(with:Data($0.utf8))) as? [String:Any]}.filter{$0["k"] as? String==name}
    }
    @MainActor static func point(_ view:NSView,_ p:NSPoint)->CGPoint {
        let s=view.window!.convertPoint(toScreen:view.convert(p,to:nil));return CGPoint(x:s.x,y:NSScreen.screens[0].frame.maxY-s.y)
    }
    @MainActor static func sub<T:NSView>(_ v:NSView?,_ t:T.Type)->[T]{guard let v else{return []};return ([v as? T].compactMap{$0})+v.subviews.flatMap{sub($0,t)}}
    @MainActor static func table()->NSTableView?{NSApp.windows.filter(\.isVisible).compactMap{sub($0.contentView,NSTableView.self).first}.first}
    @MainActor static func inTable(_ t:NSTableView,_ row:Int)->CGPoint{let r=t.rect(ofRow:row);return point(t,CGPoint(x:r.minX+48,y:r.midY))}
    @MainActor static func run() async throws{
        let suite="org.nuphylab.qa.desktop."+UUID().uuidString, d=UserDefaults(suiteName:suite)!
        let root=base.appendingPathComponent("qa-"+UUID().uuidString,isDirectory:true)
        let folder=base.appendingPathComponent("Finder fixtures"),file=folder.appendingPathComponent("NuPhy-R54-Finder.txt")
        let privateBoard=NSPasteboard.withUniqueName()
        let tools=DesktopTools(directory:root,defaults:d)
        defer{tools.shutdown();privateBoard.releaseGlobally();d.removePersistentDomain(forName:suite);try? FileManager.default.removeItem(at:root)}
        for key in DesktopTools.actions{tools.keys[key]?.clear()}
        tools.english=true;tools.setAdded([DesktopTools.shelf])
        check("feature center additions initially off",!tools.shelfEnabled && !FileManager.default.fileExists(atPath:root.path))
        let binding=VoiceShortcutValue(keyCode:38,modifiers:(1<<18)|(1<<19)|(1<<20))
        try tools.keys["batch"]!.save(binding,enabled:false)
        tools.set(DesktopTools.shelf,true);tools.refresh()
        guard await wait(5,{tools.store != nil}) else { throw ShelfFailure.missing }
        let store=try tools.mandatoryStore()
        do{try tools.keys["shelf"]!.save(binding,enabled:false);check("conflicting shelf shortcuts rejected",false)}catch{check("conflicting shelf shortcuts rejected",true)}
        let vals=try store.add([.reference(file),.bytes("example.txt",.text,Data("Shelf example".utf8)),.bytes("link.txt",.link,Data("https://example.test/shelf".utf8))])
        check("references and managed storage",vals.count==3 && store.active.items[0].bytes==0 && store.used==Int64("Shelf example".utf8.count+"https://example.test/shelf".utf8.count))
        let original=store.activeID
        try store.create("Other shelf");try store.customize(name:"Pinned",color:"purple",symbol:"star",pinned:true)
        let ref=try store.add([.bytes("keep.txt",.text,Data("pinned".utf8))]);try store.closeActive(defaultName:"Shelf");check("independent shelf and close",store.activeID==original)
        if let recent=store.shelves.first(where:{$0.closed != nil}){try store.select(recent.id);check("closed shelf restored",store.active.items.first?.id==ref.first && store.active.pinned);try store.select(original)}
        let out=try ShelfPasteboard.writer(store.active.items[1],url:store.url(store.active.items[1]))
        privateBoard.writeObjects([out]);let inbound=try ShelfPasteboard.read(privateBoard)
        check("native pasteboard reconstruction",try store.add(inbound).count==1)
        try tools.addClip(.init(kind:.text,text:"From clipboard history"));check("smart clipboard item directly added",store.active.items.last?.title.contains("From clipboard")==true)
        let image=NSImage(size:NSSize(width:400,height:120));image.lockFocus();NSColor.white.setFill();NSRect(x:0,y:0,width:400,height:120).fill();("TEST SHELF" as NSString).draw(at:.init(x:25,y:30),withAttributes:[.font:NSFont.systemFont(ofSize:38),.foregroundColor:NSColor.black]);image.unlockFocus()
        let png=AssistClipboard.png(image.cgImage(forProposedRect:nil,context:nil,hints:nil)!)!;try tools.addCaptured(png)
        let photo=store.active.items.last!;check("screen capture directly added",photo.kind == .image)
        let inputs=try [photo,photo].map{ShelfInput(item:$0,url:try store.url($0))}
        let cfg=AIConfiguration(provider:.deepSeek,model:"fixture"),vision=AIConfiguration(provider:.custom,endpoint:"https://example.test/v1",model:"fixture",imageInputConfirmed:true)
        let prompt=try await ShelfProcessing.prompt(inputs,question:"Compare these fixtures",config:vision)
        check("multiphoto AI uses only explicit selected inputs",prompt.1.count==1 && prompt.0.user.contains("Screen.png") && !prompt.0.user.contains("example.test/shelf"))
        let textItem=store.active.items[1];tools.configuration={cfg};var requests=0
        tools.modelRequest={ _,prompt,images in requests+=1;return prompt.user.contains("Shelf example") && images.isEmpty ? "Fixture model result":"unexpected"}
        tools.action("ai",selected:[textItem]);check("no AI request before send",requests==0)
        if let panel=NSApp.windows.first(where:{$0.isVisible && !(sub($0.contentView,NSButton.self).filter{$0.title=="Send"}).isEmpty}),
           let send=sub(panel.contentView,NSButton.self).first(where:{$0.title=="Send"}),
           let field=sub(panel.contentView,NSTextField.self).first(where:{$0.isEditable}){
            field.stringValue="Summarize";send.performClick(nil);_=await wait{requests==1 && !tools.working}
        }
        check("AI result returned to source shelf",requests==1 && store.active.items.last?.title=="AI Answer.txt")
        tools.action("zip",selected:[textItem,photo]);_=await wait(12){!tools.working}
        check("generated ZIP returned to shelf",store.active.items.last?.title.hasSuffix(".zip")==true)
        for action in ["png","webp","compress","metadata","montage","pdf","ocr","merge","rtf","links"]{
            let before=store.active.items.count
            let chosen = ["merge","rtf"].contains(action) ? [textItem] : action=="links" ? [store.active.items[2]]:[photo]
            tools.action(action,selected:chosen);_=await wait(45){!tools.working};if store.active.items.count != before+1{details["batch "+action]=tools.notice};check("local batch "+action,store.active.items.count==before+1)
        }
        try store.remove(Set(store.active.items.map(\.id)));check("clear protects external original",FileManager.default.fileExists(atPath:file.path) && store.active.items.isEmpty)
        store.maxBytes=3;do{_=try store.add([.bytes("large",.text,Data(repeating:1,count:15))]);check("quota rejects without residue",false)}catch{check("quota rejects without residue",store.active.items.isEmpty)};tools.refresh()
        let external=LabNotchLayout.place(screen:CGRect(x:1710,y:0,width:1920,height:1080),visible:CGRect(x:1710,y:0,width:1920,height:1056),safeTop:0,left:nil,right:nil,width:400,height:180)
        check("external screen geometry stays on its own screen",external.capFrame==nil && external.frame.midX>1710 && external.frame.maxY<=1080)
        try await DesktopShelfCollectionCheck.run(base:base)
        try await actual(tools:tools)
        tools.setAdded([])
        check("removal disables shortcut and drag",!tools.shelfEnabled && !tools.canDrop && tools.reservedValues.isEmpty)
        tools.setAdded([DesktopTools.shelf])
        check("re-add requires enable", !tools.shelfEnabled)
    }
    @MainActor static func actual(tools: DesktopTools) async throws {
        guard let pid = Int32(try String(contentsOf: base.appendingPathComponent("actual-browser-pid")).trimmingCharacters(in: .whitespacesAndNewlines)),
              let chrome = NSRunningApplication(processIdentifier: pid), chrome.bundleIdentifier == "com.google.Chrome",
              let screen = NSScreen.main else { throw ShelfFailure.missing }
        try FixtureAX.activateGeneratedBrowser(base)
        guard await wait(5, { FixtureAX.focusedFixture(chrome) != nil }) else {
            throw NSError(domain:"ShelfFixture",code:2,userInfo:[NSLocalizedDescriptionKey:"The generated browser window did not become focused"])
        }
        let cg = CGDisplayBounds((screen.deviceDescription[.init("NSScreenNumber")] as! NSNumber).uint32Value)
        let desired = CGPoint(x: cg.midX, y: cg.minY + 7)
        let store = try tools.mandatoryStore()
        for (cancel, manual) in [(true,false), (false,false), (false,true)] {
            if manual {
                tools.set("notch",false); tools.refresh()
                try store.customize(name:store.active.name,color:store.active.color,symbol:store.active.symbol,pinned:true)
                tools.panel.display(on:screen, at:"notch", automatic:false)
            }
            var origin: CGPoint?
            guard await wait(3, {
                guard FixtureAX.focusedFixture(chrome) != nil else { return false }
                origin = FixtureAX.point("Shelf Source", on: chrome)
                if origin == nil, let xy = event("source-point").last?["v"] as? [Double], xy.count == 2 {
                    origin = CGPoint(x: xy[0], y: xy[1])
                }
                return origin.map(cg.contains) == true
            }), let origin else { throw NSError(domain:"ShelfFixture",code:3,userInfo:[NSLocalizedDescriptionKey:"Could not locate the generated browser drag source"]) }
            let actor = Process()
            actor.executableURL = base.appendingPathComponent("drag-fixture")
            actor.arguments = [origin.x,origin.y,desired.x,desired.y].map { String(Double($0)) } + ["chrome-source"] + (cancel ? ["cancel"] : [])
            let count = store.active.items.count
            try actor.run()
            let offered = await wait(3) { actor.isRunning && tools.panel.visible }
            check(manual ? "pinned manual shelf shown before release" : (cancel ? "cancellable offer before mouse-up" : "drop offer before mouse-up"), offered && store.active.items.count == count)
            if offered {
                let body = NSApp.windows.first { $0.isVisible && $0.contentView.map { NSStringFromClass(type(of:$0)).hasSuffix("ShelfDropView") } == true && $0.contentView?.layer?.backgroundColor != nil }
                let rgb = body?.contentView?.layer?.backgroundColor.flatMap { NSColor(cgColor:$0)?.usingColorSpace(.sRGB) }
                check("notch drop surface is opaque black without border or shadow", rgb.map { max($0.redComponent, $0.greenComponent, $0.blueComponent) < 0.001 && $0.alphaComponent == 1 } == true && body?.contentView?.layer?.borderWidth == 0 && body?.hasShadow == false)
            }
            guard await wait(5, { !actor.isRunning }), actor.terminationStatus == 0 else { throw ShelfFailure.invalid }
            check(manual ? "drop into pinned manual shelf hides both windows" : (cancel ? "cancel hides the entire drop target" : "drop hides the entire target including cap"),
                  await wait { !tools.panel.visible && !NSApp.windows.contains { $0.isVisible && $0.contentView.map { NSStringFromClass(type(of:$0)).hasSuffix("ShelfDropView") } == true } })
            check(manual ? "manual shelf stores its drop once" : (cancel ? "cancel adds nothing" : "Chrome link stored once on release"),
                  cancel ? store.active.items.count == count : (store.active.items.count == count + 1 && store.active.items.last?.kind == .link))
            check("automatic offer keeps source app focused", FixtureAX.focusedFixture(chrome) != nil)
        }
        tools.panel.refresh()
        tools.panel.yieldToPeer(false)
        await pause(0.4)
        check("no persistent count badge after drop or refresh", !tools.panel.visible && !NSApp.windows.contains { $0.isVisible && $0.contentView.map { NSStringFromClass(type(of:$0)).hasSuffix("ShelfDropView") } == true })
        tools.panel.display(on: screen, at: "notch", automatic:false)
        check("manual reopen shows saved item", tools.panel.visible && table()?.numberOfRows == store.active.items.count)
        tools.panel.yieldToPeer(true)
        check("shelf yields to another top panel", !tools.panel.visible)
    }
    @MainActor static func main(){
        let app=NSApplication.shared;app.setActivationPolicy(.accessory)
        Task{do{
            if CommandLine.arguments.count==5,CommandLine.arguments[2]=="web",let endpoint=URL(string:CommandLine.arguments[3]) {
                try await DesktopToolsWebCheck.run(base:base,endpoint:endpoint,language:CommandLine.arguments[4])
                check("WebKit settings",true)
            }else if CommandLine.arguments.dropFirst(2).first=="clear"{try await DesktopShelfClearCheck.run(base:base)}
            else if CommandLine.arguments.dropFirst(2).first=="transfer"{try await DesktopToolsTransferCheck.run(base:base)}else{try await run()}
        }catch{details["error"]=error.localizedDescription;check("suite completed",false)};report();app.stop(nil);let e=NSEvent.otherEvent(with:.applicationDefined,location:.zero,modifierFlags:[],timestamp:0,windowNumber:0,context:nil,subtype:0,data1:0,data2:0);if let e{app.postEvent(e,atStart:false)}}
        app.run()
        exit(results.values.allSatisfy{$0} ? 0:1)
    }
}
