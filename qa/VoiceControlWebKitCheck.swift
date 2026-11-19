import AppKit
import WebKit

@MainActor private final class CommandBridgeFixture:NSObject,WKScriptMessageHandlerWithReply {
    let command:LabVoiceControl
    let origin:URL
    var operations=[String]()
    init(command:LabVoiceControl,origin:URL) { self.command=command;self.origin=origin }
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage,replyHandler:@escaping(Any?,String?)->Void) {
        guard message.frameInfo.isMainFrame,let url=message.frameInfo.request.url,
              url.scheme==origin.scheme,url.host==origin.host,url.port==origin.port,
              let body=message.body as? [String:Any] else { replyHandler(nil,"Unexpected origin");return }
        operations.append(body["op"] as? String ?? "")
        command.handle(body,reply:replyHandler)
    }
}

/// Drive the compiled UI through WebKit's actual reply handler and the native
/// voice controller. Only acoustic input, model transport and USB are fixtures.
@MainActor func verifyVoiceControlInWebKit(_ url:URL) async throws {
    precondition(url.host=="127.0.0.1")
    let suite="com.nuphy.voice-control.webkit."+UUID().uuidString
    let prefs=UserDefaults(suiteName:suite)!
    defer {prefs.removePersistentDomain(forName:suite)}
    // Existing profile with a right Control command trigger and dictation on a mouse button.
    prefs.set(["keyCode":62,"modifiers":0],forKey:"NuPhyLab.voiceControl.shortcut")
    let speech=VoiceCaptureService()
    let monitor=VoiceHotkey(listenToSystemEvents:false)
    let host=LabVoiceControl(defaults:prefs,speech:speech,client:AIClient(protocolClasses:[ModelFixture.self]),hotkey:monitor,hasKey:{_ in true},readKey:{_ in "fixture-secret"})
    let directory=FileManager.default.temporaryDirectory.appendingPathComponent("dictation-command-"+UUID().uuidString)
    let dictation=VoiceInputController(directory:directory,qa:true)
    defer {dictation.shutdown();try? FileManager.default.removeItem(at:directory)}
    var oldDictation=dictation.store.settings
    oldDictation.shortcutMouseButton=4
    oldDictation.shortcutMouseModifiers=0
    try dictation.store.save(oldDictation)
    host.setInputShortcut={try dictation.setCommandShortcut($0)}
    host.mayStart={true}
    host.configuration={AIConfiguration(provider:.custom,endpoint:"https://fixture.invalid/chat",model:"fixture-model",apiProtocol:.chatCompletions)}
    speech.captureTestDriver = .init(onStart:{token in
        Task { @MainActor in
            try? await Task.sleep(for:.milliseconds(80))
            speech.receiveTestResult(.init(text:"Fixture command",isFinal:true,failureDomain:nil,failureCode:nil),token:token)
        }
    },onFinishInput:{_ in},finalizationTimeout:0.03)
    let configuration=WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let bridge=CommandBridgeFixture(command:host,origin:url)
    configuration.userContentController.addScriptMessageHandler(bridge,contentWorld:.page,name:"voiceControl")
    let visible=NSScreen.main?.visibleFrame ?? NSRect(x:0,y:0,width:1080,height:720)
    let panel=NSPanel(contentRect:NSRect(x:visible.maxX-120,y:visible.minY,width:120,height:90),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
    panel.hidesOnDeactivate=false
    panel.ignoresMouseEvents=true
    panel.alphaValue=0.15
    panel.level = .floating
    let web=WKWebView(frame:NSRect(x:0,y:0,width:1080,height:720),configuration:configuration)
    panel.contentView?.addSubview(web)
    panel.orderFrontRegardless()
    defer { panel.orderOut(nil);host.cancel();configuration.userContentController.removeScriptMessageHandler(forName:"voiceControl",contentWorld:.page) }
    func wait(_ js:String,_ reason:String) async throws {
        for _ in 0..<120 {
            if (try? await web.evaluateJavaScript(js)) as? Bool == true {return}
            try await Task.sleep(for:.milliseconds(80))
        }
        let message=(try? await web.evaluateJavaScript("JSON.stringify({visibility:document.visibilityState,language:document.documentElement.lang,page:document.querySelector('.app-shell')?.dataset.page,toolbar:document.querySelector('.lab-voice-control')?.innerText})")) as? String ?? ""
        throw NSError(domain:"VoiceControlWebKit",code:1,userInfo:[NSLocalizedDescriptionKey:"\(reason) \(message) \(bridge.operations)"])
    }
    _=web.load(URLRequest(url:url))
    try await wait("(()=>{const b=[...document.querySelectorAll('button')].find(b=>['稍后','Later'].includes(b.textContent.trim())&&b.getClientRects().length);if(b)b.click();return !!b})()","first run")
    try await wait("document.querySelector('.lvc-switch')?.disabled===false","native bridge ready")
    _=try await web.evaluateJavaScript("document.querySelector('.lvc-switch').click();true")
    try await wait("document.querySelector('.lvc-switch')?.getAttribute('aria-checked')==='true'","switch")
    _=try await web.evaluateJavaScript("document.querySelector('.lvc-talk').click();true")
    try await wait("/已添加到侧栏|In sidebar/.test(document.querySelector('.lvc-feedback')?.textContent??'')","spoken command through model transport")
    precondition(bridge.operations.contains("listen") && bridge.operations.contains("interpret") && !host.capturing)
    host.shortcut.canTrigger={true}
    host.presentShortcut={id in Task { _=try? await web.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('nuphylab:voice-control-shortcut',{detail:id}))",arguments:["id":id],in:nil,contentWorld:.page) }}
    let dictationMonitor=VoiceHotkey(listenToSystemEvents:false)
    func tapControl(_ code:UInt32) {
        let key=VoiceHotkeyPolicy.modifiers[code]!
        for flags in [key.flag | key.side,0] {
            let event=VoiceHotkeyEvent(kind:.flags,keyCode:code,flags:flags)
            _=monitor.observeRuntime(event)
            _=dictationMonitor.observeRuntime(event)
        }
    }
    func remap(_ words:String,feedback:String,keyCode:UInt16) async throws {
        speech.captureTestDriver = .init(onStart:{token in
            speech.receiveTestResult(.init(text:words,isFinal:false,failureDomain:nil,failureCode:nil),token:token)
        },onFinishInput:{token in
            speech.receiveTestResult(.init(text:words,isFinal:true,failureDomain:nil,failureCode:nil),token:token)
        })
        let before = bridge.operations.filter{$0=="setInputShortcut"}.count
        let modelCalls = bridge.operations.filter{$0=="interpret"}.count
        var expected = dictation.store.settings
        tapControl(62)
        try await wait("document.querySelector('.lvc-words')?.textContent === '“"+words+"”'","right Control started capture")
        precondition(host.capturing && bridge.operations.filter{$0=="setInputShortcut"}.count==before)
        tapControl(62)
        try await wait("document.querySelector('.lvc-feedback')?.textContent.includes('"+feedback+"')","second right Control commits dictation binding")
        expected.shortcutKeyCode=keyCode;expected.shortcutModifiers=0
        expected.shortcutMouseButton=nil;expected.shortcutMouseModifiers=nil
        let persisted=try VoiceSettingsStore(directory:directory).settings
        precondition(persisted==expected && !host.capturing && bridge.operations.filter{$0=="setInputShortcut"}.count==before+1)
        precondition(bridge.operations.filter{$0=="interpret"}.count==modelCalls)
        precondition(host.shortcut.value==VoiceShortcutValue(keyCode:62,modifiers:0))
    }
    try await remap("把语音输入的快捷键改成左边的 CTRL",feedback:"左 Control",keyCode:59)
    let persisted=try VoiceSettingsStore(directory:directory).settings
    var dictationStarts=0
    try dictationMonitor.register(keyCode:UInt32(persisted.shortcutKeyCode),modifiers:persisted.activeShortcutModifiers){dictationStarts+=1}
    let listens=bridge.operations.filter{$0=="listen"}.count
    tapControl(59)
    for _ in 0..<25 {if dictationStarts>0 {break};try await Task.sleep(for:.milliseconds(10))}
    precondition(dictationStarts==1 && !host.capturing && bridge.operations.filter{$0=="listen"}.count==listens)
    try await remap("把语音输入的快捷键给我改成 Q",feedback:"已设为 Q",keyCode:UInt16(VoiceHotkey.namedShortcut("Q")!.keyCode))
    precondition(dictationStarts==1)
    print("WebKit verified saved Left Control (59) from the reported Chinese command and a previous mouse binding. Right Control (62) still only starts/finishes commands. Dictation alone responds to a left tap. Q remapping also persisted. Temporary settings, simulated speech and key events.")
}
