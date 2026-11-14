import Foundation

/// Conflicts are evaluated against saved bindings, not event-tap order. A
/// conflict pauses Pocket while preserving both features' saved preferences.
enum PocketConflictPolicy {
    enum Conflict: Equatable {
        case selection, aiKeyboard, identicalPrefixes
        func message(english:Bool) -> String {
            switch self {
            case .selection:return english ? "This shortcut is used by Smart Selection. Change one shortcut or turn off Smart Selection." : "此快捷键已用于智能框选，请更换其中一个快捷键，或关闭智能框选。"
            case .aiKeyboard:return english ? "This key is assigned to AI mode. Choose another key or add a modifier." : "此按键已被 AI 模式占用，请更换按键或添加修饰键。"
            case .identicalPrefixes:return english ? "Store and retrieve need different shortcuts." : "收纳和取用需要使用不同的快捷键。"
            }
        }
    }
    struct Prefix: Equatable {
        var modifiers:InputModifiers
        var keyCode:UInt16?
        init(modifiers:[String],keyCode:UInt16?) {
            self.modifiers=modifiers.reduce(into:InputModifiers()) { value,name in
                switch name {
                case "control":value.insert(.control)
                case "shift":value.insert(.shift)
                case "option":value.insert(.option)
                case "command":value.insert(.command)
                case "fn":value.insert(.function)
                default:break
                }
            }
            self.keyCode=keyCode
        }
    }
    static func conflict(settings:PocketSettings,selection:InputBinding?,reservedKeys:Set<UInt32>) -> Conflict? {
        guard settings.enabled else{return nil}
        return conflict(use:Prefix(modifiers:settings.useModifiers,keyCode:settings.useTriggerKeyCode),
            capture:Prefix(modifiers:settings.captureModifiers,keyCode:settings.captureTriggerKeyCode),
            slotKeyCodes:settings.slotKeyCodes,previewEnabled:settings.previewEnabled,selection:selection,reservedKeys:reservedKeys)
    }
    static func conflict(use:Prefix,capture:Prefix,slotKeyCodes:[UInt16],previewEnabled:Bool=true,selection:InputBinding?,reservedKeys:Set<UInt32>) -> Conflict? {
        guard use != capture else{return .identicalPrefixes}
        for prefix in [use,capture] {
            // AI function keys ignore the hardware's implicit Fn flag. A real
            // Command/Control/Option/Shift modifier keeps the chord distinct.
            if prefix.modifiers.subtracting(.function).isEmpty,
               slotKeyCodes.contains(where:{reservedKeys.contains(UInt32($0))}) || prefix.keyCode.map({reservedKeys.contains(UInt32($0))}) == true {
                return .aiKeyboard
            }
            guard let selection else{continue}
            switch selection.kind {
            case .modifiers:
                // A shorter modifier-only selection can fire while the user
                // is still assembling Pocket's two-key prefix. Conversely, a
                // shorter Pocket prefix can open before a longer selection chord.
                if !selection.modifiers.isEmpty && (selection.modifiers.isSubset(of:prefix.modifiers) ||
                    (prefix.keyCode == nil && !prefix.modifiers.isEmpty && prefix.modifiers.isSubset(of:selection.modifiers))) {return .selection}
            case .keyboard:
                guard let key=selection.keyCode else{continue}
                // Both matchers must accept the same event flags. Pocket uses
                // its held prefix key for Fn normalization; only a pure
                // modifier prefix uses the selected slot key instead.
                let normalizationKey=prefix.keyCode ?? key
                let variants=[prefix.modifiers,prefix.modifiers.union(.function)]
                let matches=variants.contains { flags in
                    let pocketMatches=flags==prefix.modifiers ||
                        (PocketSettings.implicitFunctionKeys.contains(normalizationKey) &&
                         !prefix.modifiers.contains(.function) && flags.subtracting(.function)==prefix.modifiers)
                    return pocketMatches && selection.matchesModifiers(flags)
                }
                guard matches else{continue}
                // A passive modifier preview claims interaction before a
                // longer keyboard shortcut reaches Selection. Detect this
                // independently of which event tap happens to run first.
                if previewEnabled && prefix.keyCode == nil {return .selection}
                if prefix.keyCode==key || slotKeyCodes.contains(key) {return .selection}
            case .mouseButton,.disabled:break
            }
        }
        return nil
    }
}
