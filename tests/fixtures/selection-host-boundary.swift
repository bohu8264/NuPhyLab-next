// Keyboard/updater unit harness: selection is a separate boundary under test.
// A no-op factory prevents test AppDelegate instances loading real user preferences,
// Keychain state, screen capture or global input monitors. Product integration is
// separately compiled/checked using the production SelectionFeatureFactory.
import AppKit
import WebKit
// Unrelated host tests must not start ambient sensors. Production sampling and
// lifecycle are compiled separately by ambient-lighting-native.test.mjs.
final class AmbientLightMonitor {
 var onSample:(([String:Any])->Void)?
 private(set) var enabled=false
 func sync(enabled:Bool){self.enabled=enabled}
 func stop(){enabled=false}
}
enum AppLanguage {case zh,en}
@MainActor protocol SelectionFeature: AnyObject {
 var showSettings:(()->Void)? {get set}
 var requestRelaunch:(()->Bool)? {get set}
 var recordingChanged:((Bool)->Void)? {get set}
 var voiceActivityChanged:((Bool)->Void)? {get set}
 var fileDragActive:(()->Bool)? {get set}
 var shortcutSaveIssue:((InputBinding)->String?)? {get set}
 var isBusy:Bool {get}
 var dragReservedTrigger:String? {get}
 var selectionReservedBinding:InputBinding? {get}
 func setFeatureAdded(_ added:Bool)
 func setExternalShortcutRecording(_ active:Bool)
 func updateLanguage(_ language:AppLanguage)
 func updateReservedKeys(_ codes:Set<UInt32>)
 func handle(_ body:[String:Any],reply:@escaping(Any?,String?)->Void)
 func consumeLocal(_ event:NSEvent)->Bool
 func cancel()
 func cancelShortcutRecording()
 func refreshAuthorization()
 func shutdown()
}
@MainActor enum SelectionFeatureFactory {
 static func make(directory:URL,featureAdded:Bool=true)->any SelectionFeature {SelectionBoundaryFixture()}
}
@MainActor private final class SelectionBoundaryFixture:SelectionFeature {
 var dragReservedTrigger:String? {nil}
 var selectionReservedBinding:InputBinding? {nil}
 func setFeatureAdded(_ added:Bool) {}
 func setExternalShortcutRecording(_ active:Bool) {}
 var fileDragActive:(()->Bool)?
 var shortcutSaveIssue:((InputBinding)->String?)?
 var showSettings:(()->Void)?;var requestRelaunch:(()->Bool)?;var recordingChanged:((Bool)->Void)?;var voiceActivityChanged:((Bool)->Void)?;var isBusy=false
 func updateLanguage(_ language:AppLanguage){}
 func updateReservedKeys(_ codes:Set<UInt32>){}
 func handle(_ body:[String:Any],reply:@escaping(Any?,String?)->Void){reply(nil,"Selection boundary fixture")}
 func consumeLocal(_ event:NSEvent)->Bool{false}
 func cancel(){};func cancelShortcutRecording(){};func refreshAuthorization(){};func shutdown(){}
}

// Typing audio is isolated from F-key/updater unit harnesses.
@MainActor final class TypingSoundController {
 init(directory:URL,featureAdded:Bool=true) {}
 func setFeatureAdded(_ added:Bool) {}
 func setPaused(_ source:String,active:Bool) {}
 func handle(_ body:[String:Any],reply:@escaping(Any?,String?)->Void) { reply(nil,"Typing boundary fixture") }
 func shutdown() {}
}

enum TypingDictationCompletion {
 static func confirmed(_ result:[String:Any]?) -> Bool { result?["released"] as? Bool == true && ["idle","finishing"].contains(result?["observedState"] as? String ?? "unknown") }
}

// File conversion is isolated from keyboard/updater harnesses. Production
// converters and drop callbacks are tested with generated file fixtures.
final class DragConvertController {
 var selectionReservedTrigger:()->String?={nil}
 var reservedKeyCodes:()->Set<UInt32> = {[]}
 var busy=false; var isFileDragActive=false
 var canPresent:()->Bool = {true};var activityChanged:((Bool)->Void)?
 var suspended=false
 init(directory:URL,featureAdded:Bool=true) {}
 func setFeatureAdded(_ added:Bool) {}
 func updateLanguage(english:Bool) {}
 func handle(_ body:[String:Any],reply:@escaping(Any?,String?)->Void){reply(nil,"Drag boundary fixture")}
 func suspend(){suspended=true};func resume(){suspended=false};func shutdown(){suspended=true}
}

// Voice and Pocket own separate isolated controller suites. These inert
// boundaries keep host/update tests away from user data and global input.
struct InputBinding {}
struct PocketSettings {}
struct VoiceSettings {}
struct FixtureVoiceStore {var settings=VoiceSettings()}
enum VoiceConflictPolicy {
 static func issue(_ settings:VoiceSettings,selection:InputBinding?,pocket:PocketSettings,reservedKeys:Set<UInt32>)->String?{nil}
 static func binding(_ settings:VoiceSettings)->InputBinding{InputBinding()}
 static func mouseConflict(_ first:InputBinding,_ second:InputBinding)->Bool{false}
}
struct FixturePocketIssue {func message(english:Bool)->String{"fixture conflict"}}
enum PocketConflictPolicy {static func conflict(settings:PocketSettings,selection:InputBinding?,reservedKeys:Set<UInt32>)->FixturePocketIssue?{nil}}
@MainActor class PocketHostWebView:WKWebView {weak var pocketController:PocketController?}
@MainActor final class PocketController {
 var isBusy=false,isInteracting=false;var settings=PocketSettings()
 var canRecordShortcut:()->Bool={true},canActivate:()->Bool={true},canAcceptDrop:()->Bool={true}
 var recordingChanged:((Bool)->Void)?,activityChanged:((Bool)->Void)?
 var conflictIssue:(PocketSettings)->String?={_ in nil}
 init(directory:URL,featureAdded:Bool=true){}
 func setFeatureAdded(_ added:Bool){};func updateLanguage(english:Bool){}
 func attach(web:WKWebView,window:NSWindow){};func suspend(){};func resume(){};func shutdown(){}
 func refreshAuthorization(){};func cancelShortcutRecording(){};func invalidatePage(){}
 func handle(_ body:[String:Any],reply:@escaping(Any?,String?)->Void){reply(nil,"Pocket boundary fixture")}
}
@MainActor final class VoiceInputController {
 var isBusy=false,busy=false,enabled=false;var store:FixtureVoiceStore?=FixtureVoiceStore()
 var canStart:()->Bool={true},canRecordShortcut:()->Bool={true}
 var operationIssue:()->String?={nil},conflictIssue:(VoiceSettings)->String?={_ in nil}
 var activityChanged:((Bool)->Void)?,recordingChanged:((Bool)->Void)?
 init(directory:URL,migrateFrom:URL?=nil,featureAdded:Bool=true){}
 func setFeatureAdded(_ added:Bool){};func updateLanguage(english:Bool){};func start(web:WKWebView){}
 func suspend(){};func resume(){};func shutdown(){};func cancel(){};func refreshAuthorization(){}
 func handle(_ body:[String:Any],reply:@escaping(Any?,String?)->Void){reply(nil,"Voice boundary fixture")}
}
