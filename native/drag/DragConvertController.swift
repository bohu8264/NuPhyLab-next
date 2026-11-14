import AppKit
import QuartzCore
import IOKit.hid

final class DragConvertController {
    // Shared only inside this Lab process, to avoid a selection
    // shortcut opening a second overlay in the middle of a file drag.
    static weak var active: DragConvertController?
    var canPresent: () -> Bool = { true }
    var reservedKeyCodes: () -> Set<UInt32> = { [] }
    var selectionReservedTrigger: () -> String? = { nil }
    var inputAccess: () -> Bool = { IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted }
    private var selectedTrigger:DragTrigger { DragTrigger(preferences.trigger) ?? DragTrigger("shift")! }
    private var inputPermissionNeeded:Bool { selectedTrigger.needsInputAccess && !inputAccess() }
    private var aiTriggerConflict:Bool { selectedTrigger.keyCode.map { reservedKeyCodes().contains(UInt32($0)) } ?? false }
    private var selectionTriggerConflict:Bool { selectionReservedTrigger() == selectedTrigger.rawValue }
    private var triggerConflict:Bool { aiTriggerConflict || selectionTriggerConflict }
    private var triggerIssue:String {
        if selectionTriggerConflict { return "该按键已用于智能框选，请选择其他触发键 / This key is used by Smart Selection. Choose another trigger key." }
        if aiTriggerConflict { return "该按键已被 AI 模式占用，请选择其他按键 / This key is assigned to AI mode. Choose another key." }
        if inputPermissionNeeded { return "此触发键需要输入监控权限，授权后会自动生效 / This trigger needs Input Monitoring. It takes effect automatically after permission is granted." }
        return ""
    }
    var activityChanged: ((Bool) -> Void)?
    private let watcher = DragFileWatcher()
    private let panel = DragConvertPanel()
    private let workQueue = DispatchQueue(label: "local.nuphylab.dragconvert.files", qos: .userInitiated)
    private let file: URL
    private let historyFile: URL
    private var suspended=false
    private let observeDrags:Bool
    private var job: DragJobControl?
    private var currentAction = ""
    private var currentFile = ""
    private(set) var preferences = DragConvertPreferences()
    private(set) var busy = false
    private var english = false
    private var completed = 0
    private var total = 0
    private var results: [DragConversionResult] = []
    private var batches: [[String: Any]] = []
    private var outputURLs: [String: [URL]] = [:]
    private var loadIssue = ""
    var isFileDragActive: Bool { watcher.isFileDragActive || panel.isAwaitingDrop }
    var isInteracting: Bool { panel.isVisible }
    init(directory: URL, observeDrags:Bool=true) {
        self.observeDrags=observeDrags
        file = directory.appendingPathComponent("drag-convert.json")
        historyFile = directory.appendingPathComponent("drag-convert-history.json")
        if let data = try? Data(contentsOf: historyFile), data.count <= 2_000_000,
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let history = object["history"] as? [[String: Any]], let paths = object["outputs"] as? [String: [String]] {
            batches = Array(history.prefix(20))
            for batch in batches {
                if let id = batch["id"] as? String, let files = paths[id] { outputURLs[id] = files.map { URL(fileURLWithPath: $0) } }
            }
        }
        if FileManager.default.fileExists(atPath: file.path) {
            do { preferences = try JSONDecoder().decode(DragConvertPreferences.self, from: Data(contentsOf: file)).validated() }
            catch { loadIssue = "无法读取转换设置，已暂停。重新保存设置即可恢复。 / Settings could not be read." }
        }
        Self.active = self
        watcher.trigger = { [weak self] in self?.selectedTrigger ?? DragTrigger("shift")! }
        watcher.canActivate = { [weak self] in
            guard let self else { return false }
            return !self.inputPermissionNeeded && !self.triggerConflict
        }
        watcher.show = { [weak self] in self?.showWheel() ?? false }
        watcher.moved = { [weak self] in self?.panel.move($0) }
        watcher.ended = { [weak self] in self?.panel.released() }
        watcher.cancelled = { [weak self] in self?.panel.hideImmediately() }
        panel.onDrop = { [weak self] format, urls in self?.submit(format, urls: urls) ?? false }
        panel.visibilityChanged = { [weak self] active in self?.activityChanged?(active) }
        if preferences.enabled && observeDrags { watcher.start() }
    }
    func updateLanguage(english: Bool) { self.english = english }
    private func showWheel() -> Bool {
        guard preferences.enabled, !suspended, !inputPermissionNeeded, !triggerConflict, canPresent(), !busy else { watcher.ignoreCurrentDrag(); return false }
        let board = NSPasteboard(name: .drag)
        let urls = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        guard !urls.isEmpty else { return false }
        guard !DragFileKind.actions(for: urls).isEmpty else { watcher.ignoreCurrentDrag(); return false }
        let point = NSEvent.mouseLocation
        panel.present(at: point, urls: urls, english: english)
        guard panel.isVisible else{panel.hideImmediately();return false}
        return true
    }
    private func submit(_ format: DragFormat, urls: [URL]) -> Bool {
        guard preferences.enabled, !suspended, !inputPermissionNeeded, !triggerConflict, canPresent(), !busy, DragFileKind.actions(for: urls).contains(format) else { return false }
        watcher.ignoreCurrentDrag(); busy = true; completed = 0; results = []
        let groups = format.combinesInputs ? [urls] : urls.map { [$0] }
        total = groups.count; currentAction = format.rawValue
        let configuration = preferences, control = DragJobControl(); job = control
        workQueue.async { [weak self] in
            var converted: [DragConversionResult] = []
            for group in groups {
                if control.cancelled { break }
                control.update(0)
                DispatchQueue.main.async { [weak self] in self?.currentFile = group.count > 1 ? "\(group.count) files" : group[0].lastPathComponent }
                let result: DragConversionResult = autoreleasepool {
                    do { return DragConversionResult(input: group[0], output: try DragConverter.convert(group, to: format, preferences: configuration, control: control), error: nil) }
                    catch { return DragConversionResult(input: group[0], output: nil, error: error.localizedDescription) }
                }
                converted.append(result)
                DispatchQueue.main.async { [weak self] in self?.completed += 1 }
            }
            let batch = converted
            DispatchQueue.main.async { [weak self] in self?.finish(batch, format: format, inputCount: urls.count, cancelled: control.cancelled) }
        }
        return true
    }
    private func finish(_ results: [DragConversionResult], format: DragFormat, inputCount: Int, cancelled: Bool) {
        self.results = results; busy = false; job = nil
        let successes = results.compactMap(\.output), failed = results.count - successes.count
        let id = UUID().uuidString
        batches.insert(["id": id, "format": format.rawValue, "time": Date().timeIntervalSince1970,
                        "succeeded": successes.count, "failed": failed, "cancelled": cancelled, "inputCount": inputCount,
                        "files": results.map { ["input": $0.input.lastPathComponent, "output": $0.output?.lastPathComponent ?? "", "error": $0.error ?? ""] }], at: 0)
        outputURLs[id] = successes
        if batches.count > 20 {
            if let removed = batches.removeLast()["id"] as? String { outputURLs.removeValue(forKey: removed) }
        }
        // Quiet completion: never create a status window or activate the main app.
        do {
            let value: [String: Any] = ["history": batches, "outputs": outputURLs.mapValues { $0.map(\.path) }]
            try JSONSerialization.data(withJSONObject: value).write(to: historyFile, options: .atomic)
        } catch { loadIssue = "转换已结束，但记录未能保存 / Conversion finished; history could not be saved" }
    }
    private func status() -> [String: Any] {
        ["preferences": (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(preferences))) ?? [:],
         "ready": preferences.enabled && watcher.isRunning && triggerIssue.isEmpty, "busy": busy, "completed": completed, "total": total,
         "history": batches, "issue": loadIssue.isEmpty ? triggerIssue : loadIssue, "inputPermissionNeeded": inputPermissionNeeded, "triggerLabels": DragTrigger.currentLabels(),
         "progress": job?.progress ?? 0, "currentAction": currentAction, "currentFile": currentFile, "cancelling": job?.cancelled ?? false,
         "presentationMilliseconds": panel.lastPresentationMilliseconds]
    }
    func handle(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch body["op"] as? String {
        case "status": reply(status(), nil)
        case "cancel": job?.cancel(); reply(status(), nil)
        case "settings":
            do {
                guard let object = body["preferences"] as? [String: Any] else { throw DragConvertError.invalidSettings }
                var next = try JSONDecoder().decode(DragConvertPreferences.self, from: JSONSerialization.data(withJSONObject: object)).validated()
                if next.enabled, (next.trigger != preferences.trigger || !preferences.enabled), selectionReservedTrigger() == next.trigger {
                    reply(nil, english ? "This key is used by Smart Selection. Choose another trigger key." : "该按键已用于智能框选，请选择其他触发键。"); return
                }
                if next.trigger != preferences.trigger, let code=DragTrigger(next.trigger)?.keyCode, reservedKeyCodes().contains(UInt32(code)) {
                    reply(nil, english ? "This key is assigned to AI mode. Choose another key." : "该按键已被 AI 模式占用，请选择其他按键。"); return
                }
                // Output locations can only come from the native folder picker.
                next.outputDirectory = preferences.outputDirectory
                try save(next); reply(status(), nil)
            } catch { reply(nil, error.localizedDescription) }
        case "inputPermission":
            if inputPermissionNeeded {
                IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
                NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!)
            }
            reply(status(),nil)
        case "folder":
            let picker = NSOpenPanel(); picker.canChooseDirectories = true; picker.canChooseFiles = false; picker.allowsMultipleSelection = false
            picker.prompt = english ? "Choose" : "选择"; picker.message = english ? "Save converted copies here" : "选择转换副本的保存位置"
            picker.begin { [weak self] response in
                guard let self else { reply(nil, "Window closed"); return }
                if response == .OK, let url = picker.url {
                    do { var next = self.preferences; next.outputDirectory = url.path; try self.save(next) }
                    catch { reply(nil, error.localizedDescription); return }
                }
                reply(self.status(), nil)
            }
        case "sourceFolder":
            do { var next = preferences; next.outputDirectory = nil; try save(next); reply(status(), nil) }
            catch { reply(nil, error.localizedDescription) }
        case "reveal":
            guard let id = body["id"] as? String, let urls = outputURLs[id], !urls.isEmpty else { reply(nil, "No converted files"); return }
            let existing = urls.filter { FileManager.default.fileExists(atPath: $0.path) }
            guard !existing.isEmpty else { reply(nil, english ? "Files have been moved or deleted." : "文件已移动或删除。"); return }
            NSWorkspace.shared.activateFileViewerSelecting(existing); reply(true, nil)
        default: reply(nil, "Unknown drag conversion operation")
        }
    }
    private func save(_ next: DragConvertPreferences) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(next).write(to: file, options: .atomic)
        preferences = next; loadIssue = ""
        watcher.stop()
        if next.enabled && !suspended && observeDrags { watcher.start() }
    }
    func suspend() { suspended=true; watcher.stop(); panel.hideImmediately() }
    func resume() { suspended=false; if preferences.enabled && observeDrags { watcher.start() } }
    func shutdown() { suspend() }
}
