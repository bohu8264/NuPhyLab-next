import AppKit
import CoreFoundation
import Darwin
import Foundation

typealias DockTile = [String: Any]
typealias DockTiles = [DockTile]

struct DockLayout {
    let pinned: DockTiles
    // Absence is distinct from an explicitly empty recent-apps preference.
    let recent: DockTiles?

    func replacingPinned(_ tiles: DockTiles) -> DockLayout {
        guard let recent, !recent.isEmpty else { return DockLayout(pinned: tiles, recent: recent) }
        let pinnedApps = tiles.compactMap(DockAppTileIdentity.init)
        let bundleIDs = Set(pinnedApps.compactMap(\.bundleID))
        let paths = Set(pinnedApps.compactMap(\.path))
        let remaining = recent.filter { tile in
            guard let app = DockAppTileIdentity(tile) else { return true }
            return app.bundleID.map(bundleIDs.contains) != true && app.path.map(paths.contains) != true
        }
        return DockLayout(pinned: tiles, recent: remaining)
    }

    func matches(_ other: DockLayout) -> Bool {
        dockTilesEqual(pinned, other.pinned) && recentMatches(other)
    }

    func recentMatches(_ other: DockLayout) -> Bool {
        switch (recent, other.recent) {
        case (nil, nil): return true
        case (let lhs?, let rhs?): return dockTilesEqual(lhs, rhs)
        default: return false
        }
    }

    fileprivate func canRestore(from before: DockLayout, to after: DockLayout) -> Bool {
        // A batched write may commit only one key. In that case it is safe to restore
        // only if each observed value is from this transaction's own before/after pair.
        (dockTilesEqual(pinned, before.pinned) || dockTilesEqual(pinned, after.pinned)) &&
            (recentMatches(before) || recentMatches(after))
    }
}

private struct DockAppTileIdentity {
    let bundleID: String?
    let path: String?

    init?(_ tile: DockTile) {
        guard tile["tile-type"] as? String == "file-tile", let data = tile["tile-data"] as? DockTile else { return nil }
        let id = data["bundle-identifier"] as? String
        bundleID = id?.isEmpty == false ? id : nil
        path = dockTileURL(tile).flatMap { url in
            guard url.pathExtension.lowercased() == "app" else { return nil }
            return url.standardizedFileURL.resolvingSymlinksInPath().path
        }
        if bundleID == nil && path == nil { return nil }
    }
}

protocol DockBackend: Sendable {
    func readTiles() throws -> DockTiles
    func writeTiles(_ tiles: DockTiles) throws
    func replaceTiles(_ tiles: DockTiles, ifCurrent expected: DockTiles) throws
    func readLayout() throws -> DockLayout
    func replaceLayout(_ layout: DockLayout, ifCurrent expected: DockLayout) throws
    func refresh() throws
    func waitUntilReady() throws
    func refreshDelay() throws -> TimeInterval
}

extension DockBackend {
    // In-memory and file-backed Docks have no relaunched process to wait for.
    func waitUntilReady() throws {}
    func refreshDelay() throws -> TimeInterval { 0 }

    func replaceTiles(_ tiles: DockTiles, ifCurrent expected: DockTiles) throws {
        guard dockTilesEqual(try readTiles(), expected) else {
            throw DockTransactionError.changedExternally
        }
        try writeTiles(tiles)
    }

    func readLayout() throws -> DockLayout {
        DockLayout(pinned: try readTiles(), recent: nil)
    }

    func replaceLayout(_ layout: DockLayout, ifCurrent expected: DockLayout) throws {
        guard layout.recent == nil, expected.recent == nil else { throw DockTransactionError.invalidTiles }
        try replaceTiles(layout.pinned, ifCurrent: expected.pinned)
    }
}

enum DockRecovery {
    case previousIntact
    case restored
    case externalChange
    case unverified

    var description: String {
        switch self {
        case .previousIntact: return "原 Dock 布局仍在。"
        case .restored: return "已恢复切换前的 Dock 布局。"
        case .externalChange: return "检测到其他 Dock 更改，保留了当前内容。"
        case .unverified: return "暂时无法确认当前布局，原始备份仍保留。"
        }
    }
}

enum DockTransactionError: LocalizedError {
    case changedExternally
    case invalidTiles
    case failed(stage: String, recovery: DockRecovery)

    var errorDescription: String? {
        switch self {
        case .changedExternally: return "Dock 刚刚有更改。请查看当前布局后重试。"
        case .invalidTiles: return "无法读取此场景的 Dock 布局。"
        case let .failed(stage, recovery): return stage + recovery.description
        }
    }
}

struct DockTransaction: Sendable {
    let backend: any DockBackend

    @discardableResult
    func apply(expected: DockTiles, desired: DockTiles) throws -> Bool {
        let current = try backend.readLayout()
        guard dockTilesEqual(current.pinned, expected) else { throw DockTransactionError.changedExternally }
        return try apply(current: current, desired: desired)
    }

    @discardableResult
    func apply(expected: DockLayout, desired: DockTiles) throws -> Bool {
        let current = try backend.readLayout()
        guard current.matches(expected) else { throw DockTransactionError.changedExternally }
        return try apply(current: current, desired: desired)
    }

    // The caller already read the baseline. replaceLayout still checks the exact
    // pinned and recent values immediately before any write.
    func apply(current: DockLayout, desired: DockTiles) throws -> Bool {
        guard PropertyListSerialization.propertyList(desired, isValidFor: .binary) else {
            throw DockTransactionError.invalidTiles
        }
        let target = current.replacingPinned(desired)
        guard !current.matches(target) else { return false }

        do {
            try backend.replaceLayout(target, ifCurrent: current)
        } catch DockTransactionError.changedExternally {
            throw DockTransactionError.changedExternally
        } catch SystemDockError.unavailable {
            // SystemDockBackend checks process readiness before touching preferences.
            throw SystemDockError.unavailable
        } catch {
            throw DockTransactionError.failed(
                stage: error.localizedDescription,
                recovery: recover(previous: current, attempted: target)
            )
        }

        let written: DockLayout
        do {
            written = try backend.readLayout()
        } catch {
            throw DockTransactionError.failed(
                stage: "暂时无法核对写入结果。",
                recovery: recover(previous: current, attempted: target)
            )
        }
        guard written.matches(target) else {
            throw DockTransactionError.failed(
                stage: "Dock 写入结果与场景不一致。",
                recovery: recover(previous: current, attempted: target, observed: written)
            )
        }

        do {
            try backend.refresh()
        } catch {
            throw DockTransactionError.failed(
                stage: error.localizedDescription,
                recovery: recover(previous: current, attempted: target)
            )
        }
        return true
    }

    private func recover(previous: DockLayout, attempted: DockLayout, observed: DockLayout? = nil) -> DockRecovery {
        do {
            let current = try observed ?? backend.readLayout()
            if current.matches(previous) { return .previousIntact }
            guard current.canRestore(from: previous, to: attempted) else { return .externalChange }
            try backend.replaceLayout(previous, ifCurrent: current)
            let restored = try backend.readLayout()
            if restored.matches(previous) { return .restored }
            return restored.canRestore(from: previous, to: attempted) ? .unverified : .externalChange
        } catch DockTransactionError.changedExternally {
            return .externalChange
        } catch {
            return .unverified
        }
    }
}

enum SystemDockError: LocalizedError {
    case unavailable
    case readFailed
    case writeFailed
    case protected
    case refreshFailed
    case notApplication

    var errorDescription: String? {
        switch self {
        case .unavailable: return "Dock 正在启动或暂时不可用。"
        case .readFailed: return "暂时无法读取 Dock 的固定应用。"
        case .writeFailed: return "无法保存 Dock 布局。"
        case .protected: return "系统策略锁定了 Dock 固定应用。"
        case .refreshFailed: return "暂时无法刷新 Dock。"
        case .notApplication: return "请选择一个已安装的 Mac 应用。"
        }
    }
}

struct SystemDockBackend: DockBackend, @unchecked Sendable {
    private final class DockRestart {
        private let lock = NSLock()
        private var previousPID: pid_t?

        func noteSignal(to pid: pid_t) {
            lock.withLock { previousPID = pid }
        }

        var pendingPID: pid_t? { lock.withLock { previousPID } }

        func finish(_ pid: pid_t) {
            lock.withLock {
                if previousPID == pid { previousPID = nil }
            }
        }
    }

    private let appID: CFString
    private let appsKey = "persistent-apps" as CFString
    private let recentsKey = "recent-apps" as CFString
    private let restart = DockRestart()
    #if DOCK_BACKEND_TESTING
    private let testRefresh: (() throws -> Void)?
    #endif

    init() {
        appID = "com.apple.dock" as CFString
        #if DOCK_BACKEND_TESTING
        testRefresh = nil
        #endif
    }

    #if DOCK_BACKEND_TESTING
    static func fixtureDomain(_ id: UUID) -> CFString {
        "local.nuphylab.dockscenes.fixture.\(id.uuidString)" as CFString
    }

    init(fixture id: UUID, refresh: @escaping () throws -> Void) {
        appID = Self.fixtureDomain(id)
        testRefresh = refresh
    }

    func readOnlyDockProcessIdentifier() throws -> pid_t { try currentDock().processIdentifier }
    #endif

    func readTiles() throws -> DockTiles {
        guard synchronize(),
              let tiles = CFPreferencesCopyValue(
                appsKey, appID, kCFPreferencesCurrentUser, kCFPreferencesAnyHost
              ) as? DockTiles,
              PropertyListSerialization.propertyList(tiles, isValidFor: .binary) else {
            throw SystemDockError.readFailed
        }
        return tiles
    }

    func readLayout() throws -> DockLayout {
        guard synchronize(),
              let values = CFPreferencesCopyMultiple([appsKey, recentsKey] as CFArray, appID,
                kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? DockTile,
              let pinned = values[appsKey as String] as? DockTiles,
              PropertyListSerialization.propertyList(pinned, isValidFor: .binary) else {
            throw SystemDockError.readFailed
        }
        guard let stored = values[recentsKey as String] else { return DockLayout(pinned: pinned, recent: nil) }
        guard let recent = stored as? DockTiles,
              PropertyListSerialization.propertyList(recent, isValidFor: .binary) else {
            throw SystemDockError.readFailed
        }
        return DockLayout(pinned: pinned, recent: recent)
    }

    func writeTiles(_ tiles: DockTiles) throws {
        try checkWritable()
        try setTiles(tiles)
    }

    func replaceTiles(_ tiles: DockTiles, ifCurrent expected: DockTiles) throws {
        try checkWritable()
        // CFPreferences exposes no atomic conditional write. Read the exact key immediately
        // before setting it, then verify the result in DockTransaction before refreshing.
        guard dockTilesEqual(try readTiles(), expected) else {
            throw DockTransactionError.changedExternally
        }
        try setTiles(tiles)
    }

    func replaceLayout(_ layout: DockLayout, ifCurrent expected: DockLayout) throws {
        let pinnedChanged = !dockTilesEqual(layout.pinned, expected.pinned)
        let recentChanged = !layout.recentMatches(expected)
        let keys = (pinnedChanged ? [appsKey] : []) + (recentChanged ? [recentsKey] : [])
        guard !keys.isEmpty else { return }
        try checkWritable(keys: keys)

        var changes: DockTile = [:]
        var removals: [CFString] = []
        if pinnedChanged { changes[appsKey as String] = layout.pinned }
        if recentChanged {
            if let recent = layout.recent { changes[recentsKey as String] = recent }
            else { removals.append(recentsKey) }
        }
        guard PropertyListSerialization.propertyList(changes, isValidFor: .binary) else {
            throw DockTransactionError.invalidTiles
        }
        // Keep the last read and conditional check close to the keyed batch write.
        // CFPreferences doesn't expose an atomic compare-and-set across processes.
        guard try readLayout().matches(expected) else { throw DockTransactionError.changedExternally }
        CFPreferencesSetMultiple(changes as CFDictionary, removals as CFArray, appID,
                                 kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        guard synchronize() else { throw SystemDockError.writeFailed }
    }

    func refresh() throws {
        #if DOCK_BACKEND_TESTING
        if let testRefresh { try testRefresh(); return }
        #endif
        let dock = try currentDock()
        // Dock's ordinary exit can flush stale in-memory pins over the verified
        // write. Restart only this validated system Dock instance without that flush.
        guard kill(dock.processIdentifier, SIGKILL) == 0 else { throw SystemDockError.refreshFailed }
        // A successful signal may already be starting the new Dock. Do not roll back
        // preferences after this point or block the UI while LaunchServices catches up.
        restart.noteSignal(to: dock.processIdentifier)
    }

    func refreshDelay() throws -> TimeInterval {
        #if DOCK_BACKEND_TESTING
        if testRefresh != nil { return 0 }
        #endif
        let dock = try currentDock()
        guard let info = dockProcessInfo(dock.processIdentifier) else { throw SystemDockError.unavailable }
        let launchedAt = Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000
        let age = Date().timeIntervalSince1970 - launchedAt
        // launchd delays another launch if Dock exits in its first second.
        // Let the current Dock stay visible until it can be restarted promptly.
        guard launchedAt > 0, age >= 0 else { return 0 }
        return max(0, 1.10 - age)
    }

    func waitUntilReady() throws {
        #if DOCK_BACKEND_TESTING
        if testRefresh != nil { return }
        #endif
        // Only called on the serial switch worker. Dock can briefly disappear, then
        // finish launching before its preferences have settled. Observe the replacement
        // PID across several reads before another request is allowed to write.
        let departed = restart.pendingPID
        let clock = ProcessInfo.processInfo
        let started = clock.systemUptime
        var candidate: pid_t?
        repeat {
            if let pid = try? currentDock().processIdentifier, pid != departed {
                guard let departed else { return }
                if pid == candidate {
                    restart.finish(departed)
                    return
                }
                candidate = pid
            } else {
                candidate = nil
            }
            Thread.sleep(forTimeInterval: clock.systemUptime - started < 0.5 ? 0.02 : 0.06)
        } while clock.systemUptime - started < 5
        // A timeout does not make the departing process a valid target again.
        throw SystemDockError.unavailable
    }

    private func checkWritable(keys: [CFString] = ["persistent-apps" as CFString]) throws {
        if keys.contains(where: { CFPreferencesAppValueIsForced($0, appID) }) ||
            ["contents-immutable", "static-only"].contains(where: {
                CFPreferencesCopyAppValue($0 as CFString, appID) as? Bool == true
            }) {
            throw SystemDockError.protected
        }
        guard geteuid() != 0 else { throw SystemDockError.protected }
        #if DOCK_BACKEND_TESTING
        if testRefresh != nil { return }
        #endif
        _ = try currentDock()
        guard restart.pendingPID == nil else { throw SystemDockError.unavailable }
    }

    private func currentDock() throws -> NSRunningApplication {
        let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").filter {
            !$0.isTerminated && $0.isFinishedLaunching && $0.processIdentifier > 1 &&
                $0.bundleURL?.standardizedFileURL.path == "/System/Library/CoreServices/Dock.app" &&
                $0.executableURL?.standardizedFileURL.path == "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock" &&
                isCurrentUserDock($0.processIdentifier)
        }
        guard candidates.count == 1, let dock = candidates.first else { throw SystemDockError.unavailable }
        return dock
    }

    private func isCurrentUserDock(_ pid: pid_t) -> Bool {
        guard dockProcessInfo(pid) != nil else { return false }
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = path.withUnsafeMutableBufferPointer {
            proc_pidpath(pid, $0.baseAddress, UInt32($0.count))
        }
        return length > 0 && String(cString: path) == "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock"
    }

    private func dockProcessInfo(_ pid: pid_t) -> proc_bsdinfo? {
        var activity = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &activity, size) == size,
              activity.pbi_uid == geteuid(), activity.pbi_ruid == getuid(),
              activity.pbi_flags & UInt32(PROC_FLAG_INEXIT) == 0 else { return nil }
        return activity
    }

    private func setTiles(_ tiles: DockTiles) throws {
        guard PropertyListSerialization.propertyList(tiles, isValidFor: .binary) else {
            throw DockTransactionError.invalidTiles
        }
        CFPreferencesSetValue(appsKey, tiles as CFArray, appID, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        guard synchronize() else { throw SystemDockError.writeFailed }
    }

    private func synchronize() -> Bool {
        CFPreferencesSynchronize(appID, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
    }
}

func dockTilesEqual(_ lhs: DockTiles, _ rhs: DockTiles) -> Bool {
    plistValuesEqual(lhs, rhs)
}

func dockPinsMatch(_ lhs: DockTiles, _ rhs: DockTiles) -> Bool {
    guard lhs.count == rhs.count else { return false }
    return zip(lhs, rhs).allSatisfy { left, right in
        if plistValuesEqual(left, right) { return true }
        guard let leftApp = normalizedAppPin(left), let rightApp = normalizedAppPin(right) else { return false }
        return plistValuesEqual(leftApp, rightApp)
    }
}

private func normalizedAppPin(_ pin: DockTile) -> DockTile? {
    // Only on installed-app tiles. Opaque native items and other settings keep
    // their original full comparison. These fields are regenerated by Dock.
    guard pin["tile-type"] as? String == "file-tile",
          let identity = DockAppTileIdentity(pin), let path = identity.path,
          var data = pin["tile-data"] as? DockTile else { return nil }
    for key in ["book", "file-mod-date", "parent-mod-date"] { data.removeValue(forKey: key) }
    data["file-data"] = path
    var normalized = pin
    normalized.removeValue(forKey: "GUID")
    normalized["tile-data"] = data
    return normalized
}

private func plistValuesEqual(_ lhs: Any, _ rhs: Any) -> Bool {
    if let left = lhs as? [String: Any], let right = rhs as? [String: Any] {
        return left.count == right.count && left.allSatisfy { key, value in
            guard let other = right[key] else { return false }
            return plistValuesEqual(value, other)
        }
    }
    if let left = lhs as? [Any], let right = rhs as? [Any] {
        return left.count == right.count && zip(left, right).allSatisfy { plistValuesEqual($0, $1) }
    }
    if let left = lhs as? NSNumber, let right = rhs as? NSNumber {
        // NSObject equality treats true as 1 and integral reals as integers.
        // Preference tiles contain both types, so keep their plist types distinct.
        return CFGetTypeID(left) == CFGetTypeID(right) &&
            isRealNumber(left) == isRealNumber(right) && left == right
    }
    if let left = lhs as? String, let right = rhs as? String { return left.utf8.elementsEqual(right.utf8) }
    if let left = lhs as? Data, let right = rhs as? Data { return left == right }
    if let left = lhs as? Date, let right = rhs as? Date { return left == right }
    return false
}

private func isRealNumber(_ number: NSNumber) -> Bool {
    let type = String(cString: number.objCType)
    return type == "f" || type == "d"
}

func dockTileURL(_ tile: DockTile) -> URL? {
    guard let data = tile["tile-data"] as? DockTile,
          let fileData = data["file-data"] as? DockTile,
          let value = fileData["_CFURLString"] as? String else { return nil }
    // Old tiles may use a filesystem path rather than a CFURL string.
    if value.hasPrefix("/") { return URL(fileURLWithPath: value) }
    guard let url = URL(string: value), url.isFileURL, url.path.hasPrefix("/"),
          url.host == nil || url.host == "" || url.host?.lowercased() == "localhost" else { return nil }
    return url
}

func makeDockTile(for url: URL) throws -> DockTile {
    guard url.isFileURL, url.host == nil || url.host == "" || url.host?.lowercased() == "localhost",
          url.pathExtension.lowercased() == "app" else { throw SystemDockError.notApplication }
    let file = URL(fileURLWithPath: url.standardizedFileURL.path, isDirectory: true)
    let resolved = file.resolvingSymlinksInPath()
    guard let values = try? resolved.resourceValues(forKeys: [.isDirectoryKey, .localizedNameKey]),
          values.isDirectory == true,
          let bundle = Bundle(url: resolved), let identifier = bundle.bundleIdentifier else {
        throw SystemDockError.notApplication
    }
    var tileData: DockTile = [
        "bundle-identifier": identifier,
        "dock-extra": false,
        "file-data": ["_CFURLString": file.absoluteString, "_CFURLStringType": 15] as DockTile,
        "file-label": values.localizedName ?? file.deletingPathExtension().lastPathComponent,
        "file-type": 41,
        "is-beta": false
    ]
    if let bookmark = try? file.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
        tileData["book"] = bookmark
    }
    return ["GUID": UInt32.random(in: 1...UInt32.max), "tile-data": tileData, "tile-type": "file-tile"]
}
