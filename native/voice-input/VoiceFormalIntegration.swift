import Foundation
import CryptoKit

enum VoiceFormalMigration {
    static func migrate(from source:URL,to destination:URL) throws {
        let fm=FileManager.default,original=source.appendingPathComponent("settings.json")
        // A directory already created by the formal app belongs to that profile,
        // even when its user has not saved settings yet. Never re-import over it.
        guard !fm.fileExists(atPath:destination.path),fm.fileExists(atPath:original.path) else{return}
        let data=try Data(contentsOf:original)
        guard data.count<=65536 else{throw VoiceConfigurationError.invalid("语音设置文件过大。")}
        var settings=try JSONDecoder().decode(VoiceSettings.self,from:data).validated()
        settings.allowLegacyCredentials=true
        let parent=destination.deletingLastPathComponent()
        try fm.createDirectory(at:parent,withIntermediateDirectories:true)
        let staging=parent.appendingPathComponent(".voice-import-"+UUID().uuidString)
        defer {try? fm.removeItem(at:staging)}
        let store=try VoiceSettingsStore(directory:staging)
        try store.save(settings)
        try Data("true".utf8).write(to:staging.appendingPathComponent("enabled"),options:.atomic)
        let record:[String:Any]=["schema":1,"sourceBundle":"local.nuphylab.voiceinput","sourceSettingsSHA256":SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined(),"settingsImported":true,"credentialPolicy":"read existing purpose/origin on demand; future saves use formal voice namespace","at":ISO8601DateFormatter().string(from:Date())]
        try JSONSerialization.data(withJSONObject:record,options:[.sortedKeys,.prettyPrinted]).write(to:staging.appendingPathComponent("migration.json"),options:.atomic)
        // Commit the settings, enable flag and receipt together on the same volume.
        try fm.moveItem(at:staging,to:destination)
    }
}

enum VoiceConflictPolicy {
    static func shortcut(_ value:VoiceSettings)->VoiceShortcutValue {
        .init(keyCode:UInt32(value.shortcutKeyCode),modifiers:value.activeShortcutModifiers,mouseButton:value.shortcutMouseButton)
    }
    static func binding(_ value:VoiceSettings)->InputBinding {
        binding(shortcut(value))
    }
    static func binding(_ value:VoiceShortcutValue)->InputBinding {
        let code=value.keyCode
        let flags=value.mouseButton == nil ? (VoiceHotkeyPolicy.modifiers[code]?.flag ?? value.modifiers) : value.modifiers
        var modifiers=InputModifiers()
        for (flag,modifier) in [(UInt64(1<<17),InputModifiers.shift),(1<<18,.control),(1<<19,.option),(1<<20,.command),(1<<23,.function)] {if flags & flag != 0 {modifiers.insert(modifier)}}
        if let button=value.mouseButton {return .mouseButton(index:Int(button),modifiers:modifiers)}
        return VoiceHotkeyPolicy.modifierCodes.contains(code) ? .modifierChord(modifiers) : .keyboard(keyCode:UInt16(code),modifiers:modifiers)
    }
    static func mouseConflict(_ voice:InputBinding,_ selection:InputBinding)->Bool {
        voice.kind == .mouseButton && selection.kind == .mouseButton && voice.buttonIndex==selection.buttonIndex && voice.modifiers==selection.modifiers
    }
    static func issue(_ value:VoiceSettings,selection:InputBinding?,pocket:PocketSettings,reservedKeys:Set<UInt32>)->String? {
        issue(shortcut(value),selection:selection,pocket:pocket,reservedKeys:reservedKeys)
    }
    static func overlapsSelection(_ voice:InputBinding,_ other:InputBinding)->Bool {
        mouseConflict(voice,other) ||
        (other.kind == .modifiers && !other.modifiers.isEmpty && other.modifiers.isSubset(of:voice.modifiers)) ||
        (other.kind == .keyboard && voice.kind == .keyboard && other.keyCode==voice.keyCode && other.matchesModifiers(voice.modifiers))
    }
    static func issue(_ value:VoiceShortcutValue,selection:InputBinding?,pocket:PocketSettings,reservedKeys:Set<UInt32>)->String? {
        let voice=binding(value)
        if voice.kind == .keyboard,voice.modifiers.isEmpty,reservedKeys.contains(value.keyCode){return "此快捷键已用于 AI 助手，请更换语音输入快捷键。"}
        if let other=selection {
            if mouseConflict(voice,other) {return "此快捷键已用于智能框选，请更换其中一个快捷键。"}
            if overlapsSelection(voice,other){return "此快捷键已用于智能框选，请更换其中一个快捷键。"}
        }
        if PocketConflictPolicy.conflict(settings:pocket,selection:voice,reservedKeys:[]) == .selection {return "此快捷键与键盘口袋冲突，请更换其中一个快捷键。"}
        return nil
    }
}
