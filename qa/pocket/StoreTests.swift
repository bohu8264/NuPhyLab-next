import Foundation
import AppKit

@main
struct StoreTests {
    static var checks = 0

    static func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        checks += 1
        if try !value() { throw NSError(domain: "StoreTests", code: checks, userInfo: [NSLocalizedDescriptionKey: message]) }
    }

    static func expectError(_ message: String, _ operation: () throws -> Void) throws {
        do { try operation() } catch { checks += 1; return }
        throw NSError(domain: "StoreTests", code: -1, userInfo: [NSLocalizedDescriptionKey: "Expected error: " + message])
    }

    static func plain(_ text: String, board: NSPasteboard, store: PocketStore) throws -> PocketItem {
        board.clearContents()
        board.setString(text, forType: .string)
        return try store.capture(board)
    }

    static func main() throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("NuPhyPocket-StoreTests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let board = NSPasteboard(name: NSPasteboard.Name("local.nuphylab.pocket.tests." + UUID().uuidString))
        defer { board.releaseGlobally() }
        let root = temporary.appendingPathComponent("store", isDirectory: true)
        let store = try PocketStore(root: root)

        try expect(store.slots.count == 9 && store.slots.allSatisfy { $0 == nil }, "nine initial empty slots")
        try expect(store.snapshot().count == 9 && store.snapshot()[8]["empty"] as? Bool == true, "empty snapshot")
        try expect(!store.canUndo, "initial undo unavailable")
        try expectError("undo initially empty") { try store.undo() }
        let text = try plain("第一行\nsecond line 🚀", board: board, store: store)
        try expect(text.kind == "text" && text.text == "第一行\nsecond line 🚀" && text.title == "第一行", "text capture")
        try store.put(text, at: 0)
        try expect(store.canUndo, "put is undoable")
        try expectError("occupied slot") { try store.put(text, at: 0) }
        try expectError("negative index") { try store.put(text, at: -1) }
        try expectError("index nine") { try store.clear(9) }
        try expectError("empty clear") { try store.clear(8) }
        try expectError("empty rename") { try store.rename(0, title: "  \n") }
        try expectError("long rename") { try store.rename(0, title: String(repeating: "x", count: 121)) }
        try store.rename(0, title: "  我的资料  ")
        try expect(store.slots[0]?.title == "我的资料", "trimmed rename")
        try store.togglePin(0)
        try store.clear(0)
        try expect(store.slots[0] == nil, "explicit clear can remove retired pinned item")
        try store.undo()
        try expect(store.slots[0]?.pinned == true, "undo preserves retired pin metadata")
        try store.put(text, at: 0, replace: true)
        try expect(store.slots[0]?.pinned == false, "explicit replacement can replace retired pinned item")
        try store.undo()
        try expect(store.slots[0]?.pinned == true, "replacement undo restores retired pin")
        try store.swap(0, 1)
        try expect(store.slots[1]?.pinned == true && store.slots[0] == nil, "explicit swap preserves retired pinned content")
        try store.undo()
        try store.put(text, at: 1)
        try store.clearUnpinned()
        try expect(store.slots[0]?.pinned == true && store.slots[1] == nil, "clear unpinned preserves pinned")
        try store.undo()
        try expect(store.slots[1] != nil, "undo clear restores content")
        try store.togglePin(0)
        try store.swap(0, 2)
        try expect(store.slots[0] == nil && store.slots[2]?.title == "我的资料", "swap with empty slot")
        try store.write(2, to: board)
        try expect(board.string(forType: .string) == text.text, "text round trip")
        let reopened = try PocketStore(root: root)
        try expect(reopened.slots[2]?.title == "我的资料" && reopened.slots[1]?.id == text.id, "slots reopen")
        try expect(reopened.canUndo, "undo history reopens")
        try reopened.undo()
        try expect(reopened.slots[0]?.title == "我的资料" && reopened.slots[2] == nil, "undo after reopen")
        try reopened.togglePin(0)
        let beforeClearAll = reopened.slots.compactMap { $0?.id }
        try reopened.clearAll()
        try expect(reopened.slots.allSatisfy { $0 == nil }, "explicit clear-all includes legacy pinned items")
        let afterClearReopen = try PocketStore(root: root)
        try afterClearReopen.undo()
        try expect(afterClearReopen.slots.compactMap { $0?.id } == beforeClearAll && afterClearReopen.slots[0]?.pinned == true, "clear-all undo after reopen restores content and pin metadata")

        let richRoot = temporary.appendingPathComponent("rich-store")
        let richStore = try PocketStore(root: richRoot)
        let rich = NSAttributedString(string: "粗体与普通文本")
        let rtf = try rich.data(from: NSRange(location: 0, length: rich.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        board.clearContents()
        let richPayload = NSPasteboardItem()
        richPayload.setData(rtf, forType: .rtf)
        richPayload.setString("稳定纯文本", forType: .string)
        richPayload.setString("<script>throw new Error('must not execute')</script><b>ignored</b>", forType: .html)
        board.writeObjects([richPayload])
        let richItem = try richStore.capture(board)
        try expect(richItem.kind == "richText" && richItem.text == "稳定纯文本", "RTF preferred with original plain text")
        try richStore.put(richItem, at: 0)
        try richStore.write(0, to: board)
        try expect(board.data(forType: .rtf) == rtf && board.string(forType: .string) == "稳定纯文本", "rich text round trip")
        try expect(board.data(forType: .html) == nil, "HTML is not retained or executed")
        try richStore.write(0, to: board, plain: true)
        try expect(board.string(forType: .string) == "稳定纯文本" && board.data(forType: .rtf) == nil, "plain rich-text write")
        board.clearContents()
        board.setData(rtf, forType: .rtf)
        try expect(try richStore.capture(board).text == rich.string, "RTF derives plain text when absent")
        board.clearContents()
        board.setString("<b>HTML only</b>", forType: .html)
        let htmlOnly = try richStore.capture(board)
        try expect(htmlOnly.kind == "text" && htmlOnly.text == "HTML only", "HTML-only becomes plain text without a browser")
        let link = try plain("https://example.com/a%20b?q=%E4%B8%AD%E6%96%87", board: board, store: richStore)
        try expect(link.kind == "link", "URL inferred from plain text")
        try richStore.put(link, at: 1)
        try richStore.write(1, to: board)
        try expect(board.string(forType: .URL) == link.text, "URL round trip")
        let multiLine = try plain("https://example.com\nextra", board: board, store: richStore)
        try expect(multiLine.kind == "text", "multiline text is not a URL")
        let customScheme = try plain("javascript:alert(1)", board: board, store: richStore)
        try expect(customScheme.kind == "text", "executable schemes remain text")

        let fileA = temporary.appendingPathComponent("中文 空格 #100%.txt")
        let fileB = temporary.appendingPathComponent("第二个.data")
        try Data("alpha".utf8).write(to: fileA)
        try Data("beta".utf8).write(to: fileB)
        board.clearContents()
        board.writeObjects([fileA as NSURL, fileB as NSURL])
        let files = try richStore.capture(board)
        try expect(files.kind == "files" && files.files == [fileA.absoluteString, fileB.absoluteString], "file URLs preserve encoding and order")
        try richStore.put(files, at: 2)
        try richStore.write(2, to: board)
        let outputURLs = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ?? []).compactMap { ($0 as? NSURL).map { $0 as URL } }
        try expect(outputURLs.map { $0.resolvingSymlinksInPath().path } == [fileA,fileB].map { $0.resolvingSymlinksInPath().path }, "file paths round trip special characters")
        try expect(richStore.snapshot()[2]["count"] as? Int == 2 && richStore.snapshot()[2]["missing"] as? Bool == false, "file snapshot count and presence")
        let duplicate = try richStore.itemFromFiles([fileA, fileA])
        try expect(duplicate.files.count == 1, "duplicate file references removed")
        try FileManager.default.removeItem(at: fileB)
        try expect(richStore.snapshot()[2]["missing"] as? Bool == true, "missing external file is visible")
        board.clearContents()
        board.setString("keep existing", forType: .string)
        try expectError("missing file write") { try richStore.write(2, to: board) }
        try expect(board.string(forType: .string) == "keep existing", "failed file write does not clear pasteboard")
        try expectError("missing file import") { _ = try richStore.itemFromFiles([fileB]) }
        try expectError("remote file import") { _ = try richStore.itemFromFiles([URL(string: "https://example.com/file.txt")!]) }
        try expectError("file count limit") { _ = try richStore.itemFromFiles(Array(repeating: fileA, count: 257)) }

        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 8, bitsPerPixel: 32)!
        bitmap.setColor(NSColor.red, atX: 0, y: 0)
        let png = bitmap.representation(using: .png, properties: [:])!
        let sourceImage = temporary.appendingPathComponent("原始图片.png")
        try png.write(to: sourceImage)
        let imageItem = try richStore.itemFromFiles([sourceImage])
        try expect(imageItem.kind == "image" && imageItem.files.isEmpty && imageItem.imagePath != sourceImage.path, "imported image is durable copy")
        try richStore.put(imageItem, at: 3)
        try FileManager.default.removeItem(at: sourceImage)
        try richStore.write(3, to: board)
        try expect(board.data(forType: .png) == png, "imported image survives source deletion")
        try richStore.write(3, to: board, plain: true)
        try expect(board.data(forType: .png) == png && board.string(forType: .string) == nil, "plain preference preserves image type")
        let capturedImage = try richStore.capture(board)
        try expect(capturedImage.kind == "image" && capturedImage.imagePath != imageItem.imagePath, "image clipboard capture")
        let imageAsset = imageItem.imagePath!
        try richStore.clear(3)
        try expect(FileManager.default.fileExists(atPath: imageAsset), "clear retains image asset for undo")
        let imageReopened = try PocketStore(root: richRoot)
        try imageReopened.undo()
        try imageReopened.write(3, to: board)
        try expect(board.data(forType: .png) == png, "image undo after reopen retains bytes")
        let longText = try plain(String(repeating: "中", count: 300), board: board, store: richStore)
        try richStore.put(longText, at: 4)
        try expect((richStore.snapshot()[4]["preview"] as? String)?.count == 240, "preview truncates by characters")
        try expectError("oversized text") { _ = try plain(String(repeating: "x", count: PocketStore.maximumTextBytes + 1), board: board, store: richStore) }
        board.clearContents()
        board.setData(Data("not an image".utf8), forType: .png)
        try expectError("invalid image") { _ = try richStore.capture(board) }
        var escapedAsset = imageItem
        escapedAsset.imagePath = fileA.path
        try expectError("asset outside root") { try richStore.put(escapedAsset, at: 5) }

        // Regression: text editors and browsers may include an image preview of the
        // selected text. That preview must never replace a useful text representation.
        let mixedRoot = temporary.appendingPathComponent("representation-store")
        let mixedStore = try PocketStore(root: mixedRoot)
        let textPreview = NSPasteboardItem()
        textPreview.setString("可编辑的文字，不是截图\nSecond line", forType: .string)
        textPreview.setData(png, forType: .png)
        board.clearContents(); board.writeObjects([textPreview])
        let mixedText = try mixedStore.capture(board)
        try expect(mixedText.kind == "text" && mixedText.text == "可编辑的文字，不是截图\nSecond line" && mixedText.imagePath == nil, "plain text beats PNG preview")
        try mixedStore.put(mixedText, at: 0)
        try mixedStore.write(0, to: board)
        try expect(board.string(forType: .string) == mixedText.text && board.data(forType: .png) == nil, "mixed text writes editable text only")

        let richPreview = NSPasteboardItem()
        richPreview.setData(rtf, forType: .rtf)
        richPreview.setString("富文本的纯文本副本", forType: .string)
        richPreview.setData(png, forType: .png)
        board.clearContents(); board.writeObjects([richPreview])
        let mixedRich = try mixedStore.capture(board)
        try expect(mixedRich.kind == "richText" && mixedRich.text == "富文本的纯文本副本" && mixedRich.imagePath == nil, "valid RTF beats text and PNG preview")
        try mixedStore.put(mixedRich, at: 1)
        try mixedStore.write(1, to: board)
        try expect(board.data(forType: .rtf) == rtf && board.data(forType: .png) == nil, "mixed RTF writes original bytes")
        try mixedStore.write(1, to: board, plain: true)
        try expect(board.string(forType: .string) == mixedRich.text && board.data(forType: .rtf) == nil, "plain preference strips only RTF formatting")

        let filePreview = NSPasteboardItem()
        filePreview.setString(fileA.absoluteString, forType: .fileURL)
        filePreview.setString("文件名显示文字", forType: .string)
        filePreview.setData(rtf, forType: .rtf)
        filePreview.setData(png, forType: .png)
        board.clearContents(); board.writeObjects([filePreview])
        let mixedFiles = try mixedStore.capture(board)
        try expect(mixedFiles.kind == "files" && mixedFiles.files == [fileA.absoluteString], "file reference beats RTF text and PNG")
        try mixedStore.put(mixedFiles, at: 2)
        try mixedStore.write(2, to: board, plain: true)
        let plainFileURLs = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ?? []).compactMap { ($0 as? NSURL).map { $0 as URL } }
        try expect(plainFileURLs.map { $0.resolvingSymlinksInPath().path } == [fileA.resolvingSymlinksInPath().path] && board.data(forType: .png) == nil, "plain preference keeps encoded file URL representation")

        let urlPreview = NSPasteboardItem()
        urlPreview.setString("", forType: .string)
        urlPreview.setString("https://example.com/selected", forType: .URL)
        urlPreview.setData(png, forType: .png)
        board.clearContents(); board.writeObjects([urlPreview])
        let mixedURL = try mixedStore.capture(board)
        try expect(mixedURL.kind == "link" && mixedURL.text == "https://example.com/selected", "empty plain string does not mask URL or prefer PNG")
        try mixedStore.put(mixedURL, at: 3)
        try mixedStore.write(3, to: board, plain: true)
        try expect(board.string(forType: .string) == mixedURL.text && board.string(forType: .URL) == nil, "plain preference makes link plain text")

        let emptyTextImage = NSPasteboardItem()
        emptyTextImage.setString("", forType: .string)
        emptyTextImage.setData(png, forType: .png)
        board.clearContents(); board.writeObjects([emptyTextImage])
        let realImage = try mixedStore.capture(board)
        try expect(realImage.kind == "image" && realImage.text == nil, "empty text with PNG stays image")
        try mixedStore.put(realImage, at: 4)
        try mixedStore.write(4, to: board, plain: true)
        try expect(board.data(forType: .png) == png && NSImage(pasteboard: board) != nil, "pure PNG stays compatible with native image consumers")

        let tiff = bitmap.representation(using: .tiff, properties: [:])!
        board.clearContents(); board.setData(tiff, forType: .tiff)
        let tiffItem = try mixedStore.capture(board)
        try mixedStore.put(tiffItem, at: 5)
        try mixedStore.write(5, to: board, plain: true)
        try expect(tiffItem.kind == "image" && board.data(forType: .tiff) == tiff && NSImage(pasteboard: board) != nil, "TIFF-only round trips with plain preference")
        let jpegURL = temporary.appendingPathComponent("兼容图片.jpg")
        let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.8])!
        try jpeg.write(to: jpegURL)
        let jpegItem = try mixedStore.itemFromFiles([jpegURL])
        try mixedStore.put(jpegItem, at: 6)
        try mixedStore.write(6, to: board, plain: true)
        try expect(board.data(forType: .tiff) != nil && NSImage(pasteboard: board) != nil, "imported JPEG writes native TIFF with plain preference")

        let invalidPreview = NSPasteboardItem()
        invalidPreview.setString("有效文字", forType: .string)
        invalidPreview.setData(Data("invalid preview bytes".utf8), forType: .png)
        invalidPreview.setData(Data("invalid rtf".utf8), forType: .rtf)
        board.clearContents(); board.writeObjects([invalidPreview])
        let recoveredText = try mixedStore.capture(board)
        try expect(recoveredText.kind == "text" && recoveredText.text == "有效文字", "invalid RTF and image previews do not discard valid plain text")

        board.clearContents()
        board.setString("<html><head><style>body{background:url(https://invalid.example/private)}</style><script>secret()</script></head><body><p>Hello &amp; &#x4E2D;&#25991;</p><p title='a > b'>Second<br>line</p><img src='file:///etc/passwd' onerror='alert(1)'><iframe src='https://invalid.example/'>hidden</iframe><!--private--><script>throw 1</script></body></html>", forType: .html)
        let safeHTML = try mixedStore.capture(board)
        try expect(safeHTML.kind == "text" && safeHTML.text == "Hello & 中文\nSecond\nline", "HTML extracts visible text and omits active/resource elements and comments")
        try mixedStore.put(safeHTML, at: 7)
        try mixedStore.write(7, to: board)
        try expect(board.string(forType: .string) == safeHTML.text && board.data(forType: .html) == nil, "HTML fallback writes only plain text")
        board.clearContents()
        board.setString("Version:1.0\nStartHTML:0000\n<html><body>before<!--StartFragment--><b>Selected &lt;script&gt; &unknown;</b><!--EndFragment-->after</body></html>", forType: .html)
        let fragment = try mixedStore.capture(board)
        try expect(fragment.text == "Selected <script> &unknown;", "HTML fragment excludes headers and decodes escaped markup as literal text")
        board.clearContents()
        board.setString("<p>2 < 3 and 4 > 1</p>", forType: .html)
        try expect(try mixedStore.capture(board).text == "2 < 3 and 4 > 1", "HTML text comparisons are not mistaken for tags")
        let htmlPreview = NSPasteboardItem()
        htmlPreview.setString("<p>HTML selection</p>", forType: .html)
        htmlPreview.setData(png, forType: .png)
        board.clearContents(); board.writeObjects([htmlPreview])
        try expect(try mixedStore.capture(board).kind == "text", "HTML visible text beats image preview")
        let imageHTML = NSPasteboardItem()
        imageHTML.setString("<img src='https://invalid.example/image.png'>", forType: .html)
        imageHTML.setData(png, forType: .png)
        board.clearContents(); board.writeObjects([imageHTML])
        try expect(try mixedStore.capture(board).kind == "image", "HTML containing only an image keeps actual PNG")
        board.clearContents(); board.setString("<script>must never execute</script>", forType: .html)
        try expectError("HTML with no visible text") { _ = try mixedStore.capture(board) }
        board.clearContents(); board.setString(String(repeating: "x", count: PocketStore.maximumTextBytes + 1), forType: .html)
        try expectError("HTML size limit") { _ = try mixedStore.capture(board) }

        let oldImageID = mixedStore.slots[4]!.id
        let oldImagePath = mixedStore.slots[4]!.imagePath!
        let untouchedState = try Data(contentsOf: mixedRoot.appendingPathComponent("pockets.json"))
        let mixedReopened = try PocketStore(root: mixedRoot)
        try expect(mixedReopened.slots[4]?.kind == "image" && mixedReopened.slots[4]?.id == oldImageID && mixedReopened.slots[4]?.imagePath == oldImagePath, "existing images reopen unchanged without OCR or migration")
        try expect(try Data(contentsOf: mixedRoot.appendingPathComponent("pockets.json")) == untouchedState, "reopening existing data does not rewrite state")
        try mixedReopened.clear(4)
        try mixedReopened.undo()
        try mixedReopened.write(4, to: board, plain: true)
        try expect(board.data(forType: .png) == png, "existing image assets survive clear and undo after reopen")

        let moveRoot=temporary.appendingPathComponent("move-store")
        let movedStore=try PocketStore(root:moveRoot)
        let originalFolder=temporary.appendingPathComponent("Original folder",isDirectory:true)
        let renamedFolder=temporary.appendingPathComponent("Renamed folder",isDirectory:true)
        try FileManager.default.createDirectory(at:originalFolder,withIntermediateDirectories:true)
        try Data("generated move fixture".utf8).write(to:originalFolder.appendingPathComponent("中文.txt"))
        try movedStore.put(try movedStore.itemFromFiles([originalFolder]),at:0)
        let savedBeforeMove=try Data(contentsOf:moveRoot.appendingPathComponent("pockets.json"))
        try FileManager.default.moveItem(at:originalFolder,to:renamedFolder)
        let movedSnapshot=movedStore.snapshot()[0]
        try expect(movedSnapshot["missing"] as? Bool == false,"bookmark-resolved renamed folder remains available in UI")
        try expect(movedSnapshot["containsFolders"] as? Bool == true,"renamed folder retains Copy ZIP UI")
        try movedStore.write(0,to:board)
        let movedURLs=board.readObjects(forClasses:[NSURL.self],options:[.urlReadingFileURLsOnly:true]) as? [URL]
        try expect(movedURLs?.first?.resolvingSymlinksInPath().path==renamedFolder.resolvingSymlinksInPath().path,"renamed folder UI availability matches clipboard destination")
        try expect(try Data(contentsOf:moveRoot.appendingPathComponent("pockets.json"))==savedBeforeMove,"snapshot and copy preserve original identity and undo bytes")
        try FileManager.default.removeItem(at:renamedFolder)
        // A stale bookmark can resolve a replacement at the original path.
        // Reject it before changing the clipboard or saved slot metadata.
        let identityOriginal=temporary.appendingPathComponent("Identity original.txt")
        let identityMoved=temporary.appendingPathComponent("Identity moved.txt")
        try Data("original payload".utf8).write(to:identityOriginal)
        let identityRoot=temporary.appendingPathComponent("identity-store")
        let identityStore=try PocketStore(root:identityRoot)
        try identityStore.put(identityStore.itemFromFiles([identityOriginal]),at:0)
        var legacyItem=try identityStore.itemFromFiles([identityOriginal])
        legacyItem.fileBookmarks=[identityOriginal.absoluteString:try identityOriginal.bookmarkData(options:[.withSecurityScope,.securityScopeAllowOnlyReadAccess],includingResourceValuesForKeys:nil,relativeTo:nil)]
        try identityStore.put(legacyItem,at:1)
        var damagedItem=legacyItem
        damagedItem.fileBookmarks=[identityOriginal.absoluteString:Data("invalid bookmark".utf8)]
        try identityStore.put(damagedItem,at:2)
        let identityState=try Data(contentsOf:identityRoot.appendingPathComponent("pockets.json"))
        try identityStore.write(1,to:board)
        let legacyURLs=board.readObjects(forClasses:[NSURL.self],options:[.urlReadingFileURLsOnly:true]) as? [URL]
        try expect(legacyURLs?.first?.resolvingSymlinksInPath()==identityOriginal.resolvingSymlinksInPath(),"unchanged R17 bookmark remains usable after upgrade")
        try expect(identityStore.snapshot()[1]["missing"] as? Bool == false,"unchanged legacy bookmark remains available in UI")
        let writer=try FileHandle(forWritingTo:identityOriginal)
        try writer.truncate(atOffset:0);try writer.write(contentsOf:Data("edited in place".utf8));try writer.close()
        try identityStore.write(1,to:board)
        let editedURLs=board.readObjects(forClasses:[NSURL.self],options:[.urlReadingFileURLsOnly:true]) as? [URL]
        try expect(try editedURLs?.first.map{try Data(contentsOf:$0)}==Data("edited in place".utf8),"legacy bookmark still refers to an in-place edited original")
        try expect(identityStore.snapshot()[1]["missing"] as? Bool == false,"editing an original does not invalidate the legacy slot")
        try Data("original payload".utf8).write(to:identityOriginal)
        try FileManager.default.moveItem(at:identityOriginal,to:identityMoved)
        try identityStore.write(0,to:board)
        let identityURLs=board.readObjects(forClasses:[NSURL.self],options:[.urlReadingFileURLsOnly:true]) as? [URL]
        try expect(identityURLs?.first?.resolvingSymlinksInPath()==identityMoved.resolvingSymlinksInPath(),"embedded file identity follows a renamed original")
        board.clearContents();board.setString("preserve clipboard",forType:.string)
        let identityCount=board.changeCount
        try expectError("stale legacy bookmark needs original re-selection") {try identityStore.write(1,to:board)}
        try expectError("invalid bookmark cannot fall back to a path") {try identityStore.write(2,to:board)}
        try Data("unrelated replacement".utf8).write(to:identityOriginal)
        for index in 0...2 {
            try expectError("replacement never substitutes the saved original") {try identityStore.write(index,to:board)}
            try expect(board.changeCount==identityCount && board.string(forType:.string)=="preserve clipboard","rejected identity leaves clipboard intact")
            try expect(identityStore.snapshot()[index]["missing"] as? Bool == true,"invalid identity is unavailable in UI")
        }
        try expect(try Data(contentsOf:identityRoot.appendingPathComponent("pockets.json"))==identityState,"identity lookup does not rewrite slots")
        try expect(try Data(contentsOf:identityMoved)==Data("original payload".utf8),"identity lookup preserves the moved original")
        try expect(movedStore.snapshot()[0]["missing"] as? Bool == true,"deleted original still becomes unavailable")

        let failureRoot = temporary.appendingPathComponent("failure-store")
        let failureStore = try PocketStore(root: failureRoot)
        try failureStore.put(text, at: 0)
        let stateURL = failureRoot.appendingPathComponent("pockets.json")
        let savedURL = failureRoot.appendingPathComponent("saved-original.json")
        let originalState = try Data(contentsOf: stateURL)
        try FileManager.default.moveItem(at: stateURL, to: savedURL)
        try FileManager.default.createDirectory(at: stateURL, withIntermediateDirectories: false)
        try Data("block atomic replacement".utf8).write(to: stateURL.appendingPathComponent("blocker"))
        try expectError("save failure") { try failureStore.rename(0, title: "must not change") }
        try expect(failureStore.slots[0]?.title == text.title && failureStore.canUndo, "failed save preserves memory and undo")
        try expectError("undo save failure") { try failureStore.undo() }
        try expect(failureStore.slots[0]?.id == text.id && failureStore.canUndo, "failed undo preserves memory and history")
        try expect(try Data(contentsOf: savedURL) == originalState, "prior serialized bytes survive failure")
        try FileManager.default.removeItem(at: stateURL)
        try FileManager.default.moveItem(at: savedURL, to: stateURL)
        try failureStore.undo()
        try expect(failureStore.slots[0] == nil, "undo still works after storage recovers")

        let full = try PocketStore(root: temporary.appendingPathComponent("full-store"))
        for index in 0..<9 { try full.put(text, at: index) }
        do {
            try full.put(text, at: 1)
            throw NSError(domain: "StoreTests", code: -1)
        } catch PocketStoreError.full { checks += 1 }
        let replacement = try plain("replacement", board: board, store: full)
        try full.put(replacement, at: 1, replace: true)
        try expect(full.slots[1]?.text == "replacement", "explicit replacement in full store")
        for index in 0..<25 { try full.rename(1, title: "title \(index)") }
        let fullReopened = try PocketStore(root: temporary.appendingPathComponent("full-store"))
        for _ in 0..<20 { try fullReopened.undo() }
        try expect(!fullReopened.canUndo, "history bounded to twenty operations and persists")
        let largeRoot = temporary.appendingPathComponent("large-store")
        let large = try PocketStore(root: largeRoot)
        let largeText = try plain(String(repeating: "x", count: PocketStore.maximumTextBytes - 1024), board: board, store: large)
        try large.put(largeText, at: 0)
        for index in 0..<5 { try large.rename(0, title: "large \(index)") }
        try large.clear(0)
        try expect(large.slots[0] == nil && large.canUndo, "large history is pruned so clear remains possible")
        let largeReopened = try PocketStore(root: largeRoot)
        try largeReopened.undo()
        try expect(largeReopened.slots[0]?.text?.utf8.count == PocketStore.maximumTextBytes - 1024, "large item undo survives history budget and reopen")
        try expectError("non-file storage root") { _ = try PocketStore(root: URL(string: "https://example.com")!) }
        print("PocketStore: \(checks) checks passed (temporary data and named pasteboard only).")
    }
}
