import Foundation
import Security
public enum AppLanguage {case zh,en}

@main struct FormalIntegrationTests {
    static var checks=0
    static func check(_ value:Bool,_ message:String) throws {
        guard value else{throw NSError(domain:"FormalVoiceTest",code:1,userInfo:[NSLocalizedDescriptionKey:message])};checks+=1
    }
    @MainActor static func main() throws {
        let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("voice-formal-test-"+UUID().uuidString)
        defer {try? fm.removeItem(at:root)}
        let source=root.appendingPathComponent("experiment"),dest=root.appendingPathComponent("formal/voice-input")
        try VoiceFormalMigration.migrate(from:source,to:dest)
        try check(!fm.fileExists(atPath:dest.path),"absent experiment does not create migration")
        let old=try VoiceSettingsStore(directory:source)
        var settings=VoiceSettings();settings.shortcutKeyCode=61;settings.dictionary=["NuPhy"];settings.microphoneUID="fixture-mic";settings.speculativeCleanup=true
        let origin="https://"+UUID().uuidString.lowercased()+".formal-voice-test.invalid"
        settings.asrEndpoint=origin+"/asr";settings.cleanupEndpoint=origin+"/cleanup";settings.asrMode="file"
        try old.save(settings)
        let original=try Data(contentsOf:source.appendingPathComponent("settings.json"))
        try VoiceFormalMigration.migrate(from:source,to:dest)
        let migrated=try VoiceSettingsStore(directory:dest)
        var expected=settings;expected.allowLegacyCredentials=true
        try check(migrated.settings==expected,"all experimental preferences retained, fallback explicitly marked")
        try check(try Data(contentsOf:source.appendingPathComponent("settings.json"))==original,"source stays byte-identical")
        try check(try String(contentsOf:dest.appendingPathComponent("enabled"))=="true","existing user feature enabled")
        try check(fm.fileExists(atPath:dest.appendingPathComponent("migration.json").path),"receipt committed with settings")
        var changed=migrated.settings;changed.dictionary=["My new word"];try migrated.save(changed)
        try Data("false".utf8).write(to:dest.appendingPathComponent("enabled"))
        try VoiceFormalMigration.migrate(from:source,to:dest)
        try check(try VoiceSettingsStore(directory:dest).settings==changed,"repeat startup never overwrites newer data")
        try check(try String(contentsOf:dest.appendingPathComponent("enabled"))=="false","explicit disable survives repeat migration")
        let existing=root.appendingPathComponent("empty-formal");try fm.createDirectory(at:existing,withIntermediateDirectories:true)
        try VoiceFormalMigration.migrate(from:source,to:existing)
        try check(!fm.fileExists(atPath:existing.appendingPathComponent("settings.json").path),"existing formal profile not imported later")
        try Data("invalid".utf8).write(to:source.appendingPathComponent("settings.json"))
        let invalidDest=root.appendingPathComponent("bad-destination")
        do {try VoiceFormalMigration.migrate(from:source,to:invalidDest);throw NSError(domain:"acceptedInvalid",code:1)}catch {try check(!fm.fileExists(atPath:invalidDest.path),"invalid source leaves destination absent")}
        try original.write(to:source.appendingPathComponent("settings.json"))
        try check(!(try fm.contentsOfDirectory(atPath:dest.deletingLastPathComponent().path)).contains(where:{$0.hasPrefix(".voice-import-")}),"no temporary imports remain")
        try check(VoiceSettings().shortcutKeyCode==61,"new formal profile defaults to right Option, not AI F8")

        // Fresh UUID-origin synthetic Keychain items only. No real account lookup.
        let account=try VoiceSettingsStore.keyAccount("cleanup",settings:settings)
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:VoiceSettingsStore.legacyKeychainService,kSecAttrAccount as String:account]
        defer {SecItemDelete(query as CFDictionary);try? migrated.deleteKey("cleanup")}
        var add=query;add[kSecValueData as String]=Data("SYNTHETIC-LEGACY-VOICE".utf8)
        try check(SecItemAdd(add as CFDictionary,nil)==errSecSuccess,"isolated legacy credential created")
        try check(migrated.keyStatus()["hasCleanupKey"]==true,"migrated credential status found")
        try check(try migrated.readKey("cleanup")=="SYNTHETIC-LEGACY-VOICE","migration can use existing credential without copying")
        let fresh=try VoiceSettingsStore(directory:root.appendingPathComponent("fresh"));try fresh.save(settings)
        try check(try fresh.readKey("cleanup")==nil,"fresh profiles cannot use legacy keys")
        try migrated.saveKey("SYNTHETIC-FORMAL-VOICE",kind:"cleanup")
        try check(try migrated.readKey("cleanup")=="SYNTHETIC-FORMAL-VOICE","formal credential takes precedence")
        var read=query;read[kSecReturnData as String]=true;var data:CFTypeRef?
        try check(SecItemCopyMatching(read as CFDictionary,&data)==errSecSuccess && (data as? Data)==Data("SYNTHETIC-LEGACY-VOICE".utf8),"formal save preserves experimental key")
        try migrated.deleteKey("cleanup")
        try check(try migrated.readKey("cleanup")=="SYNTHETIC-LEGACY-VOICE","formal deletion does not erase legacy credential")

        var pocket=PocketSettings();var voice=VoiceSettings()
        let reserved:Set<UInt32>=[98,100,101,109,103,111]
        try check(VoiceConflictPolicy.issue(voice,selection:.mouseButton(index:4),pocket:pocket,reservedKeys:reserved)==nil,"current mouse selection/right Option coexist")
        try check(VoiceConflictPolicy.issue(voice,selection:.modifierChord(.option),pocket:pocket,reservedKeys:reserved) != nil,"modifier selection conflict")
        voice.shortcutKeyCode=100
        try check(VoiceConflictPolicy.issue(voice,selection:nil,pocket:pocket,reservedKeys:reserved) != nil,"AI F8 conflict")
        voice.shortcutModifiers=1<<20
        try check(VoiceConflictPolicy.issue(voice,selection:nil,pocket:pocket,reservedKeys:reserved)==nil,"Command F8 distinct from AI F8")
        try check(VoiceConflictPolicy.issue(voice,selection:.keyboard(keyCode:100,modifiers:.command),pocket:pocket,reservedKeys:[]) != nil,"same full chord conflicts")
        voice=VoiceSettings();pocket.enabled=true;pocket.useModifiers=["control"];pocket.captureModifiers=["option"]
        try check(VoiceConflictPolicy.issue(voice,selection:nil,pocket:pocket,reservedKeys:[]) != nil,"pocket Option prefix conflicts")
        pocket.enabled=false
        try check(VoiceConflictPolicy.issue(voice,selection:nil,pocket:pocket,reservedKeys:[])==nil,"disabled pocket keeps saved prefix without conflict")
        try check(VoiceSettingsStore.keychainService != VoiceSettingsStore.legacyKeychainService,"formal writes isolated")
        print("PASS \(checks) formal migration, credential isolation and shortcut conflict checks; temporary synthetic accounts cleaned")
    }
}
