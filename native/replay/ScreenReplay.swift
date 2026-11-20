import AppKit
import ScreenCaptureKit

@MainActor final class ScreenReplay {
    typealias Reply = (Any?, String?) -> Void
    let shortcut: LabCommandShortcut
    var english = false
    var stateChanged: () -> Void = {}
    var canRecordShortcut: () -> Bool = { false }
    var notify: (String) -> Void = { _ in }
    private let defaults: UserDefaults
    private let folder: URL
    private let displayKey = "NuPhyLab.screenReplay.display"
    private let lastFileKey = "NuPhyLab.screenReplay.lastFile"
    private(set) var added = false
    private var sessionID: UUID?
    private var capture: ReplayCapture?
    private var starting: Task<Void,Never>?
    private var stopping: Task<Void,Never>?
    private var recording = false
    private var saving = false
    private var problem = ""
    private var needsScreenPermission = false
    private var display: String { defaults.string(forKey:displayKey) ?? "main" }
    var enabled: Bool { sessionID != nil }
    var reservedShortcut: VoiceShortcutValue? { recording && shortcut.issue == nil ? shortcut.value : nil }
    var exporting: Bool { saving }
    var canSave: Bool { recording && !saving }

    init(defaults: UserDefaults = .standard, folder: URL? = nil) {
        self.defaults = defaults
        self.folder = folder ?? FileManager.default.urls(for:.moviesDirectory,in:.userDomainMask)[0]
            .appendingPathComponent("NuPhy Lab/Replays",isDirectory:true)
        shortcut = LabCommandShortcut(defaults:defaults, monitor:VoiceHotkey(), preference:"NuPhyLab.screenReplay.shortcut", defaultValue:nil)
        shortcut.pressed = { [weak self] in self?.save() }
    }

    private func label(_ zh:String, _ en:String) -> String { english ? en : zh }

    private func screens() -> [(key:String, id:CGDirectDisplayID, name:String)] {
        NSScreen.screens.compactMap { screen in
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32,
                  let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue() else { return nil }
            return (CFUUIDCreateString(nil,uuid) as String,id,screen.localizedName)
        }
    }
    private func selectedID() -> CGDirectDisplayID? {
        display == "main" ? CGMainDisplayID() : screens().first(where:{$0.key == display})?.id
    }
    private var lastFile: URL? {
        guard let name = defaults.string(forKey:lastFileKey), !name.contains("/"), name.hasPrefix("Replay-"), name.hasSuffix(".mp4") else { return nil }
        let url = folder.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath:url.path) ? url : nil
    }
    private func status() -> [String:Any] {
        var result = shortcut.status(english:english)
        result["enabled"] = enabled
        result["phase"] = stopping != nil ? "stopping" : recording ? "recording" : enabled ? "starting" : "off"
        result["saving"] = saving
        result["issue"] = problem
        result["needsScreenPermission"] = needsScreenPermission
        result["display"] = display
        result["displays"] = screens().map { ["id":$0.key,"name":$0.name] }
        result["lastFile"] = lastFile?.lastPathComponent ?? ""
        return result
    }
    func setAdded(_ value: Bool) {
        guard added != value else { return }
        added = value
        if !added { interrupt() }
    }

    private func start() {
        guard added, !enabled, stopping == nil else { return }
        problem = ""
        needsScreenPermission = false
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            needsScreenPermission = true
            problem = label("请在系统设置中允许 NuPhy Lab 录制屏幕，然后重新开启回放。","Allow NuPhy Lab to record the screen in System Settings, then turn replay on again.")
            stateChanged()
            return
        }
        guard let wanted = selectedID() else {
            problem = label("所选显示器已断开，请重新选择。","The selected display is disconnected. Choose a display.")
            stateChanged()
            return
        }
        let token = UUID()
        sessionID = token
        stateChanged()
        starting = Task { [weak self] in
            guard let self else { return }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
                guard sessionID == token else { return }
                guard selectedID() == wanted, let screen = content.displays.first(where:{$0.displayID == wanted}) else { throw ReplayError.unavailable }
                let filter = SCContentFilter(display:screen, excludingWindows:[])
                let source = try ReplayCapture(display:screen, filter:filter) { [weak self] error in
                    Task { @MainActor in self?.didFail(error, token:token) }
                }
                capture = source
                try await source.start()
                guard sessionID == token else { return }
                guard selectedID() == wanted else { throw ReplayError.unavailable }
                recording = true
                starting = nil
                refresh()
                stateChanged()
            } catch { didFail(error, token:token) }
        }
    }

    private func didFail(_ error: Error, token: UUID) {
        guard sessionID == token else { return }
        let native = error as NSError
        if !CGPreflightScreenCaptureAccess() {
            needsScreenPermission = true
            problem = label("请允许 NuPhy Lab 录制屏幕，然后重新开启回放。","Allow screen recording, then turn replay on again.")
        } else {
            problem = label("回放采集中断。","Screen capture stopped.") + " " + native.localizedDescription
        }
        stop()
    }

    func stop() {
        guard enabled else { return }
        sessionID = nil
        recording = false
        let boot = starting, source = capture
        starting = nil; capture = nil
        source?.discard()
        shortcut.cancelRecording()
        refresh()
        stopping = Task { [weak self] in
            await boot?.value
            await source?.finishStopping()
            self?.stopping = nil
            self?.stateChanged()
        }
        stateChanged()
    }
    func interrupt() { shortcut.cancelRecording(); stop() }
    func displaysChanged() {
        if enabled, let id = capture?.displayID, id != selectedID() || !screens().contains(where:{$0.id == id}) {
            problem = label("显示器已切换或断开，请重新开启回放。","The display changed or disconnected. Turn replay on again.")
            stop()
        }
        stateChanged()
    }
    func refresh() { shortcut.refresh(enabled: added && recording) }

    func save() {
        guard added, canSave, let source = capture else { return }
        let trigger = CMClockGetTime(CMClockGetHostTimeClock())
        let stamp = DateFormatter()
        stamp.locale = Locale(identifier:"en_US_POSIX"); stamp.dateFormat = "yyyy-MM-dd-HHmmss"
        let url = folder.appendingPathComponent("Replay-\(stamp.string(from:Date()))-\(UUID().uuidString.prefix(6)).mp4")
        saving = true; problem = ""
        stateChanged()
        source.clip(at:trigger) { [weak self] result in
            Task { @MainActor in await self?.finishSave(result, to:url) }
        }
    }

    private func finishSave(_ result: Result<ReplayClip,Error>, to url: URL) async {
        do {
            let clip = try result.get()
            try await clip.write(to:url)
            defaults.set(url.lastPathComponent,forKey:lastFileKey)
            notify(label("回放已保存","Replay saved"))
        } catch ReplayError.empty {
            problem = label("正在准备第一帧，请稍后再保存。","Waiting for the first frame. Try saving again in a moment.")
            notify(problem)
        } catch {
            problem = label("保存失败。","Could not save the replay.") + " " + error.localizedDescription
            notify(problem)
        }
        saving = false
        stateChanged()
    }

    func handle(_ body:[String:Any], reply:@escaping Reply) {
        let op = body["op"] as? String ?? ""
        guard added || op == "cancelRecording" else {
            reply(nil,label("请先在功能中心添加此功能。","Add this feature in Feature Center first.")); return
        }
        switch op {
        case "state": break
        case "start": start()
        case "stop": stop()
        case "save": save()
        case "display":
            guard !enabled, stopping == nil, let choice = body["value"] as? String,
                  choice == "main" || screens().contains(where:{$0.key == choice}) else {
                reply(nil,label("请先关闭回放，再选择已连接的显示器。","Turn replay off and choose a connected display.")); return
            }
            defaults.set(choice,forKey:displayKey); problem = ""
        case "record":
            guard canRecordShortcut() else { reply(nil,label("请先回到 NuPhy Lab，再录制快捷键。","Return to NuPhy Lab before recording a shortcut.")); return }
            shortcut.record(enabled:recording, english:english) { [weak self] _,error in
                self?.refresh(); reply(error == nil ? self?.status() : nil,error)
            }
            return
        case "cancelRecording": shortcut.cancelRecording()
        case "clear": shortcut.cancelRecording(); shortcut.clear()
        case "play","reveal":
            guard let url = lastFile else { reply(nil,label("找不到已保存的回放。","The saved replay could not be found.")); return }
            if op == "reveal" { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            else { NSWorkspace.shared.open(url) }
        case "permissions":
            if let url = URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { NSWorkspace.shared.open(url) }
        default: reply(nil,"Unknown replay operation"); return
        }
        reply(status(),nil)
    }
}
