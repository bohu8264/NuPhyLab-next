import AppKit
import ScreenCaptureKit
import Foundation

/// Isolated pasteboard, generated test artwork and injected provider. No personal API or clipboard.
@main struct AssistFeatureChecks {
    struct Failed: Error { let reason: String; init(_ reason: String) { self.reason = reason } }
    static var passed: [String] = []
    static func check(_ value: @autoclosure () throws -> Bool,_ label: String) throws {
        guard try value() else { throw Failed(label) }; passed.append(label)
    }
    static func image(_ word: String) throws -> Data {
        let canvas = NSImage(size:NSSize(width:600,height:160))
        canvas.lockFocus(); NSColor.white.setFill(); NSRect(x:0,y:0,width:600,height:160).fill()
        (word as NSString).draw(at:.init(x:44,y:48),withAttributes:[.font:NSFont.systemFont(ofSize:44),.foregroundColor:NSColor.black])
        canvas.unlockFocus()
        guard let pixels = canvas.cgImage(forProposedRect:nil,context:nil,hints:nil), let data = AssistClipboard.png(pixels) else { throw Failed("fixture PNG") }
        return data
    }
    @MainActor static func run() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("assist-check-"+UUID().uuidString)
        let suite = "org.nuphylab.assist.qa."+UUID().uuidString, def = UserDefaults(suiteName:suite)!
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally(); def.removePersistentDomain(forName:suite); try? FileManager.default.removeItem(at:dir) }
        let db = try ClipboardArchive(directory:dir.appendingPathComponent("archive"))
        let app = "org.example.notes", policy = AssistPrivacy(["org.example.private"])
        let today = Date(), yesterday = Calendar.current.date(byAdding:.day,value:-1,to:today)!
        let old = Calendar.current.date(byAdding:.day,value:-120,to:today)!
        func insert(_ content: ClipContent,at: Date) throws -> String { try db.add(content,app:"Fixture",bundle:app,days:365,limit:300,now:at) }
        let pinned = try insert(.init(kind:.text,text:"pinned"),at:old); try db.togglePin(pinned)
        let expired = try insert(.init(kind:.text,text:"expired"),at:old)
        let yesterdayLink = try insert(.init(kind:.link,text:"https://github.com/example/glow"),at:yesterday)
        let todayLink = try insert(.init(kind:.link,text:"https://github.com/example/other"),at:today)
        let lateText = try insert(.init(kind:.text,text:String(repeating:"a",count:15000)+" SEARCH_TAIL"),at:today)
        try db.prune(days:30,limit:5)
        try check(try db.list().contains{$0.id == pinned && $0.pinned},"pin survives age pruning")
        try check(try !db.list().contains{$0.id == expired},"expired data removed")
        try check(try db.matchingIDs("search_tail").contains(lateText),"search beyond preview boundary")
        let plan = ClipSearchPlan.local("找一下昨天复制的 GitHub 项目链接")
        try check(try plan.results(db.list(),query:"GitHub",now:today,useEmbedding:false).map(\.id) == [yesterdayLink],"natural language local time, type and keywords")
        try check((try? ClipSearchPlan.fromModel(#"{"keywords":[],"oldestDaysAgo":0,"newestDaysAgo":7}"#)) == nil,"inverted model date range rejected")
        try db.prune(days:30,limit:2)
        try check(try db.list().count == 2 && db.list().first?.id == pinned,"count limit and pin priority")
        let sql = try ClipboardArchive(directory:dir.appendingPathComponent("archive"))
        try check(try sql.list() == db.list(),"history survives reopen")
        try db.remove(lateText); try check((try? db.content(lateText)) == nil,"delete removes payload")
        func set(_ items: [NSPasteboardItem]) { board.clearContents(); _ = board.writeObjects(items) }
        func text(_ value: String,marker: NSPasteboard.PasteboardType? = nil) -> NSPasteboardItem {
            let i = NSPasteboardItem(); i.setString(value,forType:.string); if let marker {i.setString("",forType:marker)}; return i
        }
        func read(_ id: String = "org.example.notes") -> ClipContent? { AssistClipboard.capture(board,change:board.changeCount,foreground:id,privacy:policy)?.0 }
        set([text("hello")]); try check(read()?.text=="hello","plain text capture")
        try check(read("org.example.private.helper")==nil,"excluded foreground and helpers")
        let mismatch = board.changeCount; set([text("second")]); try check(AssistClipboard.capture(board,change:mismatch,foreground:app,privacy:policy)==nil,"changed clipboard ignored")
        let declared = text("blocked"); declared.setString("org.example.private",forType:AssistPrivacy.origin)
        set([declared]); try check(read()==nil,"excluded declared source")
        set([text("first"),text("secret",marker:.init("org.nspasteboard.ConcealedType"))]); try check(read()==nil,"concealed secondary representation rejects whole copy")
        set([text("https://github.com/example")]); try check(read()?.kind == .link,"URL classified")
        let rich = NSAttributedString(string:"Formatted text",attributes:[.font:NSFont.boldSystemFont(ofSize:18)])
        let rtf = try rich.data(from:NSRange(location:0,length:rich.length),documentAttributes:[.documentType:NSAttributedString.DocumentType.rtf])
        let styled = text(rich.string); styled.setData(rtf,forType:.rtf); set([styled])
        guard let original = read() else { throw Failed("read RTF") }
        try AssistClipboard.write(original,to:board,plain:false); try check(board.data(forType:.rtf) != nil,"rich paste restores RTF")
        try AssistClipboard.write(original,to:board,plain:true); try check(board.data(forType:.rtf) == nil && board.string(forType:.string)==rich.string,"plain paste strips formatting")
        let png = try image("NEBULA 742"), bitmap = NSPasteboardItem(); bitmap.setData(png,forType:.png); set([bitmap])
        guard let photo = read() else { throw Failed("read PNG") }
        try check(photo.kind == .image && photo.data == png,"image capture uses original bytes")
        let ocr = try await AssistClipboard.ocr(photo.data)
        try check(ocr.contains("NEBULA") && ocr.contains("742"),"Vision OCR from generated image")
        let photoID = try insert(photo,at:today)
        try check(try db.pendingOCR(privacy:policy).contains(photoID) && !db.pendingOCR(privacy:AssistPrivacy([app])).contains(photoID),"pending OCR respects app policy across reopen")
        try db.setOCR(ocr,id:photoID)
        try check(try !db.pendingOCR(privacy:policy).contains(photoID),"completed OCR is not repeated")
        try check(try db.matchingIDs("NEBULA").contains(photoID),"image found by OCR")
        let file = dir.resolvingSymlinksInPath().appendingPathComponent("specimen.txt"); try Data("generated".utf8).write(to:file)
        let copiedFile = NSPasteboardItem(); copiedFile.setString(file.absoluteString,forType:.fileURL); set([copiedFile])
        guard let files = read() else { throw Failed("capture file") }
        try AssistClipboard.write(files,to:board,plain:false)
        guard let raw = board.pasteboardItems?.first?.string(forType:.fileURL), let returned = URL(string:raw) else { throw Failed("file URL delivery") }
        let sourceID = try FileManager.default.attributesOfItem(atPath:file.path)[.systemFileNumber] as? NSNumber
        let pastedID = try FileManager.default.attributesOfItem(atPath:returned.path)[.systemFileNumber] as? NSNumber
        try check(files.kind == .files && sourceID != nil && sourceID == pastedID && PocketFileTransfer.matches([returned],in:board),"file identity and both pasteboard representations survive bookmark resolution")
        _ = NSApplication.shared
        for name in ["plain","pinned"] { def.set(["keyCode":21,"modifiers":131072],forKey:"NuPhyLab.assist.key."+name) }
        let tool = AssistTools(directory:dir.appendingPathComponent("tool"),defaults:def,board:board,
                               makeHotkey:{ VoiceHotkey(listenToSystemEvents:false,frontmostPID:{ NSRunningApplication.current.processIdentifier }) })
        tool.foreground = { .current }; tool.english = true
        let shortcutState = tool.state(.history)["shortcuts"] as? [String:Any]
        try check(shortcutState.map { Set($0.keys) } == ["history"] && AssistBinding(rawValue:"plain") == nil && AssistBinding(rawValue:"pinned") == nil,
                  "legacy shortcuts are absent from the bridge and cannot register")
        tool.setAdded([.screen,.history])
        try check(!tool.enabled(.screen) && !tool.enabled(.history) && tool.timer == nil,"features default off")
        var calls: [(AIRequestPrompt,[AIImageAttachment])] = []
        tool.configuration = { AIConfiguration(provider:.deepSeek,model:"fixture",imageInputConfirmed:false) }
        tool.request = { _,p,imgs in calls.append((p,imgs)); return p.system?.contains("oldestDaysAgo")==true ? #"{"keywords":["github"],"kind":"link","oldestDaysAgo":1,"newestDaysAgo":1}"# : "Test answer \(calls.count)" }
        tool.setEnabled(true,feature:.history); tool.setEnabled(true,feature:.screen)
        try check(tool.timer != nil && tool.lastChange == board.changeCount && calls.isEmpty,"enable starts at current change without sending")
        try check(try tool.storage().list().isEmpty,"pre-enable clipboard excluded")
        let store = try tool.storage()
        let id = try store.add(.init(kind:.text,text:"UNRELATED-PRIVATE-ENTRY"),app:"Fixture",bundle:app,days:30,limit:300)
        let clip = try store.add(.init(kind:.link,text:"https://github.com/FIXTURE-SELECTED"),app:"Fixture",bundle:app,days:30,limit:300,now:yesterday)
        let binding = tool.bindings[.history]!, historyKey = binding.value!, monitor = binding.monitor
        func pressHistoryKey() async -> VoiceHotkeyDecision {
            let down = monitor.observeRuntime(.init(kind:.down,keyCode:historyKey.keyCode,flags:historyKey.modifiers))
            _ = monitor.observeRuntime(.init(kind:.up,keyCode:historyKey.keyCode,flags:historyKey.modifiers))
            try? await Task.sleep(for:.milliseconds(60)); return down
        }
        let opened = await pressHistoryKey()
        try check(opened.fire && tool.mode == .history,"history hotkey opens the real palette")
        tool.allowed = { false }
        try check(tool.canTrigger(.history) && !tool.canTrigger(.screen),"own panel can close while the host is busy")
        let hidden = await pressHistoryKey()
        try check(hidden.fire && tool.mode == nil && tool.panel == nil,"same hotkey closes the palette")
        tool.allowed = { true }
        _ = await pressHistoryKey()
        try check(tool.mode == .history && tool.selectedID == nil,"opening highlights a row without copying it")
        tool.selectEntry(clip)
        try check(tool.selectedID == clip && board.string(forType:.URL) == "https://github.com/FIXTURE-SELECTED","selecting a link checks and copies the original link")
        tool.selectEntry(id)
        try check(tool.selectedID == id && board.string(forType:.string) == "UNRELATED-PRIVATE-ENTRY","second click replaces the checked entry and system copy")
        let numRows = try store.list().count
        tool.pollClipboard()
        try check(try store.list().count == numRows,"selecting a record does not duplicate it")
        let handleV = tool.historyPasteKey
        guard let appForKey = NSRunningApplication.runningApplications(withBundleIdentifier:"com.apple.finder").first,
              let v = VoiceHotkey.commandKeyCode(for:86,usual:9,commandLayer:false),
              let cmdV = VoiceHotkey.commandKeyCode(for:86,usual:9) else { throw Failed("paste receiver fixture prerequisites") }
        tool.foreground = { appForKey }
        let ctrl = CGEventFlags.maskControl.rawValue, cmd = CGEventFlags.maskCommand.rawValue
        func input(_ kind: VoiceHotkeyEventKind,_ flags: UInt64,_ repeatKey:Bool = false) -> VoiceHotkeyDecision {
            handleV.observeRuntime(.init(kind:kind,keyCode:UInt32(v),flags:flags,isRepeat:repeatKey))
        }
        let pasteDown = input(.down,ctrl), held = input(.down,ctrl,true), pasteUp = input(.up,ctrl)
        try check(pasteDown.commandKeyCode == cmdV && held.consume && held.commandKeyCode == nil && pasteUp.commandKeyCode == cmdV,"one Control-V forwards the genuine Command-V down/up, with no repeat")
        try check(!input(.down,ctrl).consume && !input(.up,ctrl).consume,"subsequent unrelated Control-V passes through")
        tool.selectEntry(clip)
        try check(!input(.down,cmd).consume && !tool.awaitingPaste,"ordinary Command-V stays native and ends the one-time alternative")
        _ = input(.up,cmd)
        tool.selectEntry(id)
        tool.conflict = { _ in "fixture binding" }
        try check(!input(.down,ctrl).consume && !input(.up,ctrl).consume,"existing Control-V shortcut wins")
        tool.conflict = { _ in nil }
        set([text("New copy")])
        try check(!input(.down,ctrl).consume && tool.selectedID == nil,"a newer clipboard ends the selection before the next timer tick")
        _ = input(.up,ctrl)
        tool.foreground = { .current }
        tool.selectEntry(clip)
        tool.updateSearch("missing test entry")
        try check(tool.records.isEmpty && tool.selectedID == clip,"searching does not silently replace the selected clipboard entry")
        tool.updateSearch("")
        _ = await pressHistoryKey()
        _ = await pressHistoryKey()
        try check(tool.selectedID == clip && board.string(forType:.URL) == "https://github.com/FIXTURE-SELECTED","checked entry survives closing and reopening with the same clipboard")
        tool.search = "yesterday's github links"; tool.aiSearch(); await tool.operation?.value
        try check(tool.records.map(\.id) == [clip],"AI search resolved against local archive")
        try check(calls.count == 1 && calls[0].0.user == tool.search && !String(describing:calls[0]).contains("FIXTURE-SELECTED") && calls[0].1.isEmpty,"model search sends query only")
        tool.clipAI(clip); try check(calls.count == 1,"local preview makes no model request")
        tool.ask("Polish")
        let transformingSession = tool.session
        tool.updateSearch("late history edit")
        await tool.operation?.value
        try check(tool.session == transformingSession && tool.answer == "Test answer 2","outgoing search field cannot cancel an entry's AI request")
        try check(calls.count == 2 && calls[1].0.user.contains("FIXTURE-SELECTED") && !calls[1].0.user.contains("UNRELATED-PRIVATE-ENTRY"),"AI transform only sends selected entry")
        tool.ask("Make it shorter"); await tool.operation?.value
        try check(calls.last!.0.user.contains("Make it shorter") && calls.last!.0.user.contains("Test answer 2") && calls.last!.0.user.contains("FIXTURE-SELECTED"),"follow-up retains source and previous answer")
        let resultSession = tool.session
        try check(tool.copyAnswer() && board.string(forType:.string) == "Test answer 3","copy only the latest clipboard answer")
        try check(tool.mode == .clipAI && tool.session == resultSession && tool.notice.isEmpty,"copy keeps the conversation open without inserting a status line")
        tool.close(); tool.mode = .screen; tool.captured = .init(scope:"Fixture window",text:"Screen sample",image:png,sources:[app])
        tool.includeImage = true; tool.ask("Describe"); await tool.operation?.value
        try check(calls.last!.1.isEmpty,"text-only model never receives screen pixels")
        try check(tool.copyAnswer() && board.string(forType:.string) == tool.answer && tool.notice.isEmpty,"screen answer uses the same copy-only feedback")
        tool.configuration = { AIConfiguration(provider:.custom,endpoint:"https://example.test/v1/chat/completions",model:"fixture",imageInputConfirmed:true) }
        tool.ask("Look closer"); await tool.operation?.value
        try check(calls.last!.1.first?.png == png,"explicit image-capable request attaches generated screen")
        let before = calls.count
        tool.captured = .init(scope:"Restricted",text:"never send",image:png,sources:["com.apple.Passwords"])
        tool.ask("Read"); await tool.operation?.value; try check(calls.count == before,"excluded scope cannot send even if stale")
        tool.allowed = { false }; tool.trigger(.screen)
        try check(tool.mode == nil && tool.captured == nil,"screen hotkey dismisses the current conversation")
        tool.allowed = { true }
        let screenBinding = tool.bindings[.screen]!, screenKey = screenBinding.value!
        var screenRequests = 0
        tool.displaySnapshot = { _,_,_,_ in
            screenRequests += 1
            return .init(scope:"Full screen",text:"Two generated windows",image:nil,sources:[app])
        }
        func pressScreenKey() async {
            _ = screenBinding.monitor.observeRuntime(.init(kind:.down,keyCode:screenKey.keyCode,flags:screenKey.modifiers))
            _ = screenBinding.monitor.observeRuntime(.init(kind:.up,keyCode:screenKey.keyCode,flags:screenKey.modifiers))
            try? await Task.sleep(for:.milliseconds(75))
        }
        await pressScreenKey(); await tool.operation?.value
        try check(screenRequests == 1 && tool.captured?.scope == "Full screen" && calls.count == before,"single screen shortcut reads the display locally")
        await pressScreenKey()
        try check(tool.mode == nil && screenRequests == 1,"second screen shortcut closes without another capture")
        tool.displaySnapshot = { _,_,_,_ in
            try await Task.sleep(for:.seconds(3))
            return .init(scope:"Late frame",text:"",image:nil,sources:[])
        }
        await pressScreenKey(); let pendingFrame = tool.operation; await pressScreenKey(); await pendingFrame?.value
        try check(tool.mode == nil && tool.captured == nil,"same shortcut cancels an in-flight display snapshot without reopening")
        tool.setSessionAvailable(false); try check(tool.timer == nil && tool.captured == nil && tool.mode == nil,"lock releases capture, session, and recorder")
        set([text("while locked")]); tool.setSessionAvailable(true)
        try check(tool.lastChange == board.changeCount,"resume skips clipboard copied while locked")
        tool.setAdded([]); try check(tool.timer == nil && !tool.enabled(.history) && !tool.enabled(.screen),"feature removal releases both")
        tool.setAdded([.history]); try check(!tool.enabled(.history),"re-adding stays off")
        try check(try tool.storage().content(id).text == "UNRELATED-PRIVATE-ENTRY","feature removal preserves saved entries")
        tool.shutdown()
        if #available(macOS 14.4, *) {
            _ = NSApplication.shared
            let w = NSWindow(contentRect:.init(x:80,y:120,width:460,height:185),styleMask:[.borderless],backing:.buffered,defer:false)
            w.isReleasedWhenClosed = false; w.isOpaque = true; w.backgroundColor = .white
            let field = NSTextField(labelWithString:"LUMEN 527")
            field.frame = .init(x:20,y:30,width:390,height:110); field.textColor = .black; field.font = NSFont.boldSystemFont(ofSize:42)
            w.contentView?.addSubview(field); w.orderFrontRegardless(); w.display()
            defer { w.orderOut(nil) }
            if CGPreflightScreenCaptureAccess() {
                try await Task.sleep(for:.milliseconds(400))
                let content = try await SCShareableContent.currentProcess
                guard let window = content.windows.first(where:{$0.windowID == CGWindowID(w.windowNumber)}) else { throw Failed("generated window not listed") }
                let entire = try await AssistScreenCapture.pixels(filter:SCContentFilter(desktopIndependentWindow:window),size:window.frame.size,crop:nil)
                try check(entire.text.contains("527"),"ScreenCaptureKit single fixture window and OCR")
                let displays = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true).displays
                guard let display = displays.first(where:{$0.frame.contains(window.frame)}) else { throw Failed("fixture display") }
                let portion = window.frame.insetBy(dx:9,dy:9)
                let crop = try await AssistScreenCapture.regionPixels(portion,on:display,including:[window])
                try check(crop.text.contains("527") && crop.imagePNG != entire.imagePNG,"ScreenCaptureKit cropped region only from fixture window")
                let w2 = NSWindow(contentRect:.init(x:550,y:120,width:390,height:185),styleMask:[.borderless],backing:.buffered,defer:false)
                w2.isReleasedWhenClosed = false; w2.isOpaque = true; w2.backgroundColor = .white
                let field2 = NSTextField(labelWithString:"ORBIT 836"); field2.frame = .init(x:12,y:30,width:365,height:110)
                field2.font = .boldSystemFont(ofSize:42); field2.textColor = .black
                w2.contentView?.addSubview(field2); w2.orderFrontRegardless(); w2.display()
                defer { w2.orderOut(nil) }
                try await Task.sleep(for:.milliseconds(250))
                let own = try await SCShareableContent.currentProcess
                let pair = own.windows.filter { [CGWindowID(w.windowNumber), CGWindowID(w2.windowNumber)].contains($0.windowID) }
                try check(pair.count == 2,"two different generated windows share one display")
                if pair.allSatisfy({ AssistPrivacy([]).allows($0.owningApplication?.bundleIdentifier) }) {
                    let shot = try await AssistScreenCapture.desktop(on:display,windows:pair,name:"Fixture display",privacy:AssistPrivacy([]),english:true)
                    try check(shot.scope.hasPrefix("Full screen") && shot.text.contains("527") && shot.text.contains("836"),
                              "full display combines separate windows, including the rear window's visible area")
                } else {
                    // Unbundled command-line test executables have no attributable application.
                    do {
                        _ = try await AssistScreenCapture.desktop(on:display,windows:pair,name:"Fixture",privacy:AssistPrivacy([]),english:true)
                        throw Failed("unattributed capture accepted")
                    } catch let issue as AssistIssue {
                        try check(issue.en == AssistScreenCapture.blocked.en,"unknown window owners stay out of full-display capture")
                    }
                }
                let left = window.frame.offsetBy(dx:-display.frame.minX,dy:-display.frame.minY)
                let sanitized = try await AssistScreenCapture.pixels(filter:SCContentFilter(display:display,including:pair),
                                size:display.frame.size,crop:CGRect(origin:.zero,size:display.frame.size),redactions:[left])
                try check(!sanitized.text.contains("527") && sanitized.text.contains("836"),"mask covers only the correct window before OCR")
                guard let ns = NSBitmapImageRep(data:sanitized.imagePNG) else { throw Failed("redacted preview") }
                let x = Int(left.midX / display.frame.width * CGFloat(ns.pixelsWide))
                let y = Int(left.midY / display.frame.height * CGFloat(ns.pixelsHigh))
                let color = ns.colorAt(x:x,y:y)?.usingColorSpace(.sRGB)
                try check(color.map { $0.redComponent < 0.05 && $0.greenComponent < 0.05 && $0.blueComponent < 0.05 } == true,
                          "same exclusion is black in the actual image attachment")

            } else { print("NOT RUN: external screen recording permission on this test runner") }
            let cn = AssistTools(directory:dir.appendingPathComponent("panel"),defaults:def,board:board)
            cn.bindings.values.forEach{$0.clear()};cn.setAdded([.screen]);cn.setEnabled(true,feature:.screen)
            defer { cn.shutdown() }
            for en in [false,true] {
                cn.english = en;cn.mode = .screen;cn.captured = .init(scope:"Fixture",text:"LUMEN 527",image:nil,sources:[app])
                cn.present(takingFocus:false)
                try await Task.sleep(for:.milliseconds(200))
                guard let shown = NSApp.windows.first(where:{$0.title == (en ? "Screen Awareness":"AI 屏幕感知") && $0.isVisible}),let screen = shown.screen else { throw Failed("native panel not shown") }
                let geometry = LabNotchLayout.place(on:screen,width:524,height:shown.frame.height)
                try check(abs(shown.frame.maxY-geometry.frame.maxY)<2 && abs(shown.frame.midX-geometry.frame.midX)<2 && shown.frame.height<215,"native notch and compact controls "+(en ? "English":"Chinese"))
                cn.mode = en ? .clipAI : .screen
                let lines = Array(repeating:"A", count:12).joined(separator:"\n")
                let short = lines.replacingOccurrences(of:"\n", with:" ")
                cn.answer = short
                try await Task.sleep(for:.milliseconds(450))
                let compact = shown.frame
                cn.answer = lines
                try await Task.sleep(for:.milliseconds(450))
                try check(shown.frame.height > compact.height + 80,"result follows rendered lines of equal-length answers")
                cn.answer = Array(repeating:lines,count:7).joined(separator:"\n")
                try await Task.sleep(for:.milliseconds(450))
                try check(abs(shown.frame.height-geometry.maximumHeight) < 2,"long result scrolls at the available notch height")
                cn.answer = short
                try await Task.sleep(for:.milliseconds(450))
                try check(shown.frame == compact,"a short follow-up shrinks the panel back to its content")
                try check(cn.copyAnswer() && board.string(forType:.string) == short,"latest visible result is copied")
                try await Task.sleep(for:.milliseconds(200))
                try check(shown.frame == compact && cn.notice.isEmpty,"copying leaves the panel height and footer unchanged")
                cn.close()
            }
        }
        _ = todayLink
    }
    static func main() async {
        do { try await run(); print("PASS \(passed.count) checks\n"+passed.joined(separator:"\n")) }
        catch { print("FAIL after \(passed.count): \(error)"); exit(1) }
    }
}
