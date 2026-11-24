import Foundation
import Darwin
import CryptoKit

struct PocketPreparedFileTransfer {
    let urls: [URL]
    let archived: Bool
    fileprivate let temporaryDirectory: URL?
    fileprivate let token: String?
}

struct PocketFolderTransferLimits {
    var maximumEntries = 10_000
    var maximumBytes: Int64 = 1024 * 1024 * 1024
    var maximumCacheBytes: Int64 = 4 * 1024 * 1024 * 1024
    var timeout: TimeInterval = 60
}

enum PocketFolderTransferError: Error, LocalizedError {
    case limit, timeout, cacheFull, unsafeCache, changed
    var errorDescription: String? {
        switch self {
        case .limit: return PocketL10n.english ? "Folder exceeds 10,000 entries or 1 GB. Choose fewer files." : "文件夹超过 10,000 项或 1 GB，请缩小范围。"
        case .timeout: return PocketL10n.english ? "Folder preparation timed out. Originals were kept." : "文件夹打包超时，原内容已保留。"
        case .cacheFull: return PocketL10n.english ? "Folder transfer cache is full. Check storage in Keyboard Pocket." : "文件夹传输缓存已满，可在键盘口袋查看占用空间。"
        case .unsafeCache: return PocketL10n.english ? "Temporary transfer folder is unavailable. Originals were kept." : "临时文件夹不可用，原内容已保留。"
        case .changed: return PocketL10n.english ? "The folder changed while preparing. Try again." : "文件夹在打包时发生变化，请重试。"
        }
    }
}

/// Local compatibility preparation only. Call on a worker queue after explicit
/// retrieval. The controller must recheck its generation, target and focus
/// before writing the clipboard or posting Command-V. This code never sends.
enum PocketFolderTransfer {
    // Verified against the installed application and native Finder paste. Do
    // not infer other applications or Lark editions from their display names.
    static let supportedTargets: Set<String> = ["com.bytedance.macos.feishu"]
    static let retention: TimeInterval = 7 * 24 * 60 * 60
    private static let workLock = NSLock()
    private static let cleanupQueue = DispatchQueue(label: "local.nuphylab.pocket.transfer-cleanup", qos: .utility)
    private static let markerName = ".pocket-transfer.json"
    private struct Marker: Codable {
        let version: Int
        let token: String
        var createdAt: Date
        let archive: String
        var sourceKey: String?
        var archiveSignature: Signature?
        var shared: Bool?
    }
    private struct Signature: Equatable, Codable {
        let device: Int32, inode: UInt64, mode: UInt16, size: Int64
        let mtime: Int, mtimeNanos: Int, ctime: Int, ctimeNanos: Int
        init(_ info: stat) {
            device=info.st_dev;inode=info.st_ino;mode=info.st_mode;size=info.st_size
            mtime=info.st_mtimespec.tv_sec;mtimeNanos=info.st_mtimespec.tv_nsec
            ctime=info.st_ctimespec.tv_sec;ctimeNanos=info.st_ctimespec.tv_nsec
        }
    }

    static func needsArchive(_ urls: [URL], targetBundleIdentifier: String?) throws -> Bool {
        guard let targetBundleIdentifier, supportedTargets.contains(targetBundleIdentifier) else { return false }
        var containsDirectory = false
        for url in urls {
            let info = try metadata(url)
            containsDirectory = containsDirectory || info.st_mode & S_IFMT == S_IFDIR
        }
        return containsDirectory
    }

    static func prepare(_ urls: [URL], targetBundleIdentifier: String?, pocketRoot: URL,
                        control: DragJobControl, limits: PocketFolderTransferLimits = PocketFolderTransferLimits(),
                        now: Date = Date(), clipboardFiles: () -> [URL]? = { [] }) throws -> PocketPreparedFileTransfer {
        try control.check()
        guard try needsArchive(urls, targetBundleIdentifier: targetBundleIdentifier) else {
            return PocketPreparedFileTransfer(urls: urls, archived: false, temporaryDirectory: nil, token: nil)
        }
        guard !urls.isEmpty, urls.count <= 128, limits.maximumEntries > 0,
              limits.maximumBytes > 0, limits.maximumCacheBytes > 0,
              limits.timeout.isFinite, limits.timeout > 0 else { throw PocketFolderTransferError.limit }
        let deadline = ProcessInfo.processInfo.systemUptime + limits.timeout
        let timeout = DispatchWorkItem { control.cancel() }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + limits.timeout, execute: timeout)
        defer { timeout.cancel() }
        func check() throws {
            if ProcessInfo.processInfo.systemUptime >= deadline { throw PocketFolderTransferError.timeout }
            try control.check()
        }
        // Serialize cache accounting and expiry without blocking the UI. Check
        // cancellation while another worker is winding down.
        while !workLock.lock(before: Date().addingTimeInterval(0.05)) { try check() }
        defer { workLock.unlock() }
        do {
            try check()
            let cache = pocketRoot.appendingPathComponent("transfer", isDirectory: true)
            let cachePath = cache.resolvingSymlinksInPath().standardizedFileURL.path
            for url in urls {
                let path = url.resolvingSymlinksInPath().standardizedFileURL.path
                // Both directions matter: do not include our output tree, and
                // do not expire a cached archive that is an input to this job.
                guard path != cachePath, !path.hasPrefix(cachePath + "/") else { throw PocketFolderTransferError.unsafeCache }
                if try metadata(url).st_mode & S_IFMT == S_IFDIR {
                    guard !cachePath.hasPrefix(path + "/") else { throw PocketFolderTransferError.unsafeCache }
                }
            }
            let before = try snapshot(urls, limits: limits, check: check)
            try ensureDirectory(pocketRoot, create: false)
            try ensureDirectory(cache, create: true)
            let key = sourceKey(urls, entries: before.entries)
            let scan = try inspect(cache, now: now, key: key, clipboardFiles: clipboardFiles, check: check)
            guard scan.bytes <= limits.maximumCacheBytes else { throw PocketFolderTransferError.cacheFull }
            if let (job, candidate) = scan.reusable {
                var marker = candidate
                // Directory enumeration may expand /var to /private/var. Publish the
                // same file URL spelling as a newly prepared transfer.
                let archive = cache.appendingPathComponent(job.lastPathComponent, isDirectory: true)
                    .appendingPathComponent(marker.archive, isDirectory: false)
                guard try snapshot(urls, limits: limits, check: check).entries == before.entries,
                      try Signature(metadata(archive)) == marker.archiveSignature else { throw PocketFolderTransferError.changed }
                try check()
                marker.createdAt = now
                marker.shared = true
                let markerURL = job.appendingPathComponent(markerName)
                let data = try JSONEncoder().encode(marker)
                let growth = Int64(data.count) - (try metadata(markerURL).st_size)
                guard growth <= limits.maximumCacheBytes - scan.bytes else { throw PocketFolderTransferError.cacheFull }
                try data.write(to: markerURL, options: .atomic)
                // Another caller may already have exposed these exact bytes to a receiver.
                return PocketPreparedFileTransfer(urls: [archive], archived: true, temporaryDirectory: nil, token: nil)
            }
            let used = scan.bytes
            // Reserve the full expanded size plus ZIP metadata overhead; actual
            // compressed size is checked again before publishing the result.
            let reservation = before.bytes + Int64(before.entries.count) * 2048 + 65536
            guard reservation <= limits.maximumCacheBytes - used else { throw PocketFolderTransferError.cacheFull }
            let token = UUID().uuidString
            let job = cache.appendingPathComponent("pocket-" + token, isDirectory: true)
            guard mkdir(job.path, 0o700) == 0 else { throw PocketFolderTransferError.unsafeCache }
            var keep = false
            defer { if !keep { try? FileManager.default.removeItem(at: job) } }
            var preferences = DragConvertPreferences()
            preferences.outputDirectory = job.path
            let archive = try DragArchiveConverter.convert(urls, to: .zip, preferences: preferences, control: control)
            try check()
            let after = try snapshot(urls, limits: limits, check: check)
            guard before.entries == after.entries else { throw PocketFolderTransferError.changed }
            let size = try metadata(archive).st_size
            guard size >= 0, size <= limits.maximumCacheBytes - used else { throw PocketFolderTransferError.cacheFull }
            guard chmod(archive.path, 0o600) == 0 else { throw PocketFolderTransferError.unsafeCache }
            let marker = Marker(version: 1, token: token, createdAt: now, archive: archive.lastPathComponent,
                                sourceKey: key, archiveSignature: try Signature(metadata(archive)))
            let markerData = try JSONEncoder().encode(marker)
            guard Int64(markerData.count) <= limits.maximumCacheBytes - used - size else { throw PocketFolderTransferError.cacheFull }
            try markerData.write(to: job.appendingPathComponent(markerName), options: .atomic)
            try check()
            keep = true
            return PocketPreparedFileTransfer(urls: [archive], archived: true, temporaryDirectory: job, token: token)
        } catch {
            if ProcessInfo.processInfo.systemUptime >= deadline { throw PocketFolderTransferError.timeout }
            throw error
        }
    }

    /// Only before the result has been exposed to another app. Successful
    /// pastes retain their archive for seven days because receivers read later.
    static func discard(_ result: PocketPreparedFileTransfer, completion: @escaping () -> Void = {}) {
        // Callable from main. Neither waiting for an active archive job nor
        // walking/removing files is allowed to block the UI thread.
        cleanupQueue.async {
            defer { completion() }
            guard let job = result.temporaryDirectory, let token = result.token else { return }
            workLock.lock(); defer { workLock.unlock() }
            guard let owned = try? ownedArchive(job), owned.marker.token == token, owned.marker.shared != true else { return }
            try? removeArchive(job, marker: owned.marker)
        }
    }

    /// Opening Lab or waking it can expire transfers even when the user never makes another ZIP.
    static func maintain(pocketRoot: URL, now: Date = Date(), clipboardFiles: @escaping () -> [URL]?,
                         completion: @escaping (Int64?) -> Void) {
        cleanupQueue.async {
            workLock.lock()
            let bytes: Int64?
            do {
                try ensureDirectory(pocketRoot, create: false)
                let cache = pocketRoot.appendingPathComponent("transfer", isDirectory: true)
                var info = stat()
                if lstat(cache.path, &info) != 0 && errno == ENOENT {
                    bytes = 0
                } else {
                    try ensureDirectory(cache, create: false)
                    bytes = try inspect(cache, now: now, key: nil, clipboardFiles: clipboardFiles, check: {}).bytes
                }
            } catch { bytes = nil }
            workLock.unlock()
            completion(bytes)
        }
    }

    private static func metadata(_ url: URL) throws -> stat {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else { throw DragConvertError.unreadable }
        var info = stat()
        guard lstat(url.path, &info) == 0 else { throw DragConvertError.unreadable }
        guard info.st_mode & S_IFMT == S_IFDIR || info.st_mode & S_IFMT == S_IFREG else { throw DragArchiveError.links }
        return info
    }
    private static func ensureDirectory(_ url: URL, create: Bool) throws {
        if create, mkdir(url.path, 0o700) != 0, errno != EEXIST { throw PocketFolderTransferError.unsafeCache }
        let info = try metadata(url)
        guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else { throw PocketFolderTransferError.unsafeCache }
    }
    private static func snapshot(_ urls: [URL], limits: PocketFolderTransferLimits, check: () throws -> Void) throws -> (entries: [String: Signature], bytes: Int64) {
        var entries = [String: Signature](), bytes: Int64 = 0
        func record(_ url: URL) throws {
            try check()
            let path = url.standardizedFileURL.path
            if entries[path] != nil { return }
            let info = try metadata(url)
            guard entries.count < limits.maximumEntries else { throw PocketFolderTransferError.limit }
            if info.st_mode & S_IFMT == S_IFREG {
                guard info.st_nlink == 1 else { throw DragArchiveError.links }
                guard info.st_size >= 0, info.st_size <= limits.maximumBytes - bytes else { throw PocketFolderTransferError.limit }
                bytes += info.st_size
            }
            entries[path] = Signature(info)
        }
        for url in urls {
            try record(url)
            if try metadata(url).st_mode & S_IFMT == S_IFDIR {
                var failure: Error?
                guard let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil, options: [], errorHandler: { _,error in failure=error; return false }) else { throw DragConvertError.unreadable }
                for case let child as URL in walker { try record(child) }
                if let failure { throw failure }
            }
        }
        return (entries, bytes)
    }
    private static func ownedArchive(_ job: URL) throws -> (marker: Marker, bytes: Int64)? {
        guard job.lastPathComponent.hasPrefix("pocket-"),
              UUID(uuidString: String(job.lastPathComponent.dropFirst(7))) != nil else { return nil }
        let info = try metadata(job)
        guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else { return nil }
        let markerURL = job.appendingPathComponent(markerName)
        let markerInfo = try metadata(markerURL)
        guard markerInfo.st_mode & S_IFMT == S_IFREG, markerInfo.st_size <= 4096, markerInfo.st_nlink == 1,
              markerInfo.st_uid == getuid() else { return nil }
        let marker = try JSONDecoder().decode(Marker.self, from: Data(contentsOf: markerURL))
        guard marker.version == 1, job.lastPathComponent == "pocket-" + marker.token,
              !marker.archive.isEmpty, marker.archive == URL(fileURLWithPath: marker.archive).lastPathComponent,
              marker.archive.hasSuffix(".zip") else { return nil }
        let contents = try FileManager.default.contentsOfDirectory(atPath: job.path)
        guard Set(contents) == Set([markerName, marker.archive]) else { return nil }
        let archiveInfo = try metadata(job.appendingPathComponent(marker.archive))
        guard archiveInfo.st_mode & S_IFMT == S_IFREG, archiveInfo.st_nlink == 1, archiveInfo.st_size >= 0,
              archiveInfo.st_uid == getuid(), marker.createdAt.timeIntervalSinceReferenceDate.isFinite,
              (archiveInfo.st_mtimespec.tv_sec, archiveInfo.st_mtimespec.tv_nsec) <= (markerInfo.st_mtimespec.tv_sec, markerInfo.st_mtimespec.tv_nsec),
              marker.archiveSignature.map({ $0 == Signature(archiveInfo) }) ?? true else { return nil }
        guard markerInfo.st_size <= Int64.max - archiveInfo.st_size else { throw PocketFolderTransferError.cacheFull }
        return (marker, archiveInfo.st_size + markerInfo.st_size)
    }
    private static func sourceKey(_ urls: [URL], entries: [String: Signature]) -> String {
        var hash = SHA256()
        func append(_ value: String) { hash.update(data: value.utf8 + [0]) }
        for url in urls { append(url.standardizedFileURL.path) }
        append("")
        for (path, s) in entries.sorted(by: { $0.key < $1.key }) {
            append(path)
            append("\(s.device),\(s.inode),\(s.mode),\(s.size),\(s.mtime),\(s.mtimeNanos),\(s.ctime),\(s.ctimeNanos)")
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func removeArchive(_ job: URL, marker: Marker) throws {
        // Remove just the two owned files. A user addition racing this operation survives.
        guard let current = try ownedArchive(job), current.marker.token == marker.token, current.marker.archive == marker.archive,
              current.marker.createdAt == marker.createdAt, current.marker.shared == marker.shared else { return }
        guard unlink(job.appendingPathComponent(marker.archive).path) == 0,
              unlink(job.appendingPathComponent(markerName).path) == 0 else { throw PocketFolderTransferError.unsafeCache }
        if rmdir(job.path) != 0 && errno != ENOTEMPTY { throw PocketFolderTransferError.unsafeCache }
    }

    private static func inspect(_ cache: URL, now: Date, key: String?, clipboardFiles: () -> [URL]?,
                                check: () throws -> Void) throws -> (bytes: Int64, reusable: (URL, Marker)?) {
        var bytes: Int64 = 0, visited = 0, failure: Error?, reusable: (URL, Marker)?
        var readReferences = false, protected: Set<String>?
        guard let jobs = FileManager.default.enumerator(at: cache, includingPropertiesForKeys: nil, options: [.skipsSubdirectoryDescendants], errorHandler: { _,error in failure=error;return false }) else { throw PocketFolderTransferError.unsafeCache }
        for case let job as URL in jobs {
            try check()
            visited += 1
            guard visited <= 20_000 else { throw PocketFolderTransferError.cacheFull }
            // Unknown, edited, linked or incomplete folders are not ours to
            // remove. Count their files against the same budget so crashes
            // cannot accumulate unaccounted staging data. Unsafe/unreadable
            // trees stop preparation instead of following links or deleting.
            let size: Int64
            if let owned = try? ownedArchive(job) {
                let age = now.timeIntervalSince(owned.marker.createdAt)
                if age > retention {
                    if !readReferences {
                        protected = try? PocketTransferReferences.protectedJobs(in: cache, clipboardFiles: clipboardFiles())
                        readReferences = true
                    }
                    if let protected, !protected.contains(job.lastPathComponent.lowercased()) {
                        try removeArchive(job, marker: owned.marker)
                        if !FileManager.default.fileExists(atPath: job.path) { continue }
                    }
                }
                if age >= 0, let key, owned.marker.sourceKey == key, owned.marker.archiveSignature != nil,
                   reusable.map({ owned.marker.createdAt > $0.1.createdAt }) ?? true {
                    reusable = (job, owned.marker)
                }
                size = owned.bytes
            } else {
                do { size = try unownedCacheBytes(job, visited: &visited, check: check) }
                catch { failure = error; continue }
            }
            guard size <= Int64.max - bytes else { throw PocketFolderTransferError.cacheFull }
            bytes += size
        }
        if let failure { throw failure }
        return (bytes, reusable)
    }
    private static func unownedCacheBytes(_ root: URL, visited: inout Int, check: () throws -> Void) throws -> Int64 {
        var bytes: Int64 = 0
        func add(_ url: URL) throws {
            try check()
            visited += 1
            guard visited <= 20_000 else { throw PocketFolderTransferError.cacheFull }
            let info = try metadata(url)
            if info.st_mode & S_IFMT == S_IFREG {
                guard info.st_size >= 0, info.st_size <= Int64.max - bytes else { throw PocketFolderTransferError.cacheFull }
                bytes += info.st_size
            }
        }
        try add(root)
        if try metadata(root).st_mode & S_IFMT == S_IFDIR {
            var failure: Error?
            guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil, options: [], errorHandler: { _,error in failure=error;return false }) else { throw PocketFolderTransferError.unsafeCache }
            for case let child as URL in walker { try add(child) }
            if let failure { throw failure }
        }
        return bytes
    }
}
