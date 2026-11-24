import AppKit
import ApplicationServices
import Carbon

/// Called once, on the command shortcut, before the picker takes focus.
enum CommandSelection {
    static let maximumBytes = 100_000

    static func validate(_ text: String) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw SelectionCommandError.emptyText }
        guard text.utf8.count <= maximumBytes else { throw SelectionCommandError.tooLong }
    }

    struct Target {
        let pid: pid_t
        let window: AXUIElement?
        let editor: AXUIElement

        func matches(_ other: Target) -> Bool {
            guard pid == other.pid, CFEqual(editor, other.editor) else { return false }
            switch (window, other.window) {
            case (nil, nil): return true
            case let (lhs?, rhs?): return CFEqual(lhs, rhs)
            default: return false
            }
        }
    }

    static func isCurrent(_ pid: pid_t) -> Bool {
        !IsSecureEventInputEnabled() && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    }

    enum ShortcutSource {
        case focused(Target?)
        case userCopy
    }

    static func usesUserCopy(_ bundleID: String?) -> Bool {
        guard let id = bundleID?.lowercased() else { return false }
        return ["com.tencent.xinwechat", "com.tencent.wechat"].contains { id == $0 || id.hasPrefix($0 + ".") }
    }

    // Resolve the policy before constructing any accessibility reference to the source app.
    static func shortcutSource(bundleID: String?, focused: () -> Target?) -> ShortcutSource {
        if usesUserCopy(bundleID) { return .userCopy }
        return .focused(focused())
    }

    // Capture only focus references at the actual shortcut press. A busy application
    // falls back to manual paste. Text is read off the event-tap callback.
    static func capture(in pid: pid_t, budget: TimeInterval = 0.05) -> Target? {
        guard isCurrent(pid), AXIsProcessTrusted() else { return nil }
        let deadline = ProcessInfo.processInfo.systemUptime + budget
        func reference(_ object: AXUIElement, _ name: String) throws -> AXUIElement? {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { throw SelectionCommandError.unavailable }
            AXUIElementSetMessagingTimeout(object, Float(min(remaining, 0.04)))
            var value: CFTypeRef?
            switch AXUIElementCopyAttributeValue(object, name as CFString, &value) {
            case .success:
                guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { throw SelectionCommandError.unavailable }
                return (value as! AXUIElement)
            case .attributeUnsupported, .noValue: return nil
            default: throw SelectionCommandError.unavailable
            }
        }
        do {
            let app = AXUIElementCreateApplication(pid)
            let window = try reference(app, kAXFocusedWindowAttribute)
            guard var editor = try reference(app, kAXFocusedUIElementAttribute),
                  owner(editor) == pid else { return nil }
            for _ in 0..<4 {
                guard let child = try reference(editor, kAXFocusedUIElementAttribute), !CFEqual(child, editor) else { break }
                guard owner(child) == pid else { return nil }
                editor = child
            }
            guard ProcessInfo.processInfo.systemUptime <= deadline, isCurrent(pid) else { return nil }
            return Target(pid:pid, window:window, editor:editor)
        } catch { return nil }
    }

    static func read(_ target: Target) throws -> String? {
        guard let before = capture(in:target.pid, budget:0.18), target.matches(before) else { return nil }
        let focused = target.editor
        AXUIElementSetMessagingTimeout(focused, 0.18)
        var element: AXUIElement? = focused
        for _ in 0..<16 {
            guard let current = element else { break }
            guard !protected(current) else { return nil }
            element = child(current, kAXParentAttribute)
        }
        let value: String?
        if let text = attribute(focused, kAXSelectedTextAttribute) as? String, !text.isEmpty {
            value = text
        } else if let range = attribute(focused, kAXSelectedTextRangeAttribute), CFGetTypeID(range) == AXValueGetTypeID() {
            var span = CFRange()
            guard AXValueGetValue(range as! AXValue, .cfRange, &span), span.location >= 0, span.length > 0 else { return nil }
            guard span.length <= maximumBytes else { throw SelectionCommandError.tooLong }
            var text: CFTypeRef?
            guard AXUIElementCopyParameterizedAttributeValue(focused, kAXStringForRangeParameterizedAttribute as CFString, range, &text) == .success else { return nil }
            value = text as? String
        } else {
            return nil
        }
        guard let after = capture(in:target.pid, budget:0.18), target.matches(after),
              !protected(focused), isCurrent(target.pid), let value, !value.isEmpty else { return nil }
        try validate(value)
        return value
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
    private static func child(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let result = attribute(element, name), CFGetTypeID(result) == AXUIElementGetTypeID() else { return nil }
        return (result as! AXUIElement)
    }
    private static func owner(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }
    private static func protected(_ element: AXUIElement) -> Bool {
        VoiceInsertionPolicy.sensitive(role: attribute(element,kAXRoleAttribute) as? String,
            subrole: attribute(element,kAXSubroleAttribute) as? String, protected: attribute(element,"AXProtectedContent") as? Bool == true)
    }
}
