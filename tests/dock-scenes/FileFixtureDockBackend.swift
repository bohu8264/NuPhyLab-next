import Foundation

struct FileFixtureDockBackend: DockBackend, Sendable {
    let url: URL

    func readTiles() throws -> DockTiles {
        try readLayout().pinned
    }

    func readLayout() throws -> DockLayout {
        try layout(in: readDomain())
    }

    private func layout(in root: DockTile) throws -> DockLayout {
        guard let tiles = root["persistent-apps"] as? DockTiles else {
            throw CocoaError(.fileReadCorruptFile)
        }
        guard let stored = root["recent-apps"] else { return DockLayout(pinned: tiles, recent: nil) }
        guard let recent = stored as? DockTiles else { throw CocoaError(.fileReadCorruptFile) }
        return DockLayout(pinned: tiles, recent: recent)
    }

    func writeTiles(_ tiles: DockTiles) throws {
        var root = try readDomain()
        root["persistent-apps"] = tiles
        try writeDomain(root)
    }

    func replaceLayout(_ desired: DockLayout, ifCurrent expected: DockLayout) throws {
        var root = try readDomain()
        guard try layout(in: root).matches(expected) else { throw DockTransactionError.changedExternally }
        root["persistent-apps"] = desired.pinned
        root["recent-apps"] = desired.recent
        try writeDomain(root)
    }

    private func writeDomain(_ root: DockTile) throws {
        let data = try PropertyListSerialization.data(fromPropertyList: root, format: .binary, options: 0)
        try data.write(to: url, options: .atomic)
    }

    func refresh() throws {
        if FileManager.default.fileExists(atPath: url.deletingLastPathComponent().appendingPathComponent("fail-refresh").path) {
            throw CocoaError(.fileWriteUnknown)
        }
    }

    private func readDomain() throws -> [String: Any] {
        guard let root = try PropertyListSerialization.propertyList(from: Data(contentsOf: url),
                                                                     options: [], format: nil) as? [String: Any] else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return root
    }
}
