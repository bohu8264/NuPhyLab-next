import AppKit

@MainActor enum DesktopShelfClearCheck {
    typealias QA = DesktopToolsChecks

    static func run(base: URL) async throws {
        guard let screen = NSScreen.main else { throw ShelfFailure.unavailable }
        let suite = "org.nuphylab.qa.shelf.clear." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let fixture = base.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        let tools = DesktopTools(directory: fixture.appendingPathComponent("shelves"), defaults: defaults,
                                 makeHotkey: { VoiceHotkey(listenToSystemEvents: false) })
        defer {
            tools.shutdown()
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: fixture)
        }
        tools.set("notch", false)
        tools.setAdded([DesktopTools.shelf])
        tools.set(DesktopTools.shelf, true)
        tools.refresh()
        guard await QA.wait(5, { tools.store != nil }), let store = tools.store else { throw ShelfFailure.unavailable }
        let original = fixture.appendingPathComponent("Original.txt")
        let originalData = Data("External fixture".utf8)
        try originalData.write(to: original)
        let ids = try store.add([.reference(original)] + (1..<60).map {
            .bytes("Item-\($0).txt", .text, Data("Managed fixture".utf8))
        })
        let firstShelf = store.activeID
        let managed = try store.url(store.active.items[1])
        tools.rememberFree(NSPoint(x:screen.visibleFrame.midX - 200, y:screen.visibleFrame.midY - 100))

        for english in [false, true] {
            tools.english = english
            let lang = english ? "EN" : "ZH"
            let cancel = english ? "Cancel" : "取消"
            let clear = english ? "Clear" : "清空"
            tools.panel.display(on: screen, at: english ? "notch" : "free", automatic: false)
            guard let table = QA.table(), let window = table.window else { throw ShelfFailure.missing }
            table.selectRowIndexes([48,49], byExtendingSelection: false)
            table.scrollRowToVisible(49)
            let frame = window.frame
            let scrollY = table.enclosingScrollView!.contentView.bounds.minY
            if english {
                try request(from: table)
            } else {
                try useContextMenu(on: table, panel: tools.panel)
            }
            guard let cancelButton = button(cancel, window), let confirmButton = button(clear, window) else { throw ShelfFailure.missing }
            QA.check("\(lang) 60-row shelf replaced in same window", window.isVisible && table.isHiddenOrHasHiddenAncestor && NSApp.modalWindow == nil)
            QA.check("\(lang) count visible in prompt", QA.sub(window.contentView, NSTextField.self).contains {
                !$0.isHiddenOrHasHiddenAncestor && $0.stringValue.contains(english ? "60 items" : "60 项")
            })
            QA.check("\(lang) both buttons on screen and hit-testable", [cancelButton,confirmButton].allSatisfy { hittable($0, on:screen) })
            QA.check("\(lang) compact prompt retains top edge", window.frame.height < 170 && abs(window.frame.maxY-frame.maxY)<1 && abs(window.frame.minX-frame.minX)<1)
            tools.panel.scheduleCollapse()
            tools.panel.display(on:screen, at:"left", automatic:true)
            await QA.pause(1.25)
            QA.check("\(lang) confirmation survives pointer exit and drag offer", button(clear,window) === confirmButton && window.isVisible)
            if english {
                try key(53, characters:"\u{1b}", in:window)
            } else {
                cancelButton.performClick(nil)
            }
            QA.check("\(lang) cancel restores selection and scroll", window.frame == frame && !table.isHiddenOrHasHiddenAncestor
                     && table.selectedRowIndexes == [48,49] && abs(table.enclosingScrollView!.contentView.bounds.minY - scrollY)<1
                     && store.active.items.map(\.id) == ids)
            tools.panel.hide()
        }
        tools.panel.display(on:screen, at:"notch", automatic:false)
        guard let table = QA.table(), let window = table.window else { throw ShelfFailure.missing }
        try request(from:table)
        try key(36, characters:"\r", in:window)
        QA.check("Return defaults to cancel", button("Clear",window) == nil && store.active.items.count == 60)
        try request(from: table)
        guard let oldButton = button("Clear", window) else { throw ShelfFailure.missing }
        try store.create("Another fixture shelf")
        let other = try store.add([.bytes("Keep.txt",.text,Data([7]))])
        tools.panel.refresh()
        oldButton.performClick(nil)
        QA.check("switching shelves invalidates the old confirmation", button("Clear",window) == nil && store.active.items.map(\.id) == other)
        tools.select(firstShelf)
        try store.customize(name:"Pinned fixture",color:"graphite",symbol:"tray",pinned:true)
        try request(from:table)
        tools.panel.hide()
        tools.panel.display(on:screen, at:"right", automatic:false)
        QA.check("dismissed prompt stays closed on reopen", button("Clear",window) == nil && store.active.items.count == 60)
        try request(from:table)
        let late = try store.add([.bytes("New arrival.txt", .text, Data([9]))])
        tools.panel.markSelection(late)
        oldButton.performClick(nil)
        QA.check("a stale button cannot confirm a newer request", store.active.items.count == 61 && button("Clear",window) != nil)
        guard let confirm = button("Clear",window) else { throw ShelfFailure.missing }
        confirm.performClick(nil)
        QA.check("only confirmed items removed, new arrivals stay", store.active.items.map(\.id) == late && table.numberOfRows == 1)
        QA.check("external original intact, managed file removed", (try? Data(contentsOf: original)) == originalData && !FileManager.default.fileExists(atPath:managed.path))
        try request(from:table)
        button("Clear",window)?.performClick(nil)
        QA.check("clearing last item returns to empty shelf", store.active.items.isEmpty && table.numberOfRows == 0 && button("Clear",window) == nil)
        try request(from:table)
        QA.check("empty shelf cannot open a destructive prompt", button("Clear",window) == nil)
    }

    private static func request(from table: NSTableView) throws {
        guard let menu = table.menu else { throw ShelfFailure.missing }
        menu.delegate?.menuNeedsUpdate?(menu)
        guard let index = menu.items.firstIndex(where: { $0.representedObject as? String == "clear" }) else { throw ShelfFailure.missing }
        menu.performActionForItem(at: index)
        table.window?.contentView?.layoutSubtreeIfNeeded()
    }

    private static func useContextMenu(on table: NSTableView, panel: ShelfPanel) throws {
        guard let window = table.window, let menu = table.menu else { throw ShelfFailure.missing }
        let rect = table.visibleRect
        let location = table.convert(NSPoint(x:rect.midX,y:rect.midY),to:nil)
        guard let event = NSEvent.mouseEvent(with:.rightMouseDown,location:location,modifierFlags:[],
            timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,context:nil,
            eventNumber:1,clickCount:1,pressure:1) else { throw ShelfFailure.invalid }
        // Exercise actual AppKit menu tracking without sending input to any other process.
        let leave = Timer(timeInterval:0.05,repeats:false) { _ in
            MainActor.assumeIsolated { panel.scheduleCollapse() }
        }
        var visibleWhileChoosing = false
        let finish = Timer(timeInterval:1.4,repeats:false) { _ in
            MainActor.assumeIsolated {
                visibleWhileChoosing = panel.visible
                menu.cancelTrackingWithoutAnimation()
            }
        }
        for timer in [leave,finish] { RunLoop.main.add(timer,forMode:.eventTracking) }
        defer { leave.invalidate(); finish.invalidate() }
        NSMenu.popUpContextMenu(menu, with: event, for: table)
        QA.check("context menu stays visible while choosing Clear", visibleWhileChoosing)
        try request(from: table)
    }

    private static func button(_ title: String, _ window: NSWindow) -> NSButton? {
        QA.sub(window.contentView,NSButton.self).first { $0.title == title && !$0.isHiddenOrHasHiddenAncestor }
    }

    private static func hittable(_ button: NSButton, on screen: NSScreen) -> Bool {
        guard let root = button.window?.contentView, let window = button.window else { return false }
        let rect = button.convert(button.bounds,to:nil)
        let p = root.convert(NSPoint(x:rect.midX,y:rect.midY),from:nil)
        guard let hit = root.hitTest(p) else { return false }
        return screen.frame.contains(window.convertToScreen(rect)) && root.bounds.contains(root.convert(rect,from:nil))
            && (hit === button || hit.isDescendant(of:button))
    }

    private static func key(_ code: UInt16, characters: String, in window: NSWindow) throws {
        guard let event = NSEvent.keyEvent(with:.keyDown, location:.zero, modifierFlags:[], timestamp:0,
            windowNumber:window.windowNumber, context:nil, characters:characters, charactersIgnoringModifiers:characters,
            isARepeat:false, keyCode:code) else { throw ShelfFailure.invalid }
        if !window.performKeyEquivalent(with:event) { window.sendEvent(event) }
    }
}
