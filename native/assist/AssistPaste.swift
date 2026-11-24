import AppKit
import Carbon

extension AssistTools {
    // Offer Control-V only for the next user paste of a deliberately selected history entry.
    // The normal Command-V and all input in the palette's search field pass to their responder.
    func configureHistoryPasteKey() {
        historyPasteKey.canHandle = { [weak self] in self?.awaitingPaste == true }
        historyPasteKey.acceptsKeyDown = { [weak self] event in
            guard let self, awaitingPaste, sessionAvailable, enabled(.history),
                  mode == nil || (mode == .history && panel?.isKey != true),
                  !IsSecureEventInputEnabled() else { return false }
            guard selectionChange == board.changeCount else { markClipboardSelection(nil); return false }
            let flags = event.flags & VoiceHotkeyPolicy.physicalFlagMask
            if flags == CGEventFlags.maskCommand.rawValue {
                awaitingPaste = false
                return false
            }
            guard flags == CGEventFlags.maskControl.rawValue, privacy(.history).allows(foreground()?.bundleIdentifier),
                  mode == .history || allowed() else { return false }
            let key = VoiceShortcutValue(keyCode:event.keyCode,modifiers:flags)
            return reserved(key) == nil && conflict(key) == nil
        }
        historyPasteKey.prepareForegroundPress = { [weak self] _,_ in
            let v = VoiceHotkey.commandKeyCode(for:86,usual:CGKeyCode(kVK_ANSI_V))
            self?.awaitingPaste = false
            return .init(commandKeyCode:v) {}
        }
    }
    func armHistoryPasteKey() {
        guard let v = VoiceHotkey.commandKeyCode(for:86,usual:CGKeyCode(kVK_ANSI_V),commandLayer:false),
              VoiceHotkey.commandKeyCode(for:86,usual:CGKeyCode(kVK_ANSI_V)) != nil else { return }
        try? historyPasteKey.register(keyCode:UInt32(v),modifiers:CGEventFlags.maskControl.rawValue) {}
    }
}
