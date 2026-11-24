import Foundation
import SQLite3

/// File references that must survive expiry. Inspect file records only, on the
/// transfer worker. Any unreadable store leaves potentially referenced jobs alone.
enum PocketTransferReferences {
    private struct Item: Decodable { let files: [String] }
    private struct State: Decodable { let version: Int; let slots: [Item?]; let history: [[Item?]] }
    private struct ClipFile: Decodable { let path: String }

    static func protectedJobs(in cache: URL, clipboardFiles: [URL]?) throws -> Set<String>? {
        guard let clipboardFiles else { return nil }
        let root = cache.deletingLastPathComponent()
        let path = cache.standardizedFileURL.resolvingSymlinksInPath().path.lowercased()
        var references = Set(clipboardFiles.map(\.absoluteString))
        let store = root.appendingPathComponent("pockets.json")
        if try exists(store) {
            let info = try store.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard info.isRegularFile == true, info.isSymbolicLink != true,
                  let size = info.fileSize, size <= 64 * 1024 * 1024 else { return nil }
            let state = try JSONDecoder().decode(State.self, from: Data(contentsOf: store, options: .mappedIfSafe))
            guard state.version == 1 else { return nil }
            for snapshot in [state.slots] + state.history {
                for item in snapshot.compactMap({ $0 }) { references.formUnion(item.files) }
            }
        }
        let history = root.deletingLastPathComponent().appendingPathComponent("smart-clipboard")
        if try exists(history) {
            guard try history.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { return nil }
            let db = history.appendingPathComponent("history.sqlite")
            if try exists(db) { try addClipboardFiles(db, to: &references) }
        }
        var jobs = Set<String>()
        for ref in references {
            guard let url = URL(string: ref), url.isFileURL, ["", "localhost"].contains(url.host?.lowercased() ?? "") else { return nil }
            let file = url.standardizedFileURL.resolvingSymlinksInPath().path.lowercased()
            if file == "/" || file == path || path.hasPrefix(file + "/") { return nil }
            if file.hasPrefix(path + "/"), let job = file.dropFirst(path.count + 1).split(separator: "/").first {
                jobs.insert(String(job))
            }
        }
        return jobs
    }

    private static func exists(_ url: URL) throws -> Bool {
        var info = stat()
        if lstat(url.path, &info) == 0 { return true }
        if errno == ENOENT { return false }
        throw PocketFolderTransferError.unsafeCache
    }

    private static func addClipboardFiles(_ url: URL, to references: inout Set<String>) throws {
        let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard info.isRegularFile == true, info.isSymbolicLink != true else { throw PocketFolderTransferError.unsafeCache }
        var db: OpaquePointer?
        defer { sqlite3_close_v2(db) }
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK else {
            throw PocketFolderTransferError.unsafeCache
        }
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "SELECT payload FROM clips WHERE kind='files'", -1, &statement, nil) == SQLITE_OK else {
            throw PocketFolderTransferError.unsafeCache
        }
        var step = sqlite3_step(statement)
        while step == SQLITE_ROW {
            let size = Int(sqlite3_column_bytes(statement, 0))
            guard size <= 12 * 1024 * 1024, let bytes = sqlite3_column_blob(statement, 0) else { throw PocketFolderTransferError.unsafeCache }
            let files = try JSONDecoder().decode([ClipFile].self, from: Data(bytes: bytes, count: size))
            references.formUnion(files.map(\.path))
            step = sqlite3_step(statement)
        }
        guard step == SQLITE_DONE else { throw PocketFolderTransferError.unsafeCache }
    }
}
