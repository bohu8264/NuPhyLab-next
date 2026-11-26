import AppKit

@MainActor enum DesktopShelfCollectionCheck {
    static func run(base: URL) async throws {
        let suite = "org.nuphylab.qa.watch." + UUID().uuidString
        let defaults = UserDefaults(suiteName:suite)!
        let root = base.appendingPathComponent(UUID().uuidString)
        let source = root.appendingPathComponent("input")
        let fm = FileManager.default
        try fm.createDirectory(at:source, withIntermediateDirectories:true)
        try Data().write(to:source.appendingPathComponent("existing.txt"))
        let slow = DispatchSemaphore(value:0)
        let watcher = ShelfWatcher(list: { url in
            if url == source || url.standardizedFileURL.path == source.standardizedFileURL.path {
                _ = slow.wait(timeout:.now()+0.65)
            }
            return try fm.contentsOfDirectory(atPath:url.path)
        })
        defaults.set(true, forKey:"NuPhyLab.desktopTools.shake")
        defaults.set(true, forKey:"NuPhyLab.desktopTools.keyboard-click")
        let tools = DesktopTools(directory:root.appendingPathComponent("database"), defaults:defaults, watcher:watcher,
                                 makeHotkey:{ VoiceHotkey(listenToSystemEvents:false) })
        defer {
            tools.shutdown(); defaults.removePersistentDomain(forName:suite)
            try? fm.removeItem(at:root)
        }
        tools.setAdded([DesktopTools.shelf])
        let check = DesktopToolsChecks.check
        check("retired shake and navigation are removed on startup",
              defaults.object(forKey:tools.k("shake")) == nil && defaults.object(forKey:tools.k("keyboard-click")) == nil && tools.keys["navigate"] == nil)
        tools.handle(["feature":DesktopTools.shelf,"op":"enable","value":true]) { _,_ in }
        guard await DesktopToolsChecks.wait(5, {tools.store != nil}), let store = tools.store else { throw ShelfFailure.invalid }
        let legacy = [ShelfWatchRule(kind:"downloads",path:source.path,shelf:store.activeID,filter:"documents"),
                      ShelfWatchRule(kind:"custom",path:source.path,shelf:store.activeID,filter:"images")]
        tools.set("watch",try JSONEncoder().encode(legacy))
        check("legacy multi-source selection survives upgrade",tools.loadCollection().enabled && tools.loadCollection().rules == legacy)
        try tools.configureCollection(["enabled":false])
        check("one switch pauses every legacy source without erasing choices", !tools.loadCollection().enabled && tools.loadCollection().rules == legacy && tools.watcher.status == "off")
        try tools.configureCollection(["source":"custom","filter":"documents"],customPath:source.path)
        let began = ProcessInfo.processInfo.systemUptime
        var bridgeError: String?
        tools.handle(["feature":DesktopTools.shelf,"op":"collection","enabled":true]) { _,error in bridgeError = error }
        let elapsed = ProcessInfo.processInfo.systemUptime - began
        DesktopToolsChecks.metrics["collection switch milliseconds"] = elapsed * 1000
        check("enable returns before slow initial scan",bridgeError == nil && elapsed < 0.2 && tools.watcher.status == "starting")
        var beat = false
        DispatchQueue.main.asyncAfter(deadline:.now()+0.06) { beat = true }
        check("main loop responds while directory is still scanning",await DesktopToolsChecks.wait(0.35,{beat}) && tools.watcher.status == "starting")
        slow.signal()
        guard await DesktopToolsChecks.wait(3,{tools.watcher.status == "ready"}) else { throw ShelfFailure.invalid }
        check("baseline does not import old files", store.active.items.isEmpty)
        try Data("fixture".utf8).write(to:source.appendingPathComponent("new.txt"))
        try Data().write(to:source.appendingPathComponent("skip.tmp"))
        try Data().write(to:source.appendingPathComponent("skip.png"))
        slow.signal()
        check("new matching file collected once as a reference",await DesktopToolsChecks.wait(5,{store.active.items.count == 1}) && store.active.items[0].title == "new.txt" && store.used == 0)
        try tools.configureCollection(["enabled":false])
        try Data().write(to:source.appendingPathComponent("while-off.txt"))
        await DesktopToolsChecks.pause(0.7)
        check("switch off stops collecting and retains source and type",store.active.items.count == 1 && tools.loadCollection().rules.first?.filter == "documents" && tools.loadCollection().customPath == source.path)
        try tools.configureCollection(["enabled":true])
        try tools.configureCollection(["enabled":false])
        await DesktopToolsChecks.pause(0.75)
        check("late baseline cannot revive a disabled watcher",tools.watcher.status == "off" && store.active.items.count == 1)
        let missing = root.appendingPathComponent("missing")
        try tools.configureCollection(["source":"custom","enabled":true],customPath:missing.path)
        check("missing directory yields actionable status",await DesktopToolsChecks.wait(2, {tools.watcher.status == "unavailable"}))
        try tools.configureCollection(["enabled":false])
        check("all collection gestures leave the UI hidden",!tools.panel.visible)
    }
}
