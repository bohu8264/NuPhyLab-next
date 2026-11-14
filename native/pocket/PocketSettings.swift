import Foundation
import CoreFoundation

struct PocketSettings: Codable {
    var enabled = false
    var previewEnabled = true
    var shortcut = "controlOption"
    var clearAfterUse = false
    var plainText = false
    var sequential = false
    var sequenceIndex = 0
    var retainDays = 0
    var useModifiers = ["fn"]
    var captureModifiers = ["fn", "shift"]
    var useTriggerKeyCode: UInt16?
    var captureTriggerKeyCode: UInt16?
    var slotKeyCodes: [UInt16] = [18, 19, 20, 21, 23, 22, 26, 28, 25]
    var slotOrder = Array(0..<9)

    static let modifierNames = ["fn", "control", "option", "shift", "command"]
    // macOS may attach Fn to these keys without a separately held Fn key.
    static let implicitFunctionKeys: Set<UInt16> = [64,79,80,90,96,97,98,99,100,101,103,105,106,107,109,111,113,114,115,116,117,118,119,120,121,122,123,124,125,126]
    /// Physical key names; no input source or keyboard mapping is changed.
    static let keyNames: [UInt16: String] = [
        0:"A", 1:"S", 2:"D", 3:"F", 4:"H", 5:"G", 6:"Z", 7:"X", 8:"C", 9:"V", 10:"§", 11:"B",
        12:"Q", 13:"W", 14:"E", 15:"R", 16:"Y", 17:"T", 18:"1", 19:"2", 20:"3", 21:"4", 22:"6", 23:"5",
        24:"=", 25:"9", 26:"7", 27:"−", 28:"8", 29:"0", 30:"]", 31:"O", 32:"U", 33:"[", 34:"I", 35:"P",
        36:"Return", 37:"L", 38:"J", 39:"'", 40:"K", 41:";", 42:"\\", 43:",", 44:"/", 45:"N", 46:"M", 47:".",
        48:"Tab", 49:"Space", 50:"`", 51:"Delete", 53:"Esc", 64:"F17", 65:"小键盘 .", 67:"小键盘 ×", 69:"小键盘 +",
        71:"小键盘 Clear", 75:"小键盘 ÷", 76:"小键盘 Enter", 78:"小键盘 −", 79:"F18", 80:"F19", 81:"小键盘 =",
        82:"小键盘 0", 83:"小键盘 1", 84:"小键盘 2", 85:"小键盘 3", 86:"小键盘 4", 87:"小键盘 5", 88:"小键盘 6",
        89:"小键盘 7", 90:"F20", 91:"小键盘 8", 92:"小键盘 9", 93:"¥", 94:"_", 95:"小键盘 ,", 96:"F5", 97:"F6",
        98:"F7", 99:"F3", 100:"F8", 101:"F9", 102:"英数", 103:"F11", 104:"かな", 105:"F13", 106:"F16", 107:"F14",
        109:"F10", 110:"Menu", 111:"F12", 113:"F15", 114:"Help", 115:"Home", 116:"Page Up", 117:"Forward Delete",
        118:"F4", 119:"End", 120:"F2", 121:"Page Down", 122:"F1", 123:"←", 124:"→", 125:"↓", 126:"↑"
    ]

    var slotKeyNames: [String] { slotKeyCodes.map { PocketL10n.text(Self.keyNames[$0] ?? "键码 \($0)") } }
    var panelModifiers: [String] {
        shortcut == "commandShift" ? ["command", "shift"] : shortcut == "controlShift" ? ["control", "shift"] : ["control", "option"]
    }
    var dictionary: [String: Any] {
        ["enabled":enabled, "previewEnabled":previewEnabled, "shortcut":shortcut, "clearAfterUse":clearAfterUse, "plainText":plainText,
         "sequential":sequential, "sequenceIndex":sequenceIndex, "retainDays":retainDays,
         "useModifiers":useModifiers, "captureModifiers":captureModifiers,
         "useTriggerKeyCode":useTriggerKeyCode.map { Int($0) as Any } ?? NSNull(),
         "captureTriggerKeyCode":captureTriggerKeyCode.map { Int($0) as Any } ?? NSNull(),
         "slotKeyCodes":slotKeyCodes.map(Int.init), "slotKeyNames":slotKeyNames, "slotOrder":slotOrder]
    }

    init() {}
    private enum CodingKeys: String, CodingKey {
        case enabled, previewEnabled, shortcut, clearAfterUse, plainText, sequential, sequenceIndex, retainDays
        case useModifiers, captureModifiers, useTriggerKeyCode, captureTriggerKeyCode, slotKeyCodes, slotOrder
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        // Missing new fields never discard earlier preferences.
        enabled = (try? values.decode(Bool.self, forKey:.enabled)) ?? false
        previewEnabled = (try? values.decode(Bool.self, forKey:.previewEnabled)) ?? true
        shortcut = (try? values.decode(String.self, forKey:.shortcut)) ?? "controlOption"
        clearAfterUse = (try? values.decode(Bool.self, forKey:.clearAfterUse)) ?? false
        plainText = (try? values.decode(Bool.self, forKey:.plainText)) ?? false
        sequential = (try? values.decode(Bool.self, forKey:.sequential)) ?? false
        sequenceIndex = max(0, min(8, (try? values.decode(Int.self, forKey:.sequenceIndex)) ?? 0))
        retainDays = max(0, (try? values.decode(Int.self, forKey:.retainDays)) ?? 0)
        useModifiers = values.contains(.useModifiers) ? ((try? values.decode([String].self, forKey:.useModifiers)) ?? []) : ["fn"]
        captureModifiers = values.contains(.captureModifiers) ? ((try? values.decode([String].self, forKey:.captureModifiers)) ?? []) : ["fn", "shift"]
        slotKeyCodes = values.contains(.slotKeyCodes) ? ((try? values.decode([UInt16].self, forKey:.slotKeyCodes)) ?? []) : [18, 19, 20, 21, 23, 22, 26, 28, 25]
        slotOrder = values.contains(.slotOrder) ? ((try? values.decode([Int].self, forKey:.slotOrder)) ?? []) : Array(0..<9)
        useTriggerKeyCode = Self.decodeTrigger(values, key:.useTriggerKeyCode)
        captureTriggerKeyCode = Self.decodeTrigger(values, key:.captureTriggerKeyCode)
    }

    mutating func apply(_ values: [String: Any]) {
        if let x = values["enabled"] as? Bool { enabled = x }
        if let x = values["previewEnabled"] as? Bool { previewEnabled = x }
        if let x = values["shortcut"] as? String, ["controlOption", "controlShift", "commandShift"].contains(x) { shortcut = x }
        if let x = values["clearAfterUse"] as? Bool { clearAfterUse = x }
        if let x = values["plainText"] as? Bool { plainText = x }
        if let x = values["sequential"] as? Bool { sequential = x }
        if let x = values["sequenceIndex"] as? Int { sequenceIndex = max(0, min(8, x)) }
        if let x = values["retainDays"] as? Int { retainDays = max(0, x) }
        if let value = values["useModifiers"] { useModifiers = Self.modifiers(value) }
        if let value = values["captureModifiers"] { captureModifiers = Self.modifiers(value) }
        if let value = values["useTriggerKeyCode"] { useTriggerKeyCode = value is NSNull ? nil : Self.keyCode(value) }
        if let value = values["captureTriggerKeyCode"] { captureTriggerKeyCode = value is NSNull ? nil : Self.keyCode(value) }
        if let value = values["slotOrder"] {
            slotOrder = (value as? [Any] ?? []).map { item in
                guard let number = item as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
                      (0...8).contains(number.doubleValue) else { return -1 }
                return number.intValue
            }
        }
        if let value = values["slotKeyCodes"] {
            // Keep malformed numbers invalid so validate() rejects the update.
            slotKeyCodes = (value as? [Any] ?? []).map(Self.keyCode)
        }
    }

    func validate() throws {
        guard ["controlOption", "controlShift", "commandShift"].contains(shortcut) else { throw SettingError("备用面板快捷键无效。") }
        for (label, modifiers, trigger) in [("取用", useModifiers, useTriggerKeyCode), ("收纳", captureModifiers, captureTriggerKeyCode)] {
            guard !modifiers.isEmpty || trigger != nil else { throw SettingError("\(label)前缀至少需要一个修饰键或普通按键。") }
            guard modifiers.allSatisfy({ Self.modifierNames.contains($0) }) else { throw SettingError("\(label)快捷键含有不支持的修饰键。") }
            guard Set(modifiers).count == modifiers.count else { throw SettingError("\(label)快捷键不能重复修饰键。") }
            if let trigger {
                guard Self.keyNames[trigger] != nil else { throw SettingError("\(label)前缀含有无效键码或修饰键。") }
                guard !slotKeyCodes.contains(trigger) else { throw SettingError("\(label)前缀键不能同时作为口袋槽位按键。") }
            }
        }
        guard Set(useModifiers) != Set(captureModifiers) || useTriggerKeyCode != captureTriggerKeyCode else { throw SettingError("取用与收纳不能使用完全相同的前缀。") }
        let functionAlias = useTriggerKeyCode.map { Self.implicitFunctionKeys.contains($0) }
            ?? slotKeyCodes.contains(where:Self.implicitFunctionKeys.contains)
        if useTriggerKeyCode==captureTriggerKeyCode,functionAlias,
           Set(useModifiers).subtracting(["fn"])==Set(captureModifiers).subtracting(["fn"]) {
            throw SettingError(PocketL10n.english ? "Store and retrieve cannot differ only by Fn for this key. Choose another key or modifier." : "此按键的收纳和取用不能只用 Fn 区分，请更换按键或其他修饰键。")
        }
        guard slotKeyCodes.count == 9 else { throw SettingError("需要为九个口袋各设置一个按键。") }
        guard Set(slotKeyCodes).count == 9 else { throw SettingError("九个口袋的按键不能重复。") }
        guard slotKeyCodes.allSatisfy({ Self.keyNames[$0] != nil }) else { throw SettingError("口袋按键含有无效键码或修饰键。") }
        guard slotOrder.count == 9, Set(slotOrder) == Set(0..<9) else { throw SettingError("显示顺序必须包含全部九个口袋且不能重复。") }
    }

    private static func modifiers(_ value: Any) -> [String] {
        (value as? [String] ?? []).map { $0.trimmingCharacters(in:.whitespacesAndNewlines).lowercased() }
    }
    private static func keyCode(_ item: Any) -> UInt16 {
        guard let number = item as? NSNumber else { return UInt16.max }
        let value = number.doubleValue
        guard CFGetTypeID(number) != CFBooleanGetTypeID(), value.isFinite,
              value.rounded(.towardZero) == value, (0...Double(UInt16.max)).contains(value) else { return UInt16.max }
        return UInt16(value)
    }
    private static func decodeTrigger(_ values: KeyedDecodingContainer<CodingKeys>, key: CodingKeys) -> UInt16? {
        guard values.contains(key), (try? values.decodeNil(forKey:key)) != true else { return nil }
        return (try? values.decode(UInt16.self, forKey:key)) ?? UInt16.max
    }
    private struct SettingError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { PocketL10n.text(message) }
    }
}
