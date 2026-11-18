import CoreFoundation
import Foundation

private enum FixtureError: Error { case failed }

private final class DockFixture: DockBackend, @unchecked Sendable {
    var domain: [String: Any]
    var events: [String] = []
    var reads = 0
    var onRead: ((DockFixture) throws -> Void)?
    var onWrite: ((DockFixture) throws -> Void)?
    var onRefresh: ((DockFixture) throws -> Void)?

    init(_ tiles: DockTiles) {
        domain = ["persistent-apps": tiles, "persistent-others": [["label": "Fixture stack"]],
                  "autohide": true, "tilesize": 42.0, "orientation": "left"]
    }

    var tiles: DockTiles {
        get { domain["persistent-apps"] as! DockTiles }
        set { domain["persistent-apps"] = newValue }
    }

    var recent: DockTiles? {
        get { domain["recent-apps"] as? DockTiles }
        set { domain["recent-apps"] = newValue }
    }

    func readTiles() throws -> DockTiles {
        reads += 1
        events.append("read")
        try onRead?(self)
        return tiles
    }

    func writeTiles(_ tiles: DockTiles) throws {
        events.append("write")
        self.tiles = tiles
        try onWrite?(self)
    }

    func readLayout() throws -> DockLayout { DockLayout(pinned: try readTiles(), recent: recent) }

    func replaceLayout(_ layout: DockLayout, ifCurrent expected: DockLayout) throws {
        guard try readLayout().matches(expected) else { throw DockTransactionError.changedExternally }
        recent = layout.recent
        try writeTiles(layout.pinned)
    }

    func refresh() throws {
        events.append("refresh")
        try onRefresh?(self)
    }
}

@main
private enum DockBackendTests {
    private static var assertions = 0

    private static func check(_ passes: Bool, _ description: String) {
        guard passes else { fatalError(description) }
        assertions += 1
    }

    private static func failure(_ operation: () throws -> Bool) -> DockRecovery {
        do {
            _ = try operation()
            fatalError("Expected transaction error")
        } catch DockTransactionError.failed(_, let recovery) {
            return recovery
        } catch {
            fatalError("Expected a transaction failure: \(error)")
        }
    }

    private static func appTile(_ name: String, bundle: String? = nil, guid: Int = 1) -> DockTile {
        var data: DockTile = ["file-label": "Same Display Name", "file-data": [
            "_CFURLString": "file:///Applications/\(name).app/", "_CFURLStringType": 15
        ], "book": Data([UInt8(guid)])]
        data["bundle-identifier"] = bundle
        return ["GUID": guid, "tile-type": "file-tile", "tile-data": data]
    }

    private static func checkRecentDuplicates() throws {
        let chat = appTile("ChatGPT", bundle: "fixture.chat")
        let fallback = appTile("NuPhy%20Lab", bundle: "fixture.formal", guid: 2)
        let chatMoved = appTile("Moved%20ChatGPT", bundle: "fixture.chat", guid: 3)
        let noBundle = appTile("NuPhy%20Lab", guid: 4)
        let unrelated = appTile("NuPhy%20Dock%20Lab", bundle: "fixture.experiment", guid: 5)
        let thirdParty = appTile("External", bundle: "fixture.external", guid: 6)
        let opaque: DockTile = ["tile-type": "future", "tile-data": ["bundle-identifier": "fixture.chat"]]
        let pins = [chat, fallback]
        let before = DockLayout(pinned: pins, recent: [chatMoved, unrelated, noBundle, opaque])
        let pruned = before.replacingPinned(pins)
        check(dockTilesEqual(pruned.recent ?? [], [unrelated, opaque]), "Filter by valid bundle ID or file path only")
        check(dockTilesEqual(pruned.pinned, pins), "Never remove identical pins when pruning recents")
        let removeFallback = before.replacingPinned([chat])
        check(dockTilesEqual(removeFallback.recent ?? [], [unrelated, noBundle, opaque]),
              "Compare with target pins and preserve recent entries that will become unpinned")
        let fixture = DockFixture(pins)
        fixture.recent = before.recent
        fixture.domain["show-recents"] = true
        try check(DockTransaction(backend: fixture).apply(expected: before, desired: pins),
                  "Run recent-only cleanup even when pinned layout is unchanged")
        check(fixture.events == ["read", "read", "write", "read", "refresh"], "Read back both keys before refreshing")
        check(try fixture.readLayout().matches(pruned), "Retain original raw pinned and nonduplicate recent tiles")
        check(fixture.domain["show-recents"] as? Bool == true, "Preserve the user's recent-apps toggle")
        check(!(try DockTransaction(backend: fixture).apply(expected: pruned, desired: pins)), "A second switch is a no-op")
        let absent = DockLayout(pinned: pins, recent: nil)
        let empty = DockLayout(pinned: pins, recent: [])
        check(absent.replacingPinned([]).recent == nil, "Keep absent recents absent")
        check(empty.replacingPinned([]).recent?.isEmpty == true, "Keep existing empty recent-apps array")
        check(!empty.matches(absent), "Differentiate absent and empty recent-apps preferences")

        let newPins = [fallback, chat]
        let partial = DockFixture(pins)
        partial.recent = before.recent
        partial.onWrite = {
            if dockTilesEqual($0.tiles, newPins) { $0.recent = before.recent }
        }
        check(failure { try DockTransaction(backend: partial).apply(expected: before, desired: newPins) } == .restored,
              "Restore a partially applied batch when both values belong to the transaction")
        check(try partial.readLayout().matches(before), "Partial rollback restores the entire pair exactly")
        check(!partial.events.contains("refresh"), "Do not refresh a partial commit")

        let refreshFailure = DockFixture(pins)
        refreshFailure.recent = before.recent
        refreshFailure.onRefresh = { _ in throw FixtureError.failed }
        check(failure { try DockTransaction(backend: refreshFailure).apply(expected: before, desired: newPins) } == .restored,
              "Restore both preference keys when Dock refresh cannot be performed")
        check(try refreshFailure.readLayout().matches(before), "Keep previous pins and recents after failed refresh")

        let conflict = DockFixture(pins)
        conflict.recent = before.recent
        conflict.onRead = { if $0.reads == 2 { $0.recent = [thirdParty] } }
        do {
            _ = try DockTransaction(backend: conflict).apply(expected: before, desired: newPins)
            fatalError("Recent-only conflict was ignored")
        } catch DockTransactionError.changedExternally {
            check(conflict.events == ["read", "read"], "Recheck recents before committing changed pins")
            check(dockTilesEqual(conflict.recent ?? [], [thirdParty]), "Preserve new recents from concurrent Dock use")
        }

        let concurrent = DockFixture(pins)
        concurrent.recent = before.recent
        concurrent.onRefresh = { $0.recent = [thirdParty]; throw FixtureError.failed }
        check(failure { try DockTransaction(backend: concurrent).apply(expected: before, desired: newPins) } == .externalChange,
              "Do not roll back across unrelated recent-apps changes")
        check(dockTilesEqual(concurrent.recent ?? [], [thirdParty]), "Rollback must never overwrite concurrent recent entries")
    }

    #if DOCK_BACKEND_TESTING
    private static func checkPreferenceAdapter(original: DockTiles, desired: DockTiles) throws {
        let id = UUID()
        let domain = SystemDockBackend.fixtureDomain(id)
        let key = "persistent-apps" as CFString
        let recentKey = "recent-apps" as CFString
        let unrelated: DockTile = ["persistent-others": [["label": "Untouched"]], "autohide": true, "show-recents": false]
        let duplicate = appTile("Design%20Page", guid: 11)
        let separate = appTile("Separate", bundle: "fixture.separate", guid: 12)
        let recents = [duplicate, separate]
        let initial = unrelated.merging([key as String: original, recentKey as String: recents]) { _, new in new }
        func readDomain() -> DockTile {
            CFPreferencesCopyMultiple(nil, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? DockTile ?? [:]
        }
        defer {
            CFPreferencesSetMultiple(nil, (Array(initial.keys) + ["static-only", "contents-immutable"]) as CFArray,
                                     domain, kCFPreferencesCurrentUser,
                                     kCFPreferencesAnyHost)
            _ = CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
            let home = FileManager.default.homeDirectoryForCurrentUser
            let plist = home.appendingPathComponent("Library/Preferences/\(domain as String).plist")
            // cfprefsd can persist the empty fixture after synchronize returns.
            Thread.sleep(forTimeInterval: 0.2)
            if let bytes = try? Data(contentsOf: plist),
               let empty = try? PropertyListSerialization.propertyList(from: bytes, options: [], format: nil) as? DockTile,
               empty.isEmpty {
                try? FileManager.default.removeItem(at: plist)
            }
        }
        CFPreferencesSetMultiple(initial as CFDictionary, nil, domain, kCFPreferencesCurrentUser,
                                 kCFPreferencesAnyHost)
        check(CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost), "Sync fixture domain")
        var refreshes = 0
        var failRefresh = false
        let backend = SystemDockBackend(fixture: id) {
            refreshes += 1
            if failRefresh { throw FixtureError.failed }
        }
        let captured = try backend.readLayout()
        check(captured.matches(DockLayout(pinned: original, recent: recents)), "Read both typed values from actual CFPreferences")
        let actualTransaction = DockTransaction(backend: backend)
        check(try actualTransaction.apply(expected: captured, desired: desired), "Commit batched changes to isolated CFPreferences")
        check(refreshes == 1, "Only fixture refresh invoked")
        var resulting = readDomain()
        resulting.removeValue(forKey: key as String)
        check(dockTilesEqual(resulting.removeValue(forKey: recentKey as String) as? DockTiles ?? [], [separate]),
              "Preserve unrelated recent tile byte values through actual CFPreferences")
        check((unrelated as NSDictionary).isEqual(to: resulting), "Leave unrelated keys in the actual domain intact")
        check(!(try actualTransaction.apply(expected: desired, desired: desired)), "No fixture writes for identical tiles")
        CFPreferencesSetValue(recentKey, recents as CFArray, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        check(CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost), "Reset fixture recents for rollback")
        let beforeFailure = try backend.readLayout()
        failRefresh = true
        check(failure { try actualTransaction.apply(expected: beforeFailure, desired: original) } == .restored,
              "Rollback in actual CFPreferences")
        check(try backend.readLayout().matches(beforeFailure), "Restore both verified preference values")
        check(refreshes == 2, "No spurious refresh in fixture rollback")
        for policy in ["static-only", "contents-immutable"] {
            let policyKey = policy as CFString
            CFPreferencesSetValue(policyKey, kCFBooleanTrue, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
            check(CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost), "Persist fixture policy")
            check(failure { try actualTransaction.apply(expected: desired, desired: original) } == .previousIntact,
                  "Honor Dock policy \(policy)")
            let lockedTiles = try backend.readTiles()
            check(refreshes == 2 && dockTilesEqual(lockedTiles, desired), "No write or refresh under policy")
            CFPreferencesSetValue(policyKey, nil, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
            _ = CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        }
    }

    private static func probeRunningDock() throws {
        let backend = SystemDockBackend()
        let pid = try backend.readOnlyDockProcessIdentifier()
        let captured = try backend.readLayout()
        let defaults = Process()
        defaults.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
        defaults.arguments = ["export", "com.apple.dock", "-"]
        let output = Pipe()
        defaults.standardOutput = output
        try defaults.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        defaults.waitUntilExit()
        let values = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? DockTile
        let exported = DockLayout(pinned: values?["persistent-apps"] as? DockTiles ?? [], recent: values?["recent-apps"] as? DockTiles)
        check(defaults.terminationStatus == 0 && captured.matches(exported), "Read-only check must match both keys in system export")
        let removed = (captured.recent?.count ?? 0) - (captured.replacingPinned(captured.pinned).recent?.count ?? 0)
        print("Read-only Dock: PID \(pid), \(captured.pinned.count) pins, \(captured.recent?.count ?? 0) recents, \(removed) duplicate recents")
    }
    #endif

    static func main() throws {
        try checkRecentDuplicates()
        let a: DockTile = ["GUID": 1, "tile-type": "file-tile", "tile-data": [
            "file-data": ["_CFURLString": "file:///Applications/Design%20Page.app/", "_CFURLStringType": 15],
            "book": Data([1, 2]), "dock-extra": true, "custom-key": ["nested": 7]
        ] as DockTile]
        let b: DockTile = ["GUID": 2, "tile-type": "small-spacer-tile", "tile-data": [:] as DockTile]
        let c: DockTile = ["GUID": 3, "tile-type": "unknown-tile", "tile-data": ["arbitrary": "保留"]]
        let original = [a, b, c]
        let design = [b, a]
        let external = [c, b]
        let fixture = DockFixture(original)
        let txn = DockTransaction(backend: fixture)
        var untouched = fixture.domain
        untouched.removeValue(forKey: "persistent-apps")

        check(try txn.apply(expected: original, desired: design), "Explicit switch should write")
        check(dockTilesEqual(fixture.tiles, design), "Preserve chosen raw tile order")
        check(fixture.events == ["read", "read", "write", "read", "refresh"], "Read back before refresh")
        check(!(try txn.apply(expected: design, desired: design)), "No-op repeats should not write")
        check(fixture.events.suffix(1) == ["read"], "No refresh after no-op")
        check(try txn.apply(expected: design, desired: original), "Restore complete baseline")
        check(dockTilesEqual(fixture.tiles, original), "Preserve unknown keys, bookmarks, spacers")
        var remaining = fixture.domain
        remaining.removeValue(forKey: "persistent-apps")
        check((untouched as NSDictionary).isEqual(to: remaining), "Leave right side and appearance alone")

        let alreadyChanged = DockFixture(external)
        do {
            _ = try DockTransaction(backend: alreadyChanged).apply(expected: original, desired: design)
            fatalError("Initial conflict was ignored")
        } catch DockTransactionError.changedExternally {
            check(alreadyChanged.events == ["read"], "Conflict must not write")
        }

        let lateChange = DockFixture(original)
        lateChange.onRead = { if $0.reads == 2 { $0.tiles = external } }
        do {
            _ = try DockTransaction(backend: lateChange).apply(expected: original, desired: design)
            fatalError("Late conflict was ignored")
        } catch DockTransactionError.changedExternally {
            check(lateChange.events == ["read", "read"], "Recheck before writing")
            check(dockTilesEqual(lateChange.tiles, external), "Respect concurrent edits")
        }

        let partialWrite = DockFixture(original)
        partialWrite.onWrite = {
            if dockTilesEqual($0.tiles, design) { throw FixtureError.failed }
        }
        check(failure { try DockTransaction(backend: partialWrite).apply(expected: original, desired: design) } == .restored,
              "Recover from a failed synchronize after the new value reached storage")
        check(dockTilesEqual(partialWrite.tiles, original), "Rollback restores exact tiles")
        check(!partialWrite.events.contains("refresh"), "Never refresh after failed write")

        let noWrite = DockFixture(original)
        noWrite.onWrite = { $0.tiles = original }
        check(failure { try DockTransaction(backend: noWrite).apply(expected: original, desired: design) } == .previousIntact,
              "Detect a backend that accepts but does not retain a write")
        check(noWrite.events.filter { $0 == "write" }.count == 1, "Do not restore an unchanged value")

        let failureDuringRefresh = DockFixture(original)
        failureDuringRefresh.onRefresh = { _ in throw FixtureError.failed }
        check(failure { try DockTransaction(backend: failureDuringRefresh).apply(expected: original, desired: design) } == .restored,
              "Restore previous preferences when signal is not delivered")
        check(failureDuringRefresh.events.filter { $0 == "refresh" }.count == 1, "No second refresh after signal rejection")
        check(dockTilesEqual(failureDuringRefresh.tiles, original), "Refresh failure restores baseline")

        let externalAfterWrite = DockFixture(original)
        externalAfterWrite.onWrite = { $0.tiles = external; throw FixtureError.failed }
        check(failure { try DockTransaction(backend: externalAfterWrite).apply(expected: original, desired: design) } == .externalChange,
              "Do not roll back a different layout")
        check(dockTilesEqual(externalAfterWrite.tiles, external), "Preserve externally written value after failed write")
        check(!externalAfterWrite.events.contains("refresh"), "Do not reload unrelated changes")

        let externalDuringRollback = DockFixture(original)
        externalDuringRollback.onWrite = { if dockTilesEqual($0.tiles, design) { throw FixtureError.failed } }
        externalDuringRollback.onRead = { if $0.reads == 4 { $0.tiles = external } }
        check(failure { try DockTransaction(backend: externalDuringRollback).apply(expected: original, desired: design) } == .externalChange,
              "Guard conditional rollback against late edit")
        check(dockTilesEqual(externalDuringRollback.tiles, external), "Preserve externally written value during rollback")

        let failedVerification = DockFixture(original)
        failedVerification.onRead = { if $0.reads == 3 { throw FixtureError.failed } }
        check(failure { try DockTransaction(backend: failedVerification).apply(expected: original, desired: design) } == .restored,
              "Recover after an intermittent read failure")
        check(!failedVerification.events.contains("refresh"), "Do not refresh after an unreadable write")

        let changedVerification = DockFixture(original)
        changedVerification.onRead = { if $0.reads == 3 { $0.tiles = external } }
        check(failure { try DockTransaction(backend: changedVerification).apply(expected: original, desired: design) } == .externalChange,
              "External readback disagreement must not overwrite it")
        check(changedVerification.events == ["read", "read", "write", "read"], "Stop after different value observed")
        check(dockTilesEqual(changedVerification.tiles, external), "Preserve externally written value at verification")

        let failedRollback = DockFixture(original)
        failedRollback.onRead = { if $0.reads >= 3 { throw FixtureError.failed } }
        check(failure { try DockTransaction(backend: failedRollback).apply(expected: original, desired: design) } == .unverified,
              "Report unknown state when even recovery cannot read preferences")
        check(!failedRollback.events.contains("refresh"), "Do not refresh unverified values")

        let opaque = try PropertyListSerialization.data(fromPropertyList: original, format: .binary, options: 0)
        let decoded = try PropertyListSerialization.propertyList(from: opaque, options: [], format: nil) as! DockTiles
        check(dockTilesEqual(original, decoded), "Round trip all captured plist types")
        check(!dockTilesEqual([["value": false]], [["value": 0]]), "Boolean differs from integer")
        check(!dockTilesEqual([["value": 1.0]], [["value": 1]]), "Real differs from integer")
        check(!dockTilesEqual([a, b], [b, a]), "Order matters")
        check(dockTileURL(a)?.path == "/Applications/Design Page.app", "Read an escaped local path")
        check(dockTileURL(b) == nil, "Spacers do not need a URL")
        check(dockTileURL(["tile-data": ["file-data": ["_CFURLString": "file://other/Applications/X.app"]]]) == nil,
              "Reject remote URLs")

        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }
        let app = base.appendingPathComponent("设计 样本.app", isDirectory: true)
        let contents = app.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let info = ["CFBundleIdentifier": "local.dockscenes.fixture", "CFBundlePackageType": "APPL", "CFBundleName": "Fixture"]
        let infoData = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try infoData.write(to: contents.appendingPathComponent("Info.plist"))
        let created = try makeDockTile(for: app)
        check(dockTileURL(created)?.path == app.path, "App tile stores canonical local file URL")
        check((created["tile-data"] as? DockTile)?["bundle-identifier"] as? String == info["CFBundleIdentifier"],
              "App tile records bundle identity")
        check(PropertyListSerialization.propertyList(created, isValidFor: .binary), "App tile is safe to persist")
        let alias = base.appendingPathComponent("应用别名.app")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: app)
        let aliasTile = try makeDockTile(for: alias)
        check(dockTileURL(aliasTile)?.path == alias.path, "Validate app symlinks and preserve their selected path")
        check((aliasTile["tile-data"] as? DockTile)?["bundle-identifier"] as? String == info["CFBundleIdentifier"],
              "Read symlinked bundle identity")
        var aliasWithoutID = aliasTile
        var aliasData = aliasWithoutID["tile-data"] as? DockTile ?? [:]
        aliasData.removeValue(forKey: "bundle-identifier")
        aliasWithoutID["tile-data"] = aliasData
        let canonical = DockLayout(pinned: [], recent: [aliasWithoutID]).replacingPinned([created])
        check(canonical.recent?.isEmpty == true, "Resolve symlinked tile paths for duplicate cleanup")
        do {
            _ = try makeDockTile(for: base.appendingPathComponent("Missing.app"))
            fatalError("Created a tile for a missing app")
        } catch {
            check(true, "Reject missing app at creation")
        }
        #if DOCK_BACKEND_TESTING
        try checkPreferenceAdapter(original: original, desired: design)
        if CommandLine.arguments.contains("--read-only-dock-probe") { try probeRunningDock() }
        #endif
        print("\(assertions) Dock transaction and tile checks passed using isolated preferences fixtures")
    }
}
