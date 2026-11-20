import AppKit

/// Replace only the speech device and HTTP transport. Exercise the production
/// recognizer state machine, credential selection, request builder and parser.
final class ModelFixture: URLProtocol {
    static let plan = #"{"steps":[{"id":"add:keyboard-pocket"}]}"#
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        precondition(url.host == "fixture.invalid")
        if url.path == "/pending" { return }
        let data: Data
        if let body = request.httpBody { data = body }
        else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096), body = Data()
            while true {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                body.append(contentsOf: bytes.prefix(count))
            }
            data = body
        } else { preconditionFailure("Missing command body") }
        let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        precondition(body["model"] as? String == "fixture-model")
        let text = String(decoding: data, as: UTF8.self)
        precondition(text.contains("add:keyboard-pocket") && text.contains("Fixture command") && text.contains("currentPage"))
        precondition(!text.contains("fixture-secret") && !text.contains("base64") && !text.contains("input_audio"))
        let answer: [String: Any]
        switch url.path {
        case "/responses":
            answer = ["status":"completed","output":[["type":"message","role":"assistant","content":[["type":"output_text","text":Self.plan]]]]]
        case "/chat":
            answer = ["choices":[["finish_reason":"stop","message":["role":"assistant","content":Self.plan]]]]
        case "/messages":
            answer = ["type":"message","role":"assistant","stop_reason":"end_turn","content":[["type":"text","text":Self.plan]]]
        case "/denied": answer = ["error":"fixture error"]
        default: preconditionFailure("Unexpected request path")
        }
        let response = HTTPURLResponse(url:url,statusCode:url.path == "/denied" ? 401 : 200,
                                       httpVersion:"HTTP/1.1",headerFields:["Content-Type":"application/json"])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:try! JSONSerialization.data(withJSONObject:answer))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct VoiceControlChecks {
    @MainActor static func main() async throws {
        if CommandLine.arguments.count==2 {
            let app=NSApplication.shared
            app.setActivationPolicy(.accessory)
            Task { @MainActor in
                do {try await verifyVoiceControlInWebKit(URL(string:CommandLine.arguments[1])!);exit(0)}
                catch {FileHandle.standardError.write(Data((error.localizedDescription+"\n").utf8));exit(1)}
            }
            app.run()
            return
        }
        let suite = "com.nuphy.voice-control.qa." + UUID().uuidString
        let defaults = UserDefaults(suiteName:suite)!
        defer { defaults.removePersistentDomain(forName:suite) }
        let speech = VoiceCaptureService()
        speech.captureTestDriver = .init(onStart:{_ in}, onFinishInput:{_ in},finalizationTimeout:0.035)
        var keyAccounts = [String]()
        var savedKey = true
        let monitor=VoiceHotkey(listenToSystemEvents:false)
        let host = LabVoiceControl(defaults:defaults,speech:speech,client:AIClient(protocolClasses:[ModelFixture.self]),hotkey:monitor,hasKey:{_ in savedKey}) { account in
            keyAccounts.append(account)
            return "fixture-secret"
        }
        var activeChanges = [Bool]()
        host.activityChanged = { activeChanges.append($0) }
        var count = 0
        func check(_ ok:Bool,_ reason:String) { count += 1; precondition(ok,reason) }
        typealias Result = ([String: Any]?,String?)
        func ask(_ body:[String:Any]) async -> Result {
            await withCheckedContinuation { continuation in
                host.handle(body) { result,error in continuation.resume(returning:(result as? [String:Any],error)) }
            }
        }
        func endpoint(_ path:String,_ api:AIProtocol = .chatCompletions) -> AIConfiguration {
            AIConfiguration(provider:.custom,endpoint:"https://fixture.invalid/" + path,model:"fixture-model",apiProtocol:api)
        }
        let interpret:[String:Any] = ["op":"interpret","text":"Fixture command","page":"features","catalog":"add:keyboard-pocket Keyboard Pocket"]
        check(!host.enabled && !host.capturing,"initial opt-out")
        check(await ask(["op":"listen"]).1 != nil,"disabled refuses capture")
        _ = await ask(["op":"enable","enabled":true])
        check(host.enabled && !host.capturing && activeChanges.isEmpty,"switch alone never opens mic")
        check(LabVoiceControl(defaults:defaults,hasKey:{_ in false},readKey:{_ in ""}).enabled,"choice persists across controller creation")
        host.mayStart = { true }
        check(await ask(interpret).1 != nil,"missing model")
        host.configuration = { endpoint("chat") }
        savedKey = false
        check(await ask(["op":"listen"]).1 != nil && !host.capturing && activeChanges.isEmpty,"missing key detected before opening mic")
        savedKey = true
        host.mayStart = { false }
        check(await ask(["op":"listen"]).1 != nil,"conflicting operation refuses recording")
        host.mayStart = { true }
        var captures = [Result]()
        func listen() {
            host.handle(["op":"listen","hints":["NuPhy Lab"]]) { value,error in captures.append((value as? [String:Any],error)) }
        }
        listen()
        let first = speech.session.generation
        check(host.capturing && activeChanges == [true],"capture activated")
        check(await ask(interpret).1 != nil,"incomplete capture cannot be sent to model")
        speech.receiveTestResult(.init(text:"打开功能中心",isFinal:true,failureDomain:nil,failureCode:nil),token:first)
        check(captures.last?.0?["text"] as? String == "打开功能中心" && captures.last?.0?["review"] as? Bool == false,"final transcript")
        check(!host.capturing && activeChanges == [true,false] && keyAccounts.isEmpty,"mic released and no automatic model call from native")
        listen()
        let partial = speech.session.generation
        speech.receiveTestResult(.init(text:"remove",isFinal:false,failureDomain:nil,failureCode:nil),token:partial)
        speech.receiveTestResult(.init(text:nil,isFinal:false,failureDomain:"kAFAssistantErrorDomain",failureCode:1101),token:partial)
        check(captures.last?.0?["review"] as? Bool == true && captures.last?.0?["text"] as? String == "remove","partial explicitly marked for review")
        listen()
        let silence = speech.session.generation
        speech.receiveTestResult(.init(text:nil,isFinal:false,failureDomain:"kAFAssistantErrorDomain",failureCode:1110),token:silence)
        check(captures.last?.1 != nil && !host.capturing,"silence")
        listen()
        let interrupted = speech.session.generation
        host.cancel()
        speech.receiveTestResult(.init(text:"late",isFinal:true,failureDomain:nil,failureCode:nil),token:interrupted)
        check(captures.count == 4 && captures.last?.0?["cancelled"] as? Bool == true,"late transcript discarded")
        host.shortcut.canTrigger={host.enabled}
        var pressID:String?
        host.presentShortcut={pressID=$0}
        let standard=LabCommandShortcut.standard
        func press(_ key:VoiceShortcutValue) async {
            _ = monitor.observeRuntime(.init(kind:.down,keyCode:key.keyCode,flags:key.modifiers))
            _ = monitor.observeRuntime(.init(kind:.down,keyCode:key.keyCode,flags:key.modifiers,isRepeat:true))
            _ = monitor.observeRuntime(.init(kind:.up,keyCode:key.keyCode,flags:key.modifiers))
            try? await Task.sleep(for:.milliseconds(15))
        }
        await press(standard)
        var manualReply:Result?
        host.handle(["op":"listen","shortcutID":pressID!]) {v,e in manualReply=(v as? [String:Any],e)}
        check(host.capturing,"first shortcut starts a manual session")
        speech.receiveTestResult(.init(text:"把语音输入的快捷键",isFinal:false,failureDomain:nil,failureCode:nil),token:speech.session.generation)
        try await Task.sleep(for:.milliseconds(1800))
        check(host.capturing && speech.isRecording && manualReply==nil,"a pause cannot execute a hotkey command")
        speech.receiveTestResult(.init(text:"把语音输入的快捷键",isFinal:true,failureDomain:nil,failureCode:nil),token:speech.session.generation)
        try await Task.sleep(for:.milliseconds(180))
        check(host.capturing && speech.isRecording && manualReply==nil,"early final collects another phrase")
        speech.receiveTestResult(.init(text:"改成 Q",isFinal:false,failureDomain:nil,failureCode:nil),token:speech.session.generation)
        await press(standard)
        try await Task.sleep(for:.milliseconds(70))
        check(manualReply?.0?["text"] as? String=="把语音输入的快捷键 改成 Q" && manualReply?.0?["review"] as? Bool==false,"only second press releases the complete command")
        check(!host.capturing && keyAccounts.isEmpty,"no third press or premature model call")
        let q=VoiceHotkey.namedShortcut("Q")!
        let chord=VoiceHotkey.namedShortcut("Ctrl+Shift+Q")!
        check(chord.keyCode==q.keyCode && chord.modifiers==standard.modifiers && q.modifiers==0,"spoken single key and chord")
        check(VoiceHotkey.namedShortcut("Q+W")==nil && VoiceHotkey.namedShortcut("Ctrl+Ctrl+Q")==nil,"invalid chord rejected")
        try host.shortcut.save(chord,enabled:true)
        let reopened=LabCommandShortcut(defaults:defaults,monitor:VoiceHotkey(listenToSystemEvents:false))
        check(reopened.value==chord,"recorded shortcut survives reopening")
        host.shortcut.conflict={_ in "Conflict"}
        do {try host.shortcut.save(q,enabled:true);check(false,"conflict was accepted")} catch {}
        check(host.shortcut.value==chord,"conflict keeps old shortcut")
        host.shortcut.conflict={_ in nil}
        pressID=nil;await press(standard);check(pressID==nil,"old shortcut released")
        await press(chord);check(pressID != nil,"new shortcut active")
        await press(chord)
        let emptyTap=await ask(["op":"listen","shortcutID":pressID!])
        check(emptyTap.0?["cancelled"] as? Bool==true && !host.capturing,"two quick taps before startup cancel cleanly")
        let side=VoiceShortcutValue(keyCode:0,modifiers:0,mouseButton:4)
        var dictation=VoiceSettings()
        dictation.shortcutKeyCode=61;dictation.shortcutMouseButton=4;dictation.shortcutMouseModifiers=0
        check(VoiceConflictPolicy.shortcut(dictation)==side,"dictation conflict ignores its previous keyboard trigger")
        let selection=InputBinding.mouseButton(index:4,modifiers:[])
        check(VoiceConflictPolicy.overlapsSelection(VoiceConflictPolicy.binding(side),selection),"Smart Selection owns the same side button")
        host.shortcut.conflict={VoiceConflictPolicy.shortcut(dictation)==$0 ? "Used for dictation" : nil}
        do {try host.shortcut.save(side,enabled:true);check(false,"occupied side button accepted")} catch {}
        check(host.shortcut.value==chord,"an occupied side button preserves the command binding")
        host.shortcut.conflict={_ in nil}
        var capture=VoiceShortcutCaptureState()
        for button in UInt32(0)...2 {
            check(capture.observe(.init(kind:.mouseDown,keyCode:button)) == .pass && capture.observe(.init(kind:.mouseUp,keyCode:button)) == .pass,"primary mouse buttons pass through")
        }
        check(capture.observe(.init(kind:.mouseDown,keyCode:4)) == .consume,"side-button capture claims down")
        guard case .complete(let recorded)=capture.observe(.init(kind:.mouseUp,keyCode:4)) else { preconditionFailure("Side button was not recorded") }
        try host.shortcut.save(recorded,enabled:true)
        check(recorded==side && host.reservedShortcut==side,"side button saved on release")
        let reloaded=LabCommandShortcut(defaults:defaults,monitor:VoiceHotkey(listenToSystemEvents:false))
        check(reloaded.value==side && reloaded.status(english:true)["shortcutLabel"] as? String=="Mouse side button 2","side button persists with an English label")
        func mouse(_ kind:VoiceHotkeyEventKind,_ button:UInt32=4,_ mods:UInt64=0)->VoiceHotkeyDecision {
            monitor.observeRuntime(.init(kind:kind,keyCode:button,flags:mods))
        }
        pressID=nil
        check(!mouse(.mouseDown,3).consume && !mouse(.mouseUp,3).consume,"unbound side passes through")
        check(!mouse(.mouseDown,4,1<<17).consume && !mouse(.mouseUp,4,1<<17).consume,"modifier mismatch passes through")
        check(mouse(.mouseDown).consume && mouse(.mouseDown).consume && pressID==nil,"holding or repeated down cannot start speech")
        check(mouse(.mouseUp).fire && !mouse(.mouseUp).fire,"one trigger per side-button release")
        try await Task.sleep(for:.milliseconds(20))
        guard let sideID=pressID else {preconditionFailure("Missing side-button request")}
        manualReply=nil
        host.handle(["op":"listen","shortcutID":sideID]) {v,e in manualReply=(v as? [String:Any],e)}
        let clearWhileListening=await ask(["op":"clearShortcut"])
        check(host.capturing && clearWhileListening.1 != nil,"active recording keeps its finish shortcut")
        speech.receiveTestResult(.init(text:"侧键指令",isFinal:false,failureDomain:nil,failureCode:nil),token:speech.session.generation)
        _=mouse(.mouseDown);_=mouse(.mouseUp)
        try await Task.sleep(for:.milliseconds(90))
        check(manualReply?.0?["text"] as? String=="侧键指令" && !host.capturing,"second side-button click finishes the command")
        pressID=nil;_=mouse(.mouseDown);_=mouse(.mouseUp)
        try await Task.sleep(for:.milliseconds(20))
        let pendingID=pressID!
        _=mouse(.mouseDown)
        let cleared=await ask(["op":"clearShortcut"])
        check(cleared.0?["shortcutLabel"] as? String=="" && host.enabled && host.reservedShortcut==nil,"clearing releases the shortcut without disabling Voice Control")
        let released=mouse(.mouseUp)
        check(released.consume && !released.fire,"clearing during a held click drains only its release")
        check(!mouse(.mouseDown).consume && !mouse(.mouseUp).consume,"subsequent clicks return to the mouse")
        check((await ask(["op":"listen","shortcutID":pendingID])).0?["cancelled"] as? Bool==true,"a queued shortcut cannot start after clearing")
        _=await ask(["op":"enable","enabled":false]);_=await ask(["op":"enable","enabled":true])
        let unbound=LabCommandShortcut(defaults:defaults,monitor:VoiceHotkey(listenToSystemEvents:false))
        check(unbound.value==nil && !monitor.isReady,"empty choice survives reopening and toggling")
        pressID=nil;await press(standard);await press(chord)
        check(pressID==nil,"neither the default nor previous shortcut comes back")
        listen();check(host.capturing,"the Speak button still works without a shortcut")
        speech.receiveTestResult(.init(text:"按钮指令",isFinal:true,failureDomain:nil,failureCode:nil),token:speech.session.generation)
        check(captures.last?.0?["text"] as? String=="按钮指令","button-initiated speech can finish with no binding")
        try host.shortcut.save(chord,enabled:true)
        check(host.reservedShortcut==chord && monitor.isReady,"a new shortcut can be assigned after clearing")
        let pairs:[(String,AIProtocol)] = [("responses",.responses),("chat",.chatCompletions),("messages",.anthropicMessages)]
        for (path,api) in pairs {
            let config = endpoint(path,api)
            host.configuration = { config }
            let response = await ask(interpret)
            check(response.1 == nil && response.0?["plan"] as? String == ModelFixture.plan,"model round trip: " + path)
            check(keyAccounts.last == (try config.credentialAccount()),"key matches selected origin and protocol")
        }
        host.configuration = { endpoint("denied") }
        let denied = await ask(interpret)
        check(denied.0 == nil && denied.1 != nil,"model error never returns an action")
        host.configuration = { endpoint("pending") }
        let pending = Task { @MainActor in await ask(interpret) }
        try await Task.sleep(for:.milliseconds(40))
        _ = await ask(["op":"enable","enabled":false])
        let result = await pending.value
        check(result.0?["cancelled"] as? Bool == true && !host.enabled,"switch off invalidates pending model response")
        check(await ask(interpret).1 != nil,"off blocks later requests")
        pressID=nil;await press(chord);check(pressID==nil,"disabled control no longer claims its key")
        print("Voice Control native checks passed: \(count). Temporary preferences, simulated speech and three isolated model transports.")
    }
}
