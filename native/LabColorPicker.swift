import AppKit

/// AppKit performs the sampling. Only the selected color reaches the application.
@MainActor final class LabColorPicker {
    typealias Reply = (Any?, String?) -> Void
    typealias Sample = (@escaping (NSColor?) -> Void) -> Void

    // R31 stored an ordered list. Keep its file format readable by both revisions.
    private struct StoredPreferences: Codable {
        let enabled: Bool
        let shortcuts: [VoiceShortcutValue]
    }

    private let file: URL
    private let monitor: VoiceHotkey
    private let sample: Sample
    private let copyHex: (String) -> Bool
    private var enabled = false
    private var shortcut: VoiceShortcutValue?
    private var membership: Bool?
    private var disablePending = false
    private var readError: String?
    private var migrationError: String?
    private var registrationError: String?
    private var copyError: String?
    private var recordingReply: Reply?
    private var sampleID: UUID?
    private var discardSample = false
    private(set) var reservedShortcut: VoiceShortcutValue?
    var english = false
    var busy: Bool { recordingReply != nil || sampleID != nil }
    var canStart: () -> Bool = { false }
    var canRecord: () -> Bool = { false }
    var conflict: (VoiceShortcutValue) -> String? = { _ in nil }
    var activityChanged: () -> Void = {}
    var stateChanged: () -> Void = {}
    var showNotice: (NSColor, String) -> Void = { _,_ in }
    var hideNotice: () -> Void = {}

    init(directory: URL, monitor: VoiceHotkey, sample: @escaping Sample, copyHex: @escaping (String) -> Bool) {
        file = directory.appendingPathComponent("color-picker.json")
        self.monitor = monitor
        self.sample = sample
        self.copyHex = copyHex
        if FileManager.default.fileExists(atPath: file.path) {
            do {
                let stored = try JSONDecoder().decode(StoredPreferences.self, from: Data(contentsOf: file))
                guard stored.shortcuts.allSatisfy(Self.valid) else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                enabled = stored.enabled
                shortcut = stored.shortcuts.last
                if stored.shortcuts.count > 1 {
                    do { try save(enabled: enabled, shortcut: shortcut) }
                    catch { migrationError = error.localizedDescription }
                }
            } catch { readError = error.localizedDescription }
        }
        monitor.canHandle = { [weak self] in
            guard let self else { return false }
            return membership == true && enabled && !busy && canStart()
        }
        monitor.onRecordingCancelled = { [weak self] in self?.finishRecording() }
    }

    convenience init(directory: URL) {
        self.init(directory: directory, monitor: VoiceHotkey(), sample: { LabColorPicker.sampleScreen($0) },
                  copyHex: { LabColorPicker.copy($0, to: .general) })
    }

    static func copy(_ hex: String, to pasteboard: NSPasteboard) -> Bool {
        pasteboard.clearContents()
        return pasteboard.setString(hex, forType: .string)
    }

    static func sampleScreen(_ completion: @escaping (NSColor?) -> Void) {
        NSColorSampler().show { color in completion(color) }
    }

    private static func valid(_ shortcut: VoiceShortcutValue) -> Bool {
        (shortcut.mouseButton == nil || shortcut.keyCode == 0) &&
        VoiceHotkeyPolicy.valid(keyCode: shortcut.keyCode, modifiers: shortcut.modifiers, mouseButton: shortcut.mouseButton)
    }

    static func hex(_ color: NSColor) -> String? {
        guard let rgb = color.usingColorSpace(.sRGB) else { return nil }
        let channels = [rgb.redComponent, rgb.greenComponent, rgb.blueComponent]
        guard channels.allSatisfy({ $0.isFinite }) else { return nil }
        return "#" + channels.map { String(format: "%02X", Int((min(1, max(0, $0)) * 255).rounded())) }.joined()
    }

    private func t(_ zh: String, _ en: String) -> String { english ? en : zh }
    private func save(enabled: Bool, shortcut: VoiceShortcutValue?) throws {
        let stored = StoredPreferences(enabled: enabled, shortcuts: shortcut.map { [$0] } ?? [])
        try JSONEncoder().encode(stored).write(to: file, options: .atomic)
        self.enabled = enabled
        self.shortcut = shortcut
        migrationError = nil
    }

    func setAdded(_ added: Bool) {
        guard membership != added || disablePending else { return }
        let wasAdded = membership == true
        membership = added
        if !added {
            if wasAdded { interrupt() }
            if enabled || disablePending {
                do { try save(enabled: false, shortcut: shortcut); disablePending = false }
                catch { disablePending = true }
            }
        }
        refresh()
    }

    func refresh() {
        guard recordingReply == nil else { return }
        let previous = registrationError
        defer { if previous != registrationError { stateChanged() } }
        reservedShortcut = nil
        registrationError = nil
        guard membership == true, enabled, !disablePending, readError == nil, let shortcut else {
            monitor.suspendHandling()
            return
        }
        if let issue = conflict(shortcut) {
            registrationError = issue
            monitor.suspendHandling()
            return
        }
        reservedShortcut = shortcut
        do {
            try monitor.register(keyCode: shortcut.keyCode, modifiers: shortcut.modifiers, mouseButton: shortcut.mouseButton) {
                [weak self] in _ = self?.pick()
            }
            monitor.recoverIfNeeded()
        } catch {
            monitor.suspendHandling()
            registrationError = VoiceL10n.text(error.localizedDescription, english: english)
        }
    }

    @discardableResult func pick() -> Bool {
        guard membership == true, !busy, canStart() else { return false }
        hideNotice()
        copyError = nil
        let id = UUID()
        sampleID = id
        discardSample = false
        activityChanged()
        stateChanged()
        sample { [weak self] color in
            guard let self, sampleID == id else { return }
            let accept = !discardSample && membership == true
            sampleID = nil
            if accept, let color {
                if let hex = Self.hex(color), copyHex(hex) { showNotice(color, hex) }
                else { copyError = t("未能复制色号，请重新取色。", "Could not copy the color. Pick it again.") }
            }
            activityChanged()
            stateChanged()
        }
        return true
    }

    private func snapshot() -> [String: Any] {
        var result: [String: Any] = ["enabled":enabled && membership == true, "sampling":sampleID != nil]
        if let shortcut {
            let label = VoiceHotkey.label(keyCode:shortcut.keyCode, modifiers:shortcut.modifiers, mouseButton:shortcut.mouseButton)
            result["shortcutLabel"] = VoiceL10n.text(label, english:english)
        }
        result["issue"] = readError ?? copyError ?? registrationError ?? migrationError
        result["needsAccess"] = registrationError != nil && reservedShortcut != nil && !AXIsProcessTrusted()
        return result
    }

    func handle(_ body: [String: Any], reply: @escaping Reply) {
        guard membership == true, let op = body["op"] as? String else {
            reply(nil, t("请先在功能中心添加取色器。", "Add Color Picker in Feature Center first.")); return
        }
        if op == "state" { refresh(); reply(snapshot(), nil); return }
        if op == "cancelRecording" { monitor.cancelRecording(); reply(snapshot(), nil); return }
        guard !busy else { reply(nil, t("请先完成当前取色或按键录制。", "Finish picking a color or recording the shortcut first.")); return }
        if op == "pick" {
            if pick() { reply(snapshot(), nil) }
            else { reply(nil, t("请先结束当前操作，再开始取色。", "Finish the current operation before picking a color.")) }
            return
        }
        if let readError { reply(nil, readError); return }
        do {
            switch op {
            case "enable":
                guard let enabled = body["enabled"] as? Bool else { throw CocoaError(.validationMissingMandatoryProperty) }
                try save(enabled: enabled, shortcut: shortcut)
            case "remove":
                try save(enabled: enabled, shortcut: nil)
            case "record":
                guard canRecord(), canStart() else { reply(nil, t("请先回到 NuPhy Lab 的取色器页面。", "Bring the Color Picker page in NuPhy Lab to the front.")); return }
                recordingReply = reply
                activityChanged()
                monitor.beginRecording { [weak self] shortcut in self?.saveRecorded(shortcut) }
                return
            default:
                reply(nil, t("未知操作。", "Unknown action.")); return
            }
            refresh()
            reply(snapshot(), nil)
        } catch { reply(nil, error.localizedDescription) }
    }

    private func saveRecorded(_ shortcut: VoiceShortcutValue) {
        guard recordingReply != nil, membership == true else { return }
        if let issue = conflict(shortcut) { finishRecording(issue); return }
        do { try save(enabled: enabled, shortcut: shortcut); finishRecording() }
        catch { finishRecording(error.localizedDescription) }
    }

    private func finishRecording(_ error: String? = nil) {
        guard let reply = recordingReply else { return }
        recordingReply = nil
        refresh()
        activityChanged()
        reply(error == nil ? snapshot() : nil, error)
    }

    func cancelRecording() { monitor.cancelRecording() }

    // AppKit owns its active sampler until the user clicks or presses Escape.
    // A result delivered after removal, sleep or shutdown must leave the clipboard alone.
    func interrupt() {
        discardSample = true
        cancelRecording()
        hideNotice()
    }

    func shutdown() { membership = false; interrupt(); monitor.unregister() }
}

