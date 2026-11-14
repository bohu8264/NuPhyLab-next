// Adapted from apps/macos/Sources/Chord/Input/IntentModifierMonitor.swift.
// Standalone single-selection extraction; see source-provenance.json for changes and hashes.
import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import IOKit.hid

public enum IntentMonitorFailure: Error { case createFailed, sourceFailed, timeout, userInput, healthDisabled }

enum SelectionSyntheticInput {
    // Shared event protocol with PocketHotkeys.ownEventMarker and the Pocket
    // command sender. These are transfers, never physical Selection gestures.
    static let pocketTransferMarker:Int64 = 0x4E504B54
    static func isPocketTransfer(_ event:CGEvent?) -> Bool {
        event?.getIntegerValueField(.eventSourceUserData) == pocketTransferMarker
    }
}

/// Owns exactly one explicitly configured hold input. Does not draw overlays,
/// read text, capture screens, record audio, or send requests by itself.
/// If Lab already routes the same hardware events, use IntentInputBridge there
/// instead of installing a second event tap for the same binding.
@MainActor public final class SelectionHoldMonitor {
    public var onEvent: ((IntentPressEvent) -> Void)?
    public var onCancel: (() -> Void)?
    public var onFailure: ((IntentMonitorFailure) -> Void)?
    public private(set) var isMonitoring = false
    public var isReady: Bool {
        isMonitoring && enabled && workspaceActive && !safetySuspended &&
        !IsSecureEventInputEnabled() && executor?.isHealthy == true
    }
    nonisolated static var inputAccessGranted: Bool {
        IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
    }
    /// Keep this object alive after stop while it drains a consumed down's up.
    public var isDrainingInput: Bool { !isMonitoring && receiver.withLock { $0.hasOwnedInput } }
    private let receiver = IntentBindingReceiver()
    private var executor: IntentTapRunLoop?
    private var epoch = UUID()
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var displayObserver: NSObjectProtocol?
    private var enabled = true
    private var workspaceActive = true
    private var safetySuspended = false

    public init() {}
    public func start(binding: InputBinding) throws {
        if let issue = InputBindingPolicy.issue(for: binding) { throw issue }
        stop()
        guard binding.kind != .disabled else { return }
        if let executor, !executor.isHealthy { tearDown() }
        guard AXIsProcessTrusted() else { throw IntentServiceError.accessibilityPermission }
        guard Self.inputAccessGranted else { throw IntentServiceError.inputPermission }
        epoch = UUID(); let current = epoch
        receiver.withLock { value in
            value.binding = binding; value.enabled = enabled && workspaceActive
            value.input.primeModifiers(Self.modifiers(CGEventSource.flagsState(.combinedSessionState)), binding: binding)
            value.onPress = { [weak self] event in
                DispatchQueue.main.async {
                    guard let self, self.epoch == current, self.isMonitoring,
                          self.receiver.withLock({ $0.input.accepts(event) }) else { return }
                    self.onEvent?(event)
                }
            }
            value.onMoveReady = { [weak self] token in
                DispatchQueue.main.async {
                    guard let self, self.epoch == current, self.isMonitoring else { return }
                    let event = self.receiver.withLock { value -> IntentPressEvent? in
                        guard let event = value.moves.take(token), value.input.accepts(event) else { return nil }
                        return event
                    }
                    if let event { self.onEvent?(event) }
                }
            }
            value.onEscape = { [weak self] in
                DispatchQueue.main.async {
                    guard let self, self.epoch == current, self.isMonitoring else { return }
                    self.onCancel?()
                }
            }
            value.onFault = { [weak self] reason in
                DispatchQueue.main.async {
                    guard let self, self.epoch == current, self.isMonitoring else { return }
                    self.stop(); self.onFailure?(reason)
                }
            }
        }
        // Reconfiguration can arrive while an old consumed physical down is
        // still draining. Reuse that tap and ownership until its matching up.
        if executor == nil {
            let worker = IntentTapRunLoop(receiver: receiver)
            do { try worker.start() } catch { receiver.withLock { $0.reset() }; throw error }
            executor = worker
        }
        isMonitoring = true; safetySuspended = false
        if timer == nil {
            let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.checkSafety() }
            }
            self.timer = timer; RunLoop.main.add(timer, forMode: .common)
        }
        observeWorkspace()
    }

    /// Pause/recording/host shutdown must call this synchronously. A cancelled
    /// press is disarmed until a new physical edge; it cannot restart itself.
    public func setEnabled(_ value: Bool) {
        enabled = value
        receiver.withLock { receiver in
            receiver.enabled = value && workspaceActive
            if !receiver.enabled { receiver.cancelLogical() }
        }
        if !value { onCancel?() }
    }
    public func stop() {
        let wasMonitoring = isMonitoring
        epoch = UUID(); isMonitoring = false
        receiver.withLock { $0.enabled = false; $0.cancelLogical() }
        observers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }; observers = []
        if let displayObserver { NotificationCenter.default.removeObserver(displayObserver); self.displayObserver = nil }
        // Keep draining only known physical pairs. The host receives no more
        // logical events, and unrelated input continues to pass immediately.
        if !receiver.withLock({ $0.hasOwnedInput }) { tearDown() }
        if wasMonitoring { onCancel?() }
    }
    private func checkSafety() {
        guard executor != nil else { return }
        if executor?.isHealthy != true {
            let wasMonitoring = isMonitoring
            stop(); tearDown()
            if wasMonitoring { onFailure?(.healthDisabled) }
            return
        }
        reconcileOwnedInput()
        guard isMonitoring else { return }
        let unsafe = IsSecureEventInputEnabled() || !AXIsProcessTrusted() || !Self.inputAccessGranted
        if unsafe, !safetySuspended {
            receiver.withLock { $0.cancelLogical() }
            onCancel?()
        }
        safetySuspended = unsafe
    }
    private func reconcileOwnedInput(at time: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        let owner = receiver.withLock { $0.input.runtime.pair.owner }
        let sides = receiver.withLock { $0.trackedSideButtons }
        // OS sampling stays outside the tap lock. A missing snapshot bit only
        // drains an already cancelled/released pair; it never ends an active hold.
        let mouseMask = NSEvent.pressedMouseButtons
        var samples: [BoundInput: Bool] = [:]
        if let owner {
            switch owner {
            case .key(let code): samples[owner] = CGEventSource.keyState(.hidSystemState, key: code)
            case .mouse(let index): samples[owner] = index >= 0 && index < Int.bitWidth && mouseMask & (1 << index) != 0
            }
        }
        for index in sides { samples[.mouse(index)] = mouseMask & (1 << index) != 0 }
        receiver.withLock { value in
            if let owner, let pressed = samples[owner] { value.input.observePhysicalState(isPressed: pressed, at: time) }
            for index in sides { if let pressed = samples[.mouse(index)] { value.observeSidePhysicalState(index, isPressed: pressed, at: time) } }
        }
        if !isMonitoring, !receiver.withLock({ $0.hasOwnedInput }) { tearDown() }
    }
    private func tearDown() {
        timer?.invalidate(); timer = nil
        executor?.stop(); executor = nil
        receiver.withLock { $0.reset() }
    }
    private func observeWorkspace() {
        let center = NSWorkspace.shared.notificationCenter
        let changes: [(Notification.Name, Bool)] = [(NSWorkspace.willSleepNotification, false),
            (NSWorkspace.sessionDidResignActiveNotification, false), (NSWorkspace.didWakeNotification, true),
            (NSWorkspace.sessionDidBecomeActiveNotification, true)]
        for (name, active) in changes {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.workspaceActive = active
                    self.receiver.withLock { receiver in
                        receiver.enabled = active && self.enabled
                        if !active { receiver.cancelLogical() }
                    }
                    if !active { self.onCancel?() }
                }
            })
        }
        displayObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.isMonitoring else { return }
                    self.receiver.withLock { $0.cancelLogical() }; self.onCancel?()
                }
            }
    }
    nonisolated static func modifiers(_ flags: CGEventFlags) -> InputModifiers {
        var result: InputModifiers = []
        if flags.contains(.maskControl) { result.insert(.control) }
        if flags.contains(.maskShift) { result.insert(.shift) }
        if flags.contains(.maskAlternate) { result.insert(.option) }
        if flags.contains(.maskCommand) { result.insert(.command) }
        if flags.contains(.maskSecondaryFn) { result.insert(.function) }
        return result
    }
    deinit {
        timer?.invalidate(); executor?.stop()
        observers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        if let displayObserver { NotificationCenter.default.removeObserver(displayObserver) }
    }
}

/// The callback mutates only this short-lock state. Framework capture/speech
/// and all host callbacks execute outside the tap thread.
final class IntentBindingReceiver {
    private let lock = NSRecursiveLock()
    var binding = InputBinding.disabled
    var enabled = false
    var input = IntentInputBridge()
    var moves = IntentPointerMoveBuffer()
    var onPress: ((IntentPressEvent) -> Void)?
    var onMoveReady: ((IntentPressToken) -> Void)?
    var onEscape: (() -> Void)?
    var onFault: ((IntentMonitorFailure) -> Void)?
    var replacementEvent: CGEvent?
    #if DEBUG
    var testSafetyAllowed: Bool?
    #endif
    private var safetyAllowed: Bool {
        #if DEBUG
        if let testSafetyAllowed { return testSafetyAllowed }
        #endif
        return !IsSecureEventInputEnabled() && AXIsProcessTrusted() && SelectionHoldMonitor.inputAccessGranted
    }
    private var failed = false
    private enum SideRepresentation: Hashable { case standard, auxiliary }
    private struct SidePair {
        var consumed: Bool
        var isDown = true
        var drained = false
        var downs: Set<SideRepresentation>
        var ups = Set<SideRepresentation>()
        var startedAt: CGEventTimestamp
        var previousConsumed: Bool?
        var lastTimestamp: CGEventTimestamp
        var releasedAt: TimeInterval?
    }
    private var sidePairs: [Int: SidePair] = [:]
    var hasOwnedInput: Bool { input.runtime.pair.owner != nil || sidePairs.values.contains { $0.consumed && !$0.drained } }
    var trackedSideButtons: [Int] { sidePairs.filter { !$0.value.drained }.keys.sorted() }
    func observeSidePhysicalState(_ index: Int, isPressed: Bool, at time: TimeInterval) {
        guard var pair = sidePairs[index], !pair.drained else { return }
        let active = input.runtime.pair.owner == .mouse(index) && input.runtime.pair.logicalActive
        if isPressed || active { pair.releasedAt = nil }
        else if let releasedAt = pair.releasedAt, time - releasedAt >= 0.3 {
            pair.isDown = false; pair.drained = true; pair.releasedAt = nil
        } else if pair.releasedAt == nil { pair.releasedAt = time }
        sidePairs[index] = pair
    }
    func withLock<T>(_ block: (IntentBindingReceiver) throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }; return try block(self)
    }
    func cancelLogical() { input.invalidate(); moves.reset() }
    func reset() {
        enabled = false; failed = false; input.resetAfterFailure(); moves.reset(); sidePairs = [:]
        onPress = nil; onMoveReady = nil; onEscape = nil; onFault = nil; replacementEvent = nil
    }
    func receive(_ type: CGEventType, event: CGEvent) -> Bool {
        replacementEvent = nil
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            guard !failed else { return false }
            failed = true; input.resetAfterFailure(); moves.reset(); sidePairs = [:]
            onFault?(type == .tapDisabledByTimeout ? .timeout : .userInput)
            return false
        }
        guard !SelectionSyntheticInput.isPocketTransfer(event) else{return false}
        let allowed = enabled && !failed && safetyAllowed
        let flags = SelectionHoldMonitor.modifiers(event.flags)
        if type.rawValue == 14 { return receiveAuxiliary(event, allowed: allowed) }
        let point = allowed ? IntentInputPoint(x: event.location.x, y: event.location.y) : nil
        if type == .mouseMoved { dispatch(input.pointerMoved(point, allowed: allowed)); return false }
        if type == .flagsChanged {
            let step = input.flagsChanged(keyCode: UInt16(clamping: event.getIntegerValueField(.keyboardEventKeycode)),
                modifiers: flags, binding: binding, allowed: allowed)
            dispatch(step); return step.consumes
        }
        if type == .keyDown, event.getIntegerValueField(.keyboardEventKeycode) == 53 {
            cancelLogical(); onEscape?(); return false
        }
        let physical: BoundInput, edge: BoundInputEdge
        switch type {
        case .keyDown, .keyUp:
            physical = .key(UInt16(clamping: event.getIntegerValueField(.keyboardEventKeycode)))
            edge = type == .keyDown ? .down : .up
        case .otherMouseDown, .otherMouseDragged, .otherMouseUp:
            physical = .mouse(Int(event.getIntegerValueField(.mouseEventButtonNumber)))
            edge = type == .otherMouseDown ? .down : type == .otherMouseUp ? .up : .dragged
        default: return false
        }
        if case .mouse(let index) = physical { return receiveSide(index, edge: edge, representation: .standard, event: event, allowed: allowed, point: point) }
        let step = input.handle(input: physical, edge: edge, isRepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
            modifiers: flags, binding: binding, allowed: allowed, point: point)
        dispatch(step); return step.consumes
    }
    private func dispatch(_ step: IntentBridgeStep) { if let event = step.event { emit(event) } }
    private func emit(_ event: IntentPressEvent) {
        if event.edge == .moved {
            if moves.offer(event) { onMoveReady?(event.token) }
        } else {
            if event.edge == .released || event.edge == .cancelled { moves.discard(event.token) }
            onPress?(event)
        }
    }
    private func receiveSide(_ index: Int, edge: BoundInputEdge, representation: SideRepresentation,
                             event: CGEvent, allowed: Bool, point: IntentInputPoint?) -> Bool {
        guard (binding.kind == .mouseButton && binding.buttonIndex == index) || sidePairs[index] != nil else { return false }
        if !allowed { dispatch(input.pointerMoved(nil, allowed: false)) }
        if var pair = sidePairs[index] {
            if event.timestamp > 0, event.timestamp < pair.startedAt, edge != .down || pair.previousConsumed != nil { return pair.previousConsumed ?? false }
            let logical = input.runtime.pair.owner == .mouse(index) && input.runtime.pair.logicalActive
            if edge == .down {
                let duplicate = event.timestamp > 0 && event.timestamp <= pair.lastTimestamp
                if pair.isDown && (!pair.downs.contains(representation) || duplicate || (event.timestamp == 0 && logical)) {
                    pair.startedAt = min(pair.startedAt, event.timestamp)
                    pair.downs.insert(representation); pair.lastTimestamp = max(pair.lastTimestamp, event.timestamp)
                    sidePairs[index] = pair; return pair.consumed
                }
                if !pair.isDown, event.timestamp > 0, event.timestamp <= pair.lastTimestamp { return pair.consumed }
                if pair.isDown && logical, let token = input.activePress {
                    input.cancelPress(token); emit(.init(token: token, source: .mouse, edge: .cancelled, point: nil))
                }
            } else if edge == .up {
                if !pair.isDown {
                    pair.ups.insert(representation); pair.lastTimestamp = max(pair.lastTimestamp, event.timestamp)
                    sidePairs[index] = pair; return pair.consumed
                }
                dispatch(input.handle(input: .mouse(index), edge: .up, modifiers: SelectionHoldMonitor.modifiers(event.flags), binding: binding, allowed: allowed, point: point))
                pair.isDown = false; pair.ups.insert(representation); pair.lastTimestamp = max(pair.lastTimestamp, event.timestamp)
                sidePairs[index] = pair; return pair.consumed
            } else if !pair.consumed { return false }
        }
        let step = input.handle(input: .mouse(index), edge: edge, modifiers: SelectionHoldMonitor.modifiers(event.flags), binding: binding, allowed: allowed, point: point)
        dispatch(step)
        if edge == .down { sidePairs[index] = .init(consumed: step.consumes, downs: [representation], startedAt: event.timestamp, previousConsumed: sidePairs[index]?.consumed, lastTimestamp: event.timestamp) }
        return step.consumes
    }
    private static func buttonMask(_ value: Int) -> UInt32? {
        if let value = UInt32(exactly: value) { return value }
        if let value = Int32(exactly: value) { return UInt32(bitPattern: value) }
        return nil
    }
    private func receiveAuxiliary(_ event: CGEvent, allowed: Bool) -> Bool {
        guard let native = NSEvent(cgEvent: event), native.type == .systemDefined, native.subtype.rawValue == 7,
              let changed = Self.buttonMask(native.data1), let state = Self.buttonMask(native.data2), changed != 0 else { return false }
        var suppressed: UInt32 = 0
        for index in 3..<32 where changed & (UInt32(1) << index) != 0 {
            let bit = UInt32(1) << index
            let point = allowed ? IntentInputPoint(x: event.location.x, y: event.location.y) : nil
            if receiveSide(index, edge: state & bit == 0 ? .up : .down, representation: .auxiliary, event: event, allowed: allowed, point: point) { suppressed |= bit }
        }
        let remaining = changed & ~suppressed
        if remaining == 0 { return true }
        var ownedMask = suppressed
        for (index, pair) in sidePairs where pair.consumed && pair.isDown { ownedMask |= UInt32(1) << index }
        guard suppressed != 0 || state & ownedMask != 0 else { return false }
        guard let replacement = NSEvent.otherEvent(with: .systemDefined, location: native.locationInWindow,
            modifierFlags: native.modifierFlags, timestamp: native.timestamp, windowNumber: native.windowNumber,
            context: nil, subtype: 7, data1: Int(remaining), data2: Int(state & ~ownedMask))?.cgEvent else { return false }
        replacement.timestamp = event.timestamp; replacement.flags = event.flags; replacement.location = event.location
        for field: CGEventField in [.eventSourceUserData, .eventSourceUnixProcessID, .eventSourceUserID, .eventSourceGroupID, .eventSourceStateID] {
            replacement.setIntegerValueField(field, value: event.getIntegerValueField(field))
        }
        replacementEvent = replacement
        return false
    }
}

let intentBindingCallback: CGEventTapCallBack = { _, type, event, pointer in
    guard let pointer else { return Unmanaged.passUnretained(event) }
    let receiver = Unmanaged<IntentBindingReceiver>.fromOpaque(pointer).takeUnretainedValue()
    return autoreleasepool {
        receiver.withLock { receiver in
            if receiver.receive(type, event: event) { return nil }
            if let replacement = receiver.replacementEvent { return Unmanaged.passRetained(replacement) }
            return Unmanaged.passUnretained(event)
        }
    }
}
