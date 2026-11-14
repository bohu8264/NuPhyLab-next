import Foundation
import AppKit
import ImageIO

struct PocketItem: Codable {
    var id: String
    var kind: String
    var title: String
    var text: String?
    var files: [String]
    var imagePath: String?
    var richTextPath: String?
    var createdAt: Date
    var pinned: Bool
    // Optional provenance for new generated labels. Legacy and user titles remain exact.
    var fileBookmarks: [String: Data]? = nil
    var generatedTitle: String? = nil
    var displayTitle: String {
        switch generatedTitle {
        case "image" where kind == "image": return PocketL10n.text("图片")
        case "files" where kind == "files": return PocketL10n.text("\(files.count) 个文件")
        case "text" where kind == "text" || kind == "richText": return PocketL10n.text("文字")
        default: return title
        }
    }
}

enum PocketStoreError: LocalizedError {
    case invalidIndex, emptySlot, occupied, pinned, full, noUndo, unsupported
    case limit(String), invalid(String), missing(String), persistence(String)

    var errorDescription: String? { PocketL10n.text(originalDescription) }
    private var originalDescription: String {
        switch self {
        case .invalidIndex: return "槽位不存在。"
        case .emptySlot: return "这个槽位还是空的。"
        case .occupied: return "这个槽位已有内容，请选择空位或明确替换。"
        case .pinned: return "请先取消固定，再清空或替换这个槽位。"
        case .full: return "9 个槽位已满，请先清空一个槽位或明确替换。"
        case .noUndo: return "没有可以撤销的操作。"
        case .unsupported: return "剪贴板中没有可保存的文字、图片、链接或文件。"
        case .limit(let message), .invalid(let message): return message
        case .missing(let name): return "文件已移动或删除：\(name)"
        case .persistence(let reason): return "保存失败，原有内容未改变：\(reason)"
        }
    }
}

/// An isolated, nine-slot clipboard library. Files are URL references; imported images and RTF
/// are durable assets. Assets are deliberately retained for undo and never deleted automatically.
final class PocketStore {
    static let slotCount = 9
    static let maximumTextBytes = 16 * 1024 * 1024
    static let maximumImageBytes = 32 * 1024 * 1024
    static let maximumFiles = 256
    private static let maximumHistory = 20
    private static let imageExtensions = Set(["png", "jpg", "jpeg", "tif", "tiff", "gif", "heic", "heif", "webp", "bmp"])

    private struct State: Codable {
        var version: Int
        var slots: [PocketItem?]
        var history: [[PocketItem?]]
    }

    private let root: URL
    private let assets: URL
    private let stateURL: URL
    private var history: [[PocketItem?]] = []
    private(set) var slots: [PocketItem?] = Array(repeating: nil, count: slotCount)
    var canUndo: Bool { !history.isEmpty }

    init(root: URL) throws {
        guard root.isFileURL else { throw PocketStoreError.invalid("数据目录必须是本机目录。") }
        self.root = root.standardizedFileURL
        assets = self.root.appendingPathComponent("assets", isDirectory: true)
        stateURL = self.root.appendingPathComponent("pockets.json")
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: stateURL.path) {
            let size = try stateURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 64 * 1024 * 1024 else { throw PocketStoreError.limit("保存文件过大，未载入。") }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let state = try decoder.decode(State.self, from: boundedData(stateURL, maximum: 64 * 1024 * 1024))
            guard state.version == 1, state.slots.count == Self.slotCount,
                  state.history.count <= Self.maximumHistory,
                  state.history.allSatisfy({ $0.count == Self.slotCount }) else {
                throw PocketStoreError.invalid("口袋数据格式不正确，原文件已保留。")
            }
            for item in (state.slots + state.history.flatMap { $0 }).compactMap({ $0 }) {
                try validate(item)
            }
            slots = state.slots
            history = state.history
        }
    }

    func capture(_ pb: NSPasteboard) throws -> PocketItem {
        let fileObjects = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ?? []
        let urls = fileObjects.compactMap { ($0 as? NSURL).map { $0 as URL } }
        if !urls.isEmpty { return try itemFromFiles(urls) }

        if let rtf = pb.data(forType: .rtf) {
            guard rtf.count <= Self.maximumTextBytes else { throw PocketStoreError.limit("富文本不能超过 16 MB。") }
            if let attributed = NSAttributedString(rtf: rtf, documentAttributes: nil) {
                let plain = pb.string(forType: .string)
                let value = plain?.isEmpty == false ? plain! : attributed.string
                try validateText(value)
                let path = try persistAsset(rtf, extension: "rtf").path
                return makeItem(kind: "richText", title: titleForText(value), text: value, richTextPath: path)
            }
        }

        // Some applications attach a PNG/TIFF preview to copied text. Preserve the
        // editable representation before considering that preview as an image.
        if let value = [NSPasteboard.PasteboardType.string, .URL].lazy.compactMap({ pb.string(forType: $0) }).first(where: { !$0.isEmpty }) {
            try validateText(value)
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            let isLink = Self.isSupportedLink(trimmed)
            let title = isLink ? (pb.string(forType: NSPasteboard.PasteboardType("public.url-name")) ?? titleForText(value)) : titleForText(value)
            return makeItem(kind: isLink ? "link" : "text", title: String(title.prefix(120)), text: value)
        }

        // This is a text-only lexer, not NSAttributedString's HTML importer or a web view:
        // it cannot execute scripts, resolve URLs, load images/styles, or expand a DTD.
        if let data = pb.data(forType: .html) {
            guard data.count <= Self.maximumTextBytes else { throw PocketStoreError.limit("HTML 内容不能超过 16 MB。") }
            if let html = pb.string(forType: .html) {
                try validateText(html)
                let value = Self.plainTextFromHTML(html)
                if !value.isEmpty {
                    try validateText(value)
                    return makeItem(kind: "text", title: titleForText(value), text: value)
                }
            }
        }

        for (type, suffix) in [(NSPasteboard.PasteboardType.png, "png"), (.tiff, "tiff")] {
            if let data = pb.data(forType: type) {
                guard data.count <= Self.maximumImageBytes else { throw PocketStoreError.limit("图片不能超过 32 MB。") }
                try validateImage(data: data)
                return makeItem(kind: "image", title: "图片", imagePath: try persistAsset(data, extension: suffix).path, generatedTitle: "image")
            }
        }
        throw PocketStoreError.unsupported
    }

    func itemFromFiles(_ urls: [URL]) throws -> PocketItem {
        guard !urls.isEmpty else { throw PocketStoreError.unsupported }
        guard urls.count <= Self.maximumFiles else { throw PocketStoreError.limit("每个槽位最多保存 256 个文件。") }
        let access = try PocketFileAccess(urls: urls)
        defer { access.close() }
        var unique: [URL] = []
        var seen = Set<String>()
        for input in urls {
            guard input.isFileURL else { throw PocketStoreError.invalid("只支持本机文件引用。") }
            let url = input // Preserve the file picker / pasteboard security scope.
            guard FileManager.default.fileExists(atPath: url.path) else { throw PocketStoreError.missing(url.lastPathComponent) }
            if seen.insert(url.absoluteString).inserted { unique.append(url) }
        }
        if unique.count == 1, let url = unique.first,
           Self.imageExtensions.contains(url.pathExtension.lowercased()),
           (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= Self.maximumImageBytes else { throw PocketStoreError.limit("图片不能超过 32 MB。") }
            // Copy first; validate the actual durable bytes rather than trusting a mutable source.
            let destination = assets.appendingPathComponent(UUID().uuidString).appendingPathExtension(url.pathExtension.lowercased())
            let temporary = assets.appendingPathComponent(".import-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: temporary) }
            try FileManager.default.copyItem(at: url, to: temporary)
            let copiedSize = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard copiedSize <= Self.maximumImageBytes else { throw PocketStoreError.limit("图片不能超过 32 MB。") }
            try validateImage(url: temporary)
            try FileManager.default.moveItem(at: temporary, to: destination)
            return makeItem(kind: "image", title: String(url.lastPathComponent.prefix(120)), imagePath: destination.path)
        }
        var item = makeItem(kind: "files", title: unique.count == 1 ? String(unique[0].lastPathComponent.prefix(120)) : "\(unique.count) 个文件", files: unique.map(\.absoluteString), generatedTitle: unique.count > 1 ? "files" : nil)
        item.fileBookmarks = try Dictionary(uniqueKeysWithValues: unique.map { ($0.absoluteString, try PocketFileAccess.bookmark($0)) })
        return item
    }

    func put(_ item: PocketItem, at index: Int, replace: Bool = false) throws {
        try check(index)
        try validate(item)
        if slots[index] != nil {
            guard replace else { throw slots.allSatisfy({ $0 != nil }) ? PocketStoreError.full : PocketStoreError.occupied }
        }
        var next = slots
        next[index] = item
        try commit(next)
    }

    func clear(_ index: Int) throws {
        _ = try requireItem(index)
        var next = slots
        next[index] = nil
        try commit(next)
    }

    func clearUnpinned() throws {
        guard slots.contains(where: { $0 != nil && $0?.pinned == false }) else { return }
        try commit(slots.map { $0?.pinned == true ? $0 : nil })
    }

    /// Invoked only after an explicit clear-all action. Retired pin metadata is
    /// retained in undo history; loading or upgrading never clears any item.
    func clearAll() throws {
        guard slots.contains(where: { $0 != nil }) else { return }
        try commit(Array(repeating: nil, count: Self.slotCount))
    }

    func rename(_ index: Int, title: String) throws {
        var item = try requireItem(index)
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 120 else { throw PocketStoreError.invalid("名称须为 1–120 个字符。") }
        item.title = title
        item.generatedTitle = nil
        var next = slots
        next[index] = item
        try commit(next)
    }

    func togglePin(_ index: Int) throws {
        var item = try requireItem(index)
        item.pinned.toggle()
        var next = slots
        next[index] = item
        try commit(next)
    }

    func swap(_ a: Int, _ b: Int) throws {
        try check(a)
        try check(b)
        guard a != b else { return }
        // Explicit movement remains available for legacy pinned items. The
        // serialized pin flag itself is preserved for history compatibility.
        var next = slots
        next.swapAt(a, b)
        try commit(next)
    }

    func undo() throws {
        guard let previous = history.last else { throw PocketStoreError.noUndo }
        var nextHistory = history
        nextHistory.removeLast()
        let retainedHistory = try persist(slots: previous, history: nextHistory)
        slots = previous
        history = retainedHistory
    }

    func write(_ index: Int, to pb: NSPasteboard, plain: Bool = false) throws {
        let item = try requireItem(index)
        let output = NSPasteboardItem()
        // “文字去格式” applies only to textual items. Images and file references
        // keep their native pasteboard representations when that preference is on.
        if plain && ["text", "richText", "link"].contains(item.kind) {
            guard let text = item.text else { throw PocketStoreError.invalid("文字内容缺失。") }
            output.setString(text, forType: .string)
        } else {
            switch item.kind {
            case "files":
                let access = try fileAccess(index)
                defer { access.close() }
                try PocketFileTransfer.write(access.urls, to: pb)
                return
            case "image":
                guard let path = item.imagePath else { throw PocketStoreError.invalid("图片内容缺失。") }
                let url = try assetURL(path, checkExists: true)
                let data = try boundedData(url, maximum: Self.maximumImageBytes)
                try validateImage(data: data)
                if ["png", "tif", "tiff"].contains(url.pathExtension.lowercased()) {
                    output.setData(data, forType: url.pathExtension.lowercased() == "png" ? .png : .tiff)
                } else {
                    guard let image = NSImage(data: data), let tiff = image.tiffRepresentation,
                          tiff.count <= 128 * 1024 * 1024 else { throw PocketStoreError.invalid("图片无法转换为剪贴板格式。") }
                    output.setData(tiff, forType: .tiff)
                }
            case "richText":
                guard let path = item.richTextPath else { throw PocketStoreError.invalid("富文本内容缺失。") }
                let data = try boundedData(assetURL(path, checkExists: true), maximum: Self.maximumTextBytes)
                guard NSAttributedString(rtf: data, documentAttributes: nil) != nil else { throw PocketStoreError.invalid("富文本内容无法读取。") }
                output.setData(data, forType: .rtf)
                output.setString(item.text ?? "", forType: .string)
            case "text", "link":
                guard let text = item.text else { throw PocketStoreError.invalid("文字内容缺失。") }
                output.setString(text, forType: .string)
                if item.kind == "link" {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if Self.isSupportedLink(trimmed) { output.setString(trimmed, forType: .URL) }
                }
            default: throw PocketStoreError.unsupported
            }
        }
        pb.clearContents()
        guard pb.writeObjects([output]) else { throw PocketStoreError.invalid("无法写入剪贴板。") }
    }

    func fileAccess(_ index: Int) throws -> PocketFileAccess {
        let item = try requireItem(index)
        guard item.kind == "files" else { throw PocketStoreError.unsupported }
        // Older versions kept only URL strings. A new bookmark made from that
        // string cannot recover the user's original file selection. Repair that
        // metadata once through NSOpenPanel instead of reporting an empty copy.
        // App-owned transfer files already have access and need no re-selection.
        let ownedRoot=root.resolvingSymlinksInPath().path+"/"
        for reference in item.files where item.fileBookmarks?[reference] == nil {
            let url=try fileReference(reference,checkExists:true)
            guard url.resolvingSymlinksInPath().path.hasPrefix(ownedRoot) else {
                throw PocketFileAccessError.denied(url.lastPathComponent)
            }
        }
        return try PocketFileAccess(urls: item.files.map { try PocketFileAccess.resolve($0, bookmark: item.fileBookmarks?[$0]) })
    }

    /// Renew only access metadata; content, identity, order and undo stay exact.
    func renewFileAccess(_ index: Int, urls: [URL]) throws {
        var item = try requireItem(index)
        guard item.kind == "files", urls.count == item.files.count else { throw PocketStoreError.unsupported }
        let expected = try item.files.map { try fileReference($0, checkExists: false).standardizedFileURL.path }
        guard Set(urls.map { $0.standardizedFileURL.path }) == Set(expected) else {
            throw PocketStoreError.invalid(PocketL10n.english ? "Select the original file or folder for this slot." : "请选择这个槽位原来的文件或文件夹。")
        }
        let access = try PocketFileAccess(urls: urls)
        defer { access.close() }
        item.fileBookmarks = try Dictionary(uniqueKeysWithValues: item.files.map { reference in
            let path = try fileReference(reference, checkExists: false).standardizedFileURL.path
            let url = urls.first { $0.standardizedFileURL.path == path }!
            return (reference, try PocketFileAccess.bookmark(url))
        })
        var next = slots; next[index] = item
        let kept = try persist(slots: next, history: history)
        slots = next; history = kept
    }

    func snapshot() -> [[String: Any]] {
        let formatter = ISO8601DateFormatter()
        return slots.enumerated().map { index, item in
            guard let item else { return ["index": index, "empty": true] }
            // Use the same bookmark resolution as actual retrieval. A valid
            // bookmark may follow a renamed/moved original on the same volume.
            let resolvedFiles = item.files.map { try? PocketFileAccess.resolve($0,bookmark:item.fileBookmarks?[$0]) }
            let missingFile = resolvedFiles.contains { url in
                guard let url else{return true}
                let scope=url.startAccessingSecurityScopedResource()
                defer {if scope {url.stopAccessingSecurityScopedResource()}}
                return !FileManager.default.fileExists(atPath:url.path)
            }
            let missingImage = item.imagePath.map { (try? assetURL($0, checkExists: true)) == nil } ?? false
            let missingRichText = item.richTextPath.map { (try? assetURL($0, checkExists: true)) == nil } ?? false
            return [
                "index": index, "empty": false, "id": item.id, "kind": item.kind,
                "title": item.displayTitle, "text": item.text ?? "", "files": item.files,
                "imagePath": item.imagePath ?? "", "createdAt": formatter.string(from: item.createdAt),
                "pinned": item.pinned, "missing": missingFile || missingImage || missingRichText,
                "containsFolders": item.kind == "files" && resolvedFiles.contains { resolved in
                    guard let url=resolved else{return false}
                    let scope=url.startAccessingSecurityScopedResource()
                    defer {if scope {url.stopAccessingSecurityScopedResource()}}
                    var directory: ObjCBool = false
                    return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
                },
                "preview": String((item.text ?? item.displayTitle).prefix(240)),
                "count": item.kind == "files" ? item.files.count : 1
            ]
        }
    }

    private func makeItem(kind: String, title: String, text: String? = nil, files: [String] = [], imagePath: String? = nil, richTextPath: String? = nil, generatedTitle: String? = nil) -> PocketItem {
        let label = generatedTitle ?? ((kind == "text" || kind == "richText") && text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true ? "text" : nil)
        return PocketItem(id: UUID().uuidString, kind: kind, title: title, text: text, files: files, imagePath: imagePath, richTextPath: richTextPath, createdAt: Date(), pinned: false, generatedTitle: label)
    }

    private func titleForText(_ value: String) -> String {
        let first = value.components(separatedBy: .newlines).first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? "文字"
        return String(first.trimmingCharacters(in: .whitespaces).prefix(80))
    }

    private static func isSupportedLink(_ value: String) -> Bool {
        guard !value.contains(where: { $0.isWhitespace }), let url = URL(string: value), let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "http" || scheme == "https" { return !(url.host ?? "").isEmpty }
        return scheme == "mailto" && !url.path.isEmpty
    }

    /// A deliberately small HTML-to-text fallback for clipboard payloads without plain text.
    /// Tags and attributes are never interpreted as resources. Escaped markup is decoded only
    /// after tag removal, so it remains literal text; declarations/entities cannot read files.
    private static func plainTextFromHTML(_ html: String) -> String {
        var source = html[...]
        if let start = source.range(of: "<!--StartFragment-->", options: .caseInsensitive),
           let end = source.range(of: "<!--EndFragment-->", options: .caseInsensitive, range: start.upperBound..<source.endIndex) {
            source = source[start.upperBound..<end.lowerBound]
        }
        let blockTags = Set(["address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tr", "ul"])
        let hiddenTags = Set(["head", "script", "style", "iframe", "object", "template", "noscript", "svg"])
        var hidden: String?
        var result = ""
        var cursor = source.startIndex

        func lineBreak() {
            while result.last == " " || result.last == "\t" { result.removeLast() }
            if !result.isEmpty, result.last != "\n" { result.append("\n") }
        }
        func appendText(_ text: Substring) {
            for character in decodeHTMLEntities(text) {
                if character.isWhitespace {
                    if !result.isEmpty, result.last != " " && result.last != "\n" { result.append(" ") }
                } else { result.append(character) }
            }
        }
        func isASCIILetter(_ c: Character) -> Bool {
            guard let ascii = c.asciiValue else { return false }
            return (65...90).contains(ascii) || (97...122).contains(ascii)
        }

        while cursor < source.endIndex {
            guard let opening = source[cursor...].firstIndex(of: "<") else {
                if hidden == nil { appendText(source[cursor...]) }
                break
            }
            if hidden == nil { appendText(source[cursor..<opening]) }
            if source[opening...].hasPrefix("<!--") {
                guard let end = source.range(of: "-->", range: opening..<source.endIndex) else { break }
                cursor = end.upperBound
                continue
            }
            var index = source.index(after: opening)
            guard index < source.endIndex else {
                if hidden == nil { result.append("<") }
                break
            }
            let closing = source[index] == "/"
            if closing { index = source.index(after: index) }
            guard index < source.endIndex, isASCIILetter(source[index]) || source[index] == "!" || source[index] == "?" else {
                if hidden == nil { result.append("<") }
                cursor = source.index(after: opening)
                continue
            }
            let nameStart = index
            while index < source.endIndex, isASCIILetter(source[index]) || source[index].isNumber { index = source.index(after: index) }
            let name = source[nameStart..<index].lowercased()
            var quote: Character?
            var end: String.Index?
            while index < source.endIndex {
                let character = source[index]
                if let active = quote {
                    if character == active { quote = nil }
                } else if character == "\"" || character == "'" { quote = character }
                else if character == ">" { end = index; break }
                index = source.index(after: index)
            }
            guard let end else { break }
            cursor = source.index(after: end)
            if let current = hidden {
                if closing && name == current { hidden = nil }
                continue
            }
            if hiddenTags.contains(name), !closing { hidden = name; continue }
            if blockTags.contains(name) { lineBreak() }
            else if name == "td" || name == "th" {
                if !result.isEmpty, result.last != " " && result.last != "\n" { result.append(" ") }
            }
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func decodeHTMLEntities(_ text: Substring) -> String {
        let named: [String: String] = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ", "ensp": " ", "emsp": " ", "thinsp": " ", "ndash": "–", "mdash": "—", "hellip": "…", "bull": "•", "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”", "copy": "©", "reg": "®", "trade": "™", "deg": "°", "times": "×", "divide": "÷"]
        var result = ""
        var cursor = text.startIndex
        while cursor < text.endIndex {
            guard text[cursor] == "&" else {
                result.append(text[cursor]); cursor = text.index(after: cursor); continue
            }
            let start = text.index(after: cursor)
            var end = start
            var count = 0
            while end < text.endIndex, text[end] != ";", count < 32, !text[end].isWhitespace, text[end] != "&" {
                end = text.index(after: end); count += 1
            }
            if end < text.endIndex, text[end] == ";" {
                let entity = String(text[start..<end])
                var decoded = named[entity]
                if entity.hasPrefix("#") {
                    let hexadecimal = entity.hasPrefix("#x") || entity.hasPrefix("#X")
                    let digits = entity.dropFirst(hexadecimal ? 2 : 1)
                    if let number = UInt32(digits, radix: hexadecimal ? 16 : 10), number > 0,
                       let scalar = UnicodeScalar(number) { decoded = String(scalar) }
                }
                if let decoded {
                    result.append(decoded); cursor = text.index(after: end); continue
                }
            }
            result.append("&"); cursor = start
        }
        return result
    }

    private func check(_ index: Int) throws {
        guard slots.indices.contains(index) else { throw PocketStoreError.invalidIndex }
    }

    private func requireItem(_ index: Int) throws -> PocketItem {
        try check(index)
        guard let item = slots[index] else { throw PocketStoreError.emptySlot }
        return item
    }

    private func validateText(_ text: String) throws {
        guard text.utf8.count <= Self.maximumTextBytes else { throw PocketStoreError.limit("文字不能超过 16 MB。") }
    }

    private func validate(_ item: PocketItem) throws {
        guard !item.id.isEmpty, !item.title.isEmpty, item.title.count <= 120,
              ["text", "richText", "image", "link", "files"].contains(item.kind),
              item.files.count <= Self.maximumFiles else { throw PocketStoreError.invalid("口袋内容格式不正确。") }
        if let bookmarks = item.fileBookmarks {
            guard bookmarks.count <= Self.maximumFiles, bookmarks.allSatisfy({ item.files.contains($0.key) && $0.value.count <= 64 * 1024 }) else {
                throw PocketStoreError.invalid("口袋内容格式不正确。")
            }
        }
        if let text = item.text { try validateText(text) }
        for file in item.files { _ = try fileReference(file, checkExists: false) }
        if let path = item.imagePath { _ = try assetURL(path, checkExists: false) }
        if let path = item.richTextPath { _ = try assetURL(path, checkExists: false) }
        switch item.kind {
        case "text", "link": guard item.text != nil else { throw PocketStoreError.invalid("文字内容缺失。") }
        case "richText": guard item.text != nil, item.richTextPath != nil else { throw PocketStoreError.invalid("富文本内容缺失。") }
        case "image": guard item.imagePath != nil else { throw PocketStoreError.invalid("图片内容缺失。") }
        case "files": guard !item.files.isEmpty else { throw PocketStoreError.invalid("文件引用为空。") }
        default: throw PocketStoreError.unsupported
        }
    }

    private func fileReference(_ value: String, checkExists: Bool) throws -> URL {
        guard let url = URL(string: value), url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else {
            throw PocketStoreError.invalid("文件引用不是有效的本机 URL。")
        }
        if checkExists, !FileManager.default.fileExists(atPath: url.path) { throw PocketStoreError.missing(url.lastPathComponent) }
        return url
    }

    private func assetURL(_ path: String, checkExists: Bool) throws -> URL {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let canonical = url.resolvingSymlinksInPath().path
        let prefix = assets.resolvingSymlinksInPath().path + "/"
        guard canonical.hasPrefix(prefix), url.path == path else { throw PocketStoreError.invalid("素材路径不在当前口袋数据目录。") }
        if checkExists, !FileManager.default.fileExists(atPath: url.path) { throw PocketStoreError.missing(url.lastPathComponent) }
        return url
    }

    private func boundedData(_ url: URL, maximum: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximum + 1) ?? Data()
        guard data.count <= maximum else { throw PocketStoreError.limit("素材超过大小限制。") }
        return data
    }

    private func validateImage(data: Data) throws {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            throw PocketStoreError.invalid("图片格式无法读取。")
        }
        try validateImageSource(source)
    }

    private func validateImage(url: URL) throws {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            throw PocketStoreError.invalid("图片格式无法读取。")
        }
        try validateImageSource(source)
    }

    private func validateImageSource(_ source: CGImageSource) throws {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 16_384, height <= 16_384,
              Int64(width) * Int64(height) <= 80_000_000 else {
            throw PocketStoreError.limit("图片尺寸过大或无法读取（单边最多 16384 像素，总计最多 8000 万像素）。")
        }
    }

    private func persistAsset(_ data: Data, extension suffix: String) throws -> URL {
        let url = assets.appendingPathComponent(UUID().uuidString).appendingPathExtension(suffix)
        try data.write(to: url, options: .atomic)
        return url
    }

    private func commit(_ next: [PocketItem?]) throws {
        var nextHistory = history
        nextHistory.append(slots)
        if nextHistory.count > Self.maximumHistory { nextHistory.removeFirst(nextHistory.count - Self.maximumHistory) }
        let retainedHistory = try persist(slots: next, history: nextHistory)
        slots = next
        history = retainedHistory
    }

    @discardableResult
    private func persist(slots: [PocketItem?], history: [[PocketItem?]]) throws -> [[PocketItem?]] {
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.sortedKeys]
            var retainedHistory = history
            var bytes = try encoder.encode(State(version: 1, slots: slots, history: retainedHistory))
            // History is best effort within the storage budget. A full history must never
            // prevent clearing large text or make the library impossible to recover.
            while bytes.count > 64 * 1024 * 1024, !retainedHistory.isEmpty {
                retainedHistory.removeFirst()
                bytes = try encoder.encode(State(version: 1, slots: slots, history: retainedHistory))
            }
            guard bytes.count <= 64 * 1024 * 1024 else { throw PocketStoreError.limit("口袋文字记录合计不能超过 64 MB，请减少长文本内容。") }
            try bytes.write(to: stateURL, options: .atomic)
            return retainedHistory
        } catch {
            throw PocketStoreError.persistence(error.localizedDescription)
        }
    }
}
