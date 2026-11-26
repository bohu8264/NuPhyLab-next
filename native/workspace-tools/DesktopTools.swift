import AppKit
import ApplicationServices
import Carbon

@MainActor final class DesktopTools {
    static let shelf = "desktop-shelf"
    static let actions = ["shelf", "clipboard", "batch"]

    let defaults: UserDefaults
    let directory: URL
    let trigger = ShelfDragTrigger()
    let watcher: ShelfWatcher
    lazy var composer: ShelfQuestion = {
        let value = ShelfQuestion()
        value.canRecord = { [weak self] in self?.composing == true && !IsSecureEventInputEnabled() }
        return value
    }()

    private var presentedPanel: ShelfPanel?
    var panel: ShelfPanel {
        if let presentedPanel { return presentedPanel }
        let created = ShelfPanel(self)
        presentedPanel = created
        return created
    }
    var store: DesktopShelfStore?
    private var loading = false, loadFailed = false
    var keys: [String: LabCommandShortcut] = [:]
    private var added = false
    var sessionAvailable = true

    var allowed: () -> Bool = { true }, allowsDrop: () -> Bool = { true }, peerBusy: () -> Bool = { false }
    var conflict: (VoiceShortcutValue) -> String? = { _ in nil }
    var activityChanged: () -> Void = {}, settingsChanged: () -> Void = {}
    var configuration: () -> AIConfiguration? = { nil }
    var modelRequest: ((AIConfiguration, AIRequestPrompt, [AIImageAttachment]) async throws -> String)?
    var notice = "", working = false, composing = false, english = false
    var job: Task<Void,Never>?, control: DragJobControl?, jobID = UUID()
    private var cleanup: Timer?
    var lastRules: [ShelfWatchRule] = []
    private var triggerConfig = ""
    var copiedIDs = Set<UUID>(), copyChange: Int?

    var interactive: Bool { composing || keys.values.contains(where: \.isRecording) }
    var shelfEnabled: Bool { added && bool(Self.shelf) }
    var canDrop: Bool { shelfEnabled && store != nil && sessionAvailable && !composing && allowsDrop() && !IsSecureEventInputEnabled() }
    var thumbnailView: Bool { bool("thumb", true) }
    var autoCollapse: Bool { bool("collapse", true) }
    var placement: String { str("placement", "notch") }
    var lastFree: NSPoint? {
        guard let a = defaults.array(forKey: k("free")) as? [Double], a.count == 2 else { return nil }
        return NSPoint(x: a[0], y: a[1])
    }
    func rememberFree(_ p: NSPoint) { set("free", [p.x, p.y]); set("placement", "free") }
    func t(_ zh: String, _ en: String) -> String { english ? en : zh }
    func message(_ error: Error) -> String {
        if let storage = error as? ShelfFailure { return storage.issue.message(english) }
        if let issue = error as? AssistIssue { return issue.message(english) }
        return error.localizedDescription
    }
    func k(_ key: String) -> String { "NuPhyLab.desktopTools." + key }
    func set(_ key: String, _ value: Any) { defaults.set(value, forKey: k(key)) }
    func bool(_ key: String, _ fallback: Bool = false) -> Bool { defaults.object(forKey: k(key)) as? Bool ?? fallback }
    func str(_ key: String, _ fallback: String) -> String { defaults.string(forKey: k(key)) ?? fallback }
    func number(_ key: String, _ fallback: Double) -> Double { defaults.object(forKey: k(key)) as? Double ?? fallback }

    init(directory: URL, defaults: UserDefaults = .standard, watcher: ShelfWatcher? = nil,
         makeHotkey: @MainActor () -> VoiceHotkey = { VoiceHotkey() }) {
        self.directory = directory
        self.defaults = defaults
        self.watcher = watcher ?? ShelfWatcher()

        let mods: UInt64 = (1 << 18) | (1 << 19)
        let initial: [String: VoiceShortcutValue] = [
            "shelf": .init(keyCode:11, modifiers:mods), "clipboard": .init(keyCode:11, modifiers:mods | (1 << 17))
        ]
        for id in Self.actions {
            let key = LabCommandShortcut(defaults: defaults, monitor: makeHotkey(),
                                         preference: k("key." + id), defaultValue: initial[id])
            keys[id] = key
            key.conflict = { [weak self] v in self?.reserved(v, except:id) ?? self?.conflict(v) }
            key.canTrigger = { [weak self] in
                guard let self else { return false }
                return sessionAvailable && shelfEnabled && store != nil && !interactive && allowed()
            }
            key.pressed = { [weak self] in self?.run(id) }
            key.recordingChanged = { [weak self] _ in self?.activityChanged() }
        }
        trigger.allowed = { [weak self] in self?.canDrop == true }
        trigger.show = { [weak self] screen, position in self?.panel.display(on: screen, at: position, automatic: true) }
        trigger.end = { [weak self] in self?.presentedPanel?.endDropOffer() }
        self.watcher.changed = { [weak self] in self?.settingsChanged() }
        self.watcher.collected = { [weak self] items, target in
            guard let self, shelfEnabled, sessionAvailable, let store,
                  store.shelves.contains(where: { $0.id == target && $0.closed == nil }) else { return }
            do {
                try store.appendCollected(items, to: target)
                if presentedPanel?.visible == true { presentedPanel?.refresh() }
            } catch { feedback(message(error)) }
        }
        // Only retired R54 keys are removed. The shelf and its shortcut preferences keep their identities.
        for name in ["keyboard-click","key.navigate","alphabet","tint","size","opacity","style","scope",
                     "continuous","vision","excluded","shake"] where defaults.object(forKey: k(name)) != nil {
            defaults.removeObject(forKey: k(name))
        }
    }

    func setAdded(_ ids: Set<String>) {
        let nowAdded = ids.contains(Self.shelf)
        if !nowAdded && bool(Self.shelf) { set(Self.shelf, false); stopShelf() }
        guard nowAdded != added else { return }
        added = nowAdded
        refresh()
    }
    func setSessionAvailable(_ yes: Bool) {
        guard yes != sessionAvailable else { return }
        sessionAvailable = yes
        if !yes { cancelRecording(); stopShelf() }
        refresh()
    }
    func cancelRecording() { keys.values.forEach { $0.cancelRecording() } }
    private func stopShelf() {
        jobID = UUID()
        job?.cancel(); job = nil; control?.cancel(); control = nil; working = false
        if composing { composing = false; composer.close(); activityChanged() }
        presentedPanel?.hide()
        trigger.stop(); triggerConfig = ""
        watcher.stop(); lastRules = []
        cleanup?.invalidate(); cleanup = nil
    }
    func shutdown() { setSessionAvailable(false); keys.values.forEach { $0.shutdown() } }

    private func loadStore() {
        guard !loading, !loadFailed else { return }
        loading = true
        let directory = self.directory, name = t("我的暂存台", "My shelf")
        let days = Int(number("days", 7)), maxBytes = Int64(number("mb", 512)) * 1024 * 1024
        Task {
            do {
                let loaded = try await Task.detached(priority: .userInitiated) {
                    let store = try DesktopShelfStore(directory: directory, defaultName: name)
                    store.days = days; store.maxBytes = maxBytes
                    try store.prune()
                    return store
                }.value
                store = loaded
            } catch { loadFailed = true; notice = message(error) }
            loading = false
            refresh()
            settingsChanged()
        }
    }
    func refresh() {
        let active = sessionAvailable && shelfEnabled
        for key in keys.values { key.refresh(enabled: active && store != nil) }
        guard active else { return }
        guard let store else { loadStore(); return }
        store.days = Int(number("days", 7)); store.maxBytes = Int64(number("mb", 512)) * 1024 * 1024
        if cleanup == nil {
            cleanup = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.prune() }
            }
        }
        let notch = bool("notch", true), edge = str("edge", "off")
        let signature = "\(notch)/\(edge)"
        if signature != triggerConfig {
            trigger.stop(); triggerConfig = signature; trigger.notch = notch; trigger.edge = edge; trigger.start()
        }
        refreshCollection()
        presentedPanel?.yieldToPeer(composing || peerBusy())
    }
    func prune() {
        if let change = copyChange, change != NSPasteboard.general.changeCount { copiedIDs = []; copyChange = nil }
        do {
            try store?.prune(protected: (presentedPanel?.activeDragIDs ?? []).union(copiedIDs))
            if presentedPanel?.visible == true { presentedPanel?.refresh() }
        } catch { feedback(message(error)) }
    }
    func feedback(_ s: String) {
        notice = s
        if presentedPanel?.visible == true { presentedPanel?.refresh() }
        settingsChanged()
    }
    func select(_ id: UUID) { do { try store?.select(id); panel.markSelection([]) } catch { feedback(message(error)) } }
    func mandatoryStore() throws -> DesktopShelfStore {
        guard shelfEnabled, sessionAvailable, let store else { throw ShelfFailure.missing }
        return store
    }
    func addBoard(_ board: NSPasteboard) throws -> [UUID] {
        let ids = try mandatoryStore().add(ShelfPasteboard.read(board))
        notice = ""
        panel.markSelection(ids)
        return ids
    }
    func addClip(_ c:ClipContent)throws{
        let store=try mandatoryStore()
        let payloads:[ShelfPayload]
        switch c.kind {
        case .files: payloads=try JSONDecoder().decode([AssistClipboard.FileReference].self,from:c.data).map{.reference(try PocketFileAccess.resolve($0.path,bookmark:$0.bookmark))}
        case .image: guard let img=NSImage(data:c.data),let cg=img.cgImage(forProposedRect:nil,context:nil,hints:nil),let data=AssistClipboard.png(cg) else{throw ShelfFailure.invalid};payloads=[.bytes("Image.png",.image,data)]
        case .link: payloads=[.bytes(ShelfPasteboard.stem(c.text)+".txt",.link,Data(c.text.utf8))]
        default:
            if c.format==NSPasteboard.PasteboardType.rtf.rawValue && !c.data.isEmpty{payloads=[.bytes("Text.rtf",.rich,c.data)]}
            else{payloads=[.bytes(ShelfPasteboard.stem(c.text)+".txt",.text,Data(c.text.utf8))]}
        }
        panel.markSelection(try store.add(payloads))
    }
    func addCaptured(_ image:Data)throws{let store=try mandatoryStore();panel.markSelection(try store.add([.bytes("Screen.png",.image,image)]))}
    var reservedValues: [VoiceShortcutValue] { shelfEnabled ? keys.values.compactMap(\.value) : [] }
    func reserved(_ value: VoiceShortcutValue, except id: String? = nil) -> String? {
        guard shelfEnabled || id != nil else { return nil }
        return keys.contains { $0.key != id && $0.value.value == value }
            ? t("此快捷键已用于桌面临时暂存台。", "This shortcut is used by Desktop Shelf.") : nil
    }
    func run(_ id: String) {
        guard sessionAvailable, shelfEnabled, store != nil else { return }
        switch id {
        case "shelf":
            if panel.visible { panel.hide() } else { panel.display(on: nil, at: nil, automatic: false) }
        case "clipboard":
            do { _ = try addBoard(.general); panel.display(on: nil, at: nil, automatic: false) }
            catch { feedback(message(error)) }
        case "batch":
            panel.display(on: nil, at: nil, automatic: false)
            if panel.selectedItems.isEmpty { feedback(t("先选择要处理的素材。", "Select items to process.")) }
            else { action(str("batchOp","zip"), selected: panel.selectedItems) }
        default: break
        }
    }

    func snapshot() -> [String: Any] {
        let settings = loadCollection()
        let rules = settings.rules
        let source = rules.count > 1 ? "legacy" : (rules.first?.kind ?? "screenshots")
        let collection: [String: Any] = [
            "enabled":settings.enabled, "source":source, "path":settings.customPath ?? "",
            "target":Set(rules.map(\.shelf)).count > 1 ? "mixed" : (rules.first?.shelf ?? store?.activeID)?.uuidString ?? "",
            "filter":Set(rules.map(\.filter)).count > 1 ? "mixed" : rules.first?.filter ?? "all", "status":watcher.status,
            "sources":rules.map(\.kind)
        ]
        let options: [String: Any] = [
            "notch":bool("notch",true), "edge":str("edge","off"), "placement":placement, "thumb":thumbnailView,
            "collapse":autoCollapse, "days":number("days",7), "mb":number("mb",512), "batchOp":str("batchOp","zip")
        ]
        return ["enabled":shelfEnabled, "ready":store != nil, "loading":loading, "keys":keys.mapValues { $0.status(english:english) },
                "options":options, "accessibility":AXIsProcessTrusted(), "storage":store?.used ?? 0, "notice":notice,
                "shelves":store?.shelves.filter { $0.closed == nil }.map { ["id":$0.id.uuidString,"name":$0.name] } ?? [],
                "collection":collection]
    }

    func handle(_ body: [String: Any], reply: @escaping LabVoiceControl.Reply) {
        guard body["feature"] as? String == Self.shelf, added, let op = body["op"] as? String else {
            reply(nil, t("先在功能中心添加。", "Add this tool in Feature Center first.")); return
        }
        do {
            switch op {
            case "status": break
            case "enable":
                let yes = body["value"] as? Bool == true
                set(Self.shelf, yes); notice = ""; loadFailed = false
                if !yes { cancelRecording(); stopShelf() }
                refresh(); activityChanged()
            case "record", "clear":
                guard let action = body["key"] as? String, let key = keys[action], !interactive else { throw ShelfFailure.invalid }
                if op == "record" {
                    key.record(enabled:shelfEnabled, english:english) { [weak self] _, error in
                        reply(error == nil ? self?.snapshot() : nil, error)
                    }
                    return
                }
                key.clear()
            case "cancel": cancelRecording()
            case "option":
                guard let name = body["key"] as? String, let value = body["value"] else { throw ShelfFailure.invalid }
                let choices = ["edge":["off","left","right","bottom","top"], "placement":["notch","free","left","right","bottom"],
                               "batchOp":["zip","ocr","pdf","montage","merge","compress","ai"]]
                if let options = choices[name], let choice = value as? String, options.contains(choice) { set(name,choice) }
                else if ["notch","thumb","collapse"].contains(name), let flag = value as? Bool { set(name,flag) }
                else if let range = ["days":1.0...365.0,"mb":32.0...4096.0][name], let amount = value as? NSNumber,
                        range.contains(amount.doubleValue) { set(name,amount.doubleValue) }
                else { throw ShelfFailure.invalid }
                refresh()
                if presentedPanel?.visible == true { presentedPanel?.refresh() }
                if name == "days" || name == "mb" { prune() }
            case "collection":
                if body["chooseFolder"] as? Bool == true {
                    _ = try mandatoryStore()
                    let picker = NSOpenPanel()
                    picker.canChooseFiles = false; picker.canChooseDirectories = true; picker.allowsMultipleSelection = false
                    let finish: (NSApplication.ModalResponse) -> Void = { [weak self] response in
                        guard let self else { reply(nil, "Shelf unavailable"); return }
                        do {
                            if response == .OK, let url = picker.url {
                                try self.configureCollection(body, customPath: url.path)
                            }
                            reply(self.snapshot(), nil)
                        } catch { reply(nil, self.message(error)) }
                    }
                    if let window = NSApp.mainWindow { picker.beginSheetModal(for:window, completionHandler:finish) }
                    else { picker.begin(completionHandler:finish) }
                    return
                }
                try configureCollection(body)
            case "open": run("shelf")
            case "permission":
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
            default: throw ShelfFailure.invalid
            }
            reply(snapshot(), nil)
        } catch { reply(nil, message(error)) }
    }
}
