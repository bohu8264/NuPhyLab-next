import AppKit

@main struct PocketFileTransferTests {
    static func main() throws {
        if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "read-file-board" {
            let board=NSPasteboard(name:.init(CommandLine.arguments[2]))
            let urls=(board.readObjects(forClasses:[NSURL.self],options:[.urlReadingFileURLsOnly:true]) as? [URL]) ?? []
            let expected=try JSONDecoder().decode([String].self,from:Data(CommandLine.arguments[3].utf8))
            guard urls.map(\.path) == expected else { throw PocketFileAccessError.unavailable }
            return
        }
        var count = 0
        func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
            count += 1
            guard try value() else { throw NSError(domain: "PocketFileTransferTests", code: count, userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        func rejects(_ action: () throws -> Void, _ message: String) throws {
            do { try action() } catch { count += 1; return }
            throw NSError(domain: "PocketFileTransferTests", code: -1, userInfo: [NSLocalizedDescriptionKey: message])
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pocket-file-transfer-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let a = root.appendingPathComponent("中文 空格 #100%.zip")
        let b = root.appendingPathComponent("second.txt")
        let folder = root.appendingPathComponent("目录 中文 #", isDirectory: true)
        try Data("fixture zip bytes".utf8).write(to: a)
        try Data("fixture second file".utf8).write(to: b)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let child = folder.appendingPathComponent("child.txt")
        let childBytes = Data("fixture folder content remains exact".utf8)
        try childBytes.write(to: child)
        let originalEntries = try FileManager.default.subpathsOfDirectory(atPath: root.path).sorted()
        let board = NSPasteboard(name: NSPasteboard.Name("local.nuphylab.pocket.file-transfer.tests." + UUID().uuidString))
        defer { board.releaseGlobally() }
        func readURLs() -> [URL] {
            (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ?? []).compactMap { ($0 as? NSURL).map { $0 as URL } }
        }
        for urls in [[a], [folder], [a, b], [folder, a, b]] {
            try PocketFileTransfer.write(urls, to: board)
            try check(readURLs().map(\.path) == urls.map(\.path), "Modern file URLs keep order without duplicates")
            try check(board.propertyList(forType: PocketFileTransfer.filenamesType) as? [String] == urls.map(\.path), "Legacy aggregate contains all file paths")
            let items = board.pasteboardItems ?? []
            try check(items.count == urls.count, "One native item per file or directory")
            try check(items.allSatisfy { $0.types.contains(.fileURL) }, "Every item declares a modern file URL")
            try check(board.types?.contains(PocketFileTransfer.filenamesType) == true, "Board offers the legacy filename format")
            try check(items.allSatisfy { !$0.types.contains(.string) && !$0.types.contains(.URL) }, "Files are never substituted with plain paths or web links")
        }
        // A receiver process must see the same native file list. Reading back
        // from the writing process alone can hide rejected transfer extensions.
        let reader=Process();reader.executableURL=URL(fileURLWithPath:CommandLine.arguments[0])
        reader.arguments=["read-file-board",board.name.rawValue,String(data:try JSONEncoder().encode([folder,a,b].map(\.path)),encoding:.utf8)!]
        try reader.run();reader.waitUntilExit()
        try check(reader.terminationStatus == 0,"Independent process receives the complete native file list")
        try check(try Data(contentsOf: child) == childBytes, "Folder payload untouched")
        try check(try FileManager.default.subpathsOfDirectory(atPath: root.path).sorted() == originalEntries, "No compression or temporary transport files created")

        board.clearContents(); board.setString("keep named clipboard", forType: .string)
        let originalCount = board.changeCount
        try rejects({ try PocketFileTransfer.write([a, root.appendingPathComponent("missing.txt")], to: board) }, "Missing member must fail")
        try check(board.changeCount == originalCount && board.string(forType: .string) == "keep named clipboard", "Missing member preserves clipboard")
        try rejects({ try PocketFileTransfer.write([], to: board) }, "Empty selection must fail")
        try rejects({ try PocketFileTransfer.write([URL(string: "https://example.invalid/file")!], to: board) }, "Web URL must fail")
        try rejects({ try PocketFileTransfer.write([URL(string: "file://remote-host/tmp/file")!], to: board) }, "Remote file URL must fail")
        try rejects({ try PocketFileTransfer.write(Array(repeating: a, count: 257), to: board) }, "File-count budget must apply")
        try check(board.changeCount == originalCount, "All invalid preparations preserve clipboard")

        let store = try PocketStore(root: root.appendingPathComponent("store"))
        let payload = try store.itemFromFiles([folder, a])
        try store.put(payload, at: 0)
        try store.write(0, to: board, plain: true)
        try check(readURLs().map { $0.resolvingSymlinksInPath().path } == [folder,a].map { $0.resolvingSymlinksInPath().path }, "Plain-text setting never converts file/folder references")
        try check((board.propertyList(forType: PocketFileTransfer.filenamesType) as? [String])?.map { URL(fileURLWithPath:$0).resolvingSymlinksInPath().path } == [folder,a].map { $0.resolvingSymlinksInPath().path }, "Store uses compatible file writer")
        let again = try store.capture(board)
        try check(again.kind == "files" && again.files.compactMap(URL.init(string:)).map { $0.resolvingSymlinksInPath().path } == payload.files.compactMap(URL.init(string:)).map { $0.resolvingSymlinksInPath().path }, "File/folder output can be captured without changing kind")
        try check(payload.fileBookmarks?.count == 2, "Selected file access is persisted per reference")
        let reopened = try PocketStore(root: root.appendingPathComponent("store"))
        try reopened.write(0, to: board)
        try check(readURLs().count == 2, "Reopened store resolves saved file grants")
        var legacy = payload; legacy.id = UUID().uuidString; legacy.fileBookmarks = nil
        try store.put(legacy, at: 1)
        board.clearContents();board.setString("keep previous clipboard",forType:.string)
        let beforeLegacy=board.changeCount
        try rejects({try store.write(1,to:board)},"Legacy external references need the original selection, not a synthetic grant")
        try check(board.changeCount==beforeLegacy,"Legacy reference repair leaves current clipboard intact")
        let historyBefore = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("store/pockets.json"))) as! [String:Any]
        try store.renewFileAccess(1, urls: [a,folder])
        let historyAfter = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("store/pockets.json"))) as! [String:Any]
        try check((historyBefore["history"] as! NSArray) == (historyAfter["history"] as! NSArray), "Renewing access does not replace undo history")
        try check(store.slots[1]?.id == legacy.id && store.slots[1]?.files == legacy.files, "Renewing access preserves slot identity and references")
        try store.write(1,to:board)
        try check(readURLs().count==2,"Renewed legacy file references become usable without replacing content")
        let owned=root.appendingPathComponent("store/transfer/owned.txt")
        try FileManager.default.createDirectory(at:owned.deletingLastPathComponent(),withIntermediateDirectories:true)
        try Data("app-owned fixture".utf8).write(to:owned)
        var ownedItem=try store.itemFromFiles([owned]);ownedItem.fileBookmarks=nil
        try store.put(ownedItem,at:2);try store.write(2,to:board)
        try check(readURLs().first?.lastPathComponent=="owned.txt","App-owned legacy transfer file does not need new selection")
        try rejects({try store.renewFileAccess(1, urls:[a,b])}, "Wrong files cannot silently replace the slot during access renewal")
        let denied = root.appendingPathComponent("no-read.pdf")
        try Data("private fixture".utf8).write(to:denied)
        try FileManager.default.setAttributes([.posixPermissions:0],ofItemAtPath:denied.path)
        board.clearContents(); board.setString("preserve clipboard on access failure",forType:.string)
        let deniedCount = board.changeCount
        try rejects({try PocketFileTransfer.write([denied],to:board)},"Unreadable file is rejected even when fileExists succeeds")
        try check(board.changeCount == deniedCount && board.string(forType:.string) == "preserve clipboard on access failure","Failed access cannot clear the previous clipboard or report success")
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:denied.path)
        print("Pocket file transfer: \(count) checks passed (generated files and named pasteboard; no target app or upload)")
    }
}
