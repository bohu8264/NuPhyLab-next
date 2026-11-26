import AppKit
import CoreServices

struct ShelfWatchRule: Codable, Equatable {
    let kind: String
    let path: String
    var shelf: UUID
    var filter: String
}

struct ShelfCollectionSettings: Codable {
    var enabled: Bool
    var rules: [ShelfWatchRule]
    var customPath: String?
}

private final class ShelfDirectoryWatch {
    private let queue = DispatchQueue(label: "NuPhyLab.ShelfDirectoryWatch", qos: .utility)
    private var source: DispatchSourceFileSystemObject?
    private var pending: DispatchWorkItem?
    private var names = Set<String>()
    private let rule: ShelfWatchRule
    private let list: (URL) throws -> [String]

    init(rule: ShelfWatchRule, list: @escaping (URL) throws -> [String]) {
        self.rule = rule
        self.list = list
    }

    func start(status: @escaping (Bool) -> Void, collect: @escaping ([ShelfItem]) -> Void) {
        queue.async {
            let directory = URL(fileURLWithPath: self.rule.path, isDirectory: true)
            let fd = open(directory.path, O_EVTONLY | O_DIRECTORY | O_CLOEXEC)
            guard fd >= 0 else { status(false); return }
            let watch = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd, eventMask: [.write, .rename, .delete, .revoke], queue: self.queue)
            self.source = watch
            watch.setCancelHandler { Darwin.close(fd) }
            watch.setEventHandler { [weak self] in
                guard let self, let source = self.source else { return }
                guard source.data.intersection([.delete, .rename, .revoke]).isEmpty else {
                    self.close()
                    status(false)
                    return
                }
                guard self.pending == nil else { return }
                let work = DispatchWorkItem { [weak self] in
                    guard let self, self.source != nil else { return }
                    self.pending = nil
                    do {
                        let latest = Set(try self.list(directory))
                        let added = latest.subtracting(self.names)
                        self.names = latest
                        var items: [ShelfItem] = []
                        for name in added.sorted() where !name.hasPrefix(".") {
                            let url = directory.appendingPathComponent(name)
                            guard self.matches(url), let item = try? DesktopShelfStore.referenceItem(url) else { continue }
                            items.append(item)
                            if items.count == 32 { collect(items); items.removeAll(keepingCapacity: true) }
                        }
                        if !items.isEmpty { collect(items) }
                    } catch {
                        self.close()
                        status(false)
                    }
                }
                self.pending = work
                self.queue.asyncAfter(deadline: .now() + 0.35, execute: work)
            }
            // Subscribe before establishing the baseline. Events arriving during the scan stay queued.
            watch.resume()
            do {
                self.names = Set(try self.list(directory))
                status(true)
            } catch {
                self.close()
                status(false)
            }
        }
    }

    private func matches(_ url: URL) -> Bool {
        guard !["download", "crdownload", "part", "tmp"].contains(url.pathExtension.lowercased()) else { return false }
        let kind = DragFileKind.kind(url)
        if rule.kind == "screenshots" {
            guard kind == .image else { return false }
            let name = url.lastPathComponent.lowercased()
            let hasScreenshotName = ["screenshot", "screen shot", "截屏", "屏幕快照"].contains(where: name.hasPrefix)
            if !hasScreenshotName {
                let marked = MDItemCreateWithURL(nil, url as CFURL)
                    .flatMap { MDItemCopyAttribute($0, "kMDItemIsScreenCapture" as CFString) as? Bool }
                guard marked == true else { return false }
            }
        }
        switch rule.filter {
        case "images": return kind == .image
        case "documents": return ["pdf","doc","docx","rtf","md","txt","pages","csv"].contains(url.pathExtension.lowercased())
        case "media": return kind == .audio || kind == .video
        default: return true
        }
    }

    func stop() { queue.async { self.close() } }

    private func close() {
        pending?.cancel()
        pending = nil
        source?.cancel()
        source = nil
    }
}

@MainActor final class ShelfWatcher {
    private var watches: [ShelfDirectoryWatch] = []
    private var generation = UUID()
    private var pending = 0
    private var inaccessible = false
    private(set) var status = "off"
    private let list: (URL) throws -> [String]
    var changed: () -> Void = {}
    var collected: ([ShelfItem], UUID) -> Void = { _, _ in }

    init(list: @escaping (URL) throws -> [String] = { try FileManager.default.contentsOfDirectory(atPath: $0.path) }) {
        self.list = list
    }

    func stop() {
        generation = UUID()
        watches.forEach { $0.stop() }
        watches.removeAll()
        pending = 0
        inaccessible = false
        status = "off"
    }

    func start(_ rules: [ShelfWatchRule]) {
        stop()
        guard !rules.isEmpty else { return }
        let current = generation
        pending = rules.count
        status = "starting"
        for rule in rules {
            let watch = ShelfDirectoryWatch(rule: rule, list: list)
            watches.append(watch)
            watch.start(status: { [weak self] available in
                DispatchQueue.main.async {
                    guard let self, self.generation == current else { return }
                    self.pending = max(0, self.pending - 1)
                    if !available { self.inaccessible = true }
                    self.status = self.inaccessible ? "unavailable" : (self.pending == 0 ? "ready" : "starting")
                    self.changed()
                }
            }, collect: { [weak self] items in
                DispatchQueue.main.async {
                    guard let self, self.generation == current else { return }
                    self.collected(items, rule.shelf)
                }
            })
        }
    }
}

@MainActor extension DesktopTools {
    func loadCollection() -> ShelfCollectionSettings {
        let decoder = JSONDecoder()
        if let data = defaults.data(forKey: k("collection")),
           let settings = try? decoder.decode(ShelfCollectionSettings.self, from: data) { return settings }
        let legacy = defaults.data(forKey: k("watch")).flatMap { try? decoder.decode([ShelfWatchRule].self, from: $0) } ?? []
        return ShelfCollectionSettings(enabled: !legacy.isEmpty, rules: legacy,
                                       customPath: legacy.first(where: { $0.kind == "custom" })?.path)
    }

    func collectionRule(_ kind: String, custom: String?, target: UUID, filter: String) throws -> ShelfWatchRule {
        let path: String?
        switch kind {
        case "custom": path = custom
        case "downloads": path = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first?.path
        case "screenshots":
            let location = defaults.persistentDomain(forName: "com.apple.screencapture")?["location"] as? String
            path = location.map { ($0 as NSString).expandingTildeInPath }
                ?? FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first?.path
        default: throw ShelfFailure.invalid
        }
        guard let path, path.hasPrefix("/") else { throw ShelfFailure.missing }
        return ShelfWatchRule(kind: kind, path: path, shelf: target, filter: filter)
    }

    func configureCollection(_ body: [String: Any], customPath: String? = nil) throws {
        let store = try mandatoryStore()
        var settings = loadCollection()
        if let newPath = customPath { settings.customPath = newPath }
        let open = store.shelves.filter { $0.closed == nil }
        let previous = settings.rules.first
        let previousTarget = previous.flatMap { rule in open.first { $0.id == rule.shelf }?.id } ?? store.activeID
        let filter = body["filter"] as? String ?? previous?.filter ?? "all"
        guard ["all", "images", "documents", "media"].contains(filter) else { throw ShelfFailure.invalid }
        if let kind = body["source"] as? String {
            settings.rules = [try collectionRule(kind, custom: settings.customPath, target: previousTarget, filter: filter)]
        } else if settings.rules.isEmpty {
            settings.rules = [try collectionRule("screenshots", custom: nil, target: previousTarget, filter: filter)]
        }
        if let target = body["target"] as? String {
            guard let id = UUID(uuidString: target), open.contains(where: { $0.id == id }) else { throw ShelfFailure.changed }
            for index in settings.rules.indices { settings.rules[index].shelf = id }
        }
        if body["filter"] != nil {
            for index in settings.rules.indices { settings.rules[index].filter = filter }
        }
        if let enabled = body["enabled"] as? Bool { settings.enabled = enabled }
        let encoded = try JSONEncoder().encode(settings)
        set("collection", encoded)
        defaults.removeObject(forKey: k("watch"))
        refreshCollection()
    }

    func refreshCollection() {
        let settings = loadCollection()
        let rules = settings.enabled && shelfEnabled && sessionAvailable ? settings.rules : []
        guard rules != lastRules else { return }
        lastRules = rules
        watcher.start(rules)
    }
}
