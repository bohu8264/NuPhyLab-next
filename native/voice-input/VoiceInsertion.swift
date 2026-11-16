import AppKit
import ApplicationServices
import Carbon

struct VoiceTarget {
    let pid: pid_t
    let element: AXUIElement
    let window: AXUIElement
    // Many web and Electron editors expose a real focus but omit these attributes.
    // They strengthen verification when available; they are not an insertion requirement.
    let range: CFRange?
    let value: String?
    let compatibility: Bool
    let compatibilityFocus: AXUIElement?
    let token: UUID
    let screen: NSScreen?
}

enum VoiceInsertionResult {
    case verified, dispatched, manual(String)
    var message: String {
        switch self {
        case .verified: return "已插入到原输入框。"
        case .dispatched: return "已发起插入，请在原输入框确认。"
        case .manual(let reason): return reason
        }
    }
}

enum VoiceTargetValidation: Equatable {
    case unchanged, changed(String), unavailable(String)
}

enum VoiceInsertionPolicy {
    static func allows(sameApplication: Bool, sameElement: Bool, sameWindow: Bool, sameRange: Bool, sameValue: Bool, invalidated: Bool, secure: Bool) -> Bool {
        sameApplication && sameElement && sameWindow && sameRange && sameValue && !invalidated && !secure
    }
    static func expectedValue(original: String, range: CFRange, inserted: String) -> String? {
        let ns = original as NSString
        guard range.location >= 0, range.length >= 0, range.location <= ns.length, range.length <= ns.length - range.location else { return nil }
        func splitsSurrogate(_ offset: Int) -> Bool {
            guard offset > 0, offset < ns.length else { return false }
            return (0xD800...0xDBFF).contains(ns.character(at: offset - 1)) && (0xDC00...0xDFFF).contains(ns.character(at: offset))
        }
        guard !splitsSurrogate(range.location), !splitsSurrogate(range.location + range.length) else { return nil }
        return ns.replacingCharacters(in: NSRange(location: range.location, length: range.length), with: inserted)
    }
    static func sensitive(role: String?, subrole: String?, protected: Bool) -> Bool {
        protected || role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }
    static let supportedRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXTextEntryArea"]
    static func editable(role: String?, explicitlyEditable: Bool, selectedTextSettable: Bool) -> Bool {
        guard let role else { return false }
        if supportedRoles.contains(role) { return true }
        return ["AXGroup", "AXWebArea", "AXUnknown", "AXLayoutArea"].contains(role) && (explicitlyEditable || selectedTextSettable)
    }
    static func compatibilityAllowed(bundleID: String?, windowTitle: String?, focusRole: String?) -> Bool {
        guard bundleID == "com.tencent.xinWeChat" else { return false }
        let title = (windowTitle ?? "").lowercased()
        guard !["登录","登入","log in","login","sign in"].contains(where:{title.contains($0)}) else { return false }
        // Never reinterpret an exposed button/menu as an opaque text editor.
        guard let focusRole else { return true }
        return ["AXWindow","AXApplication","AXGroup","AXUnknown","AXLayoutArea"].contains(focusRole)
    }
    static func compatibilityFocusChanged(originalAvailable: Bool, currentAvailable: Bool, sameElement: Bool) -> Bool {
        originalAvailable && currentAvailable && !sameElement
    }
    static func rangeChanged(_ original: CFRange?, _ current: CFRange?) -> Bool {
        guard let original, let current else { return false }
        return original.location != current.location || original.length != current.length
    }
    static func valueChanged(_ original: String?, _ current: String?) -> Bool {
        guard let original, let current else { return false }
        return original != current
    }
    static func invalidates(_ validation: VoiceTargetValidation) -> Bool {
        // Temporary focus/navigation is checked again immediately before paste.
        // A confirmed text edit or cancelled session must remain invalidated.
        if case .changed(let code) = validation { return ["value_changed","session_changed","cancelled"].contains(code) }
        return false
    }
    static func isTrigger(keyCode: UInt16, modifiers: UInt64, triggerCode: UInt32?, triggerModifiers: UInt64) -> Bool {
        guard let triggerCode, UInt32(keyCode) == triggerCode else { return false }
        let mask = UInt64(NSEvent.ModifierFlags([.command, .control, .option, .shift]).rawValue)
        return (modifiers & mask) == (triggerModifiers & mask)
    }
    static func releaseReady(modifiersDown: Bool, triggerDown: Bool) -> Bool { !modifiersDown && !triggerDown }
}

@MainActor final class VoiceInsertion {
    private var currentToken: UUID?
    private var invalidationCode: String?
    private var workspaceObserver: NSObjectProtocol?
    private var axObserver: AXObserver?
    private var interactionMonitor: Any?
    private var observationTimer: Timer?
    private var observedTarget: VoiceTarget?
    private var triggerCode: UInt32?
    private var triggerModifiers: UInt64 = 0
    private(set) var diagnosticCode = "idle"
    private var diagnosticRole = ""
    private var diagnosticFocusSource = ""
    private var hasValue = false, hasRange = false, interactionGuard = false
    private var compatibility = false
    private let excludedBundles: Set<String> = ["com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.Warp-Stable"]
    /// Safe to show in diagnostics: no text, selection offsets, window titles or secrets.
    var diagnostics: [String: Any] {
        ["code": diagnosticCode, "captureRole": diagnosticRole, "focusSource": diagnosticFocusSource,
         "valueReadable": hasValue, "rangeReadable": hasRange, "interactionGuard": interactionGuard,
         "compatibility": compatibility, "invalidated": invalidationCode != nil]
    }
    var diagnosticSummary: String { Self.explanation(diagnosticCode) }

    func capture(shortcutKeyCode: UInt32? = nil, shortcutModifiers: UInt64 = 0) -> VoiceTarget? {
        stopObserving(); currentToken = nil; observedTarget = nil; invalidationCode = nil
        triggerCode = shortcutKeyCode; triggerModifiers = shortcutModifiers
        diagnosticCode = "capturing"; diagnosticRole = ""; diagnosticFocusSource = ""
        hasValue = false; hasRange = false; interactionGuard = false; compatibility = false
        guard AXIsProcessTrusted() else { return captureFailed("accessibility_missing") }
        guard !IsSecureEventInputEnabled() else { return captureFailed("secure_input") }
        guard let app = NSWorkspace.shared.frontmostApplication else { return captureFailed("application_unavailable") }
        guard app.processIdentifier != getpid() else { return captureFailed("own_application") }
        guard !excludedBundles.contains(app.bundleIdentifier ?? "") else { return captureFailed("terminal_target") }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        let resolved = resolveFocus(application, pid: app.processIdentifier)
        if let focus = resolved?.0, sensitive(focus) { return captureFailed("secure_field") }
        let target: VoiceTarget
        if let (focus, source) = resolved, editable(focus) {
            diagnosticRole = safeRole(string(focus,kAXRoleAttribute)); diagnosticFocusSource = source
            guard let window = targetWindow(application,focus:focus) else { return captureFailed("window_unavailable") }
            let value = boundedValue(focus), selection = range(focus)
            hasValue = value != nil; hasRange = selection != nil
            target = VoiceTarget(pid:app.processIdentifier,element:focus,window:window,range:selection,value:value,compatibility:false,compatibilityFocus:nil,token:UUID(),screen:screen(window))
        } else {
            let focus = resolved?.0
            diagnosticRole = safeRole(focus.flatMap{string($0,kAXRoleAttribute)})
            guard app.bundleIdentifier == "com.tencent.xinWeChat" else { return captureFailed(focus == nil ? "focus_unavailable" : "focus_not_editable") }
            guard let window = compatibilityWindow(application) else { return captureFailed("window_unavailable") }
            guard !sensitive(window), VoiceInsertionPolicy.compatibilityAllowed(bundleID:app.bundleIdentifier,windowTitle:string(window,kAXTitleAttribute),focusRole:focus.flatMap{string($0,kAXRoleAttribute)}) else { return captureFailed("compatibility_target_unavailable") }
            // This specific WeChat version exposes only its window and title buttons.
            // Window identity plus the interaction guard replaces unavailable editor AX.
            // No text/range is inferred, and dispatch is never reported as verified.
            compatibility = true; diagnosticFocusSource = "wechat-window"
            if focus == nil { diagnosticRole = "AXWindow" }
            target = VoiceTarget(pid:app.processIdentifier,element:focus ?? window,window:window,range:nil,value:nil,compatibility:true,compatibilityFocus:focus,token:UUID(),screen:screen(window))
        }
        currentToken = target.token; observedTarget = target; diagnosticCode = compatibility ? "ready_wechat_compatibility" : "ready"
        startObserving(target, application: application)
        if compatibility && !interactionGuard { invalidate();return captureFailed("interaction_guard_unavailable") }
        return target
    }
    private func captureFailed(_ code: String) -> VoiceTarget? { diagnosticCode = code; return nil }
    func invalidate() { if currentToken != nil{markInvalid("cancelled")}; currentToken = nil; observedTarget = nil; stopObserving() }
    private func markInvalid(_ code: String) {
        if invalidationCode == nil { invalidationCode = code; diagnosticCode = code }
    }
    private func startObserving(_ target: VoiceTarget, application: AXUIElement) {
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                self?.observeCurrentState()
            }
        }
        // AX notifications often fire with an unchanged range/value (WebKit and Electron).
        // Read back the real state; a notification alone is never proof of a changed target.
        var observer: AXObserver?
        if AXObserverCreate(target.pid, { _, _, _, pointer in
            guard let pointer else { return }
            MainActor.assumeIsolated { Unmanaged<VoiceInsertion>.fromOpaque(pointer).takeUnretainedValue().observeCurrentState() }
        }, &observer) == .success, let observer {
            let pointer = Unmanaged.passUnretained(self).toOpaque()
            for name in [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification] { AXObserverAddNotification(observer, application, name as CFString, pointer) }
            for name in [kAXValueChangedNotification, kAXSelectedTextChangedNotification] { AXObserverAddNotification(observer, target.element, name as CFString, pointer) }
            axObserver = observer
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        // Opaque WeChat editors cannot expose what changed. Only that compatibility
        // route keeps the interaction guard; readable editors tolerate navigation.
        interactionMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, self.currentToken != nil else { return }
                guard target.compatibility else { self.observeCurrentState();return }
                if event.type == .keyDown, VoiceInsertionPolicy.isTrigger(keyCode: event.keyCode, modifiers: UInt64(event.modifierFlags.rawValue), triggerCode: self.triggerCode, triggerModifiers: self.triggerModifiers) { return }
                self.markInvalid(event.type == .keyDown ? "user_keyboard_edit" : "user_mouse_interaction")
            }
        }
        interactionGuard = interactionMonitor != nil
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.observeCurrentState() } }
        observationTimer = timer; RunLoop.main.add(timer, forMode: .common)
    }
    private func observeCurrentState() {
        guard invalidationCode == nil, let target = observedTarget else { return }
        if VoiceInsertionPolicy.valueChanged(target.value,boundedValue(target.element)) { markInvalid("value_changed");return }
        let validation=validate(target)
        if VoiceInsertionPolicy.invalidates(validation),case .changed(let code)=validation { markInvalid(code) }
    }
    private func stopObserving() {
        observationTimer?.invalidate(); observationTimer = nil
        if let workspaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver) }; workspaceObserver = nil
        if let interactionMonitor { NSEvent.removeMonitor(interactionMonitor) }; interactionMonitor = nil
        if let axObserver { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(axObserver), .commonModes) }; axObserver = nil
    }
    private func validate(_ target: VoiceTarget) -> VoiceTargetValidation {
        guard currentToken == target.token else { return .changed("session_changed") }
        if let code = invalidationCode { return .changed(code) }
        guard AXIsProcessTrusted() else { return .unavailable("accessibility_missing") }
        guard !IsSecureEventInputEnabled() else { return .changed("secure_input") }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else { return .changed("application_changed") }
        let application = AXUIElementCreateApplication(target.pid)
        if target.compatibility {
            guard NSRunningApplication(processIdentifier:target.pid)?.bundleIdentifier == "com.tencent.xinWeChat" else { return .changed("application_changed") }
            guard let window = compatibilityWindow(application) else { return .unavailable("window_unavailable") }
            guard CFEqual(window,target.window) else { return .changed("window_changed") }
            guard !sensitive(window), VoiceInsertionPolicy.compatibilityAllowed(bundleID:"com.tencent.xinWeChat",windowTitle:string(window,kAXTitleAttribute),focusRole:nil) else { return .changed("compatibility_target_unavailable") }
            let focus = resolveFocus(application,pid:target.pid)?.0
            if let focus, sensitive(focus) { return .changed("secure_field") }
            let same = focus.flatMap { current in target.compatibilityFocus.map{CFEqual(current,$0)} } ?? false
            if VoiceInsertionPolicy.compatibilityFocusChanged(originalAvailable:target.compatibilityFocus != nil,currentAvailable:focus != nil,sameElement:same) { return .changed("focus_changed") }
            if let focus, !editable(focus), !VoiceInsertionPolicy.compatibilityAllowed(bundleID:"com.tencent.xinWeChat",windowTitle:nil,focusRole:string(focus,kAXRoleAttribute)) { return .changed("focus_changed") }
            return .unchanged
        }
        guard let (focus, _) = resolveFocus(application, pid: target.pid) else { return .unavailable("focus_unavailable") }
        guard !sensitive(focus) else { return .changed("secure_field") }
        guard CFEqual(focus, target.element) else { return .changed("focus_changed") }
        guard let window = targetWindow(application, focus: focus) else { return .unavailable("window_unavailable") }
        guard CFEqual(window, target.window) else { return .changed("window_changed") }
        guard !VoiceInsertionPolicy.rangeChanged(target.range, range(focus)) else { return .changed("selection_changed") }
        guard !VoiceInsertionPolicy.valueChanged(target.value, boundedValue(focus)) else { return .changed("value_changed") }
        return .unchanged
    }
    func insert(text: String, target: VoiceTarget?) async -> VoiceInsertionResult {
        guard !text.isEmpty else { return finishManual("empty_result") }
        guard let target else { return finishManual(diagnosticCode == "ready" ? "focus_unavailable" : diagnosticCode) }
        let clipboard = NSPasteboard.general, clipboardBeforeWait = NSPasteboard.general.changeCount
        var ready = false, unavailableCode = "focus_unavailable"
        for _ in 0..<40 {
            if Task.isCancelled { return finishManual("cancelled") }
            switch validate(target) {
            case .changed(let code):
                if ["application_changed","focus_changed","window_changed","selection_changed"].contains(code),invalidationCode == nil { unavailableCode=code }
                else { return finishManual(code) }
            case .unavailable(let code): unavailableCode = code
            case .unchanged:
                if Self.keysReleased(triggerKeyCode: triggerCode) { ready = true }
                else { unavailableCode = "shortcut_held" }
            }
            if ready { break }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        guard ready, !Task.isCancelled else { return finishManual(Task.isCancelled ? "cancelled" : unavailableCode) }
        guard clipboard.changeCount == clipboardBeforeWait else { return finishManual("clipboard_changed") }
        guard case .unchanged = validate(target), Self.keysReleased(triggerKeyCode: triggerCode) else { return finishManual("target_changed_before_paste") }
        guard let source = CGEventSource(stateID: .privateState), let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { return finishManual("event_unavailable") }
        // Stop observation immediately before our own edit. Exactly one transport/attempt.
        stopObserving()
        clipboard.clearContents()
        guard clipboard.setString(text, forType: .string) else { return finishManual("clipboard_write_failed") }
        let ownedCount = clipboard.changeCount
        guard !Task.isCancelled, clipboard.changeCount == ownedCount, case .unchanged = validate(target), Self.keysReleased(triggerKeyCode: triggerCode) else { return finishManual("target_changed_after_copy") }
        down.flags = .maskCommand; up.flags = .maskCommand
        down.setIntegerValueField(.eventSourceUserData, value: 0x4E565649); up.setIntegerValueField(.eventSourceUserData, value: 0x4E565649)
        // Match the normal macOS keyboard route (and the Lab Pocket implementation).
        // PID-directed events do not reliably invoke Chromium/Electron menu commands.
        // No await between the final foreground/control guard and this single pair.
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        diagnosticCode = "paste_dispatched"
        let expected = target.value.flatMap { value in target.range.flatMap { VoiceInsertionPolicy.expectedValue(original: value, range: $0, inserted: text) } }
        try? await Task.sleep(nanoseconds: 180_000_000)
        let verified = expected != nil && boundedValue(target.element) == expected
        currentToken = nil; observedTarget = nil
        diagnosticCode = verified ? "paste_verified" : "paste_dispatched"
        // Clipboard retains the result. Do not perform a timed restoration or retry.
        return verified ? .verified : .dispatched
    }
    private func finishManual(_ code: String) -> VoiceInsertionResult {
        diagnosticCode = code; currentToken = nil; observedTarget = nil; stopObserving()
        return .manual(Self.explanation(code))
    }
    static func keysReleased(triggerKeyCode: UInt32? = nil) -> Bool {
        let modifiers = CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand,.maskControl,.maskAlternate,.maskShift])
        let triggerDown = triggerKeyCode.map { $0 < 128 && CGEventSource.keyState(.hidSystemState, key: CGKeyCode($0)) } ?? false
        return VoiceInsertionPolicy.releaseReady(modifiersDown: !modifiers.isEmpty, triggerDown: triggerDown)
    }
    private func resolveFocus(_ application: AXUIElement, pid: pid_t) -> (AXUIElement, String)? {
        var candidates: [(AXUIElement,String)] = []
        if let focused = axElement(application, kAXFocusedUIElementAttribute) { candidates.append((focused,"application")) }
        if let focused = axElement(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) {
            var owner: pid_t = 0
            if AXUIElementGetPid(focused, &owner) == .success, owner == pid, !candidates.contains(where:{CFEqual($0.0,focused)}) { candidates.append((focused,"system")) }
        }
        for (candidate, source) in candidates {
            var current = candidate, seen = [candidate]
            for _ in 0..<6 {
                if sensitive(current) { return (current,source) }
                guard let next = axElement(current,kAXFocusedUIElementAttribute), !seen.contains(where:{CFEqual($0,next)}) else { break }
                current = next; seen.append(next)
            }
            if sensitive(current) { return (current,source) }
            // Containers may claim editability while their actual focused child is a
            // password field or a different editor. Resolve the deepest real focus first.
            var budget = 40
            if !VoiceInsertionPolicy.supportedRoles.contains(string(current,kAXRoleAttribute) ?? ""),
               let descendant = focusedDescendant(current, depth:0, budget:&budget) { return (descendant,source+".descendant") }
            if editable(current) { return (current,source) }
        }
        return candidates.first
    }
    private func focusedDescendant(_ owner: AXUIElement, depth: Int, budget: inout Int) -> AXUIElement? {
        guard depth < 5, budget > 0, let children = attribute(owner,kAXChildrenAttribute) as? [AXUIElement] else { return nil }
        for child in children.prefix(20) {
            budget -= 1; if budget < 0 { return nil }
            if (attribute(child,kAXFocusedAttribute) as? Bool) == true {
                if sensitive(child) { return child }
                if let next = axElement(child,kAXFocusedUIElementAttribute), !CFEqual(next,child) {
                    if sensitive(next) { return next }
                    if let deeper = focusedDescendant(next,depth:depth+1,budget:&budget) { return deeper }
                    if editable(next) { return next }
                }
                if let deeper = focusedDescendant(child,depth:depth+1,budget:&budget) { return deeper }
                if editable(child) { return child }
            }
            let role = string(child,kAXRoleAttribute) ?? ""
            if ["AXGroup","AXWebArea","AXScrollArea","AXSplitGroup","AXWindow"].contains(role), let next = focusedDescendant(child,depth:depth+1,budget:&budget) { return next }
        }
        return nil
    }
    private func editable(_ element: AXUIElement) -> Bool {
        let role = string(element,kAXRoleAttribute)
        if VoiceInsertionPolicy.supportedRoles.contains(role ?? "") { return (attribute(element,kAXEnabledAttribute) as? Bool) != false }
        let explicit = (attribute(element,"AXEditable") as? Bool) == true
        var settable = DarwinBoolean(false)
        let selectionSettable = AXUIElementIsAttributeSettable(element,kAXSelectedTextAttribute as CFString,&settable) == .success && settable.boolValue
        return VoiceInsertionPolicy.editable(role:role,explicitlyEditable:explicit,selectedTextSettable:selectionSettable)
    }
    private func targetWindow(_ application: AXUIElement, focus: AXUIElement) -> AXUIElement? {
        axElement(focus,kAXWindowAttribute) ?? axElement(application,kAXFocusedWindowAttribute)
    }
    private func compatibilityWindow(_ application: AXUIElement) -> AXUIElement? {
        axElement(application,kAXFocusedWindowAttribute) ?? axElement(application,kAXMainWindowAttribute)
    }
    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        AXUIElementSetMessagingTimeout(element,0.15)
        guard AXUIElementCopyAttributeValue(element,name as CFString,&value) == .success else { return nil }
        return value
    }
    private func axElement(_ owner: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(owner,name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    private func string(_ element: AXUIElement, _ name: String) -> String? { attribute(element,name) as? String }
    private func boundedValue(_ element: AXUIElement) -> String? {
        guard let text = string(element,kAXValueAttribute), text.utf16.count <= 500_000 else { return nil }
        return text
    }
    private func safeRole(_ value: String?) -> String { guard let value, value.hasPrefix("AX"), value.count < 80 else { return "unknown" }; return value }
    private func sensitive(_ element: AXUIElement) -> Bool {
        VoiceInsertionPolicy.sensitive(role:string(element,kAXRoleAttribute),subrole:string(element,kAXSubroleAttribute),protected:(attribute(element,"AXProtectedContent") as? Bool) == true)
    }
    private func range(_ element: AXUIElement) -> CFRange? {
        guard let value = attribute(element,kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var result = CFRange()
        guard AXValueGetValue(value as! AXValue,.cfRange,&result),result.location >= 0,result.length >= 0 else { return nil }
        return result
    }
    private func screen(_ window: AXUIElement) -> NSScreen? {
        guard let raw = attribute(window,kAXPositionAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return NSScreen.main }
        var point = CGPoint.zero
        guard AXValueGetValue(raw as! AXValue,.cgPoint,&point) else { return NSScreen.main }
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        return NSScreen.screens.first(where:{$0.frame.contains(NSPoint(x:point.x+40,y:primaryTop-point.y-40))}) ?? NSScreen.main
    }
    static func explanation(_ code: String) -> String {
        switch code {
        case "ready": return "已记住原输入框。"
        case "ready_wechat_compatibility": return "微信兼容输入已就绪，请保持当前聊天输入位置。"
        case "paste_verified": return "已插入到原输入框。"
        case "paste_dispatched": return "已发起粘贴，请在原输入框确认。"
        case "accessibility_missing": return "需要辅助功能权限才能自动插入，结果可手动复制。"
        case "secure_input","secure_field": return "安全输入或密码框不支持自动插入，结果已保留。"
        case "own_application": return "请先在目标应用中点击输入框，再使用快捷键。"
        case "terminal_target": return "终端窗口不自动粘贴，结果可手动复制。"
        case "focus_not_editable": return "未找到当前可编辑的输入框，结果可手动复制。"
        case "compatibility_target_unavailable": return "当前微信窗口不适合兼容输入，请在普通聊天输入框重试。"
        case "interaction_guard_unavailable": return "暂时无法保护微信输入位置，结果可手动复制。"
        case "focus_unavailable","window_unavailable","application_unavailable": return "暂时无法读取目标输入位置，结果已保留，可手动复制。"
        case "application_changed","window_changed","focus_changed","target_changed_before_paste","target_changed_after_copy": return "目标应用或输入框已切换，已停止自动插入；结果已保留。"
        case "selection_changed","value_changed","user_keyboard_edit","user_mouse_interaction": return "输入位置或内容已被操作，已停止自动插入；结果已保留。"
        case "shortcut_held": return "快捷键尚未松开，结果已保留，可手动复制。"
        case "clipboard_changed": return "剪贴板已变化，已停止自动插入；结果已保留。"
        case "empty_result": return "没有可插入的文字。"
        case "cancelled","session_changed": return "本次自动插入已取消，结果已保留。"
        default: return "未能发起粘贴，结果已保留，可手动复制。"
        }
    }
}
