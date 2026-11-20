import AppKit

@main
struct ColorPickerChecks {
    struct Failure: Error { let check: String }
    struct SavedSettings: Codable {
        let enabled: Bool
        let shortcuts: [VoiceShortcutValue]
    }

    @MainActor static func main() {
        let app = NSApplication.shared
        let previous = NSWorkspace.shared.frontmostApplication
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            do {
                try await test(app)
                if app.isActive { previous?.activate(options: []) }
                app.terminate(nil)
            } catch {
                if app.isActive { previous?.activate(options: []) }
                FileHandle.standardError.write(Data("Color Picker check failed: \(error)\n".utf8))
                exit(1)
            }
        }
        app.run()
    }

    @MainActor static func test(_ app: NSApplication) async throws {
        var count = 0
        func check(_ condition: @autoclosure () -> Bool, _ label: String) throws {
            guard condition() else { throw Failure(check: label) }
            count += 1
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let window = NSWindow(contentRect: NSRect(x: 80, y: 100, width: 260, height: 70),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "NuPhy Lab · Color Picker shortcut test"
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        defer { window.orderOut(nil) }
        for _ in 0..<80 {
            if app.isActive && NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        try check(app.isActive, "fixture must be foreground for the local recorder")
        let monitor = VoiceHotkey(listenToSystemEvents: false)
        var complete: ((NSColor?) -> Void)?
        var starts = 0, published: [String] = [], writable = true
        let picker = LabColorPicker(directory: directory, monitor: monitor, sample: { starts += 1; complete = $0 },
                                    copyHex: { writable && LabColorPicker.copy($0, to: board) })
        picker.english = true
        picker.canStart = { true }
        picker.canRecord = { app.isActive }
        picker.showNotice = { _, hex in published.append(hex) }
        defer { picker.shutdown() }
        typealias Snapshot = [String: Any]
        func request(_ op: String, _ fields: Snapshot = [:]) throws -> Snapshot {
            var result: Snapshot?, error: String?
            picker.handle(fields.merging(["op": op]) { _, value in value }) { result = $0 as? Snapshot; error = $1 }
            guard let result, error == nil else { throw Failure(check: "\(op): \(error ?? "no result")") }
            return result
        }
        func post(_ binding: VoiceShortcutValue, down: Bool) {
            let raw: CGEvent
            if let button = binding.mouseButton {
                raw = CGEvent(mouseEventSource: nil, mouseType: down ? .otherMouseDown : .otherMouseUp,
                              mouseCursorPosition: .zero, mouseButton: .center)!
                raw.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button))
            } else {
                raw = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(binding.keyCode), keyDown: down)!
            }
            raw.flags = CGEventFlags(rawValue: binding.modifiers)
            app.sendEvent(NSEvent(cgEvent: raw)!)
        }
        func record(_ binding: VoiceShortcutValue) async throws -> String? {
            var replied = false, error: String?
            picker.handle(["op": "record"]) { _, message in replied = true; error = message }
            try check(picker.busy && !replied, "recorder opens")
            post(binding, down: true)
            post(binding, down: false)
            for _ in 0..<30 {
                if replied { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            try check(replied && !picker.busy, "recorder finished for \(binding), foreground \(app.isActive)")
            return error
        }
        let q = VoiceShortcutValue(keyCode: 12, modifiers: 0)
        let chord = VoiceShortcutValue(keyCode: 40, modifiers: UInt64(NSEvent.ModifierFlags.option.rawValue))
        let side = VoiceShortcutValue(keyCode: 0, modifiers: 0, mouseButton: 4)
        let third = VoiceShortcutValue(keyCode: 0, modifiers: 0, mouseButton: 5)
        let red = NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)
        let blue = NSColor(srgbRed: 0.2, green: 0.4, blue: 0.6, alpha: 1)
        try check(LabColorPicker.hex(.black) == "#000000" && LabColorPicker.hex(.white) == "#FFFFFF", "black and white")
        try check(LabColorPicker.hex(blue) == "#336699", "upper-case sRGB")
        try check(LabColorPicker.hex(NSColor(srgbRed: 0.5, green: 0.5, blue: 0.5, alpha: 1)) == "#808080", "round each component")
        try check(LabColorPicker.hex(NSColor(displayP3Red: 1, green: 0, blue: 0, alpha: 1)) == "#FF0000", "convert P3 to clipped sRGB")
        try check(!picker.pick(), "cannot run when hidden")
        picker.setAdded(true)
        let initial = try request("state")
        try check(initial["enabled"] as? Bool == false && initial["shortcutLabel"] == nil, "starts without a global shortcut")
        let _ = try request("pick")
        try check(picker.busy && !picker.pick(), "one system sampler at a time")
        complete?(blue)
        try check(board.string(forType: .string) == "#336699" && published == ["#336699"], "manual selection and notice")
        let unchanged = board.changeCount
        try check(picker.pick(), "second manual sample")
        complete?(nil)
        try check(board.changeCount == unchanged && published.count == 1, "Escape does not touch any pasteboard type")
        writable = false
        let _ = try request("pick")
        complete?(red)
        let failed = try request("state")
        try check(failed["issue"] is String && published.count == 1, "failed copy is never announced as success")
        writable = true
        let _ = try request("enable", ["enabled": true])
        let settingsFile = directory.appendingPathComponent("color-picker.json")
        func event(_ kind: VoiceHotkeyEventKind, _ code: UInt32, _ flags: UInt64 = 0, repeatKey: Bool = false) -> VoiceHotkeyDecision {
            monitor.observeRuntime(.init(kind: kind, keyCode: code, flags: flags, isRepeat: repeatKey))
        }
        for binding in [q, chord, side] {
            let error = try await record(binding)
            try check(error == nil && picker.reservedShortcut == binding, "record and exclusively reserve the new binding")
            let saved = try JSONDecoder().decode(SavedSettings.self, from: Data(contentsOf: settingsFile))
            try check(saved.enabled && saved.shortcuts == [binding], "persist exactly one binding")
            if binding != q {
                try check(!event(.down, q.keyCode).consume && !event(.up, q.keyCode).consume, "old single key is released")
            }
            if binding == side {
                try check(!event(.down, chord.keyCode, chord.modifiers).consume && !event(.up, chord.keyCode, chord.modifiers).consume, "old chord is released")
            }
            let before = starts
            if let mouse = binding.mouseButton {
                try check(event(.mouseDown, mouse).consume && event(.mouseUp, mouse).fire, "side click triggers on release")
            } else {
                try check(event(.down, binding.keyCode, binding.modifiers).fire, "current keyboard shortcut fires")
                try check(!event(.down, binding.keyCode, binding.modifiers, repeatKey: true).fire, "auto-repeat ignored")
                try check(event(.up, binding.keyCode, binding.modifiers).consume, "matching release consumed")
            }
            try await Task.sleep(for: .milliseconds(30))
            try check(starts == before + 1 && picker.busy, "exactly one sampler")
            complete?(red)
            try check(board.string(forType: .string) == "#FF0000", "keyboard/mouse result copied")
        }
        try check(!event(.down, chord.keyCode).consume && !event(.up, chord.keyCode).consume, "wrong modifiers pass through")
        try check(!event(.mouseDown, 3).consume && !event(.mouseUp, 3).consume, "other side button passes through")
        let state = try request("state")
        try check(state["shortcutLabel"] as? String == "Mouse side button 2", "localized label")
        let same = try await record(side)
        try check(same == nil && picker.reservedShortcut == side, "recording the same shortcut is idempotent")
        picker.conflict = { $0 == third ? "Reserved for another feature" : nil }
        let conflict = try await record(third)
        try check(conflict == "Reserved for another feature" && picker.reservedShortcut == side, "conflict preserves previous shortcut")
        var cancelled = false
        picker.handle(["op": "record"]) { _, error in cancelled = error == nil }
        let _ = try request("cancelRecording")
        try check(cancelled && !picker.busy && picker.reservedShortcut == side, "cancel leaves saved shortcut intact")
        let previousMouseDown = event(.mouseDown, 4)
        let cleared = try request("remove")
        let previousMouseUp = event(.mouseUp, 4)
        try check(previousMouseDown.consume && previousMouseUp.consume && !previousMouseUp.fire, "clearing a held side button drains its release")
        try check(cleared["shortcutLabel"] == nil && picker.reservedShortcut == nil && !event(.mouseDown, 4).consume, "cleared shortcut releases subsequent clicks")
        let empty = try JSONDecoder().decode(SavedSettings.self, from: Data(contentsOf: settingsFile))
        try check(empty.shortcuts.isEmpty, "explicitly empty shortcut is durable")
        picker.conflict = { _ in nil }
        let replacement = try await record(third)
        try check(replacement == nil && picker.reservedShortcut == third, "can reassign after clearing")
        let prior = board.changeCount
        let _ = try request("pick")
        picker.setAdded(false)
        complete?(blue)
        try check(board.changeCount == prior && !event(.mouseDown, 5).consume, "removal invalidates pending sample and shortcuts")
        let fresh = LabColorPicker(directory: directory, monitor: VoiceHotkey(listenToSystemEvents: false), sample: { _ in }, copyHex: { _ in false })
        fresh.setAdded(true)
        var reloaded: Snapshot?
        fresh.handle(["op": "state"]) { reloaded = $0 as? Snapshot; _ = $1 }
        try check(reloaded?["enabled"] as? Bool == false && reloaded?["shortcutLabel"] is String && fresh.reservedShortcut == nil, "durable off and preserved binding after relaunch/re-add")
        fresh.shutdown()
        for on in [false, true] {
            for old in [[], [q], [q, chord, side]] as [[VoiceShortcutValue]] {
                let data = try JSONEncoder().encode(SavedSettings(enabled: on, shortcuts: old))
                try data.write(to: settingsFile, options: .atomic)
                let migratedMonitor = VoiceHotkey(listenToSystemEvents: false)
                let migrated = LabColorPicker(directory: directory, monitor: migratedMonitor, sample: { _ in }, copyHex: { _ in false })
                migrated.canStart = { true }
                migrated.setAdded(true)
                let now = try JSONDecoder().decode(SavedSettings.self, from: Data(contentsOf: settingsFile))
                try check(now.enabled == on && now.shortcuts == Array(old.suffix(1)), "R31 migration retains the last shortcut and original switch")
                try check(migrated.reservedShortcut == (on ? old.last : nil), "only the migrated shortcut can be active")
                if old.count > 1 {
                    try check(!migratedMonitor.observeRuntime(.init(kind: .down, keyCode: q.keyCode)).consume, "migrated-away key passes through")
                }
                migrated.shutdown()
            }
        }
        print("Color Picker: \(count) checks passed using a private pasteboard and local AppKit shortcut events")
    }
}
