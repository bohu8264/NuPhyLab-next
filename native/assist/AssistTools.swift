import AppKit
import Carbon
import SwiftUI
import UniformTypeIdentifiers

enum AssistFeature: String, CaseIterable { case screen = "screen-awareness", history = "smart-clipboard" }
enum AssistMode { case windows, screen, history, clipAI }
enum AssistBinding: String, CaseIterable {
    case screen, history
    var feature: AssistFeature { self == .screen ? .screen : .history }
    var initial: VoiceShortcutValue? {
        return .init(keyCode:self == .screen ? 1 : 9,modifiers:CGEventFlags([.maskControl,.maskAlternate]).rawValue)
    }
}

@MainActor final class AssistTools: ObservableObject {
    let defaults: UserDefaults
    let directory: URL
    let board: NSPasteboard
    var foreground: () -> NSRunningApplication? = { NSWorkspace.shared.frontmostApplication }
    var configuration: () -> AIConfiguration? = { nil }
    var displaySnapshot = AssistScreenCapture.desktop(id:name:privacy:english:)
    var translationLanguage = { "Simplified Chinese" }
    var allowed = { true }
    var conflict: (VoiceShortcutValue) -> String? = { _ in nil }
    var activityChanged: () -> Void = {}
    var request: (AIConfiguration,AIRequestPrompt,[AIImageAttachment]) async throws -> String = { config,prompt,images in
        try Task.checkCancellation()
        let account = try config.credentialAccount()
        let key = try await Task.detached(priority:.userInitiated) { try LabKeychain.read(account) }.value
        try Task.checkCancellation()
        return try await AIClient().send(configuration:config,prompt:prompt,images:images,apiKey:key)
    }
    var english = false
    var sessionAvailable = true
    var added = Set<AssistFeature>()
    var bindings: [AssistBinding:LabCommandShortcut] = [:]
    var panel: AssistPanel?
    var overlays: [NSPanel] = []
    var archive: ClipboardArchive?
    var timer: Timer?
    var observer: NSObjectProtocol?
    var lastChange = 0
    var lastApp: String?
    var lastPrune = Date.distantPast
    var ocrQueue: [String] = []
    var ocrJob: Task<Void,Never>?
    var ocrRevision = UUID()
    var session = UUID()
    var operation: Task<Void,Never>?
    let historyPasteKey: VoiceHotkey
    var awaitingPaste = false
    var selectionChange: Int?
    let voice = LocalVoiceCapture()
    var voiceID: UUID?
    var originalTask = ""
    var conversation = CommandConversation()
    var smartIDs: [String]?
    var clipSource: String?
    var inputs = Set<String>()
    var historyIssue = ""
    @Published var mode: AssistMode?
    @Published var windows: [AssistWindow] = []
    @Published var captured: AssistContext?
    @Published var working = false
    @Published var listening = false
    @Published var showPreview = false
    @Published var includeImage = false
    @Published var question = ""
    @Published var answer = ""
    @Published var notice = ""
    @Published var search = ""
    @Published var kind: ClipKind?
    @Published var pinsOnly = false
    @Published var records: [ClipSummary] = []
    @Published var highlight: String?
    @Published private(set) var selectedID: String?
    init(directory: URL, defaults: UserDefaults = .standard, board: NSPasteboard = .general,
         makeHotkey: @MainActor () -> VoiceHotkey = { VoiceHotkey() }) {
        self.defaults = defaults; self.directory = directory; self.board = board
        self.historyPasteKey = makeHotkey()
        for id in AssistBinding.allCases {
            let key = LabCommandShortcut(defaults:defaults,monitor:makeHotkey(),preference:"NuPhyLab.assist.key."+id.rawValue,defaultValue:id.initial)
            bindings[id] = key
            key.canTrigger = { [weak self] in self?.canTrigger(id) == true }
            key.conflict = { [weak self] value in self?.reserved(value,except:id) ?? self?.conflict(value) }
            key.pressed = { [weak self] in self?.trigger(id) }
            // VoiceHotkey checks the originating PID again before dispatching this user gesture.
            key.monitor.prepareForegroundPress = { [weak self] pid,_ in
                guard let self else { return .init {} }
                let originalSession = session, closing = activeFeature == id.feature
                return .init { [weak self] in
                    guard let self, session == originalSession, foreground()?.processIdentifier == pid else { return }
                    if closing { close() } else { trigger(id) }
                }
            }
            key.recordingChanged = { [weak self] _ in self?.activityChanged() }
        }
        configureHistoryPasteKey()
    }
    func t(_ zh: String,_ en: String) -> String { english ? en : zh }
    func message(_ error: Error) -> String {
        if let issue = error as? AssistIssue { return issue.message(english) }
        if let issue = error as? IntentServiceError { return issue.message(english ? .en : .zh) }
        if #available(macOS 14, *) { return SelectionLab.friendly(error,language:english ? .en : .zh) }
        return LabText.text(error.localizedDescription,language:english ? .en : .zh)
    }
    var activeFeature: AssistFeature? {
        switch mode {
        case .history, .clipAI: return .history
        case .screen, .windows: return .screen
        case nil: return overlays.isEmpty ? nil : .screen
        }
    }
    var busy: Bool { activeFeature != nil || bindings.values.contains { $0.isRecording } }
    func canTrigger(_ id: AssistBinding) -> Bool {
        guard enabled(id.feature), sessionAvailable, !IsSecureEventInputEnabled(),
              !bindings.values.contains(where: { $0.isRecording }) else { return false }
        if activeFeature == id.feature { return true }
        return !busy && allowed()
    }
    func pref(_ feature: AssistFeature,_ field: String) -> String { "NuPhyLab.assist."+feature.rawValue+"."+field }
    func enabled(_ feature: AssistFeature) -> Bool { added.contains(feature) && defaults.bool(forKey:pref(feature,"enabled")) }
    func excluded(_ feature: AssistFeature) -> [String] { defaults.stringArray(forKey:pref(feature,"excluded")) ?? AssistPrivacy.defaults }
    func privacy(_ feature: AssistFeature) -> AssistPrivacy { AssistPrivacy(excluded(feature)) }
    var days: Int { defaults.object(forKey:pref(.history,"days")) as? Int ?? 30 }
    var limit: Int { defaults.object(forKey:pref(.history,"limit")) as? Int ?? 300 }
    var reservedValues: [VoiceShortcutValue] { bindings.compactMap { enabled($0.key.feature) ? $0.value.value : nil } }
    func reserved(_ value: VoiceShortcutValue,except: AssistBinding? = nil) -> String? {
        for (id,key) in bindings where id != except && (enabled(id.feature) || except?.feature == id.feature) && key.value == value {
            return id.feature == .screen ? t("此快捷键已用于 AI 屏幕感知。","Screen Awareness uses this shortcut.") : t("此快捷键已用于智能剪贴板。","Smart Clipboard uses this shortcut.")
        }
        return nil
    }
    func setAdded(_ features: Set<AssistFeature>) {
        let absent = AssistFeature.allCases.filter { !features.contains($0) && defaults.bool(forKey:pref($0,"enabled")) }
        guard added != features || !absent.isEmpty else { return }
        let removed = added.subtracting(features)
        added = features
        for feature in Set(absent).union(removed) { setEnabled(false,feature:feature) }
        refresh()
    }
    func setEnabled(_ flag: Bool, feature: AssistFeature) {
        defaults.set(flag && added.contains(feature),forKey:pref(feature,"enabled"))
        if !enabled(feature) {
            for (id,key) in bindings where id.feature == feature { key.cancelRecording() }
            if activeFeature == feature { close() }
        }
        refresh()
    }
    func setSessionAvailable(_ value: Bool) {
        guard value != sessionAvailable else { return }
        sessionAvailable = value
        if !value { cancelRecording(); close() }
        refresh()
    }
    func refresh() {
        for (id,key) in bindings { key.refresh(enabled:sessionAvailable && enabled(id.feature)) }
        if sessionAvailable && enabled(.history) { startHistory() } else { stopHistory() }
    }
    func cancelRecording() { bindings.values.forEach { $0.cancelRecording() } }
    func trigger(_ id: AssistBinding) {
        guard canTrigger(id) else { return }
        if activeFeature == id.feature { close(); return }
        switch id {
        case .screen: openScreen()
        case .history: openHistory()
        }
    }
    func clearOverlays() { for window in overlays { window.orderOut(nil); window.contentView = nil }; overlays.removeAll() }
    func close() {
        session = UUID()
        operation?.cancel(); operation = nil
        voiceID = nil; voice.cancel(); listening = false
        clearOverlays(); panel?.close(); panel = nil
        mode = nil; captured = nil; windows = []; inputs = []; clipSource = nil
        question = ""; answer = ""; originalTask = ""; conversation = CommandConversation()
        search = ""; kind = nil; pinsOnly = false; smartIDs = nil
        records = []; highlight = nil; working = false; showPreview = false; includeImage = false; notice = ""
        activityChanged()
    }
    func present(takingFocus: Bool = true) {
        guard let screen = NSScreen.screens.first(where:{$0.frame.contains(NSEvent.mouseLocation)}) ?? NSScreen.main else { return }
        if panel == nil { panel = AssistPanel(tools:self,screen:screen); panel?.show(takingFocus:takingFocus); activityChanged() }
        else if takingFocus { panel?.focus() }
    }
    func shutdown() {
        sessionAvailable = false; close(); stopHistory()
        bindings.values.forEach { $0.shutdown() }
        historyPasteKey.unregister()
    }
    func markClipboardSelection(_ id: String?) {
        selectedID = id
        selectionChange = id == nil ? nil : board.changeCount
        awaitingPaste = id != nil
        if id == nil { historyPasteKey.suspendHandling() }
    }
    func state(_ feature: AssistFeature) -> [String:Any] {
        let shortcuts = bindings.filter { $0.key.feature == feature }.reduce(into:[String:Any]()) { $0[$1.key.rawValue] = $1.value.status(english:english) }
        var issue = feature == .history ? historyIssue : ""
        if feature == .history, enabled(.history), #available(macOS 15.4, *), board.accessBehavior == .alwaysDeny {
            issue = t("macOS 已拒绝读取剪贴板。请在系统设置中允许 NuPhy Lab 访问剪贴板。","macOS denied clipboard access. Allow NuPhy Lab to access the clipboard in System Settings.")
        }
        let names = excluded(feature).reduce(into:[String:String]()) { result,bundle in
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier:bundle) {
                result[bundle] = url.deletingPathExtension().lastPathComponent
            }
        }
        return ["enabled":enabled(feature),"shortcuts":shortcuts,"excluded":excluded(feature),"appNames":names,
                "days":days,"limit":limit,"screenPermission":CGPreflightScreenCaptureAccess(),"accessibility":AXIsProcessTrusted(),
                "issue":issue]
    }
    func handle(_ body: [String:Any], reply: @escaping LabVoiceControl.Reply) {
        guard let feature = AssistFeature(rawValue:body["feature"] as? String ?? ""), added.contains(feature),
              let op = body["op"] as? String else { reply(nil,t("请先在功能中心添加。","Add this tool in Feature Center first.")); return }
        do {
            switch op {
            case "state": break
            case "enable":
                guard let value = body["value"] as? Bool else { throw AIError.invalidOutputFormat }
                if feature == .history && value { _ = try storage() }
                setEnabled(value,feature:feature)
            case "open","region":
                guard enabled(feature), sessionAvailable else { throw AssistIssue("请先启用此功能。","Turn this feature on first.") }
                if feature == .history { openHistory() } else if op == "region" { beginRegion() } else { openScreen() }
            case "record","clear","cancel":
                guard let id = AssistBinding(rawValue:body["key"] as? String ?? ""), id.feature == feature, let key = bindings[id] else { throw AIError.invalidOutputFormat }
                if op == "clear" { key.clear() }
                else if op == "cancel" { key.cancelRecording() }
                else {
                    guard sessionAvailable, !busy, allowed() else { throw AssistIssue("请先结束当前操作。","Finish the current action first.") }
                    key.record(enabled:enabled(feature),english:english) { [weak self] _,error in reply(error == nil ? self?.state(feature) : nil,error) }
                    return
                }
            case "exclude","unexclude":
                var ids = excluded(feature)
                if op == "exclude" {
                    let picker = NSOpenPanel(); picker.allowedContentTypes = [.application]; picker.directoryURL = URL(fileURLWithPath:"/Applications")
                    picker.canChooseFiles = true; picker.canChooseDirectories = false
                    guard picker.runModal() == .OK else { break }
                    guard let url = picker.url, let id = Bundle(url:url)?.bundleIdentifier else { throw AIError.invalidOutputFormat }
                    if !ids.contains(id) { ids.append(id) }
                } else { ids.removeAll { $0 == body["bundle"] as? String } }
                defaults.set(ids.sorted(),forKey:pref(feature,"excluded")); close()
                if feature == .history { stopHistory(); refresh() }
            case "retention":
                guard feature == .history, let d = body["days"] as? Int, let n = body["limit"] as? Int,
                      [1,7,30,90,365].contains(d),[50,100,300,1000].contains(n) else { throw AIError.invalidOutputFormat }
                try storage().prune(days:d,limit:n)
                defaults.set(d,forKey:pref(.history,"days")); defaults.set(n,forKey:pref(.history,"limit"))
                if mode == .history { reloadHistory() }
            case "screenPermission":
                guard feature == .screen else { throw AIError.invalidOutputFormat }
                if !CGPreflightScreenCaptureAccess(), !CGRequestScreenCaptureAccess(), let url = URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { NSWorkspace.shared.open(url) }
            default: throw AIError.invalidOutputFormat
            }
            reply(state(feature),nil)
        } catch { reply(nil,message(error)) }
    }
}
