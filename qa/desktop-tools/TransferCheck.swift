import AppKit
import ApplicationServices

@MainActor enum DesktopToolsTransferCheck {
    static func run(base: URL) async throws {
        let suite = "org.nuphylab.qa.shelf-transfer." + UUID().uuidString
        let directory = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let target = base.appendingPathComponent("NuPhy-R54-receive-" + UUID().uuidString.prefix(8), isDirectory: true)
        let source = directory.appendingPathComponent("QA original.txt")
        let defaults = UserDefaults(suiteName: suite)!
        let tools = DesktopTools(directory: directory.appendingPathComponent("shelf"), defaults: defaults)
        let fm = FileManager.default
        try fm.createDirectory(at: target, withIntermediateDirectories: false)
        try fm.createDirectory(at: directory, withIntermediateDirectories: false)
        let original = Data("Fixture external file".utf8), note = Data("Fixture managed text".utf8)
        try original.write(to: source)
        var appleError: NSDictionary?
        defer {
            tools.shutdown()
            NSAppleScript(source: "tell application \"Finder\" to close every Finder window whose name is \"\(target.lastPathComponent)\"")?.executeAndReturnError(&appleError)
            defaults.removePersistentDomain(forName: suite)
            try? fm.removeItem(at: directory)
            try? fm.removeItem(at: target)
        }
        tools.setAdded([DesktopTools.shelf])
        tools.set(DesktopTools.shelf, true)
        tools.set("collapse", false)
        tools.refresh()
        guard await DesktopToolsChecks.wait(5, { tools.store != nil }) else { throw ShelfFailure.missing }
        let store = try tools.mandatoryStore()
        _ = try store.add([.reference(source), .bytes("QA managed.txt", .text, note)])
        let screen = try XCTUnwrap(NSScreen.main)
        func drag(to drop: CGPoint, receiver: String, cancel: Bool = false) async throws {
            tools.panel.display(on: screen, at: "right", automatic: false)
            await DesktopToolsChecks.pause(0.22)
            let table = try XCTUnwrap(DesktopToolsChecks.table())
            tools.panel.selectAll()
            guard table.selectedRowIndexes.count == 2 else { throw NSError(domain:"TransferCheck",code:5,userInfo:[NSLocalizedDescriptionKey:"Could not select the two fixture rows (\(table.numberOfRows) rows)"]) }
            let origin = DesktopToolsChecks.inTable(table, 0)
            let helper = Process()
            helper.executableURL = base.appendingPathComponent("drag-fixture")
            helper.arguments = [origin.x,origin.y,drop.x,drop.y].map{ String(Double($0)) } + [receiver] + (cancel ? ["cancel"] : [])
            try helper.run()
            guard await DesktopToolsChecks.wait(5, { !helper.isRunning }), helper.terminationStatus == 0 else {
                throw NSError(domain: "TransferCheck", code: 2, userInfo:[NSLocalizedDescriptionKey: "Test drag did not start for \(receiver)"])
            }
            let ended = await DesktopToolsChecks.wait(4, { !tools.panel.dragging })
            guard ended, store.active.items.count == 2 else {
                throw NSError(domain:"TransferCheck",code:6,userInfo:[NSLocalizedDescriptionKey:"Session ended=\(ended), stored items=\(store.active.items.count), receiver=\(receiver), cancelled=\(cancel)"])
            }
            await DesktopToolsChecks.pause(0.25)
        }

        let inboundFile = target.appendingPathComponent("QA original.txt")
        let inboundBytes = Data("Generated Finder inbound fixture".utf8)
        try inboundBytes.write(to:inboundFile)
        let finder = try XCTUnwrap(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first)
        let script = """
            tell application "Finder"
                set w to make new Finder window to (POSIX file "\(target.path)" as alias)
                set current view of w to list view
                set bounds of w to {100, 120, 940, 740}
                activate
            end tell
        """
        NSAppleScript(source: script)?.executeAndReturnError(&appleError)
        guard appleError == nil else {
            throw NSError(domain:"TransferCheck",code:3,userInfo:[NSLocalizedDescriptionKey:"Could not open the generated Finder folder: " + String(describing:appleError)])
        }
        func finderWindow() -> CGRect? {
            let app = AXUIElementCreateApplication(finder.processIdentifier)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == finder.processIdentifier,
                  let win = FixtureAX.element(FixtureAX.value(app,kAXFocusedWindowAttribute)),
                  FixtureAX.name(win) == target.lastPathComponent else { return nil }
            return FixtureAX.frame(win)
        }
        guard await DesktopToolsChecks.wait(3, { finderWindow() != nil }), let box = finderWindow() else { throw NSError(domain:"TransferCheck",code:4,userInfo:[NSLocalizedDescriptionKey:"Generated folder is not the focused Finder window"]) }
        let finderApp = AXUIElementCreateApplication(finder.processIdentifier)
        var originalPoint: CGPoint?
        let finderLabel: Set<String> = ["QA original.txt","QA original"]
        guard await DesktopToolsChecks.wait(4,{
            guard finderWindow() != nil, let window = FixtureAX.element(FixtureAX.value(finderApp,kAXFocusedWindowAttribute)) else { return false }
            originalPoint = FixtureAX.point(finderLabel,in:window)
            return originalPoint != nil
        }), let origin = originalPoint else { throw NSError(domain:"TransferCheck",code:7,userInfo:[NSLocalizedDescriptionKey:"Could not locate the generated file in its Finder window"]) }
        let fixtureContents = Set(store.active.items.map(\.id))
        let top = CGDisplayBounds(CGMainDisplayID())
        for shake in [false, true] {
            await DesktopToolsChecks.pause(0.45)
            let board = NSPasteboard(name: .drag)
            let previousChange = board.changeCount
            let helper = Process()
            helper.executableURL = base.appendingPathComponent("drag-fixture")
            helper.arguments = [origin.x,origin.y,top.midX,top.minY+7].map{String(Double($0))} + ["finder-source:"+target.lastPathComponent] + (shake ? ["shake"]:[])
            try helper.run()
            var seen = false
            let finished = await DesktopToolsChecks.wait(6) {
                if tools.panel.visible { seen = true }
                return !helper.isRunning
            }
            guard finished, helper.terminationStatus == 0 else { throw NSError(domain:"TransferCheck",code:8,userInfo:[NSLocalizedDescriptionKey:"Generated Finder source could not be verified for this drag"]) }
            if shake {
                DesktopToolsChecks.check("shaking a real Finder drag does not open the shelf", !seen && !tools.panel.visible && store.active.items.count == fixtureContents.count)
            } else {
                _ = await DesktopToolsChecks.wait(1.5, { store.active.items.count > fixtureContents.count })
                let added = store.active.items.filter { !fixtureContents.contains($0.id) }
                let inode = (try fm.attributesOfItem(atPath:inboundFile.path))[.systemFileNumber] as? NSNumber
                let received = try added.contains {
                    guard $0.reference != nil, $0.title == inboundFile.lastPathComponent, let inode else { return false }
                    let url = try store.url($0)
                    let actual = (try fm.attributesOfItem(atPath:url.path))[.systemFileNumber] as? NSNumber
                    return actual == inode && (try? Data(contentsOf:url)) == inboundBytes
                }
                DesktopToolsChecks.details["Finder inbound"] = "offer=\(seen), added=\(added.count), original=\(received), drag board changed=\(board.changeCount != previousChange), types=\((board.types ?? []).map(\.rawValue).joined(separator:","))"

                DesktopToolsChecks.check("Finder file dropped at notch is stored by reference", seen && received && added.allSatisfy{$0.bytes == 0})
                DesktopToolsChecks.check("Finder drop leaves no shelf window or badge",await DesktopToolsChecks.wait(2,{!tools.panel.visible}))
                try store.remove(Set(added.map(\.id)))
            }
        }
        _ = await DesktopToolsChecks.wait(4, {
            let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly],kCGNullWindowID) as? [[String:Any]] ?? []
            return !windows.contains { ($0[kCGWindowOwnerPID as String] as? pid_t) == finder.processIdentifier && ($0[kCGWindowLayer as String] as? Int ?? 0) >= 500 }
        })
        guard (try? Data(contentsOf: inboundFile)) == inboundBytes else { throw ShelfFailure.changed }
        try fm.removeItem(at:inboundFile)
        NSAppleScript(source:"tell application \"Finder\" to set current view of first Finder window whose name is \"\(target.lastPathComponent)\" to icon view")?.executeAndReturnError(&appleError)
        await DesktopToolsChecks.pause(0.55)
        let point = CGPoint(x: box.minX + box.width * 0.7, y: box.minY + box.height * 0.58)
        try await drag(to: point, receiver: target.lastPathComponent, cancel: true)
        DesktopToolsChecks.check("cancelled two-item Finder drop creates no files and keeps shelf", try fm.contentsOfDirectory(atPath: target.path).filter{!$0.hasPrefix(".")}.isEmpty && store.active.items.count == 2)
        try await drag(to: point, receiver: target.lastPathComponent)
        let file = target.appendingPathComponent("QA original.txt"), copy = target.appendingPathComponent("QA managed.txt")
        let accepted = await DesktopToolsChecks.wait(5) {
            (try? Data(contentsOf: file)) == original && (try? Data(contentsOf: copy)) == note
        }
        DesktopToolsChecks.check("Finder receives two dragged files with their exact bytes", accepted)
        DesktopToolsChecks.check("source still exists and both shelf items remain", (try? Data(contentsOf: source)) == original && store.active.items.count == 2)
        tools.panel.hide()
        if let pid = Int32(try String(contentsOf: base.appendingPathComponent("actual-browser-pid")).trimmingCharacters(in:.whitespacesAndNewlines)),
           let chrome = NSRunningApplication(processIdentifier: pid), chrome.bundleIdentifier == "com.google.Chrome" {
            try FixtureAX.activateGeneratedBrowser(base)
            let app = AXUIElementCreateApplication(pid)
            func fixture() -> Bool {
                guard chrome.isActive, let win = FixtureAX.element(FixtureAX.value(app,kAXFocusedWindowAttribute)) else { return false }
                return FixtureAX.name(win).contains("NuPhy R54 fixture")
            }
            guard await DesktopToolsChecks.wait(3, fixture) else { throw ShelfFailure.missing }
            var drop: CGPoint?
            _ = await DesktopToolsChecks.wait(3) {
                drop = FixtureAX.point("Fixture Drop Target", on: chrome)
                return drop != nil
            }
            let destination = try XCTUnwrap(drop)
            let before = DesktopToolsChecks.event("drop").count
            try await drag(to: destination, receiver: "chrome")
            let accepted = await DesktopToolsChecks.wait(3) {
                let list = DesktopToolsChecks.event("drop")
                let names = list.last?["v"] as? [String] ?? []
                return list.count > before && Set(names) == ["QA original.txt","QA managed.txt"]
            }
            DesktopToolsChecks.check("Chrome page accepts the same two items in one drag", accepted)
        }
    }
    private static func XCTUnwrap<T>(_ value: T?) throws -> T {
        guard let value else { throw ShelfFailure.missing }; return value
    }
}
