import AppKit
import Carbon
import ApplicationServices

enum PocketShortcutEvent { case keyDown, keyUp, flagsChanged, mouseDown, interrupted }
enum PocketPreviewChange: Equatable { case show(String), hide }
struct PocketShortcutDecision: Equatable {
    var swallow = false
    var action: String?
    var index: Int?
    var preview: PocketPreviewChange?
}

/// Bind a queued key decision to its originating application. In particular,
/// workspace notifications need not arrive before this main-queue callback.
enum PocketSlotDispatch {
    static func enqueue(action:String,index:Int,originPID:pid_t?,
                        currentPID:@escaping ()->pid_t?,permitted:@escaping ()->Bool,
                        deliver:@escaping (String,Int,pid_t)->Void,
                        schedule: (@escaping ()->Void)->Void = { DispatchQueue.main.async(execute:$0) }) {
        guard let originPID,originPID>0 else{return}
        schedule {
            guard currentPID()==originPID,permitted(),currentPID()==originPID else{return}
            deliver(action,index,originPID)
        }
    }
}

/// Pure state only: no permissions, event taps, key injection or pasteboard.
struct PocketSlotMatcher {
    private struct Prefix {
        let action: String
        let flags: CGEventFlags
        let key: UInt16?
    }
    private var enabled = false
    private var previewEnabled = true
    private var prefixes: [Prefix] = []
    private var slots: [UInt16: Int] = [:]
    private var down = Set<UInt16>()
    private var claimed = Set<UInt16>()
    private var passedPrefixKeys = Set<UInt16>()
    private var active: Prefix?
    private var shown: String?
    private var blockedModifiers: CGEventFlags = []
    private var blockedKeys = Set<UInt16>()
    private var lastFlags: CGEventFlags = []
    private(set) var functionObserved = false
    static let modifierMask: CGEventFlags = [.maskSecondaryFn, .maskControl, .maskAlternate, .maskShift, .maskCommand]
    static let implicitFunctionKeys = PocketSettings.implicitFunctionKeys

    mutating func configure(_ settings: PocketSettings) throws {
        try settings.validate()
        _ = reset()
        enabled = settings.enabled
        previewEnabled = settings.previewEnabled
        prefixes = [Prefix(action:"use", flags:Self.flags(settings.useModifiers), key:settings.useTriggerKeyCode),
                    Prefix(action:"capture", flags:Self.flags(settings.captureModifiers), key:settings.captureTriggerKeyCode)]
        // slotOrder is deliberately absent: display movement never changes identity.
        slots = Dictionary(uniqueKeysWithValues: settings.slotKeyCodes.enumerated().map { ($0.element, $0.offset) })
    }
    static func flags(_ modifiers: [String]) -> CGEventFlags {
        modifiers.reduce(into: CGEventFlags()) { flags, name in
            switch name {
            case "fn": flags.insert(.maskSecondaryFn)
            case "control": flags.insert(.maskControl)
            case "option": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            case "command": flags.insert(.maskCommand)
            default: break
            }
        }
    }
    @discardableResult
    mutating func reset() -> PocketShortcutDecision {
        let change = preview(nil)
        down.removeAll(); claimed.removeAll(); passedPrefixKeys.removeAll(); active = nil
        blockedModifiers = []; blockedKeys.removeAll(); lastFlags = []
        return .init(preview:change)
    }
    /// A focus change cancels the old hold, while draining already claimed keys.
    mutating func cancelSession() -> PocketShortcutDecision {
        if let active { block(active) }
        else if blockedModifiers.isEmpty, blockedKeys.isEmpty, let prefix = purePrefix(lastFlags) { block(prefix) }
        blockedKeys.formUnion(down.filter { code in prefixes.contains { $0.key == code } })
        active = nil
        return .init(preview:preview(nil))
    }
    private mutating func preview(_ action: String?) -> PocketPreviewChange? {
        let next = previewEnabled ? action : nil
        guard shown != next else { return nil }
        shown = next
        return next.map(PocketPreviewChange.show) ?? .hide
    }
    private mutating func block(_ prefix: Prefix) {
        if let key = prefix.key { blockedKeys.insert(key) }
        else if blockedModifiers.isEmpty { blockedModifiers = prefix.flags }
    }
    private mutating func blocked(_ flags: CGEventFlags) -> Bool {
        let modifierHeld = !blockedModifiers.isEmpty && !flags.intersection(blockedModifiers).isEmpty
        if !modifierHeld { blockedModifiers = [] }
        blockedKeys.formIntersection(down)
        return modifierHeld || !blockedKeys.isEmpty
    }
    private func matches(_ prefix: Prefix, flags: CGEventFlags, key: UInt16?) -> Bool {
        if flags == prefix.flags { return true }
        return key.map { Self.implicitFunctionKeys.contains($0) } == true && !prefix.flags.contains(.maskSecondaryFn) && flags.subtracting(.maskSecondaryFn) == prefix.flags
    }
    private func purePrefix(_ flags: CGEventFlags, key: UInt16? = nil) -> Prefix? {
        prefixes.first { $0.key == nil && $0.flags == flags }
            ?? prefixes.first { $0.key == nil && matches($0, flags:flags, key:key) }
    }
    private func keyedPrefix(_ code: UInt16, _ flags: CGEventFlags) -> Prefix? {
        // Prefer exact flags before accepting an implicit Fn flag on F keys.
        prefixes.first { $0.key == code && $0.flags == flags }
            ?? prefixes.first { $0.key == code && matches($0, flags:flags, key:code) }
    }
    private mutating func cancelActive() -> PocketPreviewChange? {
        if let active { block(active) }
        active = nil
        return preview(nil)
    }

    mutating func handle(_ event: PocketShortcutEvent, keyCode: UInt16 = 0, flags: CGEventFlags = [], isRepeat: Bool = false, permitted: Bool = true, secureInput: Bool = false, allowed: Bool = true) -> PocketShortcutDecision {
        guard enabled, permitted, !secureInput, event != .interrupted else { return reset() }
        let actual = flags.intersection(Self.modifierMask)
        if !allowed {
            // Host conflicts and transitions stop new ownership, but do not
            // leak repeats/ups for a down this matcher already consumed.
            let change=cancelSession().preview
            lastFlags=actual
            if event == .flagsChanged, flags.contains(.maskSecondaryFn) {functionObserved=true}
            for prefix in prefixes {
                blockedModifiers.formUnion(actual.intersection(prefix.flags))
            }
            let swallowed:Bool
            if event == .keyUp {
                swallowed=claimed.remove(keyCode) != nil
                down.remove(keyCode);passedPrefixKeys.remove(keyCode)
            } else {
                swallowed=event == .keyDown && claimed.contains(keyCode)
                if event == .keyDown {
                    down.insert(keyCode)
                    if !swallowed && prefixes.contains(where:{$0.key == keyCode}) {passedPrefixKeys.insert(keyCode)}
                }
            }
            blockedKeys.formUnion(down.filter {code in prefixes.contains {$0.key == code}})
            _ = blocked(actual)
            return .init(swallow:swallowed,preview:change)
        }
        if event == .mouseDown {
            lastFlags = actual
            return cancelSession()
        }
        if event == .flagsChanged {
            if flags.contains(.maskSecondaryFn) { functionObserved = true }
            let added = actual.subtracting(lastFlags)
            lastFlags = actual
            if let current = active {
                if matches(current, flags:actual, key:current.key) { return .init() }
                // Adding a modifier may intentionally select the other pure
                // prefix; releasing one must never start a new preview.
                if current.key == nil, !added.isEmpty, let next = purePrefix(actual) {
                    active = next
                    return .init(preview:preview(next.action))
                }
                let change = cancelActive()
                // This event may have released the entire prefix. Drain its
                // block now; otherwise the next fresh press is wrongly treated
                // as part of the previous hold and every other preview is lost.
                _ = blocked(actual)
                return .init(preview:change)
            }
            guard !blocked(actual), !added.isEmpty, let next = purePrefix(actual) else { return .init() }
            active = next
            return .init(preview:preview(next.action))
        }
        lastFlags = actual
        if event == .keyUp {
            let swallowed = claimed.remove(keyCode) != nil
            let change = active?.key == keyCode ? cancelActive() : nil
            down.remove(keyCode);passedPrefixKeys.remove(keyCode)
            _ = blocked(actual)
            return .init(swallow:swallowed, preview:change)
        }
        guard event == .keyDown else { return .init() }
        let first = down.insert(keyCode).inserted
        if claimed.contains(keyCode) { return .init(swallow:true) }
        let isBlocked = blocked(actual)
        if let prefix = keyedPrefix(keyCode, actual) {
            // A selected ordinary/F prefix is dedicated while enabled. It is
            // never replayed into an application, even if no slot is chosen.
            guard !isBlocked, !passedPrefixKeys.contains(keyCode) else {
                block(prefix)
                return .init()
            }
            claimed.insert(keyCode)
            guard first, !isRepeat else {
                block(prefix)
                return .init(swallow:true)
            }
            active = prefix
            return .init(swallow:true, preview:preview(prefix.action))
        }
        guard first, !isRepeat else { return .init() }
        if !isBlocked, let index = slots[keyCode] {
            let prefix = active ?? purePrefix(actual, key:keyCode)
            if let prefix, matches(prefix, flags:actual, key:prefix.key ?? keyCode),
               prefix.key == nil || down.contains(prefix.key!) {
                claimed.insert(keyCode)
                block(prefix)
                active = nil
                return .init(swallow:true, action:prefix.action, index:index, preview:preview(nil))
            }
        }
        if keyCode == 53, active != nil {
            claimed.insert(keyCode)
            return .init(swallow:true, preview:cancelActive())
        }
        if active != nil { return .init(preview:cancelActive()) }
        if !isBlocked, let prefix = purePrefix(actual) { block(prefix) }
        return .init()
    }
}

/// Entry points and OS callbacks run on the main run loop. Sendable permits
/// queued delivery to that run loop without moving mutable state off-thread.
final class PocketHotkeys: @unchecked Sendable {
    var onAction: ((UInt32) -> Void)?
    var canActivate: () -> Bool = { true }
    var onSlotAction: ((String, Int, pid_t) -> Void)?
    var onStateChange: (() -> Void)?
    var onUserInput: ((Double) -> Void)?
    var onPreviewAction: ((String?) -> Void)?
    private(set) var slotStatus = "直达快捷键尚未启用"
    private(set) var slotReady = false
    var functionObserved: Bool { matcher.functionObserved }
    var isMonitoring:Bool { !stopped && (tap.map { CGEvent.tapIsEnabled(tap:$0) } ?? false) }
    static let ownEventMarker: Int64 = 0x4E504B54

    private var settings: PocketSettings?
    private var matcher = PocketSlotMatcher()
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var permissionTimer: Timer?
    private var generation = 0
    // New user input cancels queued transfers, but must not cancel a queued
    // preview hide. Lifecycle changes continue to invalidate both via generation.
    private var inputGeneration = 0
    private var reportedState = ""
    private var stopped = true

    // Construction is inert. Only user-configured prefix/slot events are listened to.
    init() {}

    @discardableResult
    func configure(_ settings: PocketSettings) -> Bool {
        precondition(Thread.isMainThread)
        generation += 1
        dispatchPreview(.hide)
        do { try matcher.configure(settings) }
        catch {
            self.settings = nil
            stopped = true
            removeTap()
            permissionTimer?.invalidate(); permissionTimer = nil
            setStatus("直达快捷键配置无效：\(error.localizedDescription)")
            return false
        }
        self.settings = settings
        stopped = !settings.enabled
        guard settings.enabled else {
            removeTap()
            permissionTimer?.invalidate(); permissionTimer = nil
            setStatus("快捷键已关闭")
            return true
        }
        refreshPermissions()
        if permissionTimer == nil {
            permissionTimer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] _ in self?.refreshPermissions() }
        }
        return isMonitoring
    }

    func refreshPermissions() {
        precondition(Thread.isMainThread)
        guard !stopped, let settings, settings.enabled else { removeTap(); setStatus("快捷键已关闭"); return }
        guard AXIsProcessTrusted() else {
            removeTap()
            setStatus("未授权：请在系统设置允许辅助功能")
            return
        }
        guard !IsSecureEventInputEnabled() else {
            if let tap, CGEvent.tapIsEnabled(tap: tap) {
                CGEvent.tapEnable(tap: tap, enable: false)
                generation += 1
            }
            dispatchPreview(matcher.reset().preview)
            setStatus("安全输入已开启，直达快捷键暂停")
            return
        }
        if tap == nil { createTap() }
        guard let tap else { setStatus("直达监听未启动，请检查辅助功能权限"); return }
        if !CGEvent.tapIsEnabled(tap: tap) { dispatchPreview(matcher.reset().preview); CGEvent.tapEnable(tap: tap, enable: true) }
        guard CGEvent.tapIsEnabled(tap: tap) else { setStatus("直达监听已暂停，正在重新连接"); return }
        let requiresFn = settings.useModifiers.contains("fn") || settings.captureModifiers.contains("fn")
        if requiresFn && !functionObserved {
            setStatus("等待检测 Fn：请按一次 Fn；硬件若不向 macOS 发送 Fn，可改用其他修饰键")
        } else {
            let dedicated = [(settings.useModifiers, settings.useTriggerKeyCode), (settings.captureModifiers, settings.captureTriggerKeyCode)].compactMap { modifiers, code in
                modifiers.isEmpty ? code.flatMap { PocketSettings.keyNames[$0] } : nil
            }
            let notice = dedicated.isEmpty ? "" : "；\(dedicated.joined(separator:"、")) 已专用于口袋，未选槽位也不会输入原字符"
            setStatus("直达快捷键就绪" + notice, ready: true)
        }
    }

    /// Stops listeners without changing the user's saved configuration.
    func stop() {
        precondition(Thread.isMainThread)
        generation += 1
        stopped = true
        dispatchPreview(.hide)
        _ = matcher.reset()
        removeTap()
        permissionTimer?.invalidate(); permissionTimer = nil
        setStatus("快捷键已停止")
    }

    /// Focus changes retire the old prefix hold without replaying claimed keys.
    func cancelPreviewSession() {
        precondition(Thread.isMainThread)
        generation += 1
        _ = matcher.cancelSession()
        dispatchPreview(.hide)
    }
    func interrupt() { cancelPreviewSession() }

    private func createTap() {
        // Reading trust never prompts. No tap is created before AX is allowed.
        guard !stopped, AXIsProcessTrusted(), !IsSecureEventInputEnabled(), settings?.enabled == true else { return }
        let mask = [CGEventType.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown].reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let newTap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
            guard let pointer else { return Unmanaged.passUnretained(event) }
            return Unmanaged<PocketHotkeys>.fromOpaque(pointer).takeUnretainedValue().handleTap(type, event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0) else { CFMachPortInvalidate(newTap); return }
        tap = newTap
        tapSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: newTap, enable: true)
    }

    private func handleTap(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        precondition(Thread.isMainThread)
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            generation += 1
            dispatchPreview(matcher.handle(.interrupted).preview)
            dispatchUserInput(ProcessInfo.processInfo.systemUptime)
            refreshPermissions()
            return Unmanaged.passUnretained(event)
        }
        // The host tags its copy/paste events. Never consume or cancel them.
        if event.getIntegerValueField(.eventSourceUserData) == Self.ownEventMarker { return Unmanaged.passUnretained(event) }
        if type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown {
            // Retire a queued slot decision immediately, before a deferred
            // user-input callback can be overtaken by the slot callback.
            inputGeneration += 1
            let trusted = AXIsProcessTrusted()
            let secure = IsSecureEventInputEnabled()
            dispatchPreview(matcher.handle(.mouseDown, flags:event.flags, permitted:trusted, secureInput:secure, allowed:canActivate()).preview)
            if !trusted || secure { refreshPermissions() }
            dispatchUserInput(Double(event.timestamp) / 1_000_000_000)
            return Unmanaged.passUnretained(event)
        }
        let kind: PocketShortcutEvent
        switch type {
        case .keyDown: kind = .keyDown
        case .keyUp: kind = .keyUp
        case .flagsChanged: kind = .flagsChanged
        default: return Unmanaged.passUnretained(event)
        }
        let trusted = AXIsProcessTrusted()
        let secure = IsSecureEventInputEnabled()
        let wasObserved = functionObserved
        let repeatKey = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        let decision = matcher.handle(kind, keyCode: UInt16(clamping: event.getIntegerValueField(.keyboardEventKeycode)), flags: event.flags, isRepeat: repeatKey, permitted: trusted, secureInput: secure, allowed:canActivate())
        if !trusted || secure || wasObserved != functionObserved { refreshPermissions() }
        let newUserInput = kind == .keyDown && !repeatKey && !decision.swallow
        if newUserInput { inputGeneration += 1 }
        dispatchPreview(decision.preview)
        if let action = decision.action, let index = decision.index {
            let currentGeneration = generation
            let currentInputGeneration = inputGeneration
            let originPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
            PocketSlotDispatch.enqueue(action:action,index:index,originPID:originPID,
                currentPID:{ NSWorkspace.shared.frontmostApplication?.processIdentifier },permitted:{ [weak self] in
                guard let self, self.generation == currentGeneration, self.inputGeneration == currentInputGeneration,
                      !self.stopped, self.settings?.enabled == true,
                      AXIsProcessTrusted(), !IsSecureEventInputEnabled() else { return false }
                guard self.canActivate() else {self.cancelPreviewSession();return false}
                return true
            },deliver:{ [weak self] action,index,pid in self?.onSlotAction?(action,index,pid) })
        } else if newUserInput { dispatchUserInput(Double(event.timestamp) / 1_000_000_000) }
        return decision.swallow ? nil : Unmanaged.passUnretained(event)
    }

    private func dispatchUserInput(_ timestamp: Double) {
        DispatchQueue.main.async { [weak self] in self?.onUserInput?(timestamp) }
    }
    private func dispatchPreview(_ change: PocketPreviewChange?) {
        guard let change else { return }
        let currentGeneration = generation
        DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == currentGeneration else { return }
            switch change {
            case .show(let action):
                guard self.generation == currentGeneration, !self.stopped, self.settings?.enabled == true else { return }
                guard self.canActivate(), AXIsProcessTrusted(), !IsSecureEventInputEnabled() else {self.cancelPreviewSession();return}
                self.onPreviewAction?(action)
            case .hide: self.onPreviewAction?(nil)
            }
        }
    }
    private func setStatus(_ value: String, ready: Bool = false) {
        slotStatus = value
        slotReady = ready
        let state = "\(value)|\(functionObserved)|\(ready)"
        guard state != reportedState else { return }
        reportedState = state
        DispatchQueue.main.async { [weak self] in self?.onStateChange?() }
    }
    private func removeTap() {
        if tap != nil { generation += 1 }
        if let source = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        tapSource = nil
        tap = nil
        dispatchPreview(matcher.reset().preview)
    }
    deinit {
        permissionTimer?.invalidate()
        if let source = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
    }
}
