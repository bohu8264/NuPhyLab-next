import AppKit
import Combine
import Foundation
import SwiftUI
import UniformTypeIdentifiers

struct DockSwitchRecord: Codable {
    var lastAppliedSceneID: String?
    var pendingSceneID: String?
}

@MainActor
final class DockScenesController: ObservableObject {
    @Published private(set) var state: DockSceneState?
    @Published private(set) var currentSceneID: String?
    @Published private(set) var requestedSceneID: String?
    var isApplying: Bool { requestedSceneID != nil || switchRunning }
    var english = false
    private(set) var featureAvailable = true
    private(set) var shortcutsEnabled = true
    let sceneApplied = PassthroughSubject<String, Never>()
    @Published private(set) var isRecoveryPending = false
    @Published private(set) var notice: String?
    @Published private(set) var noticeIsError = false
    @Published private var activeShortcuts: [String: DockShortcut] = [:]
    @Published private var shortcutWarnings: [String: String] = [:]
    @Published private(set) var recordingSceneID: String?
    @Published private(set) var shortcutEditorWarning: String?
    @Published private(set) var shortcutEditorDidSave = false

    private(set) var isRecordingShortcut = false
    var sceneShortcutsAvailable: (() -> Bool)?
    var presentShortcutEditor: ((String) -> Void)?

    func shortcutLabel(for id: String) -> String? { activeShortcuts[id]?.label }
    func shortcutWarning(for id: String) -> String? { shortcutWarnings[id] }
    func savedShortcutLabel(for id: String) -> String? { state?.shortcut(for: id)?.label }

    private let directory: URL
    private let backend: any DockBackend
    private let catalog: DockAppCatalog
    private let store: DockSceneStore
    private var hotKeys: [String: DockGlobalShortcut] = [:]
    private let worker = DispatchQueue(label: "local.nuphylab.dockscenes.dock")
    private var record = DockSwitchRecord()
    private var lastTiles: DockTiles?
    private var filePanel: NSOpenPanel?
    private let coalescingInterval: TimeInterval
    private var switchTimer: Task<Void, Never>?
    private var switchRunning = false
    private var lastRequestTime: TimeInterval = 0
    private var refreshNotBefore: TimeInterval = 0
    private var retryBaseline: DockTiles?
    private var retriedSceneID: String?

    init(directory: URL, backend: any DockBackend = SystemDockBackend(), catalog: DockAppCatalog = .init(),
         coalescingInterval: TimeInterval = 0.10) {
        self.directory = directory
        self.backend = backend
        self.catalog = catalog
        self.coalescingInterval = coalescingInterval
        store = DockSceneStore(directory: directory)
    }

    func start() {
        do {
            record = try loadRecord()
        } catch {
            // The original snapshot is separate. A new explicit switch can repair this record.
            isRecoveryPending = true
        }
        isRecoveryPending = isRecoveryPending || record.pendingSceneID != nil
        refresh()
    }

    func refresh() {
        guard !isApplying else { return }
        if state == nil {
            do {
                if let saved = try store.load() {
                    state = saved
                } else {
                    let tiles = try backend.readTiles()
                    let captured = try DockSceneState(originalTiles: tiles, catalog: catalog)
                    try store.save(captured)
                    state = captured
                    updateCurrentScene(tiles)
                    setNotice(nil)
                    return
                }
            } catch {
                setNotice(error.localizedDescription, error: true)
                return
            }
        }
        readLiveLayout()
        synchronizeShortcuts()
    }

    func setFeatureAvailable(_ available: Bool) {
        featureAvailable = available
        guard !available else { return }
        setShortcutsEnabled(false)
        switchTimer?.cancel()
        switchTimer = nil
        requestedSceneID = nil
        retryBaseline = nil
        retriedSceneID = nil
        filePanel?.cancel(nil)
    }

    func setShortcutsEnabled(_ enabled: Bool) {
        shortcutsEnabled = enabled && featureAvailable
        synchronizeShortcuts()
    }

    func restoreOriginal() {
        applyScene(DockSceneState.allID)
    }

    func applyScene(_ id: String) {
        guard featureAvailable, !isRecordingShortcut, let scene = state?.scene(id) else { return }
        guard id == DockSceneState.allID || !scene.apps.isEmpty else {
            setNotice("先添加应用，再切换到这个场景。", error: true)
            return
        }
        guard requestedSceneID != id else { return }
        if !isApplying { setNotice(nil) }
        requestedSceneID = id
        lastRequestTime = ProcessInfo.processInfo.systemUptime
        if !switchRunning { scheduleSwitch() }
    }

    private func scheduleSwitch() {
        switchTimer?.cancel()
        let now = ProcessInfo.processInfo.systemUptime
        let delay = max(0, max(lastRequestTime + coalescingInterval, refreshNotBefore) - now)
        switchTimer = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard !Task.isCancelled, let self, self.featureAvailable,
                  let latest = self.requestedSceneID.flatMap({ self.state?.scene($0) }) else { return }
            self.switchTimer = nil
            self.switchRunning = true
            self.switchTo(latest, retryPins: self.retryBaseline, retried: self.retriedSceneID == latest.id)
        }
    }

    private func switchTo(_ scene: DockScene, retryPins: DockTiles?, retried: Bool) {
        let id = scene.id
        let previousRecord = record
        let prepared = DockSwitchRecord(lastAppliedSceneID: previousRecord.lastAppliedSceneID, pendingSceneID: id)
        let backend = self.backend
        let recordURL = switchRecordURL
        worker.async { [weak self] in
            let outcome: Result<DockTiles, Error>
            var resultingRecord = previousRecord
            var recordWritten = false
            var applied = false
            do {
                let target = try scene.tiles()
                if id != DockSceneState.allID && target.contains(where: { tile in
                    if let url = dockTileURL(tile) { return !FileManager.default.fileExists(atPath: url.path) }
                    return tile["tile-type"] as? String == "file-tile"
                }) { throw DockSceneControllerError.missingApplication }

                try backend.waitUntilReady()
                let current = try backend.readLayout()
                let alreadyInPlace = dockPinsMatch(current.pinned, target)
                // A retry after a verified reversion still obeys the pre-write
                // snapshot. A user who moved pins while Dock was coming up wins.
                if let retryPins, !dockTilesEqual(current.pinned, retryPins), !alreadyInPlace {
                    throw DockTransactionError.changedExternally
                }
                let desired = alreadyInPlace ? current.pinned : target
                let tiles: DockTiles
                if current.matches(current.replacingPinned(desired)) {
                    tiles = current.pinned
                } else {
                    let delay = try backend.refreshDelay()
                    if delay > 0 {
                        // No preferences have been touched. Re-select the latest target
                        // after leaving the current Dock visible for the rest of this delay.
                        let eligibleAt = ProcessInfo.processInfo.systemUptime + delay
                        DispatchQueue.main.async {
                            guard let self else { return }
                            self.switchRunning = false
                            self.refreshNotBefore = eligibleAt
                            self.scheduleSwitch()
                        }
                        return
                    }
                    // Covers a pinned-app change and a recents-only correction.
                    try Self.saveRecord(prepared, to: recordURL)
                    resultingRecord = prepared
                    recordWritten = true
                    applied = try Self.replacePinned(desired, expected: current, backend: backend)
                    if applied { try backend.waitUntilReady() }
                    tiles = try Self.confirm(desired, before: current.pinned, afterRefresh: applied, backend: backend)
                }
                let completed = DockSwitchRecord(lastAppliedSceneID: id)
                do { try Self.saveRecord(completed, to: recordURL) }
                catch { throw DockSceneControllerError.statusSaveFailed }
                resultingRecord = completed
                outcome = .success(tiles)
            } catch {
                if recordWritten, Self.isSettled(error, afterRefresh: applied),
                   (try? Self.saveRecord(previousRecord, to: recordURL)) != nil {
                    resultingRecord = previousRecord
                }
                outcome = .failure(error)
            }
            let finishedRecord = resultingRecord
            DispatchQueue.main.async {
                self?.finishSwitch(outcome, record: finishedRecord, scene: scene, retried: retried)
            }
        }
    }

    @discardableResult
    func createScene(name: String) -> String? {
        edit { try $0.createScene(name: name) }
    }

    @discardableResult
    func renameScene(_ id: String, name: String) -> Bool {
        edit { try $0.renameScene(id: id, name: name) } != nil
    }

    @discardableResult
    func deleteScene(_ id: String) -> Bool {
        guard recordingSceneID == nil, edit({ try $0.deleteScene(id: id) }) != nil else { return false }
        synchronizeShortcuts()
        return true
    }

    func chooseApplications(for id: String) {
        guard !isApplying, filePanel == nil, state?.scene(id) != nil, id != DockSceneState.allID else { return }
        let panel = NSOpenPanel()
        panel.title = english ? "Add Applications" : "添加应用"
        panel.prompt = english ? "Add" : "添加"
        panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
        panel.allowedContentTypes = [.applicationBundle]
        panel.allowsMultipleSelection = true
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        filePanel = panel
        let completion: (NSApplication.ModalResponse) -> Void = { [weak self, weak panel] answer in
            guard let self else { return }
            self.filePanel = nil
            guard answer == .OK, let urls = panel?.urls, !urls.isEmpty else { return }
            self.edit { try $0.addApplications(urls, to: id) }
        }
        if let window = NSApp.keyWindow, window.attachedSheet == nil {
            panel.beginSheetModal(for: window, completionHandler: completion)
        } else {
            panel.begin(completionHandler: completion)
        }
    }

    func removeItem(from id: String, at index: Int) {
        guard let items = state?.scene(id)?.apps, items.indices.contains(index) else { return }
        edit { try $0.removeApplication(items[index].id, from: id) }
    }

    func moveItem(in id: String, from: Int, to: Int) {
        guard let items = state?.scene(id)?.apps, items.indices.contains(from) else { return }
        edit { try $0.moveApplication(items[from].id, in: id, to: to) }
    }

    func requestShortcutEditor(for id: String) {
        guard state?.scene(id) != nil, !isApplying, recordingSceneID == nil else { return }
        presentShortcutEditor?(id)
    }

    @discardableResult
    func startRecordingShortcut(for id: String) -> Bool {
        guard state?.scene(id) != nil, !isApplying, recordingSceneID == nil else { return false }
        recordingSceneID = id
        shortcutEditorDidSave = false
        shortcutEditorWarning = shortcutWarnings[id]
        focusShortcutRecorder(true)
        return true
    }

    func focusShortcutRecorder(_ focused: Bool) {
        guard let id = recordingSceneID, isRecordingShortcut != focused else { return }
        isRecordingShortcut = focused
        if focused {
            if let failure = shortcutWarnings[id] { shortcutEditorWarning = failure }
            for hotKey in hotKeys.values { hotKey.unregister() }
        } else {
            // A sheet left open in the background must not disable global bindings.
            synchronizeShortcuts()
        }
    }

    func finishEditingShortcut() {
        guard recordingSceneID != nil else { return }
        recordingSceneID = nil
        isRecordingShortcut = false
        shortcutEditorWarning = nil
        shortcutEditorDidSave = false
        synchronizeShortcuts()
    }

    @discardableResult
    func setShortcut(keyCode: UInt32, modifiers: NSEvent.ModifierFlags) -> Bool {
        guard isRecordingShortcut else { return false }
        do {
            return setShortcut(try DockShortcut(keyCode: keyCode, flags: modifiers))
        } catch {
            shortcutEditorWarning = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func setShortcut(_ shortcut: DockShortcut) -> Bool {
        guard isRecordingShortcut, let id = recordingSceneID, var updated = state else { return false }
        let hotKey = hotKey(for: id)
        do {
            try updated.setShortcut(shortcut, for: id)
            try hotKey.register(shortcut)
            // Validate exclusive registration now, then keep the sheet able to
            // capture the next chord while it has keyboard focus.
            defer { hotKey.unregister() }
            try store.save(updated)
            state = updated
            shortcutEditorWarning = nil
            shortcutEditorDidSave = true
            return true
        } catch {
            if let owner = state?.scenes.first(where: { $0.id != id && state?.shortcut(for: $0.id) == shortcut }) {
                shortcutEditorWarning = english ? "This shortcut is assigned to “\(dockSceneName(owner, english: true))”." : "这组快捷键已用于「\(owner.name)」。"
            } else {
                shortcutEditorWarning = error.localizedDescription
            }
            return false
        }
    }

    @discardableResult
    func clearShortcut() -> Bool {
        guard let id = recordingSceneID, var updated = state else { return false }
        do {
            try updated.setShortcut(nil, for: id)
            try store.save(updated)
            state = updated
            shortcutEditorWarning = nil
            shortcutEditorDidSave = true
            return true
        } catch {
            shortcutEditorWarning = error.localizedDescription
            return false
        }
    }

    func setNotice(_ message: String?, error: Bool = false) {
        noticeIsError = error
        notice = message
    }

    @discardableResult
    private func edit<Value>(_ modify: (inout DockSceneState) throws -> Value) -> Value? {
        guard featureAvailable, !isApplying, var updated = state else { return nil }
        do {
            let value = try modify(&updated)
            try store.save(updated)
            state = updated
            if let lastTiles { updateCurrentScene(lastTiles) }
            setNotice(nil)
            return value
        } catch {
            setNotice(error.localizedDescription, error: true)
            return nil
        }
    }

    private func hotKey(for sceneID: String) -> DockGlobalShortcut {
        if let existing = hotKeys[sceneID] { return existing }
        let hotKey = DockGlobalShortcut()
        hotKey.onPress = { [weak self] registrationID in
            DispatchQueue.main.async {
                guard let self, self.featureAvailable, self.shortcutsEnabled, !self.isRecordingShortcut,
                      self.hotKeys[sceneID]?.registrationID == registrationID,
                      self.sceneShortcutsAvailable?() != false else { return }
                self.applyScene(sceneID)
            }
        }
        hotKeys[sceneID] = hotKey
        return hotKey
    }

    private func synchronizeShortcuts() {
        guard featureAvailable && shortcutsEnabled else {
            for hotKey in hotKeys.values { hotKey.unregister() }
            if !activeShortcuts.isEmpty { activeShortcuts = [:] }
            if !shortcutWarnings.isEmpty { shortcutWarnings = [:] }
            return
        }
        guard !isRecordingShortcut, let state else { return }
        for id in Array(hotKeys.keys) where state.shortcut(for: id) == nil {
            hotKeys.removeValue(forKey: id)?.unregister()
        }

        var active: [String: DockShortcut] = [:]
        var failures: [String: String] = [:]
        for scene in state.scenes {
            guard let shortcut = state.shortcut(for: scene.id) else { continue }
            let hotKey = hotKey(for: scene.id)
            do {
                try hotKey.register(shortcut)
                active[scene.id] = shortcut
            } catch {
                failures[scene.id] = error.localizedDescription
            }
        }
        if activeShortcuts != active { activeShortcuts = active }
        if shortcutWarnings != failures { shortcutWarnings = failures }
    }

    #if DOCK_SHORTCUT_TESTING
    func registrationID(for id: String) -> UInt32? { hotKeys[id]?.registrationID }
    #endif

    private func readLiveLayout() {
        do {
            updateCurrentScene(try backend.readTiles())
        } catch {
            currentSceneID = nil
            lastTiles = nil
            if !noticeIsError { setNotice(error.localizedDescription, error: true) }
        }
    }

    private func finishSwitch(_ outcome: Result<DockTiles, Error>, record: DockSwitchRecord,
                              scene: DockScene, retried: Bool) {
        switchRunning = false
        refreshNotBefore = 0
        retryBaseline = nil
        retriedSceneID = nil
        self.record = record
        isRecoveryPending = record.pendingSceneID != nil
        let latest = requestedSceneID.flatMap { state?.scene($0) }
        switch outcome {
        case .success(let tiles):
            lastTiles = tiles
            currentSceneID = scene.id
            if let latest, latest.id != scene.id {
                scheduleSwitch()
                return
            }
            requestedSceneID = nil
            setNotice(nil)
            // A shortcut to the already-applied scene must still select its preview.
            sceneApplied.send(scene.id)
        case .failure(let error):
            if let latest {
                // An older unconfirmed journal must not suppress a retry when
                // this switch has positively identified the former live layout.
                if case DockSceneControllerError.revertedAfterRefresh(let pins) = error,
                   !retried || latest.id != scene.id {
                    retryBaseline = pins
                    retriedSceneID = latest.id == scene.id ? scene.id : nil
                    scheduleSwitch()
                    return
                }
                if latest.id != scene.id, Self.canContinueAfterFailedSwitch(error),
                   record.pendingSceneID != scene.id {
                    scheduleSwitch()
                    return
                }
            }
            requestedSceneID = nil
            readLiveLayout()
            let queued = latest.flatMap { $0.id == scene.id ? nil : "「\($0.name)」尚未应用。" } ?? ""
            if english {
                let waiting = latest.flatMap { $0.id == scene.id ? nil : " “\(dockSceneName($0, english: true))” has not been applied." } ?? ""
                setNotice("Could not confirm “\(dockSceneName(scene, english: true))”. \(dockMessage(error.localizedDescription, english: true))\(waiting)", error: true)
            } else {
                setNotice("未能确认「\(scene.name)」的切换。\(error.localizedDescription)\(queued)", error: true)
            }
        }
    }

    nonisolated private static func replacePinned(_ target: DockTiles, expected: DockLayout,
                                                  backend: any DockBackend) throws -> Bool {
        let transaction = DockTransaction(backend: backend)
        var baseline = expected
        for retries in 0...2 {
            do { return try transaction.apply(current: baseline, desired: target) }
            catch DockTransactionError.changedExternally where retries < 2 {
                // Rebase only a Recents change. Never race a concurrent pin edit.
                let latest = try backend.readLayout()
                guard dockTilesEqual(latest.pinned, baseline.pinned), !latest.recentMatches(baseline) else {
                    throw DockTransactionError.changedExternally
                }
                baseline = latest
            } catch SystemDockError.unavailable where retries < 2 {
                try backend.waitUntilReady()
                let latest = try backend.readLayout()
                guard dockTilesEqual(latest.pinned, baseline.pinned) else {
                    throw DockTransactionError.changedExternally
                }
                baseline = latest
            }
        }
        throw DockTransactionError.changedExternally
    }

    nonisolated private static func confirm(_ target: DockTiles, before: DockTiles, afterRefresh: Bool,
                                            backend: any DockBackend) throws -> DockTiles {
        let clock = ProcessInfo.processInfo
        let deadline = clock.systemUptime + (afterRefresh ? 0.45 : 0)
        while true {
            let tiles: DockTiles
            do {
                tiles = try backend.readTiles()
            } catch {
                guard clock.systemUptime < deadline else { throw error }
                Thread.sleep(forTimeInterval: 0.035)
                continue
            }
            if dockPinsMatch(tiles, target) { return tiles }
            // The exiting Dock can persist its former scene. A different layout
            // may instead be a user edit and must not be reapplied over.
            guard afterRefresh, dockPinsMatch(tiles, before) else {
                throw DockSceneControllerError.unconfirmedLayout
            }
            if clock.systemUptime >= deadline { throw DockSceneControllerError.revertedAfterRefresh(tiles) }
            Thread.sleep(forTimeInterval: 0.035)
        }
    }

    private func updateCurrentScene(_ tiles: DockTiles) {
        lastTiles = tiles
        guard let state else { currentSceneID = nil; return }
        // Dock can enrich freshly created tiles after restarting. Only use relaxed identity
        // for the visible scene badge; the write transaction compares the full plist.
        let ordered = record.lastAppliedSceneID.flatMap { state.scene($0) }.map { [$0] } ?? []
        let candidates = ordered + state.scenes.filter { $0.id != ordered.first?.id }
        currentSceneID = candidates.first { scene in
            guard let saved = try? scene.tiles() else { return false }
            return dockPinsMatch(tiles, saved)
        }?.id
    }

    private var switchRecordURL: URL {
        directory.appendingPathComponent("switch-status.plist")
    }

    private func loadRecord() throws -> DockSwitchRecord {
        guard FileManager.default.fileExists(atPath: switchRecordURL.path) else { return .init() }
        return try PropertyListDecoder().decode(DockSwitchRecord.self, from: Data(contentsOf: switchRecordURL))
    }

    nonisolated private static func saveRecord(_ record: DockSwitchRecord, to url: URL) throws {
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        try encoder.encode(record).write(to: url, options: .atomic)
    }

    nonisolated private static func isSettled(_ error: Error, afterRefresh: Bool) -> Bool {
        if case DockSceneControllerError.revertedAfterRefresh = error { return true }
        guard !afterRefresh else { return false }
        if case SystemDockError.unavailable = error { return true }
        guard let transaction = error as? DockTransactionError else { return false }
        switch transaction {
        case .changedExternally, .invalidTiles: return true
        case .failed(_, let recovery):
            switch recovery {
            case .previousIntact, .restored, .externalChange: return true
            case .unverified: return false
            }
        }
    }

    private static func canContinueAfterFailedSwitch(_ error: Error) -> Bool {
        if case SystemDockError.unavailable = error { return true }
        if case DockSceneControllerError.missingApplication = error { return true }
        if case DockTransactionError.failed(_, let recovery) = error {
            return recovery == .previousIntact || recovery == .restored
        }
        return false
    }
}

private enum DockSceneControllerError: LocalizedError {
    case statusSaveFailed, unconfirmedLayout, missingApplication
    case revertedAfterRefresh(DockTiles)
    var errorDescription: String? {
        switch self {
        case .statusSaveFailed: return "未能保存切换状态。原始备份仍保留。"
        case .unconfirmedLayout: return "Dock 返回了不同的布局，可重新应用或恢复原 Dock。"
        case .missingApplication: return "场景中有应用已移除或不可用。"
        case .revertedAfterRefresh: return "系统在刷新后还原了上一个布局。"
        }
    }
}
