import AppKit
import Combine
import WebKit

@MainActor
final class DockScenesFeature {
    private let profile: URL
    private let legacy: URL
    private let preference: URL
    private let icons = NSCache<NSString, NSString>()
    private var controller: DockScenesController?
    private var subscriptions = Set<AnyCancellable>()
    private var editor: DockShortcutEditor?
    private var added: Bool?
    private var needsDisableWrite = false
    private var startupIssue: String?
    private var preferenceIssue: String?
    private var enabled = false
    private var updateScheduled = false
    private var appliedRevision = 0
    weak var window: NSWindow?
    weak var web: WKWebView?
    var allowSwitch: () -> Bool = { false }
    var english = false { didSet { controller?.english = english } }
    var isApplying: Bool { controller?.isApplying == true }
    var isRecording: Bool { editor != nil }
    func usesShortcut(keyCode:UInt32,flags:UInt64) -> Bool {
        guard added==true, enabled, let state=controller?.state,
              let shortcut=try? DockShortcut(keyCode:keyCode,flags:NSEvent.ModifierFlags(rawValue:UInt(flags))) else {return false}
        return state.scenes.contains { state.shortcut(for:$0.id)==shortcut }
    }

    init(directory: URL, legacy: URL) {
        profile = directory.appendingPathComponent("dock-scenes", isDirectory: true)
        preference = directory.appendingPathComponent("dock-scenes-shortcuts.json")
        self.legacy = legacy
        icons.countLimit = 128
    }

    func setAdded(_ value: Bool) {
        if added == value && !needsDisableWrite { return }
        added = value
        if value {
            start()
        } else {
            editor?.close()
            controller?.setFeatureAvailable(false)
            enabled = false
            do {
                if FileManager.default.fileExists(atPath: preference.path),
                   (try? Data(contentsOf: preference)) != Data("false".utf8) {
                    try saveEnabled(false)
                }
                needsDisableWrite = false
                preferenceIssue = nil
            } catch {
                needsDisableWrite = true
                preferenceIssue = error.localizedDescription
            }
        }
    }

    private func start() {
        guard added == true else { return }
        do {
            if controller == nil {
                try migrateDockScenes(from: legacy, to: profile)
            }
            if FileManager.default.fileExists(atPath: preference.path) {
                enabled = try JSONDecoder().decode(Bool.self, from: Data(contentsOf: preference))
            } else {
                enabled = false
            }
            if let controller {
                controller.setFeatureAvailable(true)
                controller.setShortcutsEnabled(enabled)
                controller.refresh()
            } else {
                let core = DockScenesController(directory: profile)
                core.english = english
                core.setShortcutsEnabled(enabled)
                core.sceneShortcutsAvailable = { [weak self] in
                    guard let self, self.added == true, self.enabled, self.allowSwitch() else { return false }
                    return !NSApp.isActive || (NSApp.modalWindow == nil && self.window?.attachedSheet == nil)
                }
                core.objectWillChange.sink { [weak self] _ in self?.scheduleUpdate() }.store(in: &subscriptions)
                core.sceneApplied.sink { [weak self] _ in
                    self?.appliedRevision += 1
                    self?.scheduleUpdate()
                }.store(in: &subscriptions)
                controller = core
                core.start()
            }
            startupIssue = nil
        } catch DockMigrationError.experimentRunning {
            startupIssue = english ? "Quit the Dock Scenes experiment, then select Reload." : "请先退出 Dock 场景实验版，再点「重新读取」。"
        } catch {
            startupIssue = english ? "Could not load the saved scenes. Check the profile and select Reload." : "无法读取已有场景，请检查配置目录后点「重新读取」。"
        }
    }

    func refreshIfOpen() {
        if added == true { controller?.refresh() }
    }

    private func saveEnabled(_ value: Bool) throws {
        try JSONEncoder().encode(value).write(to: preference, options: .atomic)
    }

    private func scheduleUpdate() {
        guard !updateScheduled else { return }
        updateScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.updateScheduled = false
            self.web?.evaluateJavaScript("window.dispatchEvent(new Event('nuphylab:dock-scenes'))")
        }
    }

    private func icon(for url: URL) -> String? {
        let path = url.path as NSString
        if let cached = icons.object(forKey: path) { return cached as String }
        let image = NSWorkspace.shared.icon(forFile: url.path)
        let size = NSSize(width: 64, height: 64)
        let small = NSImage(size: size, flipped: false) { rect in
            image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
            return true
        }
        guard let data = small.tiffRepresentation,
              let png = NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]) else { return nil }
        let result = "data:image/png;base64," + png.base64EncodedString()
        icons.setObject(result as NSString, forKey: path)
        return result
    }

    private func snapshot() -> [String: Any] {
        var answer: [String: Any] = [
            "enabled": enabled, "scenes": [], "applying": isApplying, "recovery": false,
            "appliedRevision": appliedRevision
        ]
        if let issue = startupIssue ?? preferenceIssue { answer["error"] = issue }
        guard let core = controller else { return answer }
        answer["scenes"] = core.state?.scenes.map { scene -> [String: Any] in
            var detail: [String: Any] = [
                "id": scene.id, "name": dockSceneName(scene, english: english),
                "custom": !DockSceneState.builtInIDs.contains(scene.id),
                "apps": scene.apps.map { app -> [String: Any] in
                    var data: [String: Any] = ["id": app.id.uuidString,
                        "name": english && app.name == "Dock 项目" ? "Dock item" : app.name, "available": app.isAvailable]
                    if let url = app.url, let image = icon(for: url) { data["icon"] = image }
                    return data
                }
            ]
            if let saved = core.savedShortcutLabel(for: scene.id) { detail["shortcut"] = dockMessage(saved, english: english) }
            detail["registered"] = core.shortcutLabel(for: scene.id) != nil
            if let warning = core.shortcutWarning(for: scene.id) { detail["warning"] = dockMessage(warning, english: english) }
            return detail
        } ?? []
        answer["current"] = core.currentSceneID
        answer["pending"] = core.requestedSceneID
        answer["recovery"] = core.isRecoveryPending
        if let issue = core.notice, core.noticeIsError { answer["error"] = dockMessage(issue, english: english) }
        return answer
    }

    func handle(_ body: [String: Any], reply: (Any?, String?) -> Void) {
        func reject(_ zh: String, _ en: String) { reply(nil, english ? en : zh) }
        guard added == true, let op = body["op"] as? String else { reject("请先添加 Dock 场景。", "Add Dock Scenes first."); return }
        if op == "reload" { start() }
        if op == "state" || op == "reload" { reply(snapshot(), nil); return }
        guard let core = controller, core.state != nil, startupIssue == nil else {
            reject("请先重新读取场景。", "Reload your scenes first."); return
        }
        let id = body["id"] as? String ?? ""
        var created: String?
        if op == "enable" {
            guard let value = body["enabled"] as? Bool else { reject("设置无效。", "Invalid setting."); return }
            do {
                try saveEnabled(value)
                enabled = value
                preferenceIssue = nil
                core.setShortcutsEnabled(value)
            } catch { reply(nil, error.localizedDescription); return }
        } else if op == "apply" {
            guard allowSwitch(), core.state?.scene(id) != nil else { reject("请先完成当前操作。", "Finish the current action first."); return }
            core.applyScene(id)
        } else {
            guard !core.isApplying, editor == nil else { reject("请先完成当前操作。", "Finish the current action first."); return }
            switch op {
            case "create":
                created = core.createScene(name: body["name"] as? String ?? "")
                guard created != nil else { reply(nil, dockMessage(core.notice ?? "", english: english)); return }
            case "rename", "delete":
                let ok = op == "delete" ? core.deleteScene(id) : core.renameScene(id, name: body["name"] as? String ?? "")
                guard ok else { reply(nil, dockMessage(core.notice ?? "", english: english)); return }
            case "addApps":
                core.chooseApplications(for: id)
            case "moveApp", "removeApp":
                guard let apps = core.state?.scene(id)?.apps,
                      let item = body["app"] as? String, let from = apps.firstIndex(where: { $0.id.uuidString == item }),
                      id != DockSceneState.allID else { reject("找不到这个项目。", "Item not found."); return }
                if op == "removeApp" { core.removeItem(from: id, at: from) }
                else if let to = body["to"] as? Int, apps.indices.contains(to) { core.moveItem(in: id, from: from, to: to) }
                else { reject("位置无效。", "Invalid position."); return }
            case "shortcut":
                guard let window, NSApp.isActive, window.isKeyWindow, window.attachedSheet == nil, core.state?.scene(id) != nil else {
                    reject("请先打开 NuPhy Lab 主窗口。", "Bring the NuPhy Lab window to the front."); return
                }
                let panel = DockShortcutEditor(controller: core, sceneID: id, parent: window)
                editor = panel
                panel.begin { [weak self] in self?.editor = nil; self?.scheduleUpdate() }
            default: reject("未知操作。", "Unknown action."); return
            }
        }
        var next = snapshot()
        next["created"] = created
        reply(next, nil)
    }
}
