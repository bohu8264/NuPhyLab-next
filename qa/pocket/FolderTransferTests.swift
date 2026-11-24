import Foundation
import Darwin
import SQLite3

enum PocketFolderTransferTestHooks {
    private static let lock = NSLock()
    private static var locked: (() -> Void)?, packed: (() -> Void)?
    static func setLocked(_ hook: (() -> Void)?) { lock.lock(); locked=hook; lock.unlock() }
    static func setPacked(_ hook: (() -> Void)?) { lock.lock(); packed=hook; lock.unlock() }
    static func runLocked() { lock.lock(); let hook=locked; lock.unlock(); hook?() }
    static func runPacked() { lock.lock(); let hook=packed; lock.unlock(); hook?() }
}

@main struct FolderTransferTests {
    static func main() throws {
        var count = 0
        func check(_ value: @autoclosure () throws -> Bool, _ name: String) throws {
            count += 1
            guard try value() else { throw NSError(domain: "FolderTransferTests", code: count, userInfo: [NSLocalizedDescriptionKey: name]) }
        }
        func fails(_ name: String, _ action: () throws -> Void) throws {
            do { try action() } catch { count += 1; return }
            throw NSError(domain: "FolderTransferTests", code: -1, userInfo: [NSLocalizedDescriptionKey: name])
        }
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("pocket-folder-fixture-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        func directory(_ name: String) throws -> URL {
            let url = root.appendingPathComponent(name, isDirectory: true)
            try fm.createDirectory(at: url, withIntermediateDirectories: true)
            return url
        }
        let source = try directory("目录 中文 #100%")
        let nested = source.appendingPathComponent("nested", isDirectory: true)
        try fm.createDirectory(at: nested, withIntermediateDirectories: true)
        let content = Data("local fixture only; never upload".utf8)
        let child = nested.appendingPathComponent("test.txt")
        try content.write(to: child)
        let other = root.appendingPathComponent("extra.txt")
        try Data("mixed ordinary file".utf8).write(to: other)
        let profile = try directory("profile")
        let target = "com.bytedance.macos.feishu"
        try check(try PocketFolderTransfer.needsArchive([source], targetBundleIdentifier: target), "Verified target directory needs archive")
        try check(try !PocketFolderTransfer.needsArchive([other], targetBundleIdentifier: target), "Ordinary file unchanged")
        try check(try !PocketFolderTransfer.needsArchive([source], targetBundleIdentifier: "com.bytedance.macos.lark"), "Unverified Lark identifier is not guessed")
        try check(try !PocketFolderTransfer.needsArchive([source], targetBundleIdentifier: nil), "No target means no conversion")
        let passthrough = try PocketFolderTransfer.prepare([source], targetBundleIdentifier: "com.apple.finder", pocketRoot: profile, control: DragJobControl())
        try check(!passthrough.archived && passthrough.urls == [source] && !fm.fileExists(atPath: profile.appendingPathComponent("transfer").path), "Other apps get unchanged references and no cache")
        let filePass = try PocketFolderTransfer.prepare([other], targetBundleIdentifier: target, pocketRoot: profile, control: DragJobControl())
        try check(!filePass.archived && filePass.urls == [other], "Known target ordinary file passes through")
        let mixed = try PocketFolderTransfer.prepare([source, other], targetBundleIdentifier: target, pocketRoot: profile, control: DragJobControl())
        try check(mixed.archived && mixed.urls.count == 1 && mixed.urls[0].pathExtension == "zip", "Mixed selection becomes one ZIP")
        // Inspect the standard central directory independently of libarchive's
        // tolerant reader. Without bit 11 a normal ZIP reader assumes CP437.
        let zipBytes=[UInt8](try Data(contentsOf:mixed.urls[0]))
        func u16(_ p:Int)->Int {Int(zipBytes[p]) | Int(zipBytes[p+1]) << 8}
        func u32(_ p:Int)->Int {u16(p) | u16(p+2) << 16}
        let end=(0...zipBytes.count-22).reversed().first {Array(zipBytes[$0..<$0+4]) == [0x50,0x4b,5,6]}!
        var cursor=u32(end+16),names=[String](),unicodeFlags=true
        for _ in 0..<u16(end+10) {
            precondition(Array(zipBytes[cursor..<cursor+4]) == [0x50,0x4b,1,2])
            let length=u16(cursor+28),nameBytes=Array(zipBytes[cursor+46..<cursor+46+length])
            if nameBytes.contains(where:{$0>=128}) {unicodeFlags = unicodeFlags && u16(cursor+8)&0x800 != 0}
            names.append(String(bytes:nameBytes,encoding:.utf8)!)
            cursor += 46+length+u16(cursor+30)+u16(cursor+32)
        }
        try check(unicodeFlags,"Unicode ZIP entries declare UTF-8 for independent readers")
        try check(names.contains(source.lastPathComponent+"/nested/test.txt"),"Chinese archive paths retain their exact name")
        try check(mixed.urls[0].path.hasPrefix(profile.appendingPathComponent("transfer").path + "/"), "ZIP stays in profile transfer cache")
        var preferences = DragConvertPreferences()
        let extracted = try directory("extracted")
        preferences.outputDirectory = extracted.path
        let contents = try DragArchiveConverter.convert(mixed.urls, to: .extract, preferences: preferences, control: DragJobControl())
        try check(try Data(contentsOf: contents.appendingPathComponent(source.lastPathComponent + "/nested/test.txt")) == content, "Archive contains complete original folder")
        try check(try Data(contentsOf: contents.appendingPathComponent("extra.txt")) == Data(contentsOf: other), "Archive contains mixed ordinary file")
        try check(try Data(contentsOf: child) == content, "Original folder remains exact")
        try check(try fm.subpathsOfDirectory(atPath: source.path).sorted() == ["nested", "nested/test.txt"], "No generated artifacts added to original folder")
        let repeated = try PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: profile, control: DragJobControl())
        try check(repeated.urls[0] != mixed.urls[0] && fm.fileExists(atPath: mixed.urls[0].path), "Repeated take does not replace an earlier archive")

        let cleaned = DispatchSemaphore(value: 0)
        let start = ProcessInfo.processInfo.systemUptime
        PocketFolderTransfer.discard(repeated) { precondition(!Thread.isMainThread); cleaned.signal() }
        try check(ProcessInfo.processInfo.systemUptime - start < 0.1, "Discard returns without blocking the caller")
        try check(cleaned.wait(timeout: .now() + 5) == .success, "Asynchronous discard reaches its completion barrier")
        try check(!fm.fileExists(atPath: repeated.urls[0].path) && fm.fileExists(atPath: mixed.urls[0].path), "Discard removes only its own unpublished result")

        let lockEntered = DispatchSemaphore(value: 0), releaseLock = DispatchSemaphore(value: 0), workerFinished = DispatchSemaphore(value: 0)
        let underLockCleanup = DispatchSemaphore(value: 0), waitingControl = DragJobControl()
        PocketFolderTransferTestHooks.setLocked { lockEntered.signal(); _ = releaseLock.wait(timeout: .now() + 5) }
        DispatchQueue.global().async {
            _ = try? PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: profile, control: waitingControl)
            workerFinished.signal()
        }
        try check(lockEntered.wait(timeout: .now() + 5) == .success, "Preparation holds cache lock at test barrier")
        let lockStart = ProcessInfo.processInfo.systemUptime
        PocketFolderTransfer.discard(mixed) { underLockCleanup.signal() }
        try check(ProcessInfo.processInfo.systemUptime - lockStart < 0.1, "Discard does not wait on an active preparation lock")
        try check(underLockCleanup.wait(timeout: .now() + 0.02) == .timedOut, "Cleanup waits off-main until packing lock releases")
        waitingControl.cancel(); PocketFolderTransferTestHooks.setLocked(nil); releaseLock.signal()
        try check(workerFinished.wait(timeout: .now() + 5) == .success && underLockCleanup.wait(timeout: .now() + 5) == .success, "Cancelled preparation and asynchronous cleanup complete")
        try check(!fm.fileExists(atPath: mixed.urls[0].path), "Delayed cleanup eventually removes only requested archive")

        let failureProfile = try directory("failure-profile")
        func prepare(_ limits: PocketFolderTransferLimits = PocketFolderTransferLimits(), _ urls: [URL]? = nil, _ control: DragJobControl = DragJobControl()) throws {
            _ = try PocketFolderTransfer.prepare(urls ?? [source], targetBundleIdentifier: target, pocketRoot: failureProfile, control: control, limits: limits)
        }
        var small = PocketFolderTransferLimits(); small.maximumBytes = 1
        try fails("Byte budget rejects before publishing") { try prepare(small) }
        small = PocketFolderTransferLimits(); small.maximumEntries = 1
        try fails("Entry budget rejects before publishing") { try prepare(small) }
        small = PocketFolderTransferLimits(); small.maximumCacheBytes = 1
        try fails("Cache budget rejects before publishing") { try prepare(small) }
        small = PocketFolderTransferLimits(); small.timeout = 0.000001
        try fails("Deadline rejects without publishing") { try prepare(small) }
        let cancelled = DragJobControl(); cancelled.cancel()
        try fails("Pre-cancelled request does not prepare") { try prepare(PocketFolderTransferLimits(), nil, cancelled) }
        try fails("More than 128 roots rejected") { try prepare(PocketFolderTransferLimits(), Array(repeating: source, count: 129)) }
        try fails("Missing mixed reference rejected") { try prepare(PocketFolderTransferLimits(), [source, root.appendingPathComponent("missing")]) }
        let link = root.appendingPathComponent("linked")
        try fm.createSymbolicLink(at: link, withDestinationURL: source)
        try fails("Root symlink rejected") { try prepare(PocketFolderTransferLimits(), [link]) }
        let innerLink = source.appendingPathComponent("link")
        try fm.createSymbolicLink(at: innerLink, withDestinationURL: other)
        try fails("Nested symlink rejected") { try prepare() }
        try fm.removeItem(at: innerLink)
        let hardLink = source.appendingPathComponent("hardlink")
        try fm.linkItem(at: other, to: hardLink)
        try fails("Nested hardlink rejected") { try prepare() }
        try fm.removeItem(at: hardLink)
        try fails("Cache within selected ancestor rejected") {
            _ = try PocketFolderTransfer.prepare([root], targetBundleIdentifier: target, pocketRoot: profile, control: DragJobControl())
        }
        try fails("Cache root itself selected is rejected") {
            _ = try PocketFolderTransfer.prepare([profile], targetBundleIdentifier: target, pocketRoot: profile, control: DragJobControl())
        }
        let symlinkProfile = try directory("symlink-profile"), outside = try directory("outside")
        try fm.createSymbolicLink(at: symlinkProfile.appendingPathComponent("transfer"), withDestinationURL: outside)
        try fails("Linked cache refused") {
            _ = try PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: symlinkProfile, control: DragJobControl())
        }
        try check(try fm.contentsOfDirectory(atPath: outside.path).isEmpty, "Outside symlink destination untouched")
        let failureCache = failureProfile.appendingPathComponent("transfer")
        try check(!fm.fileExists(atPath: failureCache.path) || (try fm.contentsOfDirectory(atPath: failureCache.path)).isEmpty, "Failures leave no transfer payload")
        let addedDuringPacking = source.appendingPathComponent("added-during-packing.txt")
        PocketFolderTransferTestHooks.setPacked { try! content.write(to: addedDuringPacking) }
        try fails("Source directory change after packing rejects result") { try prepare() }
        PocketFolderTransferTestHooks.setPacked(nil)
        try check((try fm.contentsOfDirectory(atPath: failureCache.path)).isEmpty, "Changed source leaves no published or partial result")
        try fm.removeItem(at: addedDuringPacking)

        let now = Date()
        let expiryProfile = try directory("expiry-profile")
        let old = try PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: expiryProfile, control: DragJobControl(), now: now.addingTimeInterval(-PocketFolderTransfer.retention - 1))
        let cache = expiryProfile.appendingPathComponent("transfer")
        try fails("Cached source file is refused before expiry can delete it") {
            _ = try PocketFolderTransfer.prepare([source, old.urls[0]], targetBundleIdentifier: target, pocketRoot: expiryProfile, control: DragJobControl(), now: now)
        }
        try check(fm.fileExists(atPath: old.urls[0].path), "Rejected overlapping input archive remains intact")
        try fails("Cached source directory is refused") {
            _ = try PocketFolderTransfer.prepare([old.urls[0].deletingLastPathComponent()], targetBundleIdentifier: target, pocketRoot: expiryProfile, control: DragJobControl(), now: now)
        }
        let unknown = cache.appendingPathComponent("unknown-user-file.txt")
        try content.write(to: unknown)
        let malformed = cache.appendingPathComponent("pocket-" + UUID().uuidString)
        try fm.createDirectory(at: malformed, withIntermediateDirectories: false)
        try content.write(to: malformed.appendingPathComponent("unknown.txt"))
        let fresh = try PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: expiryProfile, control: DragJobControl(), now: now)
        try check(!fm.fileExists(atPath: old.urls[0].path), "Owned archive expires after seven days")
        try check(fm.fileExists(atPath: fresh.urls[0].path), "Newly exposed archive stays available")
        try check(try Data(contentsOf: unknown) == content && Data(contentsOf: malformed.appendingPathComponent("unknown.txt")) == content, "Unknown or unowned cache contents never cleaned")
        let edited = try PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: expiryProfile, control: DragJobControl(), now: now.addingTimeInterval(-PocketFolderTransfer.retention - 1))
        let editedJob = edited.urls[0].deletingLastPathComponent()
        try content.write(to: editedJob.appendingPathComponent("user-added.txt"))
        _ = try PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: expiryProfile, control: DragJobControl(), now: now)
        try check(fm.fileExists(atPath: edited.urls[0].path) && fm.fileExists(atPath: editedJob.appendingPathComponent("user-added.txt").path), "Modified owned folder is not automatically removed")
        let residue = cache.appendingPathComponent("incomplete-owned-work")
        try fm.createDirectory(at: residue, withIntermediateDirectories: false)
        let residueFile = residue.appendingPathComponent("partial.zip")
        try Data().write(to: residueFile)
        let residueHandle = try FileHandle(forWritingTo: residueFile)
        try residueHandle.truncate(atOffset: 1024 * 1024); try residueHandle.close()
        var cacheLimit = PocketFolderTransferLimits(); cacheLimit.maximumCacheBytes = 512 * 1024
        try fails("Unowned crash residue counts against cache quota") {
            _ = try PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: expiryProfile, control: DragJobControl(), limits: cacheLimit, now: now)
        }
        try check(fm.fileExists(atPath: residueFile.path), "Unowned crash residue is preserved when cache is full")
        let cacheLink = cache.appendingPathComponent("unknown-link")
        try fm.createSymbolicLink(at: cacheLink, withDestinationURL: outside)
        try fails("Uncountable linked cache entry blocks preparation without following") {
            _ = try PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: expiryProfile, control: DragJobControl(), now: now)
        }
        try check(try fm.destinationOfSymbolicLink(atPath: cacheLink.path) == outside.path && fm.contentsOfDirectory(atPath: outside.path).isEmpty, "Unknown linked cache and external destination unchanged")

        func maintain(_ profile: URL, at date: Date, board: @escaping () -> [URL]? = { [] }) throws -> Int64 {
            let done = DispatchSemaphore(value: 0)
            var result: Int64?
            PocketFolderTransfer.maintain(pocketRoot: profile, now: date, clipboardFiles: board) { bytes in
                result = bytes; done.signal()
            }
            guard done.wait(timeout: .now() + 5) == .success, let result else { throw PocketFolderTransferError.unsafeCache }
            return result
        }
        let reuseRoot = try directory("reuse-profile")
        try check(try maintain(reuseRoot, at: now) == 0 && !fm.fileExists(atPath: reuseRoot.appendingPathComponent("transfer").path), "A new installation creates no transfer cache during maintenance")
        let reuseSource = try directory("copy-again")
        let note = reuseSource.appendingPathComponent("note.txt")
        try Data("one".utf8).write(to: note)
        func take(_ source: URL, _ root: URL, _ stamp: Date) throws -> PocketPreparedFileTransfer {
            try PocketFolderTransfer.prepare([source], targetBundleIdentifier: target, pocketRoot: root, control: DragJobControl(), now: stamp)
        }
        let first = try take(reuseSource, reuseRoot, now)
        let originalBytes = try Data(contentsOf: first.urls[0])
        let again = try take(reuseSource, reuseRoot, now.addingTimeInterval(86400))
        try check(first.urls == again.urls && (try fm.contentsOfDirectory(atPath: reuseRoot.appendingPathComponent("transfer").path)).count == 1, "Unchanged folder reused on another day without repacking")
        for result in [first, again] {
            let done = DispatchSemaphore(value: 0)
            PocketFolderTransfer.discard(result) { done.signal() }
            try check(done.wait(timeout: .now() + 5) == .success && (try Data(contentsOf: first.urls[0])) == originalBytes, "Cancellation cannot delete an archive shared with another retrieval")
        }
        let sevenDaysLater = now.addingTimeInterval(PocketFolderTransfer.retention + 1)
        try check(try maintain(reuseRoot, at: sevenDaysLater, board: { preconditionFailure("Fresh ZIPs need no clipboard inspection") }) > 0, "Seven-day retention restarts on reuse")
        try Data("two".utf8).write(to: note)
        let changed = try take(reuseSource, reuseRoot, now.addingTimeInterval(86401))
        try check(first.urls != changed.urls && (try Data(contentsOf: first.urls[0])) == originalBytes, "Same-size source edit creates a new ZIP and preserves the receiver's old bytes")
        try Data("edited by user".utf8).write(to: changed.urls[0])
        _ = try maintain(reuseRoot, at: sevenDaysLater.addingTimeInterval(86500))
        try check(!fm.fileExists(atPath: first.urls[0].path) && (try Data(contentsOf: changed.urls[0])) == Data("edited by user".utf8), "Independent maintenance expires only the unmodified ZIP")
        let held = try take(reuseSource, reuseRoot, sevenDaysLater)
        let heldAgain = try PocketFolderTransfer.prepare([reuseSource], targetBundleIdentifier: target, pocketRoot: reuseRoot, control: DragJobControl(), now: sevenDaysLater.addingTimeInterval(PocketFolderTransfer.retention + 1), clipboardFiles: { held.urls })
        try check(heldAgain.urls == held.urls, "An unchanged ZIP retained by the current clipboard can be reused after seven days")

        let protectedParent = try directory("saved-references")
        let pocket = protectedParent.appendingPathComponent("keyboard-pocket")
        try fm.createDirectory(at: pocket, withIntermediateDirectories: true)
        var oldURLs: [URL] = []
        for i in 0..<5 {
            let input = try directory("reference-\(i)")
            let file = try take(input, pocket, now).urls[0]
            let marker = file.deletingLastPathComponent().appendingPathComponent(".pocket-transfer.json")
            var oldMarker = try JSONSerialization.jsonObject(with: Data(contentsOf: marker)) as! [String: Any]
            for field in ["sourceKey", "archiveSignature", "shared"] { oldMarker.removeValue(forKey: field) }
            try JSONSerialization.data(withJSONObject: oldMarker).write(to: marker)
            oldURLs.append(file)
        }
        let state = pocket.appendingPathComponent("pockets.json")
        func savePocket(_ slots: [URL], _ history: [URL]) throws {
            let value: [String: Any] = ["version": 1, "slots": [["files": slots.map(\.absoluteString)]], "history": [[["files": history.map(\.absoluteString)]]]]
            try JSONSerialization.data(withJSONObject: value).write(to: state)
        }
        try savePocket([oldURLs[0]], [oldURLs[1]])
        let smart = protectedParent.appendingPathComponent("smart-clipboard")
        try fm.createDirectory(at: smart, withIntermediateDirectories: true)
        var database: OpaquePointer?
        try check(sqlite3_open(smart.appendingPathComponent("history.sqlite").path, &database) == SQLITE_OK, "Test history opened")
        defer { sqlite3_close_v2(database) }
        let hex = try JSONSerialization.data(withJSONObject: [["path": oldURLs[2].absoluteString]]).map { String(format: "%02x", $0) }.joined()
        try check(sqlite3_exec(database, "CREATE TABLE clips(kind TEXT,payload BLOB); INSERT INTO clips VALUES('files',X'\(hex)')", nil, nil, nil) == SQLITE_OK, "File clipboard reference recorded")
        _ = try maintain(pocket, at: sevenDaysLater, board: { nil })
        try check(oldURLs.allSatisfy { fm.fileExists(atPath: $0.path) }, "An unfamiliar file clipboard defers deletion without reading its contents")
        _ = try maintain(pocket, at: sevenDaysLater, board: { [oldURLs[3]] })
        try check(oldURLs.prefix(4).allSatisfy { fm.fileExists(atPath: $0.path) } && !fm.fileExists(atPath: oldURLs[4].path), "Legacy R51 cleanup preserves slots, undo, history and current file clipboard; an unused ZIP expires without another transfer")
        try Data("unknown format".utf8).write(to: state)
        _ = try maintain(pocket, at: sevenDaysLater)
        try check(fm.fileExists(atPath: oldURLs[3].path), "Unreadable saved data defers expiration")
        try savePocket([], [])
        try check(sqlite3_exec(database, "DELETE FROM clips", nil, nil, nil) == SQLITE_OK, "Release fixture history reference")
        try check(try maintain(pocket, at: sevenDaysLater) == 0 && oldURLs.allSatisfy { !fm.fileExists(atPath: $0.path) }, "Space is reclaimed when the last references are gone")

        let cancelSource = try directory("cancellation-source")
        let large = cancelSource.appendingPathComponent("large.bin")
        try Data(repeating: 0x39, count: 16 * 1024 * 1024).write(to: large)
        let liveControl = DragJobControl()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.01) { liveControl.cancel() }
        try fails("Asynchronous cancellation cleans incomplete ZIP") { try prepare(PocketFolderTransferLimits(), [cancelSource], liveControl) }
        try check((try fm.contentsOfDirectory(atPath: failureCache.path)).isEmpty && (try Data(contentsOf: large)).count == 16 * 1024 * 1024, "Cancelled job keeps original and no partial cache")
        PocketL10n.english = true
        for error in [PocketFolderTransferError.limit,.timeout,.cacheFull,.unsafeCache,.changed] {
            try check(error.localizedDescription.range(of: "[\\p{Han}]", options: .regularExpression) == nil, "English-only error message")
        }
        PocketL10n.english = false
        try check(PocketFolderTransferError.timeout.localizedDescription.contains("超时"), "Chinese error message")
        print("Pocket folder transfer: \(count) checks passed (generated fixtures only; no target app, clipboard, network or upload)")
    }
}
