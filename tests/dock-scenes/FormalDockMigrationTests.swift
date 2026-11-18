import AppKit
import Darwin

@main
enum FormalDockMigrationTests {
    @MainActor static func main() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let legacy = root.appendingPathComponent("Experiment")
        let destination = root.appendingPathComponent("Formal/dock-scenes")
        try migrateDockScenes(from: legacy, to: destination)
        precondition(!fm.fileExists(atPath: destination.path))
        let store = DockSceneStore(directory: legacy)
        let tiles: DockTiles = (1...19).map { ["tile-type":"spacer-tile", "GUID":$0] }
        var state = try DockSceneState(originalTiles: tiles, catalog: .init(resolve: { _ in nil }))
        let custom = try state.createScene(name: "My layout")
        for (id, code) in zip(["all","design","entertainment", custom], [18,19,20,21]) {
            try state.setShortcut(.init(keyCode: UInt32(code), modifiers: 256), for: id)
        }
        try store.save(state)
        let journal = try PropertyListEncoder().encode(DockSwitchRecord(lastAppliedSceneID: "all", pendingSceneID: "design"))
        try journal.write(to: legacy.appendingPathComponent("switch-status.plist"))
        let lock = open(legacy.appendingPathComponent("instance.lock").path,O_CREAT | O_RDWR, 0o600)
        precondition(lock >= 0 && flock(lock, LOCK_EX) == 0)
        do { try migrateDockScenes(from: legacy, to: destination); fatalError("import from a live writer") }
        catch DockMigrationError.experimentRunning { }
        Darwin.close(lock)
        precondition(!fm.fileExists(atPath: destination.path))
        try migrateDockScenes(from: legacy, to: destination)
        let formal = DockSceneStore(directory: destination)
        let sourceBytes = try Data(contentsOf: store.fileURL), formalBytes = try Data(contentsOf: formal.fileURL)
        let formalJournal = try Data(contentsOf: destination.appendingPathComponent("switch-status.plist"))
        precondition(formalBytes == sourceBytes && journal == formalJournal)
        let loaded = try formal.load()!
        let original = try loaded.originalTiles()
        precondition(dockTilesEqual(original, tiles) && loaded.sceneShortcuts.count == 4 && loaded.scenes.last?.id == custom)
        try state.renameScene(id: custom, name: "Changed elsewhere")
        try store.save(state)
        try migrateDockScenes(from: legacy, to: destination)
        let preserved = try Data(contentsOf: formal.fileURL)
        precondition(preserved == formalBytes)

        let corrupt = root.appendingPathComponent("Corrupt")
        try fm.createDirectory(at: corrupt, withIntermediateDirectories: false)
        try Data("invalid".utf8).write(to: corrupt.appendingPathComponent("scenes.plist"))
        let unused = root.appendingPathComponent("Unused")
        do { try migrateDockScenes(from: corrupt, to: unused); fatalError("published an unreadable profile") } catch { }
        precondition(!fm.fileExists(atPath: unused.path))

        let backend = FileFixtureDockBackend(url: root.appendingPathComponent("dock.plist"))
        let fixture = try PropertyListSerialization.data(fromPropertyList: ["persistent-apps":tiles], format:.binary, options:0)
        try fixture.write(to: backend.url)
        let core = DockScenesController(directory:destination, backend:backend, coalescingInterval: 0.1)
        core.setShortcutsEnabled(false)
        core.start()
        precondition(core.currentSceneID == "all" && core.isRecoveryPending && core.shortcutLabel(for:"all") == nil)
        core.applyScene("all")
        core.setFeatureAvailable(false)
        try await Task.sleep(nanoseconds: 200_000_000)
        let after = try Data(contentsOf: backend.url)
        let afterJournal = try Data(contentsOf: destination.appendingPathComponent("switch-status.plist"))
        precondition(!core.isApplying && after == fixture && afterJournal == formalJournal)
        core.setFeatureAvailable(true)
        precondition(core.savedShortcutLabel(for:"all") != nil && core.shortcutLabel(for:"all") == nil)
        print("Verified fresh, locked, exact migration of 19 pins and four shortcuts, corruption, idempotence, read-only startup, pending recovery, hide cancellation and disabled re-add.")
    }
}
