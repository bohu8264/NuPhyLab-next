import AppKit
import Carbon

private let shortcutSignature: OSType = 0x4E504453 // NPDS

enum DockShortcutError: LocalizedError {
    case invalid
    case unsupportedModifier
    case reservedBySystem
    case registration(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalid:
            return "试试 ⌘ 加数字，或 Control 加字母。"
        case .unsupportedModifier:
            return "这组快捷键不支持 Fn，请换一组。"
        case .reservedBySystem:
            return "这组按键已被 macOS 使用，请换一组。"
        case .registration(let status) where status == eventHotKeyExistsErr:
            return "这组快捷键已被其他应用使用，请换一组。"
        case .registration:
            return "快捷键无法启用，请换一组。"
        }
    }
}

extension DockShortcut {
    private static let modifierPairs: [(NSEvent.ModifierFlags, UInt32, String)] = [
        (.control, UInt32(controlKey), "⌃"),
        (.option, UInt32(optionKey), "⌥"),
        (.shift, UInt32(shiftKey), "⇧"),
        (.command, UInt32(cmdKey), "⌘"),
    ]

    private static let numberKeys = [
        kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4, kVK_ANSI_5,
        kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9, kVK_ANSI_0
    ]

    init(keyCode: UInt32, flags: NSEvent.ModifierFlags) throws {
        // AppKit also sets the Function flag on arrows without a physical Fn key.
        let arrows = [kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow]
        if flags.contains(.function), !arrows.contains(Int(keyCode)) {
            throw DockShortcutError.unsupportedModifier
        }
        let selected = Self.modifierPairs.filter { flags.contains($0.0) }
        let carbon = selected.reduce(0) { $0 | $1.1 }
        self.init(keyCode: keyCode, modifiers: carbon)
        try validate()
    }

    func validate() throws {
        let knownMask = Self.modifierPairs.reduce(UInt32(0)) { $0 | $1.1 }
        let primaryMask = UInt32(controlKey | cmdKey)
        let isCommandNumber = modifiers == UInt32(cmdKey) && Self.numberKeys.contains(Int(keyCode))
        guard keyCode < 128, Self.keyName(keyCode) != nil,
              modifiers & ~knownMask == 0, modifiers & primaryMask != 0,
              modifiers & UInt32(controlKey) != 0 || modifiers.nonzeroBitCount >= 2 || isCommandNumber else {
            throw DockShortcutError.invalid
        }
    }

    var label: String {
        Self.modifierPairs.filter { modifiers & $0.1 != 0 }.map { $0.2 }.joined()
            + (Self.keyName(keyCode) ?? "键 \(keyCode)")
    }

    func checkSystemReservation() throws {
        let domain = CFPreferencesCopyAppValue("AppleSymbolicHotKeys" as CFString,
                                              "com.apple.symbolichotkeys" as CFString)
        let hotKeys = domain as? [String: [String: Any]] ?? [:]
        let flags = Self.modifierPairs.reduce(UInt32(0)) {
            $0 | (modifiers & $1.1 == 0 ? 0 : UInt32($1.0.rawValue))
        }
        for hotKey in hotKeys.values {
            guard hotKey["enabled"] as? Bool == true,
                  let value = hotKey["value"] as? [String: Any],
                  let params = value["parameters"] as? [Int],
                  params.count >= 3, params[1] == Int(keyCode) else { continue }
            let keyFlags = UInt32(truncatingIfNeeded: params[2]) & 0x001E0000
            if keyFlags == flags { throw DockShortcutError.reservedBySystem }
        }
        if keyCode == UInt32(kVK_Space) &&
            [UInt32(cmdKey | optionKey), UInt32(cmdKey | controlKey)].contains(modifiers) {
            throw DockShortcutError.reservedBySystem
        }
    }

    private static func keyName(_ key: UInt32) -> String? {
        switch Int(key) {
        case kVK_Space: return "空格"
        case kVK_Return: return "↩"
        case kVK_Tab, kVK_Escape, kVK_Delete, kVK_ForwardDelete,
             kVK_CapsLock, kVK_Function, kVK_Shift, kVK_RightShift,
             kVK_Command, kVK_RightCommand, kVK_Option, kVK_RightOption,
             kVK_Control, kVK_RightControl, kVK_VolumeUp, kVK_VolumeDown, kVK_Mute:
            return nil
        case kVK_LeftArrow: return "←"
        case kVK_RightArrow: return "→"
        case kVK_UpArrow: return "↑"
        case kVK_DownArrow: return "↓"
        default: break
        }
        guard let input = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() else { return nil }
        guard let data = TISGetInputSourceProperty(input, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let layoutData = Unmanaged<CFData>.fromOpaque(data).takeUnretainedValue()
        guard let bytes = CFDataGetBytePtr(layoutData) else { return nil }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        var deadKey: UInt32 = 0
        var count = 0
        var characters = [UniChar](repeating: 0, count: 4)
        let status = UCKeyTranslate(layout, UInt16(key), UInt16(kUCKeyActionDisplay), 0,
                                    UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask),
                                    &deadKey, characters.count, &count, &characters)
        guard status == noErr, count > 0 else { return nil }
        let name = String(decoding: characters.prefix(count), as: UTF16.self).uppercased()
        guard !name.unicodeScalars.contains(where: {
            CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) ||
                (0xE000...0xF8FF).contains($0.value)
        }) else { return nil }
        return name
    }
}

// Carbon registration and delivery are owned by the main AppKit event loop.
final class DockGlobalShortcut {
    private static var nextRegistrationID: UInt32 = 0
    private var handler: EventHandlerRef?
    private var reference: EventHotKeyRef?
    private var localMonitor: Any?
    private(set) var registrationID: UInt32?
    private(set) var binding: DockShortcut?
    private enum Source { case carbon, window }
    private var lastPress: (source: Source, time: TimeInterval)?
    private var lastRelease: TimeInterval?
    var onPress: ((UInt32) -> Void)?

    func register(_ shortcut: DockShortcut) throws {
        if binding == shortcut { return }
        try shortcut.validate()
        try shortcut.checkSystemReservation()
        if handler == nil {
            let types = [kEventHotKeyPressed, kEventHotKeyReleased].map {
                EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32($0))
            }
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
                guard let event, let context else { return OSStatus(eventNotHandledErr) }
                return Unmanaged<DockGlobalShortcut>.fromOpaque(context).takeUnretainedValue().handle(event)
            }, types.count, types, Unmanaged.passUnretained(self).toOpaque(), &handler)
            guard status == noErr else { throw DockShortcutError.registration(status) }
        }
        Self.nextRegistrationID &+= 1
        let id = Self.nextRegistrationID
        var newReference: EventHotKeyRef?
        let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers,
                                        EventHotKeyID(signature: shortcutSignature, id: id),
                                        GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &newReference)
        guard status == noErr, let newReference else { throw DockShortcutError.registration(status) }

        unregister()
        reference = newReference
        registrationID = id
        binding = shortcut

        // Some AppKit-targeted key events reach the window without a Carbon event.
        // Use the same active registration when our own app is in the foreground.
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            guard let self, NSApp.isActive, let id = self.registrationID, event.keyCode == shortcut.keyCode
            else { return event }
            if event.type == .keyUp {
                self.release(at: event.timestamp)
                return event
            }
            guard (try? DockShortcut(keyCode: UInt32(event.keyCode), flags: event.modifierFlags)) == shortcut
            else { return event }
            if !event.isARepeat { self.activate(id, source: .window, time: event.timestamp) }
            return nil
        }
    }

    private func handle(_ event: EventRef) -> OSStatus {
        var id = EventHotKeyID(signature: 0, id: 0)
        let status = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                                       EventParamType(typeEventHotKeyID), nil,
                                       MemoryLayout<EventHotKeyID>.size, nil, &id)
        guard status == noErr, id.signature == shortcutSignature, id.id == registrationID else {
            return OSStatus(eventNotHandledErr)
        }
        switch Int(GetEventKind(event)) {
        case kEventHotKeyPressed:
            // Carbon reports a new hotkey press separately from raw key repeats.
            // A lost release must not suppress the next press of this shortcut.
            activate(id.id, source: .carbon, time: GetEventTime(event))
        case kEventHotKeyReleased:
            release(at: GetEventTime(event))
        default:
            return OSStatus(eventNotHandledErr)
        }
        return noErr
    }

    private func activate(_ id: UInt32, source: Source, time: TimeInterval) {
        if let lastPress {
            // Replayed events can arrive after the matching release. Keep the
            // timestamp of the last accepted press across releases.
            guard time > lastPress.time else { return }
            if lastPress.source != source, time - lastPress.time < 0.03 {
                let releasedBetween = lastRelease.map { lastPress.time < $0 && $0 <= time } ?? false
                guard releasedBetween else { return }
            }
        }
        lastPress = (source, time)
        onPress?(id)
    }

    private func release(at time: TimeInterval) {
        lastRelease = max(lastRelease ?? time, time)
    }

    func unregister() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor); self.localMonitor = nil }
        if let reference { UnregisterEventHotKey(reference) }
        reference = nil
        registrationID = nil
        lastPress = nil
        lastRelease = nil
        binding = nil
    }

    deinit {
        unregister()
        if let handler { RemoveEventHandler(handler) }
    }
}
