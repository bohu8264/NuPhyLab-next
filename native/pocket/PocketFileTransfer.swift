import AppKit

/// Native file references for explicitly requested copy/paste. No file content is
/// modified, compressed, uploaded, or sent by this writer. Keep both modern item
/// URLs and the aggregate legacy filename list for older pasteboard consumers.
enum PocketFileTransfer {
    static let filenamesType = NSPasteboard.PasteboardType("NSFilenamesPboardType")

    static func write(_ urls: [URL], to pasteboard: NSPasteboard) throws {
        guard !urls.isEmpty else {
            throw PocketStoreError.invalid("文件引用为空。")
        }
        guard urls.count <= PocketStore.maximumFiles else {
            throw PocketStoreError.limit("每个槽位最多保存 256 个文件。")
        }
        // Validate every reference before changing the current clipboard. This
        // also leaves it intact when one file in a multi-item selection is gone.
        for url in urls {
            guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else {
                throw PocketStoreError.invalid("文件引用不是有效的本机 URL。")
            }
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw PocketStoreError.missing(url.lastPathComponent)
            }
        }
        let access = try PocketFileAccess(urls: urls)
        defer { access.close() }
        // Validate through a separate pasteboard first. AppKit can report a
        // successful write even when macOS rejects the file-access extension.
        // Never destroy the user's current clipboard in that case.
        let staging = NSPasteboard(name: .init("local.nuphylab.pocket.write." + UUID().uuidString))
        defer { staging.releaseGlobally() }
        try publish(access.urls, to: staging)
        guard matches(access.urls, in: staging) else { throw PocketFileAccessError.unavailable }
        pasteboard.clearContents()
        try publish(access.urls, to: pasteboard)
        guard matches(access.urls, in: pasteboard) else { throw PocketFileAccessError.unavailable }
    }

    private static func publish(_ urls: [URL], to pasteboard: NSPasteboard) throws {
        // NSURL supplies one public.file-url item per reference, including the
        // native file transfer representations. Preserve these instead of
        // substituting plain-text paths or public.url links.
        guard pasteboard.writeObjects(urls.map { $0 as NSURL }) else {
            throw PocketStoreError.invalid("无法写入剪贴板。")
        }
        // AppKit normally synthesizes the legacy aggregate from NSURL. Also
        // materialize it through the board-level compatibility API for older
        // readers. NSPasteboardItem accepts UTIs only, so the legacy name must
        // not be written directly to an item. This keeps all modern URL items.
        guard pasteboard.setPropertyList(urls.map(\.path), forType: filenamesType) else {
            throw PocketStoreError.invalid("无法写入剪贴板。")
        }
    }

    static func matches(_ urls: [URL], in board: NSPasteboard) -> Bool {
        let items = board.pasteboardItems ?? []
        let paths = items.compactMap { $0.string(forType: .fileURL).flatMap(URL.init(string:))?.path }
        return items.count == urls.count && paths == urls.map(\.path)
            && board.propertyList(forType: filenamesType) as? [String] == urls.map(\.path)
    }
}

enum PocketFileAccessError: Error, LocalizedError {
    case denied(String), unavailable
    var errorDescription: String? {
        switch self {
        case .denied(let name): return PocketL10n.english
            ? "File access has expired for “\(name)”. Reselect the original in Keyboard Pocket."
            : "“\(name)”的文件访问已失效，请在键盘口袋中重新选择原文件。"
        case .unavailable: return PocketL10n.english
            ? "macOS could not share this file. Reselect the original in Keyboard Pocket."
            : "macOS 未能共享此文件，请在键盘口袋中重新选择原文件。"
        }
    }
}

/// Keep the original URL and its scope alive for the entire copy/archive job.
/// A serialized path is not an access grant. Old entries stay intact and require
/// an explicit file picker selection if their original grant has expired.
final class PocketFileAccess {
    let urls: [URL]
    private var scoped: [URL] = []
    init(urls: [URL]) throws {
        self.urls = urls
        for url in urls {
            guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else {
                close(); throw PocketStoreError.invalid("文件引用不是有效的本机 URL。")
            }
            if url.startAccessingSecurityScopedResource() {
                scoped.append(url)
            } else {
                // A plain saved path can pass fileExists/isReadableFile while
                // macOS refuses to issue a transfer grant to another app. Mint
                // and consume a read-only app-scoped bookmark before publishing.
                // This does not request broader Downloads/Documents permission.
                do {
                    let data = try Self.bookmark(url)
                    var stale = false
                    let granted = try URL(resolvingBookmarkData:data,
                        options:[.withSecurityScope,.withoutUI,.withoutMounting],relativeTo:nil,bookmarkDataIsStale:&stale)
                    guard granted.startAccessingSecurityScopedResource() else { throw PocketFileAccessError.denied(url.lastPathComponent) }
                    scoped.append(granted)
                } catch {
                    close(); throw PocketFileAccessError.denied(url.lastPathComponent)
                }
            }
            // Do not open user files on the UI thread: a TCC/file-provider
            // decision can block open(2). The writer validates macOS file-transfer
            // grants on a private pasteboard before changing the real clipboard.
            guard FileManager.default.fileExists(atPath: url.path) else {
                close(); throw PocketStoreError.missing(url.lastPathComponent)
            }
            guard FileManager.default.isReadableFile(atPath: url.path) else {
                close(); throw PocketFileAccessError.denied(url.lastPathComponent)
            }
        }
    }
    func close() {
        for url in scoped { url.stopAccessingSecurityScopedResource() }
        scoped.removeAll()
    }
    deinit { close() }

    static func bookmark(_ url: URL) throws -> Data {
        try url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess],
            includingResourceValuesForKeys: [.fileResourceIdentifierKey,.volumeIdentifierKey,.creationDateKey], relativeTo: nil)
    }
    static func resolve(_ reference: String, bookmark: Data?) throws -> URL {
        guard let original = URL(string: reference), original.isFileURL,
              original.host == nil || original.host == "" || original.host == "localhost" else {
            throw PocketStoreError.invalid("文件引用不是有效的本机 URL。")
        }
        if let bookmark {
            var stale = false
            guard var resolved = try? URL(resolvingBookmarkData: bookmark,
                options: [.withSecurityScope, .withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale),
                resolved.isFileURL, resolved.host == nil || resolved.host == "" || resolved.host == "localhost" else {
                throw PocketFileAccessError.denied(original.lastPathComponent)
            }
            let keys:Set<URLResourceKey>=[.fileResourceIdentifierKey,.volumeIdentifierKey,.creationDateKey]
            let saved=URL.resourceValues(forKeys:keys,fromBookmarkData:bookmark)
            // Foundation represents absent legacy resource values as NSNull,
            // which also bridges to NSObject. It is not a saved file identity.
            if let fileID=saved?.fileResourceIdentifier as? NSObject, !(fileID is NSNull),
               let volumeID=saved?.volumeIdentifier as? NSObject, !(volumeID is NSNull) {
                let scoped=resolved.startAccessingSecurityScopedResource()
                defer {if scoped {resolved.stopAccessingSecurityScopedResource()}}
                resolved.removeAllCachedResourceValues()
                guard let current=try? resolved.resourceValues(forKeys:keys),
                      let currentFile=current.fileResourceIdentifier as? NSObject,
                      let currentVolume=current.volumeIdentifier as? NSObject,
                      fileID.isEqual(currentFile),volumeID.isEqual(currentVolume),
                      saved?.creationDate == nil || saved?.creationDate == current.creationDate else {
                    throw PocketFileAccessError.denied(original.lastPathComponent)
                }
            } else if stale {
                // Legacy bookmarks did not embed an identity. A stale bookmark
                // may silently resolve a different file now at the old path.
                throw PocketFileAccessError.denied(original.lastPathComponent)
            }
            return resolved
        }
        return original
    }
}
