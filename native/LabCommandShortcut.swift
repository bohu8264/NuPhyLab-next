import AppKit

/// The command shortcut is independent of the dictation shortcut. Both use the
/// same physical-key recorder and exact modifier / repeat / key-up handling.
@MainActor final class LabCommandShortcut {
    nonisolated static let standard = VoiceShortcutValue(keyCode:49, modifiers:(1 << 17) | (1 << 18))
    private let preference: String
    private let defaults: UserDefaults
    let monitor: VoiceHotkey
    private(set) var value: VoiceShortcutValue?
    private var recordReply: LabVoiceControl.Reply?
    var isRecording: Bool { recordReply != nil }
    var conflict: (VoiceShortcutValue) -> String? = { _ in nil }
    var canTrigger: () -> Bool = { false }
    var pressed: () -> Void = {}
    var recordingChanged: (Bool) -> Void = { _ in }
    private(set) var issue: String?

    init(defaults: UserDefaults, monitor: VoiceHotkey, preference: String = "NuPhyLab.voiceControl.shortcut",
         defaultValue: VoiceShortcutValue? = LabCommandShortcut.standard) {
        self.preference = preference
        self.defaults = defaults
        self.monitor = monitor
        value = Self.savedValue(in:defaults, preference:preference, defaultValue:defaultValue)
        monitor.canHandle = { [weak self] in self?.canTrigger() == true }
        monitor.onRecordingCancelled = { [weak self] in self?.endRecording(cancelled:true) }
    }

    private static func savedValue(in defaults: UserDefaults, preference: String, defaultValue: VoiceShortcutValue?) -> VoiceShortcutValue? {
        guard let saved = defaults.dictionary(forKey:preference) else { return defaultValue }
        if saved["kind"] as? String == "none" { return nil }
        if let rawButton = saved["mouseButton"] {
            guard let button = rawButton as? UInt32, let mods = saved["modifiers"] as? UInt64,
                  VoiceHotkeyPolicy.valid(keyCode:0, modifiers:mods, mouseButton:button) else { return nil }
            return VoiceShortcutValue(keyCode:0, modifiers:mods, mouseButton:button)
        }
        guard let key = saved["keyCode"] as? UInt32, let mods = saved["modifiers"] as? UInt64,
              VoiceHotkeyPolicy.valid(keyCode:key, modifiers:mods) else { return defaultValue }
        return VoiceShortcutValue(keyCode:key, modifiers:mods)
    }

    func status(english: Bool) -> [String: Any] {
        let label = value.map { VoiceHotkey.label(keyCode:$0.keyCode, modifiers:$0.modifiers, mouseButton:$0.mouseButton) } ?? ""
        return ["shortcutLabel":VoiceL10n.text(label, english:english), "shortcutReady":value != nil && monitor.isReady,
                "shortcutIssue":VoiceL10n.text(issue ?? "", english:english)]
    }

    private func register(_ binding: VoiceShortcutValue) throws {
        try monitor.register(keyCode:binding.keyCode, modifiers:binding.modifiers, mouseButton:binding.mouseButton) { [weak self] in
            guard let self, !isRecording, canTrigger() else { return }
            pressed()
        }
    }

    func refresh(enabled: Bool) {
        guard !isRecording else { return }
        issue = nil
        guard enabled, let value else { monitor.suspendHandling(); return }
        if let reason = conflict(value) { issue=reason; monitor.suspendHandling(); return }
        do {
            try register(value)
            monitor.recoverIfNeeded()
        } catch {
            monitor.suspendHandling()
            issue = error.localizedDescription
        }
    }

    func record(enabled: Bool, english: Bool, reply: @escaping LabVoiceControl.Reply) {
        guard !isRecording else { reply(nil,english ? "Finish recording the shortcut first." : "请先完成当前快捷键录制。"); return }
        recordReply = reply
        recordingChanged(true)
        monitor.beginRecording { [weak self] binding in
            guard let self, let callback = recordReply else { return }
            recordReply = nil
            do {
                try save(binding,enabled:enabled)
                recordingChanged(false)
                callback(status(english:english),nil)
            } catch {
                refresh(enabled:enabled)
                recordingChanged(false)
                let message = error.localizedDescription
                callback(nil,english ? VoiceL10n.messages[message] ?? message : message)
            }
        }
    }

    func save(_ binding:VoiceShortcutValue,enabled:Bool) throws {
        guard VoiceHotkeyPolicy.valid(keyCode:binding.keyCode,modifiers:binding.modifiers,mouseButton:binding.mouseButton) else {
            throw VoiceHotkeyError.invalid
        }
        if let reason=conflict(binding) { throw shortcutError(reason) }
        if enabled {
            // Local recording also works before Accessibility is granted.
            // Remember the preference so a later grant can activate it.
            do { try register(binding) } catch VoiceHotkeyError.accessibilityRequired {}
        }
        var saved = ["keyCode":Int(binding.keyCode),"modifiers":Int(binding.modifiers)]
        saved["mouseButton"] = binding.mouseButton.map { Int($0) }
        defaults.set(saved,forKey:preference)
        value=binding
        refresh(enabled:enabled)
    }

    func clear() {
        // A missing preference means first launch. An explicit empty choice survives restarting.
        defaults.set(["kind":"none"],forKey:preference)
        value = nil
        issue = nil
        monitor.suspendHandling()
    }

    private func endRecording(cancelled: Bool) {
        guard let reply = recordReply else { return }
        recordReply = nil
        recordingChanged(false)
        reply(["cancelled":cancelled],nil)
    }

    func cancelRecording() { monitor.cancelRecording() }
    func shutdown() {
        cancelRecording()
        monitor.unregister()
    }

    private func shortcutError(_ message:String) -> NSError {
        NSError(domain:"NuPhyLab.CommandShortcut",code:1,userInfo:[NSLocalizedDescriptionKey:message])
    }
}
