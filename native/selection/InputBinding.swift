// Adapted from apps/macos/Sources/ChordCore/InputBinding.swift.
// Standalone single-selection extraction; see source-provenance.json for changes and hashes.
import Foundation

public struct InputBinding: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case disabled, keyboard, modifiers, mouseButton }
    public let kind: Kind
    public let keyCode: UInt16?
    public let modifiers: InputModifiers
    public let buttonIndex: Int?
    public init(kind: Kind, keyCode: UInt16? = nil, modifiers: InputModifiers = [], buttonIndex: Int? = nil) {
        self.kind = kind; self.keyCode = keyCode; self.modifiers = modifiers; self.buttonIndex = buttonIndex
    }
    public static let disabled = InputBinding(kind: .disabled)
    public static let fnGlobe = modifierChord(.function)
    public static let defaultIntent = fnGlobe
    public static func keyboard(keyCode: UInt16, modifiers: InputModifiers = []) -> Self { .init(kind: .keyboard, keyCode: keyCode, modifiers: modifiers) }
    public static func modifierChord(_ modifiers: InputModifiers) -> Self { .init(kind: .modifiers, modifiers: modifiers) }
    public static func mouseButton(index: Int, modifiers: InputModifiers = []) -> Self { .init(kind: .mouseButton, modifiers: modifiers, buttonIndex: index) }
    public func label(language: AppLanguage) -> String {
        let prefix = (modifiers.contains(.control) ? "⌃" : "") + (modifiers.contains(.option) ? "⌥" : "") + (modifiers.contains(.shift) ? "⇧" : "") + (modifiers.contains(.command) ? "⌘" : "") + (modifiers.contains(.function) ? "Fn " : "")
        switch kind {
        case .disabled: return language == .zh ? "未设置" : "Not set"
        case .modifiers: return modifiers == .function ? "Fn" : prefix.trimmingCharacters(in: .whitespaces)
        case .mouseButton: return prefix + (language == .zh ? "鼠标侧键 \((buttonIndex ?? 3) - 2)" : "Mouse side button \((buttonIndex ?? 3) - 2)")
        case .keyboard: return prefix + Self.keyLabel(keyCode ?? 0)
        }
    }
    public static let functionKeyCodes: Set<UInt16> = [122,120,99,118,96,97,98,100,101,109,103,111,105,107,113,106,64,79,80,90]
    public static func keyLabel(_ code: UInt16) -> String {
        let functions: [UInt16] = [122,120,99,118,96,97,98,100,101,109,103,111,105,107,113,106,64,79,80,90]
        if let index = functions.firstIndex(of: code) { return "F\(index + 1)" }
        let names: [UInt16: String] = [0:"A",11:"B",18:"1",19:"2",20:"3",21:"4",22:"6",23:"5",24:"=",25:"9",26:"7",27:"−",28:"8",29:"0",30:"]",33:"[",36:"Return",39:"'",41:";",42:"\\",43:",",44:"/",47:".",48:"Tab",50:"`",51:"Delete",76:"Enter",115:"Home",116:"Page Up",117:"Forward Delete",119:"End",121:"Page Down",123:"←",124:"→",125:"↓",126:"↑"]
        return names[code] ?? "Key \(code)"
    }
    public func matchesModifiers(_ value: InputModifiers) -> Bool {
        let actual = kind == .keyboard && keyCode.map(Self.functionKeyCodes.contains) == true && !modifiers.contains(.function) ? value.subtracting(.function) : value
        return actual == modifiers
    }
    /// Explain only the consequence of the selected binding; no settings change
    /// is performed by this module, and a vendor-private Fn key may never reach macOS.
    public func activationNotice(language: AppLanguage) -> String {
        if kind == .mouseButton {
            return language == .zh ? "按住此侧键并移动鼠标框选，松开完成。" : "Hold this side button and move to select a region. Release to finish."
        }
        if modifiers.contains(.function) {
            return language == .zh ? "使用 macOS 上报的 Fn / 地球键。系统原有的表情、输入法或听写动作可能仍会响应；此模块不会更改系统设置。厂商私有 Fn 键不一定可读取。" : "Uses the Fn / Globe key reported by macOS. System emoji, input-source or Dictation actions may still respond; this module does not change system settings. Vendor-private Fn keys may not be available."
        }
        if kind == .modifiers {
            return language == .zh ? "按住所选修饰键进入选择，松开完成。修饰键仍传给系统；再按普通键或加入其他修饰键会取消本次选择。" : "Hold these modifiers to select and release to finish. Modifier events still reach macOS; another key or an extra modifier cancels selection."
        }
        if kind == .keyboard, modifiers.isEmpty {
            return language == .zh ? "启用时，宿主接管此单键，不能同时用于普通打字；其他按键正常输入。可随时暂停或更换触发键。" : "While enabled, the host takes over this single key, so it cannot also type normally. Other keys remain available. Pause or change the binding at any time."
        }
        return language == .zh ? "启用时，宿主接管这一完整按键组合或鼠标侧键；其他输入正常传递。" : "While enabled, the host takes over this exact key combination or mouse side button. Other input passes through."
    }
}

public enum BoundInput: Equatable, Hashable, Sendable { case key(UInt16), mouse(Int) }
public enum BoundInputEdge { case down, dragged, up }
public enum BindingDecision: Equatable { case pass, consume, begin, release, cancel }

/// Physical ownership outlives logical cancellation and configuration changes.
public struct InputBindingPairState {
    public private(set) var owner: BoundInput?
    private var ownerModifiers: InputModifiers = []
    private var ignoresImplicitFunction = false
    public private(set) var logicalActive = false
    private var releasedAt: TimeInterval?
    public init() {}
    public mutating func handle(input: BoundInput, edge: BoundInputEdge, isRepeat: Bool = false, modifiers: InputModifiers, binding: InputBinding, allowed: Bool) -> BindingDecision {
        // A nonrepeat physical down after cancellation proves a missed up.
        // It must be reconsidered under today's binding and modifiers.
        if owner == input, edge == .down, !isRepeat, !logicalActive { resetAfterFailure() }
        if owner == input {
            if edge == .up { let release = logicalActive; owner = nil; logicalActive = false; return release ? .release : .consume }
            return .consume
        }
        guard owner == nil, edge == .down, !isRepeat, allowed, binding.matchesModifiers(modifiers) else { return .pass }
        let matches: Bool
        switch input { case .key(let code): matches = binding.kind == .keyboard && binding.keyCode == code; case .mouse(let index): matches = binding.kind == .mouseButton && binding.buttonIndex == index }
        guard matches else { return .pass }
        owner = input; ownerModifiers = binding.modifiers
        ignoresImplicitFunction = binding.kind == .keyboard && binding.keyCode.map(InputBinding.functionKeyCodes.contains) == true && !binding.modifiers.contains(.function)
        logicalActive = true
        return .begin
    }
    /// Extra modifiers cancel. Releasing a required modifier commits, while the
    /// physical main-key/button up remains owned and drained afterwards.
    public mutating func modifiersChanged(_ modifiers: InputModifiers) -> BindingDecision {
        guard owner != nil, logicalActive else { return .pass }
        let actual = ignoresImplicitFunction ? modifiers.subtracting(.function) : modifiers
        let expected = ownerModifiers
        if !actual.subtracting(expected).isEmpty { logicalActive = false; return .cancel }
        if !expected.subtracting(actual).isEmpty { logicalActive = false; return .release }
        return .pass
    }
    public mutating func cancelKeepingOwnership() { logicalActive = false }
    public mutating func resetAfterFailure() { owner = nil; logicalActive = false; releasedAt = nil }
    /// Called while draining, including during stop. No held input is timed out.
    @discardableResult public mutating func observePhysicalState(isPressed: Bool, at time: TimeInterval) -> Bool {
        guard owner != nil, !logicalActive else { releasedAt = nil; return false }
        if isPressed { releasedAt = nil; return false }
        if let releasedAt, time - releasedAt >= 0.3 { resetAfterFailure(); return true }
        if releasedAt == nil { releasedAt = time }
        return false
    }
}

public struct ModifierBindingState {
    private var active = false
    public var isActive: Bool { active }
    private var armed = true
    public init() {}
    public mutating func update(_ value: InputModifiers, required: InputModifiers, allowed: Bool) -> BindingDecision {
        guard !required.isEmpty else { return .pass }
        if !allowed, !value.intersection(required).isEmpty { armed = false }
        if active, value != required || !allowed {
            active = false
            if value.intersection(required).isEmpty { armed = true }
            return !value.subtracting(required).isEmpty || !allowed ? .cancel : .release
        }
        if value.intersection(required).isEmpty { armed = true }
        guard allowed, armed, !active, value == required else { return .pass }
        active = true; armed = false; return .begin
    }
    /// Modifier-only activation must not steal a longer shortcut or ordinary
    /// typing. Cancellation remains disarmed until all required modifiers lift.
    public mutating func cancelForOtherInput() -> BindingDecision {
        let wasActive = active
        if wasActive { interrupt() }
        return wasActive ? .cancel : .pass
    }
    public mutating func interrupt() { active = false; armed = false }
    /// Normal completion must preserve a release that was already observed.
    /// If still held, armed is already false and stays false until the real up.
    public mutating func finishLogicalHold() { active = false }
}

/// Logical delivery is separate from the lifetime of a tap draining physical ups.
public struct InputDeliveryGate {
    public private(set) var generation: UInt64 = 0
    public private(set) var isAccepting = false
    public init() {}
    @discardableResult public mutating func begin() -> UInt64 { generation &+= 1; isAccepting = true; return generation }
    public mutating func invalidate() { generation &+= 1; isAccepting = false }
    public func accepts(_ generation: UInt64) -> Bool { isAccepting && self.generation == generation }
}
