import AppKit

/// The command shortcut is independent of the dictation shortcut. Both use the
/// same physical-key recorder and exact modifier / repeat / key-up handling.
@MainActor final class LabCommandShortcut {
    static let standard = VoiceShortcutValue(keyCode:49, modifiers:(1 << 17) | (1 << 18))
    private static let preference = "NuPhyLab.voiceControl.shortcut"
    private let defaults: UserDefaults
    let monitor: VoiceHotkey
    private(set) var value: VoiceShortcutValue
    private var recordReply: LabVoiceControl.Reply?
    var isRecording: Bool { recordReply != nil }
    var conflict: (VoiceShortcutValue) -> String? = { _ in nil }
    var canTrigger: () -> Bool = { false }
    var pressed: () -> Void = {}
    var recordingChanged: (Bool) -> Void = { _ in }
    private(set) var issue: String?

    init(defaults: UserDefaults, monitor: VoiceHotkey) {
        self.defaults = defaults
        self.monitor = monitor
        let saved = defaults.dictionary(forKey: Self.preference)
        if let key = saved?["keyCode"] as? UInt32, let mods = saved?["modifiers"] as? UInt64,
           VoiceHotkeyPolicy.valid(keyCode:key, modifiers:mods) {
            value = VoiceShortcutValue(keyCode:key, modifiers:mods)
        } else {
            value = Self.standard
        }
        monitor.canHandle = { [weak self] in self?.canTrigger() == true }
        monitor.onRecordingCancelled = { [weak self] in self?.endRecording(cancelled:true) }
    }

    func status(english: Bool) -> [String: Any] {
        var label = VoiceHotkey.label(keyCode:value.keyCode, modifiers:value.modifiers)
        if english { label = label.replacingOccurrences(of:"右 ",with:"Right ").replacingOccurrences(of:"左 ",with:"Left ") }
        let problem = issue ?? ""
        return ["shortcutLabel":label, "shortcutReady":monitor.isReady, "shortcutIssue":english ? VoiceL10n.messages[problem] ?? problem : problem]
    }

    private func register(_ binding: VoiceShortcutValue) throws {
        try monitor.register(keyCode:binding.keyCode, modifiers:binding.modifiers) { [weak self] in
            guard let self, !isRecording, canTrigger() else { return }
            pressed()
        }
    }

    func refresh(enabled: Bool) {
        guard !isRecording else { return }
        issue = nil
        guard enabled else { monitor.suspendHandling(); return }
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
                try save(binding,enabled:enabled,english:english)
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

    func save(_ binding:VoiceShortcutValue,enabled:Bool,english:Bool) throws {
        guard binding.mouseButton == nil, VoiceHotkeyPolicy.valid(keyCode:binding.keyCode,modifiers:binding.modifiers) else {
            throw shortcutError(english ? "Press a keyboard key or chord." : "请按键盘上的单键或组合键。")
        }
        if let reason=conflict(binding) { throw shortcutError(reason) }
        if enabled {
            // Local recording also works before Accessibility is granted.
            // Remember the preference so a later grant can activate it.
            do { try register(binding) } catch VoiceHotkeyError.accessibilityRequired {}
        }
        defaults.set(["keyCode":Int(binding.keyCode),"modifiers":Int(binding.modifiers)],forKey:Self.preference)
        value=binding
        refresh(enabled:enabled)
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
