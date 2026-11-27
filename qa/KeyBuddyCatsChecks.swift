import AppKit
import WebKit
import ImageIO
import UniformTypeIdentifiers

/// A local transport at a reserved hostname. No real account, credential or photo participates.
private final class CatTransport: URLProtocol {
    enum Reply {case traits(String), status(Int), offline, timeout}
    static let lock=NSLock()
    static var reply=Reply.traits("")
    static var received=[Data]()
    static func respond(_ v:Reply) {lock.lock();reply=v;lock.unlock()}
    static var count:Int {lock.lock();defer{lock.unlock()};return received.count}
    override class func canInit(with request:URLRequest)->Bool {request.url?.host=="cat-fixture.invalid"}
    override class func canonicalRequest(for request:URLRequest)->URLRequest {request}
    override func startLoading() {
        guard request.url?.host=="cat-fixture.invalid",request.httpMethod=="POST" else {fatalError("Unexpected test request")}
        Self.lock.lock();Self.received.append(request.httpBody ?? Data());let mode=Self.reply;Self.lock.unlock()
        var code=200,data=Data()
        switch mode {
        case .traits(let text):
            data=try! JSONSerialization.data(withJSONObject:["choices":[["finish_reason":"stop","message":["role":"assistant","content":text]]]])
        case .status(let s):code=s
        case .offline,.timeout:
            let error: URLError = .init({if case .offline=mode {return .notConnectedToInternet};return .timedOut}())
            client?.urlProtocol(self,didFailWithError:error);return
        }
        let response=HTTPURLResponse(url:request.url!,statusCode:code,httpVersion:"HTTP/1.1",headerFields:["Content-Type":"application/json"])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:data);client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor private final class CatBridge:NSObject,WKScriptMessageHandlerWithReply {
    let buddy:KeyBuddy
    let file:URL
    init(_ buddy:KeyBuddy,_ file:URL){self.buddy=buddy;self.file=file}
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage,replyHandler:@escaping(Any?,String?)->Void) {
        guard message.frameInfo.isMainFrame,message.frameInfo.request.url?.standardizedFileURL==file.standardizedFileURL,
              let body=message.body as? [String:Any] else {replyHandler(nil,"Unknown origin");return}
        buddy.handle(body,reply:replyHandler)
    }
}

@main enum KeyBuddyCatsChecks {
    struct Failure: Error, CustomStringConvertible {var description:String}
    @MainActor static func main() {
        let app=NSApplication.shared
        app.setActivationPolicy(.regular)
        Task { @MainActor in
            do {try await exercise();exit(0)}
            catch {fputs("Cat checks failed: "+String(describing:error)+"\n",stderr);exit(1)}
        }
        app.run()
    }
    @MainActor static func exercise() async throws {
        let args=CommandLine.arguments
        let layout=URL(fileURLWithPath:args[1]), html=URL(fileURLWithPath:args[2]),out=URL(fileURLWithPath:args[3],isDirectory:true)
        _=NSApplication.shared;NSApp.setActivationPolicy(.regular)
        try String(ProcessInfo.processInfo.processIdentifier).write(to:out.appendingPathComponent("test-pid"),atomically:true,encoding:.utf8)
        let suite="NuPhy.CatTest."+UUID().uuidString
        let defaults=UserDefaults(suiteName:suite)!
        defer {defaults.removePersistentDomain(forName:suite)}
        let buddy=KeyBuddy(defaults:defaults,layoutURL:layout)
        buddy.setAdded(true)
        defer{buddy.setAdded(false)}
        var passed=[String]()
        func check(_ label:String,_ value:Bool)throws {
            if !value {throw Failure(description:label)}
            passed.append(label)
        }
        let config=AIConfiguration(provider:.custom,endpoint:"https://cat-fixture.invalid/v1/chat/completions",model:"fixture-vision")
        var current:AIConfiguration?=config
        buddy.gallery.configuration={current}
        var submittedBody=Data()
        buddy.gallery.request={ config,prompt,images in
            submittedBody = try AIRequestBuilder.build(configuration:config,prompt:prompt,images:images,apiKey:"fixture").httpBody!
            return try await AIClient(protocolClasses:[CatTransport.self]).send(configuration:config,prompt:prompt,images:images,apiKey:"fixture")
        }
        buddy.gallery.errorText={err,en in (err as? AIError)?.errorDescription ?? "Test error"}
        let webConfig=WKWebViewConfiguration();webConfig.websiteDataStore = .nonPersistent()
        let bridge=CatBridge(buddy,html)
        webConfig.userContentController.addScriptMessageHandler(bridge,contentWorld:.page,name:"keyBuddy")
        let web=WKWebView(frame:.init(x:0,y:0,width:740,height:700),configuration:webConfig)
        let w=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        w.title="NuPhy cat isolated test";w.contentView=web;w.center();w.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        defer{w.orderOut(nil)}
        web.loadFileURL(html,allowingReadAccessTo:html.deletingLastPathComponent())
        @discardableResult func js(_ code:String) async throws -> Any? {try await web.evaluateJavaScript(code)}
        func wait(_ expression:String,_ label:String) async throws {
            for _ in 0..<(label.contains("local photo") ? 400 : 110) {
                if (try? await js(expression)) as? Bool==true {passed.append(label);return}
                try await Task.sleep(nanoseconds:50_000_000)
            }
            throw Failure(description:label+" · "+((try? await js("document.body.innerText")) as? String ?? "no body"))
        }
        func click(_ title:String) async throws {
            let success=try await js("(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='"+title+"'&&!e.disabled);if(!b)return false;b.click();return true})()")
            guard success as? Bool==true else{throw Failure(description:"cannot click "+title)}
        }
        func done() async throws {try await wait("![...document.querySelectorAll('.buddy-cat')].some(b=>b.disabled)","settings ready")}
        func request(_ body:[String:Any]) async -> ([String:Any]?,String?) {
            await withCheckedContinuation{ continuation in buddy.handle(body){x,e in continuation.resume(returning:(x as? [String:Any],e))} }
        }
        try await wait("document.querySelectorAll('.buddy-cat img').length===5","five native portraits in WebKit")
        let catalog=buddy.gallery.catalog(layout:layout)
        try check("five distinct offline portraits",Set(catalog.values).count==5 && CatTransport.count==0)
        for (id,_) in BuddyAppearance.presets {
            let data=Data(base64Encoded:String(catalog[id]!.dropFirst("data:image/png;base64,".count)))!
            try data.write(to:out.appendingPathComponent("portrait-"+id+".png"))
        }
        let photoFolder=out.appendingPathComponent("picker-fixture",isDirectory:true)
        try FileManager.default.createDirectory(at:photoFolder,withIntermediateDirectories:true)
        let generatedPhoto=photoFolder.appendingPathComponent("selected-fixture.png")
        // Attach a dummy comment to the synthetic picture and confirm metadata is discarded.
        let src=CGImageSourceCreateWithURL(out.appendingPathComponent("portrait-tabby.png") as CFURL,nil)!
        let dest=CGImageDestinationCreateWithURL(generatedPhoto as CFURL,UTType.png.identifier as CFString,1,nil)!
        CGImageDestinationAddImageFromSource(dest,src,0,[kCGImagePropertyPNGDictionary:[kCGImagePropertyPNGComment:"PRIVATE-TEST-MARKER"]] as CFDictionary)
        precondition(CGImageDestinationFinalize(dest))
        for (index,preset) in BuddyAppearance.presets.enumerated() {
            _=try await js("document.querySelectorAll('.buddy-cat')["+String(index)+"].click()")
            try await done()
            try check("live offline preview "+preset.id,buddy.gallery.previewID==preset.id && buddy.gallery.activeID=="black")
            guard let view=NSApp.windows.first(where:{$0.title=="NuPhy Lab · Key Buddy" && $0.isVisible})?.contentView as? KeyBuddyView else{throw Failure(description:"missing preview")}
            try check("same desktop artwork "+preset.id,view.catStyle==preset.style)
            func snapshot(_ filename:String)throws {
                view.displayIfNeeded()
                let rep=view.bitmapImageRepForCachingDisplay(in:view.bounds)!
                view.cacheDisplay(in:view.bounds,to:rep)
                try rep.representation(using:.png,properties:[:])!.write(to:out.appendingPathComponent(filename))
            }
            view.motion.reset();_=view.tick(now:1,pointer:.zero,buttons:0)
            try snapshot("scene-"+preset.id+".png")
            func sample(_ time:Double,_ point:CGPoint = .zero) {_=view.tick(now:time,pointer:point,buttons:0)}
            sample(4.785);try check("blink "+preset.id,view.motion.pose.blink>0.95)
            for (i,g) in [CGPoint(x:-1,y:0),CGPoint(x:1,y:0),CGPoint(x:0,y:-1),CGPoint(x:0,y:1)].enumerated() {
                for j in 0..<5{sample(5+Double(i)+Double(j)*0.14,g)}
                let gaze=view.motion.pose.gaze
                try check("gaze "+preset.id+" "+String(i),hypot(gaze.x-g.x,gaze.y-g.y)<0.04)
                if preset.id=="black"{try snapshot("gaze-"+String(i)+".png")}
            }
            view.motion.key("KeyF",down:true,now:12);view.motion.key("KeyJ",down:true,now:12)
            sample(12);sample(12.14)
            try check("two paws and two flying caps "+preset.id,view.motion.pose.left==view.centers["KeyF"] && view.motion.pose.right==view.centers["KeyJ"] && view.motion.pose.floating.count==2)
            view.motion.click(now:12.3);sample(12.31);sample(12.55)
            try check("button contact "+preset.id,view.motion.pose.right==KeyBuddyMotion.grip(on:view.motion.pose.mouse,click:view.motion.pose.click))
        }
        try await click("使用这只猫");try await done()
        try check("apply preset only after confirmation",buddy.gallery.activeID=="siamese")
        try await click("生成我家的猫")
        try await wait("!!document.querySelector('.buddy-photo button')","photo chooser visible")
        if args.contains("--system-picker") {
            buddy.gallery.choose = {
                let picker=NSOpenPanel();picker.directoryURL=photoFolder;picker.title="Choose NuPhy QA fixture"
                try? generatedPhoto.path.write(to:out.appendingPathComponent("picker-target"),atomically:true,encoding:.utf8)
                return await KeyBuddyGallery.pick(picker)
            }
        } else {buddy.gallery.choose={generatedPhoto}}
        try await click("选择照片")
        try await wait("!!document.querySelector('.buddy-photo img')","local photo selected and visible")
        try check("choosing photo sent zero requests",CatTransport.count==0)
        let s=buddy.gallery.status()
        let scope=s["modelScope"] as! String
        let denied=await request(["op":"generate","modelScope":scope,"confirmed":false])
        try check("unconfirmed vision rejected before network",denied.1 != nil && CatTransport.count==0)
        let stale=await request(["op":"generate","modelScope":"another-model","confirmed":true])
        try check("recipient revalidated",stale.1 != nil && CatTransport.count==0)
        let good=#"{"coat":"silver","pattern":"tabby","eyes":"blue","face":"round"}"#
        CatTransport.respond(.traits(good))
        _=try await js("document.querySelector('.buddy-confirm input').click()")
        try await click("生成")
        try await wait("!!document.querySelector('.buddy-preview img')","generated appearance previewed")
        try check("preview is nonpersistent",buddy.gallery.previewID=="draft" && buddy.gallery.activeID=="siamese" && CatTransport.count==1)
        let payload=submittedBody
        let object=try JSONSerialization.jsonObject(with:payload) as! [String:Any]
        let messages=object["messages"] as! [[String:Any]]
        let content=messages.last!["content"] as! [[String:Any]]
        let uri=content.compactMap{$0["image_url"] as? [String:String]}.first!["url"]!
        let shot=Data(base64Encoded:String(uri.dropFirst("data:image/png;base64,".count)))!
        let photoProps=CGImageSourceCopyPropertiesAtIndex(CGImageSourceCreateWithData(shot as CFData,nil)!,0,nil)! as NSDictionary
        try check("only resized photo and traits prompt sent",content.count==2 && !photoProps.description.contains("PRIVATE-TEST-MARKER") && !String(decoding:payload,as:UTF8.self).contains(generatedPhoto.path))
        try check("optional fields use a drawing-compatible default",buddy.gallery.activeStyle.ears == .rounded && buddy.gallery.activeStyle.eyes == .blue)
        try await click("保存并使用");try await done()
        let saved=defaults.data(forKey:"NuPhyLab.KeyBuddyCats")!
        try saved.write(to:out.appendingPathComponent("generated-fixture.json"))
        try check("only local appearance saved",saved.count<700 && buddy.gallery.activeID=="custom" && buddy.gallery.photo==nil && buddy.gallery.draft==nil)
        current=nil
        let reopened=KeyBuddy(defaults:defaults,layoutURL:layout)
        try check("offline relaunch restores exact generated appearance",reopened.gallery.activeStyle == (try BuddyAppearance.fromModel(good)) && reopened.gallery.activeID=="custom" && CatTransport.count==1)
        reopened.setAdded(true)
        _=await withCheckedContinuation{ c in reopened.handle(["op":"preview","value":"custom"]){x,_ in c.resume(returning:x != nil)} }
        let restored=NSApp.windows.first{$0.title=="NuPhy Lab · Key Buddy" && $0.isVisible}?.contentView as? KeyBuddyView
        try check("restored generated cat uses the live renderer",restored?.catStyle==reopened.gallery.activeStyle)
        if let v=restored {
            v.reset();_=v.tick(now:1,pointer:.zero,buttons:0);_=v.tick(now:4.785,pointer:.zero,buttons:0)
            try check("generated cat blinks",v.motion.pose.blink>0.95)
            for i in 0..<6{_=v.tick(now:5+Double(i)*0.14,pointer:.init(x:1,y:-1),buttons:0)}
            try check("generated cat follows the pointer",v.motion.pose.gaze.x>0.95 && v.motion.pose.gaze.y < -0.95)
            for code in ["KeyF","KeyJ"]{v.motion.key(code,down:true,now:6)}
            _=v.tick(now:6,pointer:.zero,buttons:0);_=v.tick(now:6.14,pointer:.zero,buttons:0)
            try check("generated cat has two contacts and two flying caps",v.motion.pose.left==v.centers["KeyF"] && v.motion.pose.right==v.centers["KeyJ"] && v.motion.pose.floating.count==2)
            v.motion.click(now:6.3);_=v.tick(now:6.31,pointer:.zero,buttons:1);_=v.tick(now:6.56,pointer:.zero,buttons:1)
            try check("generated cat presses the mouse",v.motion.pose.right==KeyBuddyMotion.grip(on:v.motion.pose.mouse,click:v.motion.pose.click) && v.motion.pose.click>0.95)
        }
        reopened.setAdded(false)
        current=config;buddy.gallery.choose={generatedPhoto}
        _=await request(["op":"choosePhoto"])
        for (name,mode):(String,CatTransport.Reply) in [("malformed",.traits("not JSON")),("unknown palette",.traits(#"{"coat":"purple"}"#)),("unknown fields",.traits(#"{"coat":"cream","url":"data:image"}"#)),("no cat",.traits(#"{"subject":"no_cat"}"#)),("text-only provider",.status(415)),("authentication",.status(401)),("timeout",.timeout),("offline",.offline)] {
            CatTransport.respond(mode)
            let before=CatTransport.count
            let (_,e)=await request(["op":"generate","modelScope":scope,"confirmed":true])
            try check("preserves saved cat on "+name,e != nil && CatTransport.count==before+1 && buddy.gallery.activeID=="custom" && defaults.data(forKey:"NuPhyLab.KeyBuddyCats")==saved)
        }
        current=nil
        let count=CatTransport.count
        let (_,missing)=await request(["op":"generate","modelScope":scope,"confirmed":true])
        try check("unconfigured model offers settings",missing != nil && count==CatTransport.count)
        _=await request(["op":"dismiss"])
        _=try await js("window.qaLanguage('en')")
        try await wait("document.querySelector('.buddy-gallery-title button')?.textContent==='Create my cat'","English entry")
        try await click("Create my cat");try await click("Model settings")
        try await wait("document.body.dataset.models==='opened'","first-use model settings navigation")
        try JSONSerialization.data(withJSONObject:["passed":passed,"requests":CatTransport.count,"systemPicker":args.contains("--system-picker")],options:.prettyPrinted).write(to:out.appendingPathComponent("results.json"))
        print("Passed",passed.count,"catalog, motion, WebKit and model checks")
    }
}
