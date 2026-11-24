import AppKit
import Carbon

@MainActor private final class IsolatedCopyEditor: NSTextView {
    var destination: NSPasteboard!
    private(set) var copyCount = 0
    override func copy(_ sender: Any?) {
        copyCount += 1
        destination.clearContents()
        precondition(writeSelection(to:destination,types:writablePasteboardTypes))
    }
}

/// Uses an in-process editor, a private pasteboard and the isolated hotkey recognizer.
/// No events are posted to other apps and the system clipboard is never read or written.
@main @MainActor struct MyCommandCopyHandoffChecks {
    static func checkSinglePress(board: NSPasteboard, selection: String) async throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        let center = NotificationCenter()
        let pid = ProcessInfo.processInfo.processIdentifier
        var frontmost: pid_t? = pid
        let monitor = VoiceHotkey(listenToSystemEvents:false,frontmostPID:{ frontmost })
        let command = UInt64(NSEvent.ModifierFlags.command.rawValue)
        let key = UInt32(kVK_ANSI_T)
        guard let copyKey = VoiceHotkey.copyKeyCode() else { fatalError("Test layout has no Command-C equivalent") }
        let editor = IsolatedCopyEditor()
        editor.destination = board
        let window = NSPanel(contentRect:NSRect(x:0,y:0,width:360,height:120),styleMask:[.titled,.nonactivatingPanel],backing:.buffered,defer:false)
        window.contentView = editor
        precondition(window.makeFirstResponder(editor))
        defer { window.orderOut(nil) }
        editor.string = "UNSELECTED\n" + selection + "\nUNSELECTED"
        editor.setSelectedRange((editor.string as NSString).range(of:selection))
        let menu = NSMenu()
        let copy = menu.addItem(withTitle:"Copy",action:#selector(NSText.copy(_:)),keyEquivalent:"c")
        copy.target = editor
        copy.keyEquivalentModifierMask = .command
        let mainMenu = NSMenu()
        mainMenu.addItem(withTitle:"Edit",action:nil,keyEquivalent:"").submenu = menu
        app.mainMenu = mainMenu
        var received: [String] = []
        var outcomes = 0
        let handoff = CommandCopyHandoff(board:board,activationCenter:center,isCurrent:{ frontmost == pid }) { outcome in
            outcomes += 1
            if case .text(let text) = outcome { received.append(text) }
        }
        var isCopySource = true
        var prepared = 0, opened = 0
        monitor.prepareForegroundPress = { target, kind in
            prepared += 1
            precondition(target == pid)
            guard isCopySource, kind == .down else { return .init {} }
            let baseline = board.changeCount
            return .init(commandKeyCode:copyKey) {
                opened += 1
                handoff.start(sourcePID:target)
                _ = handoff.receiveCopy(after:baseline)
            }
        }
        try monitor.register(keyCode:key,modifiers:command) {}
        defer { monitor.unregister(); handoff.stop() }
        func decide(_ kind: VoiceHotkeyEventKind, repeated: Bool = false, flags: UInt64? = nil, owned: Bool = false) -> VoiceHotkeyDecision {
            monitor.observeRuntime(.init(kind:kind,keyCode:key,flags:flags ?? command,isRepeat:repeated,owned:owned))
        }
        func asEvent(_ decision: VoiceHotkeyDecision, down: Bool) -> NSEvent {
            let raw = CGEvent(keyboardEventSource:nil,virtualKey:CGKeyCode(key),keyDown:down)!
            raw.flags = .maskCommand
            let stamp = raw.timestamp, owner = raw.getIntegerValueField(.eventSourceUnixProcessID)
            precondition(decision.filtered(raw) === raw)
            precondition(raw.timestamp == stamp && raw.getIntegerValueField(.eventSourceUnixProcessID) == owner)
            let native = NSEvent(cgEvent:raw)!
            precondition(native.keyCode == copyKey && native.modifierFlags.contains(.command))
            return native
        }
        board.clearContents(); precondition(board.setString("stale clipboard",forType:.string))
        let first = decide(.down)
        precondition(first.fire && first.commandKeyCode == copyKey && prepared == 1 && opened == 0)
        precondition(menu.performKeyEquivalent(with:asEvent(first,down:true)))
        let repeated = decide(.down,repeated:true)
        precondition(repeated.consume && repeated.commandKeyCode == nil && !repeated.fire)
        let release = decide(.up,flags:0)
        precondition(!release.fire && release.commandKeyCode == copyKey && asEvent(release,down:false).type == .keyUp)
        try await Task.sleep(nanoseconds:150_000_000)
        precondition(opened == 1 && editor.copyCount == 1 && received == [selection])

        // A slower responder writes after the UI callback has armed its one-shot reader.
        let second = decide(.down)
        try await Task.sleep(nanoseconds:80_000_000)
        precondition(opened == 2 && outcomes == 1)
        precondition(menu.performKeyEquivalent(with:asEvent(second,down:true)))
        _ = decide(.up)
        try await Task.sleep(nanoseconds:120_000_000)
        precondition(editor.copyCount == 2 && received == [selection,selection])

        let third = decide(.down)
        precondition(third.commandKeyCode == copyKey)
        frontmost = nil
        let foreignUp = decide(.up)
        precondition(foreignUp.consume && foreignUp.commandKeyCode == nil)
        try await Task.sleep(nanoseconds:80_000_000)
        precondition(opened == 2 && outcomes == 2)
        frontmost = pid
        isCopySource = false
        let standard = decide(.down)
        precondition(standard.fire && standard.consume && standard.commandKeyCode == nil && decide(.up).commandKeyCode == nil)
        precondition(!decide(.down,flags:0).fire && !decide(.up,flags:0).consume)
        precondition(!decide(.down,owned:true).fire)
        monitor.suspendHandling()
        precondition(!decide(.down).fire && decide(.up).commandKeyCode == nil)
        print("Passed single ⌘T in the real shortcut recognizer and AppKit Copy menu: fast and delayed copies, exact selected text, key-up pairing, repeat suppression, refocus, normal apps and suspension.")
    }

    static func main() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let center = NotificationCenter()
        let pid = ProcessInfo.processInfo.processIdentifier
        var current = true
        var answers: [String] = []
        var misses = 0, oversize = 0, lost = 0, inspected = 0
        for id in ["com.tencent.xinWeChat","com.tencent.xinWeChat.Helper","com.tencent.WeChat"] {
            guard case .userCopy = CommandSelection.shortcutSource(bundleID:id,focused:{ inspected += 1; return nil }) else {
                fatalError("The protected source did not use manual copy")
            }
        }
        precondition(inspected == 0)
        for id in ["com.apple.Notes","com.tencent.xinWeChatOther"] {
            guard case .focused = CommandSelection.shortcutSource(bundleID:id,focused:{ inspected += 1; return nil }) else {
                fatalError("Standard text selection changed")
            }
        }
        precondition(inspected == 2)
        let handoff = CommandCopyHandoff(board:board,activationCenter:center,isCurrent:{ current }) { outcome in
            switch outcome {
            case .text(let text): answers.append(text)
            case .noText: misses += 1
            case .tooLong: oversize += 1
            case .sourceLost: lost += 1
            }
        }
        defer { handoff.stop() }
        let monitor = VoiceHotkey(listenToSystemEvents:false)
        try monitor.register(keyCode:17,modifiers:UInt64(NSEvent.ModifierFlags.command.rawValue),mouseButton:nil) {}
        defer { monitor.unregister() }
        var copies = 0
        monitor.onPassThroughCopy = { copies += 1; return handoff.copyPressed() }
        let cmd = UInt64(NSEvent.ModifierFlags.command.rawValue)
        func key(_ code: UInt32, flags: UInt64, repeatKey: Bool = false, owned: Bool = false) {
            let d = monitor.observeRuntime(.init(kind:.down,keyCode:code,flags:flags,isRepeat:repeatKey,owned:owned))
            let u = monitor.observeRuntime(.init(kind:.up,keyCode:code,flags:flags,owned:owned))
            precondition(!d.consume && !u.consume, "Copy was swallowed by the shortcut")
        }
        func write(_ s: String) { board.clearContents(); precondition(board.setString(s,forType:.string)) }
        func settle() async throws { try await Task.sleep(nanoseconds:160_000_000) }

        write("Old text")
        handoff.start(sourcePID:pid)
        key(8,flags:0); key(8,flags:cmd | UInt64(NSEvent.ModifierFlags.shift.rawValue))
        key(8,flags:cmd,repeatKey:true); key(8,flags:cmd,owned:true)
        write("Unrelated change before pressing Copy")
        try await settle()
        precondition(copies == 0 && answers.isEmpty)
        key(8,flags:cmd)
        try await Task.sleep(nanoseconds:2_350_000_000)
        precondition(copies == 1 && misses == 1 && answers.isEmpty)

        let selection = "整理蓝色样卡\n清点七个盒子 📦"
        let editor = NSTextView()
        editor.string = "Outside the selection\n" + selection + "\nOutside the selection"
        editor.setSelectedRange((editor.string as NSString).range(of:selection))
        key(8,flags:cmd)
        precondition(editor.writeSelection(to:board,types:editor.writablePasteboardTypes))
        try await settle()
        precondition(answers == [selection] && !handoff.copyPressed())
        write("Late copy"); try await settle(); precondition(answers.count == 1)

        handoff.start(sourcePID:pid)
        key(8,flags:cmd); write(String(repeating:"A",count:CommandSelection.maximumBytes+1))
        try await settle(); precondition(oversize == 1 && answers.count == 1)
        func writeMarked(_ type: NSPasteboard.PasteboardType, _ marker: String) {
            let item = NSPasteboardItem()
            item.setString("Not command text",forType:.string)
            item.setString(marker,forType:type)
            board.clearContents(); precondition(board.writeObjects([item]))
        }
        key(8,flags:cmd); writeMarked(.init("org.nspasteboard.ConcealedType"),"")
        try await settle(); precondition(misses == 2 && answers.count == 1)
        key(8,flags:cmd); writeMarked(.init("org.nspasteboard.source"),"example.unrelated")
        try await settle(); precondition(misses == 3 && answers.count == 1)
        key(8,flags:cmd); writeMarked(.fileURL,"file:///not-a-selection")
        try await settle(); precondition(misses == 4 && answers.count == 1)
        key(8,flags:cmd); write(selection); current = false
        try await settle(); precondition(lost == 1 && answers.count == 1)
        current = true
        handoff.start(sourcePID:pid); key(8,flags:cmd); write(selection)
        center.post(name:NSWorkspace.didActivateApplicationNotification,object:nil)
        try await settle(); precondition(lost == 2 && answers.count == 1)
        handoff.start(sourcePID:pid); key(8,flags:cmd); write(selection); handoff.stop()
        try await settle(); precondition(answers.count == 1 && !handoff.copyPressed())
        handoff.start(sourcePID:pid); key(8,flags:cmd)
        let rich = NSAttributedString(string:selection)
        let rtf = try rich.data(from:NSRange(location:0,length:rich.length),documentAttributes:[.documentType:NSAttributedString.DocumentType.rtf])
        board.clearContents(); precondition(board.setData(rtf,forType:.rtf))
        try await settle(); precondition(answers.last == selection && answers.count == 2)
        try await checkSinglePress(board:board,selection:selection)
        print("Passed isolated clipboard handoff: source routing without AX, original Copy delivered, stale/foreign/protected data rejected, exact multiline selection, RTF, cancellation and refocus.")
    }
}
