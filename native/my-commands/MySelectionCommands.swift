import AppKit
import Carbon

@MainActor final class MySelectionCommands {
    private let defaults: UserDefaults
    private let enabledKey = "NuPhyLab.myCommands.enabled"
    private var library: CommandLibrary
    private(set) var added = false
    private(set) var session: CommandSession?
    private var panel: CommandPanel?
    private var copyHandoff: CommandCopyHandoff?
    private var generation: Task<Void,Never>?
    let shortcut: LabCommandShortcut
    var english = false
    var configuration: () -> AIConfiguration? = { nil }
    var canRecord: () -> Bool = { false }
    var changed: () -> Void = {}
    var enabled: Bool { added && defaults.bool(forKey:enabledKey) }
    var busy: Bool { session != nil || shortcut.isRecording }
    var reservedShortcut: VoiceShortcutValue? { enabled && shortcut.issue == nil ? shortcut.value : nil }
    var reservedMessage: String { english ? "This shortcut is used by My Commands." : "此快捷键已用于「我的指令」。" }

    init(directory: URL, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        library = CommandLibrary(file:directory.appendingPathComponent("selection-commands.json"))
        let monitor = VoiceHotkey()
        shortcut = LabCommandShortcut(defaults:defaults,monitor:monitor,preference:"NuPhyLab.myCommands.shortcut",
            defaultValue:.init(keyCode:46,modifiers:(1 << 18) | (1 << 19)))
        monitor.prepareForegroundPress = { [weak self] pid, kind in
            guard let self, self.enabled else { return .init {} }
            if let current = self.session {
                return .init { [weak self, weak current] in
                    if let self, let current, self.session === current { self.close() }
                }
            }
            let bundleID = NSRunningApplication(processIdentifier:pid)?.bundleIdentifier
            let source = CommandSelection.shortcutSource(bundleID:bundleID) { CommandSelection.capture(in:pid) }
            if case .userCopy = source, kind == .down, let copyKey = VoiceHotkey.copyKeyCode() {
                // Snapshot before returning the user's key to macOS, without reading its contents.
                let baseline = NSPasteboard.general.changeCount
                return .init(commandKeyCode:copyKey) { [weak self] in self?.open(in:pid,source:source,copyBaseline:baseline) }
            }
            return .init { [weak self] in self?.open(in:pid,source:source) }
        }
    }

    func setAdded(_ value: Bool) {
        if !value {
            // Also handle a removed feature on the first launch after an interrupted shutdown.
            if defaults.bool(forKey:enabledKey) { defaults.set(false,forKey:enabledKey) }
            if added || busy { added = false; interrupt(); shortcut.refresh(enabled:false) }
            return
        }
        if !added { added = true; shortcut.refresh(enabled:enabled) }
    }

    static func dragKey(_ value: VoiceShortcutValue) -> String? {
        guard value.mouseButton == nil else { return nil }
        if VoiceHotkeyPolicy.modifierCodes.contains(value.keyCode) {
            switch value.keyCode {
            case 56,60: return "shift"
            case 59,62: return "control"
            case 58,61: return "option"
            case 54,55: return "command"
            default: return nil
            }
        }
        guard value.modifiers == 0 else { return nil }
        return DragTrigger("key:\(value.keyCode)")?.rawValue
    }

    static func usesPasteShortcut(_ value: VoiceShortcutValue) -> Bool {
        guard value.mouseButton == nil, value.modifiers == UInt64(NSEvent.ModifierFlags.command.rawValue) else { return false }
        return value.keyCode == UInt32(kVK_ANSI_V) || VoiceHotkey.label(keyCode:value.keyCode, modifiers:0) == "V"
    }

    private func open(in pid: pid_t, source: CommandSelection.ShortcutSource, copyBaseline: Int? = nil) {
        guard enabled, session == nil, CommandSelection.isCurrent(pid) else { return }
        guard case let .focused(target) = source else {
            present(source:"",commands:library.ordered(english),copyFrom:pid,copyBaseline:copyBaseline)
            return
        }
        var text = ""
        var warning = ""
        do { if let target { text = try CommandSelection.read(target) ?? "" } }
        catch let error as SelectionCommandError { warning = error.message(english) }
        catch { warning = error.localizedDescription }
        guard CommandSelection.isCurrent(pid) else { return }
        present(source:text,commands:library.ordered(english),warning:warning)
    }

    // macOS Services passes only the selection supplied for this invocation.
    // This works with responders that expose Services but omit AXSelectedText.
    func receiveServiceSelection(_ board: NSPasteboard) throws {
        guard enabled else { throw SelectionCommandError.unavailable }
        guard !IsSecureEventInputEnabled(), let text = board.string(forType:.string) else { throw SelectionCommandError.emptyText }
        try CommandSelection.validate(text)
        present(source:text,commands:library.ordered(english))
    }

    private func present(source: String, commands: [SelectionCommand], warning: String = "", copyFrom pid: pid_t? = nil, copyBaseline: Int? = nil) {
        guard let screen = NSScreen.screens.first(where:{ $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main else { return }
        close()
        let view = CommandSession(commands:commands,english:english)
        view.source = source
        view.stage = pid != nil ? .awaitingCopy : (source.isEmpty ? .input : .choose)
        view.issue = warning
        view.execute = { [weak self, weak view] in if let view { self?.run(view) } }
        view.close = { [weak self] in self?.close() }
        view.copy = { [weak self, weak view] in
            guard let self, let view, self.session === view, !view.result.isEmpty else { return }
            let board = NSPasteboard.general
            board.clearContents()
            view.copied = board.setString(view.result,forType:.string)
            if view.stage == .result { view.issue = view.copied ? "" : SelectionCommandError.copyFailed.message(view.english) }
        }
        session = view
        panel = CommandPanel(session:view,screen:screen)
        if copyBaseline == nil { panel?.show(takingFocus:pid == nil) }
        if let pid { waitForCopy(from:pid,in:view,after:copyBaseline) }
        changed()
    }

    private func waitForCopy(from pid: pid_t, in view: CommandSession, after baseline: Int?) {
        let handoff = CommandCopyHandoff(isCurrent:{ CommandSelection.isCurrent(pid) }) { [weak self, weak view] outcome in
            guard let self, let view, self.session === view, view.stage == .awaitingCopy else { return }
            switch outcome {
            case .text(let text):
                self.stopWaitingForCopy()
                view.source = text
                view.useInput()
                self.panel?.takeKeyboardFocus()
            case .noText, .tooLong:
                if case .tooLong = outcome { view.issue = SelectionCommandError.tooLong.message(view.english) }
                if baseline != nil {
                    self.stopWaitingForCopy()
                    view.stage = .input
                    self.panel?.takeKeyboardFocus()
                } else if case .noText = outcome {
                    view.issue = view.label("没有收到新的文字，请重新选中并按 ⌘C。","No new text was copied. Select the text and press ⌘C again.")
                }
            case .sourceLost:
                self.close()
            }
        }
        copyHandoff = handoff
        if baseline == nil {
            shortcut.monitor.onPassThroughCopy = { [weak handoff] in handoff?.copyPressed() == true }
        }
        shortcut.monitor.onCancelSession = { [weak self, weak view] in
            if let self, let view, self.session === view, view.stage == .awaitingCopy { self.close() }
        }
        view.pasteManually = { [weak self, weak view] in
            guard let self, let view, self.session === view, view.stage == .awaitingCopy else { return }
            self.stopWaitingForCopy()
            view.issue = ""
            view.stage = .input
            self.panel?.takeKeyboardFocus()
        }
        handoff.start(sourcePID:pid)
        if let baseline { _ = handoff.receiveCopy(after:baseline) }
    }

    private func stopWaitingForCopy() {
        copyHandoff?.stop()
        copyHandoff = nil
        shortcut.monitor.onPassThroughCopy = nil
        shortcut.monitor.onCancelSession = nil
    }

    private func run(_ view: CommandSession) {
        guard added, session === view, view.stage == .choose || view.stage == .failure || (view.stage == .result && view.pendingQuestion != nil),
              let command = view.command else { return }
        do {
            try CommandSelection.validate(view.source)
            guard let config = configuration() else { throw AIError.missingModel }
            let prompt = try view.conversation.prompt(source:view.source,instruction:command.instruction,followUp:view.pendingQuestion)
            let account = try config.credentialAccount()
            view.stage = .running
            view.issue = ""
            view.showQuestion = false
            generation?.cancel()
            generation = Task { [weak self, weak view] in
                do {
                    // A first Keychain read may wait for the user's macOS confirmation.
                    try Task.checkCancellation()
                    let key = try await Task.detached(priority:.userInitiated) { try LabKeychain.read(account) }.value
                    try Task.checkCancellation()
                    let result = try await AIClient().send(configuration:config,prompt:prompt,images:[],apiKey:key)
                    guard let self, let view, self.session === view, !Task.isCancelled else { return }
                    guard !result.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else { throw AIError.invalidOutputFormat }
                    view.receive(result,for:command.instruction)
                    self.generation = nil
                } catch {
                    guard let self, let view, self.session === view, !Task.isCancelled else { return }
                    view.issue = self.message(error)
                    view.stage = .failure
                    self.generation = nil
                }
            }
        } catch {
            view.issue = message(error)
            view.stage = .failure
        }
    }

    private func close() {
        stopWaitingForCopy()
        generation?.cancel()
        generation = nil
        guard session != nil else { return }
        panel?.close()
        panel = nil
        session = nil
        changed()
    }

    func interrupt() { shortcut.cancelRecording(); close() }

    private func message(_ error: Error) -> String {
        if let error = error as? SelectionCommandError { return error.message(english) }
        if #available(macOS 14, *) { return SelectionLab.friendly(error,language:english ? .en : .zh) }
        return error.localizedDescription
    }

    private func status() -> [String:Any] {
        var result = shortcut.status(english:english)
        result["enabled"] = enabled
        result["accessibility"] = AXIsProcessTrusted()
        result["commands"] = library.ordered(english).map { ["id":$0.id,"name":$0.name,"instruction":$0.instruction,"pinned":$0.pinned] as [String:Any] }
        result["issue"] = library.loadFailed ? SelectionCommandError.unreadableLibrary.message(english) : ""
        return result
    }

    func handle(_ body: [String:Any], reply: @escaping LabVoiceControl.Reply) {
        let op = body["op"] as? String ?? ""
        guard added || op == "status" else { reply(nil,SelectionCommandError.unavailable.message(english)); return }
        do {
            switch op {
            case "status": break
            case "enabled":
                guard let value = body["value"] as? Bool else { throw SelectionCommandError.invalidCommand }
                if value, let binding = shortcut.value, let issue = shortcut.conflict(binding) { reply(nil,issue); return }
                defaults.set(value,forKey:enabledKey)
                if !value { interrupt() }
                shortcut.refresh(enabled:enabled)
                changed()
            case "record":
                guard canRecord() else { reply(nil,english ? "Return to NuPhy Lab and finish the current shortcut operation first." : "请先回到 NuPhy Lab 并结束当前快捷键操作。"); return }
                shortcut.record(enabled:enabled,english:english) { [weak self] _,error in
                    guard let self else { reply(nil,"Closed"); return }
                    self.shortcut.refresh(enabled:self.enabled)
                    reply(error == nil ? self.status() : nil,error)
                }
                return
            case "cancelRecording": shortcut.cancelRecording()
            case "clear": shortcut.cancelRecording(); shortcut.clear(); changed()
            case "save","delete","duplicate","move","pin": try library.update(operation:op,body:body,english:english)
            case "try":
                guard canRecord() else { reply(nil,english ? "Return to NuPhy Lab to try this command." : "请先回到 NuPhy Lab 再试运行。"); return }
                let item = try CommandLibrary.validated(name:body["name"] as? String ?? "",instruction:body["instruction"] as? String ?? "",id:"trial")
                let source = body["sample"] as? String ?? ""
                try CommandSelection.validate(source)
                present(source:source,commands:[item])
                if let session { run(session) }
            default: throw SelectionCommandError.invalidCommand
            }
            reply(status(),nil)
        } catch {
            reply(nil,message(error))
        }
    }
}
