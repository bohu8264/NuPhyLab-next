import AppKit
import Carbon
import Combine
import Foundation

// File-backed Dock that cannot accept another write until its replacement is ready.
private final class RestartingDockFixture: DockBackend, @unchecked Sendable {
    let file: FileFixtureDockBackend
    var afterRestart: (() throws -> Void)?
    var beforeNextReplace: (() throws -> Void)?
    var failNextRefresh = false
    var refreshAllowedAt: TimeInterval = 0
    private(set) var restarts = 0
    private var restarting = false

    init(url: URL) { file = FileFixtureDockBackend(url: url) }
    func readTiles() throws -> DockTiles { try file.readTiles() }
    func readLayout() throws -> DockLayout { try file.readLayout() }
    func writeTiles(_ tiles: DockTiles) throws { try file.writeTiles(tiles) }
    func replaceLayout(_ layout: DockLayout, ifCurrent expected: DockLayout) throws {
        guard !restarting else { throw CocoaError(.fileWriteUnknown) }
        let before = beforeNextReplace
        beforeNextReplace = nil
        try before?()
        try file.replaceLayout(layout, ifCurrent: expected)
    }
    func refresh() throws {
        if failNextRefresh {
            failNextRefresh = false
            Thread.sleep(forTimeInterval: 0.04)
            throw CocoaError(.fileWriteUnknown)
        }
        try file.refresh()
        restarts += 1
        restarting = true
    }
    func refreshDelay() throws -> TimeInterval {
        max(0, refreshAllowedAt - ProcessInfo.processInfo.systemUptime)
    }
    func waitUntilReady() throws {
        if restarting {
            Thread.sleep(forTimeInterval: 0.04)
            restarting = false
            try afterRestart?()
        }
    }
}

@main
struct DockControllerTests {
    @MainActor
    static func main() async throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dock-scenes-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = root.appendingPathComponent("fixture.plist")
        let originals = [try makeDockTile(for: systemApp("Calendar")), ["tile-type": "small-spacer-tile", "GUID": 43]]
        let other: [String: Any] = ["persistent-others": [["folder": "sample"]], "autohide": true, "orientation": "left"]
        var originalDomain = other
        originalDomain["persistent-apps"] = originals
        try plist(originalDomain).write(to: fixture)
        let backend = RestartingDockFixture(url: fixture)
        let catalog = DockAppCatalog(resolve: { id in
            switch id {
            case "com.apple.Preview": return systemApp("Preview")
            case "com.apple.Music": return systemApp("Music")
            default: return nil
            }
        })

        var count = 0
        func check(_ value: Bool, _ reason: String) {
            precondition(value, reason)
            count += 1
        }
        func same(_ tiles: DockTiles) throws -> Bool {
            dockTilesEqual(try backend.readTiles(), tiles)
        }
        func sameOther() throws -> Bool {
            var actual = try PropertyListSerialization.propertyList(from: Data(contentsOf: fixture),
                                                                     options: [], format: nil) as! [String: Any]
            actual.removeValue(forKey: "persistent-apps")
            return NSDictionary(dictionary: actual).isEqual(to: other)
        }
        func waitForSwitch(_ controller: DockScenesController) async throws {
            for _ in 0..<200 {
                if !controller.isApplying { return }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            fatalError("Switch work did not complete")
        }
        let directory = root.appendingPathComponent("settings")
        var controller: DockScenesController? = DockScenesController(directory: directory, backend: backend,
                                                                     catalog: catalog, coalescingInterval: 0)
        controller!.start()
        check(controller!.currentSceneID == "all", "Initial All")
        check(try same(originals), "Launch does not apply")
        let savedOriginal = try controller!.state!.originalTiles()
        let alias = root.appendingPathComponent("Calendar Alias.app")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: systemApp("Calendar"))
        let aliasApp = try DockApp(applicationURL: alias)
        check(aliasApp.url?.lastPathComponent == alias.lastPathComponent, "Stable symlink app can be added")
        let custom = controller!.createScene(name: "工作台")!
        controller!.applyScene(custom)
        check(controller!.noticeIsError && !controller!.isApplying, "Empty groups cannot apply")
        let design = try controller!.state!.scene("design")!.tiles()
        let entertainment = try controller!.state!.scene("entertainment")!.tiles()
        controller!.applyScene("design")
        try await waitForSwitch(controller!)
        check(controller!.currentSceneID == "design" && !controller!.noticeIsError, "Applied design")
        check(try same(design), "Design applied exact tiles")
        check(try sameOther(), "Right and other settings retained")
        var enriched = design
        enriched[0]["GUID"] = 444
        var data = enriched[0]["tile-data"] as! DockTile
        data["parent-mod-date"] = 42
        enriched[0]["tile-data"] = data
        try backend.writeTiles(enriched)
        controller!.applyScene("design")
        try await waitForSwitch(controller!)
        check(try same(enriched) && backend.restarts == 1, "Already-visible pins survive without another refresh")
        controller!.applyScene("entertainment")
        controller!.applyScene("design")
        controller!.applyScene("all")
        check(controller!.requestedSceneID == "all", "Latest intent visible during a refresh")
        try await waitForSwitch(controller!)
        check(try same(originals), "Latest of three requests wins during restart")
        check(controller!.currentSceneID == "all" && !controller!.noticeIsError, "Only confirmed result is presented")
        check(backend.restarts == 2, "All superseded requests in one turn are skipped before the first refresh")
        controller!.applyScene("entertainment")
        controller!.applyScene("all")
        controller!.applyScene("entertainment")
        try await waitForSwitch(controller!)
        check(try same(entertainment), "Repeat switch")
        check(backend.restarts == 3, "Returning to the in-flight target cancels queued work")
        check(try sameOther(), "Other settings still retained")

        let failure = root.appendingPathComponent("fail-refresh")
        try Data().write(to: failure)
        controller!.applyScene("design")
        try await waitForSwitch(controller!)
        check(controller!.noticeIsError, "Refresh failure surfaced")
        check(try same(entertainment), "Refresh failure restores pre-switch tiles")
        check(try sameOther(), "Rollback does not replace other keys")
        try FileManager.default.removeItem(at: failure)
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        check(controller!.currentSceneID == "all", "Restore identifies All")
        check(try same(originals), "Exact full restore")
        check(try dockTilesEqual(controller!.state!.originalTiles(), savedOriginal), "Original backup never changed")
        check(try sameOther(), "No unrelated-key changes")

        // Dock may report a different layout after it has relaunched. Never
        // mark a pre-restart write as confirmed or overwrite the outside edit.
        backend.afterRestart = { try backend.writeTiles(entertainment) }
        controller!.applyScene("design")
        try await waitForSwitch(controller!)
        check(controller!.noticeIsError && controller!.isRecoveryPending, "Mismatched readback is visible and recoverable")
        check(controller!.currentSceneID == "entertainment", "Uses the observed live layout after mismatch")
        check(try same(entertainment), "External layout kept on disagreement")
        backend.afterRestart = nil
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        check(controller!.currentSceneID == "all" && controller!.notice == nil, "Restore clears earlier status")

        let beforeReversion = backend.restarts
        backend.afterRestart = {
            backend.afterRestart = nil
            try backend.writeTiles(originals)
        }
        controller!.applyScene("design")
        try await waitForSwitch(controller!)
        check(controller!.currentSceneID == "design" && !controller!.isRecoveryPending,
              "One request succeeds even after a verified reversion")
        check(try same(design) && backend.restarts == beforeReversion + 2, "Exactly one retry for a verified reversion")
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)

        backend.beforeNextReplace = { throw SystemDockError.unavailable }
        controller!.applyScene("design")
        try await waitForSwitch(controller!)
        check(try same(design) && !controller!.noticeIsError, "Readiness race before commit retries without a second press")
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)

        backend.failNextRefresh = true
        controller!.applyScene("design")
        try await Task.sleep(nanoseconds: 15_000_000)
        controller!.applyScene("entertainment")
        try await waitForSwitch(controller!)
        check(try same(entertainment) && !controller!.noticeIsError, "A rolled-back request still drains the latest intent")
        backend.beforeNextReplace = {
            let live = try backend.file.readLayout()
            let withRecent = DockLayout(pinned: live.pinned, recent: [["tile-type": "opaque-recent", "GUID": 94]])
            try backend.file.replaceLayout(withRecent, ifCurrent: live)
        }
        controller!.applyScene("design")
        try await waitForSwitch(controller!)
        check(try same(design) && !controller!.noticeIsError, "Recents-only race is rebased once")
        check(try backend.file.readLayout().recent?.first?["GUID"] as? Int == 94, "Concurrent recent survives")
        backend.beforeNextReplace = { try backend.writeTiles(entertainment) }
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        check(try same(entertainment) && controller!.noticeIsError, "Concurrent pin change is kept")

        // Simulate loss of process after the pre-switch intent was saved.
        let record = DockSwitchRecord(lastAppliedSceneID: "all", pendingSceneID: "design")
        let recordURL = directory.appendingPathComponent("switch-status.plist")
        try PropertyListEncoder().encode(record).write(to: recordURL, options: .atomic)
        try backend.writeTiles(design)
        controller = nil
        controller = DockScenesController(directory: directory, backend: backend, catalog: catalog, coalescingInterval: 0)
        controller!.start()
        check(controller!.isRecoveryPending, "Interrupted switch visible on reopen")
        check(try same(design), "Reopen never applies or restores automatically")
        check(controller!.state!.scene(custom)?.name == "工作台", "Custom group retained")
        check(try dockTilesEqual(controller!.state!.originalTiles(), savedOriginal), "Original retained on reopen")
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        let restored = try same(originals)
        check(!controller!.isRecoveryPending && restored, "Explicit restore clears recovery state")

        // Reproduce the live regression: an older pending scene survives into
        // a new All request, and the first refresh restores Entertainment.
        let stale = DockSwitchRecord(lastAppliedSceneID: "entertainment", pendingSceneID: custom)
        try PropertyListEncoder().encode(stale).write(to: recordURL, options: .atomic)
        try backend.writeTiles(entertainment)
        controller = DockScenesController(directory: directory, backend: backend, catalog: catalog, coalescingInterval: 0)
        controller!.start()
        check(controller!.isRecoveryPending, "Older unrelated switch remains in the journal")
        backend.afterRestart = {
            backend.afterRestart = nil
            try backend.writeTiles(entertainment)
        }
        let beforeRestore = backend.restarts
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        check(try same(originals), "All restores with one request even with a stale pending journal")
        check(controller!.currentSceneID == "all" && !controller!.isRecoveryPending &&
              backend.restarts == beforeRestore + 2, "Confirmed restore replaces the stale journal with one retry")

        // A new explicit All request received during another switch is not
        // discarded when that switch returns to its known starting layout.
        controller!.applyScene("entertainment")
        try await waitForSwitch(controller!)
        let beforeQueued = backend.restarts
        backend.afterRestart = {
            backend.afterRestart = nil
            try backend.writeTiles(entertainment)
        }
        controller!.applyScene("design")
        try await Task.sleep(nanoseconds: 15_000_000)
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        check(try same(originals) && !controller!.isRecoveryPending, "Queued All is applied after a reverted switch")
        check(backend.restarts == beforeQueued + 2, "The newest scene does not cause a retry of the superseded one")

        controller!.applyScene("entertainment")
        try await waitForSwitch(controller!)
        let beforeOutsideEdit = backend.restarts
        backend.afterRestart = {
            backend.afterRestart = nil
            try backend.writeTiles(entertainment)
            backend.beforeNextReplace = { try backend.writeTiles(design) }
        }
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        check(try same(design) && controller!.noticeIsError, "An outside pin change blocks the restoration retry")
        check(backend.restarts == beforeOutsideEdit + 1, "No retry refresh across an outside pin change")
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)

        controller = DockScenesController(directory: directory, backend: backend, catalog: catalog)
        controller!.start()
        let beforeBurst = backend.restarts
        controller!.applyScene("design")
        check(controller!.requestedSceneID == "design", "Preview is immediate while inputs can coalesce")
        try await Task.sleep(nanoseconds: 25_000_000)
        controller!.applyScene("entertainment")
        try await waitForSwitch(controller!)
        check(try same(entertainment) && backend.restarts == beforeBurst + 1,
              "Separate rapid presses apply only the last scene")

        let beforeCooldown = backend.restarts
        backend.refreshAllowedAt = ProcessInfo.processInfo.systemUptime + 0.45
        controller!.applyScene("design")
        try await Task.sleep(nanoseconds: 170_000_000)
        check(try same(entertainment) && backend.restarts == beforeCooldown,
              "Existing Dock remains intact during its minimum runtime")
        let waitingRecord = try PropertyListDecoder().decode(DockSwitchRecord.self, from: Data(contentsOf: recordURL))
        check(waitingRecord.pendingSceneID == nil, "A deferred switch has not entered a write transaction")
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        check(try same(originals) && backend.restarts == beforeCooldown + 1,
              "A newer All request during cooldown is the only target refreshed")
        controller = DockScenesController(directory: directory, backend: backend, catalog: catalog, coalescingInterval: 0)
        controller!.start()

        // Exercise real Carbon registration without sending any keyboard events.
        let hotkey = DockGlobalShortcut()
        let code = UInt32(kVK_ANSI_Semicolon)
        let flags: NSEvent.ModifierFlags = [.control, .option, .shift, .command]
        let shortcut = try DockShortcut(keyCode: code, flags: flags)
        var refused = false
        do { _ = try DockShortcut(keyCode: code, flags: [.option, .shift]) }
        catch { refused = true }
        check(refused, "Invalid shortcut rejected")
        do {
            _ = try DockShortcut(keyCode: code, flags: [.control, .function])
            refused = false
        } catch { refused = true }
        check(refused, "Fn is not silently discarded")
        let simple = try DockShortcut(keyCode: UInt32(kVK_ANSI_J), flags: [.control])
        check(simple.label.hasPrefix("⌃"), "Control and one ordinary key are supported")

        try hotkey.register(shortcut)
        let id = hotkey.registrationID!
        check(hotkey.binding == shortcut, "Global shortcut registers")
        var activations = 0
        hotkey.onPress = { if $0 == id { activations += 1 } }
        let press = GetCurrentEventTime()
        try dispatchHotKey(kEventHotKeyPressed, id: id, at: press)
        try dispatchHotKey(kEventHotKeyPressed, id: id, at: press)
        check(activations == 1, "Duplicate delivery of the same press is ignored")
        try dispatchHotKey(kEventHotKeyPressed, id: id, at: press + 0.1)
        check(activations == 2, "Missing release does not swallow the next press")
        try dispatchHotKey(kEventHotKeyReleased, id: id, at: press + 0.105)
        try dispatchHotKey(kEventHotKeyPressed, id: id, at: press + 0.11)
        try dispatchHotKey(kEventHotKeyPressed, id: id, at: press)
        check(activations == 3, "Rapid distinct press works and replayed old event is ignored")
        try dispatchHotKey(kEventHotKeyPressed, id: id &+ 1000)
        check(activations == 3, "Unknown Carbon event ignored")

        let duplicate = DockGlobalShortcut()
        refused = false
        do { try duplicate.register(shortcut) }
        catch { refused = true }
        check(refused, "Already registered shortcut refused")
        hotkey.unregister()
        let commandOne = try DockShortcut(keyCode: UInt32(kVK_ANSI_1), flags: [.command])
        check(commandOne.label.hasPrefix("⌘"), "Command plus one can be assigned")
        let commandTwo = try DockShortcut(keyCode: UInt32(kVK_ANSI_2), flags: [.command])
        check(controller!.startRecordingShortcut(for: "design"), "Open the Design recorder")
        check(controller!.setShortcut(commandOne), "Design accepts Command plus one")
        check(controller!.recordingSceneID == "design" && controller!.shortcutEditorDidSave,
              "Successful capture stays in the sheet with confirmation")
        check(controller!.registrationID(for: "design") == nil, "Saved chord stays suspended inside the sheet")
        check(!controller!.startRecordingShortcut(for: "entertainment"), "Single active sheet")
        check(controller!.setShortcut(commandTwo) && controller!.savedShortcutLabel(for: "design") == commandTwo.label,
              "Can rerecord in the same sheet")
        check(controller!.setShortcut(commandOne), "Can restore the first choice without closing")
        controller!.focusShortcutRecorder(false)
        check(controller!.recordingSceneID == "design" && !controller!.isRecordingShortcut,
              "Sheet stays open in the background")
        let backgroundBinding = controller!.registrationID(for: "design")!
        try dispatchHotKey(kEventHotKeyPressed, id: backgroundBinding)
        try dispatchHotKey(kEventHotKeyReleased, id: backgroundBinding)
        try await Task.sleep(nanoseconds: 15_000_000)
        try await waitForSwitch(controller!)
        check(try same(design), "Backgrounded editor leaves saved globals functional")
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        controller!.focusShortcutRecorder(true)
        check(controller!.registrationID(for: "design") == nil && controller!.isRecordingShortcut,
              "Returning to the sheet resumes editing without switching")
        controller!.finishEditingShortcut()
        check(controller!.shortcutLabel(for: "design") == commandOne.label, "Design binding active")
        check(try DockSceneStore(directory: directory).load()?.shortcut(for: "design") == commandOne, "Design binding round-trips")
        check(try same(originals), "Recording shortcut never applies")

        check(controller!.startRecordingShortcut(for: "entertainment"), "Open the Entertainment recorder")
        check(!controller!.setShortcut(commandOne), "Duplicate shortcut rejected")
        check(controller!.recordingSceneID == "entertainment" && controller!.shortcutEditorWarning != nil,
              "Duplicate stays in recorder with error")
        check(controller!.setShortcut(commandTwo), "Entertainment accepts an independent shortcut")
        check(controller!.shortcutEditorWarning == nil, "A correction clears the previous error")
        controller!.finishEditingShortcut()
        check(controller!.shortcutLabel(for: "design") == commandOne.label &&
              controller!.shortcutLabel(for: "entertainment") == commandTwo.label, "Two bindings active together")

        let earlierDesignID = controller!.registrationID(for: "design")!
        check(controller!.startRecordingShortcut(for: "design"), "Open recorder again")
        check(!controller!.setShortcut(keyCode: code, modifiers: [.shift]), "Invalid entry remains in editor")
        controller!.finishEditingShortcut()
        check(controller!.shortcutLabel(for: "design") == commandOne.label, "Cancel restores previous binding")
        check(controller!.registrationID(for: "design") != earlierDesignID, "Re-registration uses a fresh event ID")

        try dispatchHotKey(kEventHotKeyPressed, id: earlierDesignID)
        try await Task.sleep(nanoseconds: 30_000_000)
        check(try same(originals), "Stale registration cannot switch Dock")
        let designID = controller!.registrationID(for: "design")!
        let entertainmentID = controller!.registrationID(for: "entertainment")!
        try dispatchHotKey(kEventHotKeyPressed, id: designID)
        try dispatchHotKey(kEventHotKeyReleased, id: designID)
        try await Task.sleep(nanoseconds: 30_000_000)
        try await waitForSwitch(controller!)
        check(try same(design), "Design shortcut directly applies Design")
        try dispatchHotKey(kEventHotKeyPressed, id: entertainmentID)
        try dispatchHotKey(kEventHotKeyReleased, id: entertainmentID)
        try await Task.sleep(nanoseconds: 30_000_000)
        try await waitForSwitch(controller!)
        check(try same(entertainment), "Entertainment shortcut directly applies Entertainment")
        var appliedToPreview: [String] = []
        let observer = controller!.sceneApplied.sink { appliedToPreview.append($0) }
        for id in [designID, entertainmentID, designID] {
            try dispatchHotKey(kEventHotKeyPressed, id: id)
            try dispatchHotKey(kEventHotKeyReleased, id: id)
        }
        try await Task.sleep(nanoseconds: 15_000_000)
        try await waitForSwitch(controller!)
        check(try same(design), "Fast global A/B/A lands on the last scene")
        check(appliedToPreview == ["design"], "No intermediate or stale success updates")
        controller!.applyScene("design")
        try await waitForSwitch(controller!)
        check(appliedToPreview == ["design", "design"], "Already-current shortcut also selects its preview")
        observer.cancel()

        controller = nil
        try duplicate.register(commandOne)
        controller = DockScenesController(directory: directory, backend: backend, catalog: catalog, coalescingInterval: 0)
        controller!.start()
        check(controller!.shortcutLabel(for: "design") == nil && controller!.shortcutWarning(for: "design") != nil,
              "Startup conflict hides misleading active label")
        check(controller!.savedShortcutLabel(for: "design") == commandOne.label, "Conflicting key retained in config")
        check(controller!.shortcutLabel(for: "entertainment") == commandTwo.label,
              "Conflict does not stop unrelated scene shortcut")
        duplicate.unregister()
        controller!.refresh()
        check(controller!.shortcutLabel(for: "design") == commandOne.label && controller!.shortcutWarning(for: "design") == nil,
              "Refresh recovers from temporary conflict")
        check(controller!.startRecordingShortcut(for: "design"), "Open recorder before clearing")
        check(controller!.clearShortcut(), "Clear one scene shortcut")
        check(controller!.recordingSceneID == "design" && controller!.savedShortcutLabel(for: "design") == nil,
              "Removing a shortcut keeps the same sheet open")
        controller!.finishEditingShortcut()
        check(controller!.shortcutLabel(for: "design") == nil &&
              controller!.shortcutLabel(for: "entertainment") == commandTwo.label, "Only the selected binding is removed")
        check(try DockSceneStore(directory: directory).load()?.shortcut(for: "design") == nil, "Removed shortcut persists")
        let customShortcut = try DockShortcut(keyCode: UInt32(kVK_ANSI_J), flags: [.control, .shift])
        check(controller!.startRecordingShortcut(for: custom) && controller!.setShortcut(customShortcut),
              "Assign a custom scene shortcut")
        controller!.finishEditingShortcut()
        check(controller!.deleteScene(custom) && controller!.registrationID(for: custom) == nil,
              "Deleting a custom scene removes its registration")
        controller!.restoreOriginal()
        try await waitForSwitch(controller!)
        check(try same(originals), "Original layout stays recoverable")
        print("\(count) isolated Dock controller and Carbon registration checks passed")
    }

    private static func dispatchHotKey(_ kind: Int, id: UInt32, at time: EventTime = GetCurrentEventTime()) throws {
        var event: EventRef?
        let status = CreateEvent(nil, OSType(kEventClassKeyboard), UInt32(kind), time, 0, &event)
        guard status == noErr, let event else { throw CocoaError(.featureUnsupported) }
        defer { ReleaseEvent(event) }
        var key = EventHotKeyID(signature: 0x4E504453, id: id)
        let setStatus = SetEventParameter(event, EventParamName(kEventParamDirectObject),
                                          EventParamType(typeEventHotKeyID), MemoryLayout<EventHotKeyID>.size, &key)
        guard setStatus == noErr else { throw CocoaError(.featureUnsupported) }
        _ = SendEventToEventTarget(event, GetApplicationEventTarget())
    }

    private static func systemApp(_ name: String) -> URL {
        for parent in ["/System/Applications", "/Applications"] {
            let url = URL(fileURLWithPath: parent + "/" + name + ".app", isDirectory: true)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        fatalError("Missing system fixture app")
    }

    private static func plist(_ object: Any) throws -> Data {
        try PropertyListSerialization.data(fromPropertyList: object, format: .binary, options: 0)
    }
}
