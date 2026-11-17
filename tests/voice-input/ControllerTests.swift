import AppKit
import WebKit
public enum AppLanguage {case zh,en}
@main struct ControllerTests {
 @MainActor static func main() throws {
  var count=0
  func check(_ v:Bool,_ label:String) throws {guard v else{throw NSError(domain:"VoiceControllerTest",code:1,userInfo:[NSLocalizedDescriptionKey:label])};count+=1}
  let root=FileManager.default.temporaryDirectory.appendingPathComponent("formal-controller-"+UUID().uuidString)
  defer{try? FileManager.default.removeItem(at:root)}
  let controller=VoiceInputController(directory:root,qa:true)
  let web=WKWebView();controller.web=web
  try check(!controller.enabled,"new formal feature starts off")
  try check(controller.store.settings.shortcutKeyCode==61,"right Option default")
  controller.saveOutcome=true;controller.dictionarySaveOutcome=true;controller.microphoneSaveOutcome=true;controller.shortcutSaveOutcome=true;controller.promptSaveOutcome=true
  controller.phase="recording"
  for (action,key) in [("saveSettings","settingsSaved"),("saveDictionary","dictionarySaved"),("savePrompt","promptSaved"),("setMicrophone","microphoneSaved"),("setShortcut","shortcutSaved")] {
   var response:[String:Any]?
   controller.handle(["action":action]){v,e in response=v as? [String:Any]}
   try check(response?[key] as? Bool==false,"rejected \(action) cannot reuse older success")
   try check((response?["message"] as? String)?.contains("请完成后") == true,"busy rejection explains current failure")
  }
  var activity:[Bool]=[],recording:[Bool]=[]
  controller.activityChanged={activity.append($0)};controller.recordingChanged={recording.append($0)}
  controller.emit();try check(activity==[true],"session owns shared microphone/output suppression")
  controller.emit();try check(activity==[true],"unchanged state avoids repeated callback")
  controller.rawText="do not lose";controller.cleanedText="pending text";controller.phase="pending";controller.emit()
  try check(controller.isBusy && activity==[true],"pending insertion retains session ownership")
  controller.handle(["action":"leave"]){_,_ in}
  try check(controller.cleanedText=="pending text","page change keeps pending text")
  controller.cancel();try check(activity==[true,false],"cancel releases ownership")
  try check(controller.rawText.isEmpty && controller.cleanedText.isEmpty && controller.phase=="idle","cancel clears session only")
  controller.shortcutRecording=true;controller.emit();controller.shortcutRecording=false;controller.emit()
  try check(recording==[true,false],"shortcut recorder enters and leaves shared guard")
  try check(controller.store.settings.dictionary.isEmpty,"session actions preserve preferences")
  // Exercise the real bridge handlers against an isolated store, without start(),
  // recording, hotkey registration, credentials or network requests.
  controller.qa=false
  let promptURL=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("assets/voice-input/cleanup-prompt.txt")
  controller.defaultCleanupPrompt=try String(contentsOf:promptURL,encoding:.utf8)
  func request(_ body:[String:Any])->[String:Any] {var response:[String:Any]=[:];controller.handle(body){v,_ in response=v as? [String:Any] ?? [:]};return response}
  let initial=controller.store.settings
  var result=request(["action":"saveDictionary","dictionary":[" NuPhy ","张小明","NuPhy"]])
  try check(result["dictionarySaved"] as? Bool==true && controller.store.settings.dictionary==["NuPhy","张小明"],"bridge adds and normalizes dictionary")
  result=request(["action":"saveDictionary","dictionary":[]])
  try check(result["dictionarySaved"] as? Bool==true && controller.store.settings.dictionary.isEmpty,"bridge deletes final entry")
  result=request(["action":"saveDictionary","dictionary":["bad\nentry"]])
  try check(result["dictionarySaved"] as? Bool==false && controller.store.settings.dictionary.isEmpty,"invalid dictionary preserves stored entries")
  let custom="Preserve exact wording.\nCustom formatting."
  result=request(["action":"savePrompt","prompt":custom])
  try check(result["promptSaved"] as? Bool==true,"bridge reports successful prompt save")
  try check(try VoiceSettingsStore(directory:root).settings.customCleanupPrompt==custom,"bridge prompt save survives independent store reopen")
  try check(controller.store.settings.cleanupEndpoint==initial.cleanupEndpoint && controller.store.settings.shortcutKeyCode==initial.shortcutKeyCode,"prompt save preserves provider and hotkey")
  result=request(["action":"savePrompt","prompt":"   "])
  try check(result["promptSaved"] as? Bool==false && controller.store.settings.customCleanupPrompt==custom,"empty prompt retains saved prompt")
  controller.phase="recording";result=request(["action":"savePrompt","prompt":"must not apply mid-session"])
  try check(result["promptSaved"] as? Bool==false && controller.store.settings.customCleanupPrompt==custom,"prompt cannot change during active session")
  controller.phase="idle";result=request(["action":"savePrompt","prompt":controller.defaultCleanupPrompt])
  try check(result["promptSaved"] as? Bool==true && controller.store.settings.customCleanupPrompt==nil,"saving complete default removes custom override")
  try check(try VoiceSettingsStore(directory:root).settings.customCleanupPrompt==nil,"default restoration persists after reopen")
  try check(result["defaultCleanupPrompt"] as? String==controller.defaultCleanupPrompt,"UI receives complete bundled instructions")
  controller.qa=true
  controller.updateLanguage(english:true);controller.message="设置已保存，可以到语音输入页试录。"
  try check(!(controller.state()["message"] as? String ?? "").contains("设置"),"status localized in English")
  let text="用户的中文原文";controller.rawText=text;controller.cleanedText=text
  try check(controller.state()["rawText"] as? String==text,"transcripts never translated by UI localization")
  controller.enabled=false;controller.qa=true
  let savedBefore=controller.store.settings
  controller.applyShortcut(code:0,modifiers:0,mouseButton:3)
  try check(controller.shortcutSaveOutcome==true && controller.store.settings.shortcutMouseButton==3,"side shortcut saved by real controller")
  let reopened=try VoiceSettingsStore(directory:root).settings
  try check(reopened.shortcutMouseButton==3 && reopened.shortcutKeyCode==savedBefore.shortcutKeyCode,"side identity survives reopen without replacing old keyboard code")
  var expected=savedBefore;expected.shortcutMouseButton=3;expected.shortcutMouseModifiers=0
  try check(reopened==expected,"saving shortcut preserves every other preference")
  controller.conflictIssue={VoiceConflictPolicy.issue($0,selection:.mouseButton(index:4),pocket:PocketSettings(),reservedKeys:[])}
  controller.applyShortcut(code:0,modifiers:0,mouseButton:4)
  try check(controller.shortcutSaveOutcome==false && controller.store.settings==expected,"occupied side button rejected without changing saved shortcut")
  try check(controller.message.contains("智能框选"),"conflict names Smart Selection")
  controller.applyShortcut(code:0,modifiers:0,mouseButton:2)
  try check(controller.shortcutSaveOutcome==false && controller.store.settings==expected,"middle button rejected without changing data")
  controller.applyShortcut(code:61,modifiers:0)
  try check(controller.shortcutSaveOutcome==true && controller.store.settings==savedBefore,"keyboard shortcut clears previous mouse binding")
  controller.applyShortcut(code:0,modifiers:1<<20,mouseButton:3)
  let modifiedSide=try VoiceSettingsStore(directory:root).settings
  try check(modifiedSide.shortcutModifiers==savedBefore.shortcutModifiers && modifiedSide.activeShortcutModifiers==1<<20,"mouse modifiers do not overwrite remembered keyboard chord")
  var rollback=modifiedSide;rollback.shortcutMouseButton=nil;rollback.shortcutMouseModifiers=nil
  try check(try rollback.validated()==savedBefore,"older app retains a valid keyboard fallback")
  controller.applyShortcut(code:61,modifiers:0)
  // Replay the exact controller polling path with a non-system event source.
  // The production tap delegates to this same observer; no input is posted.
  controller.applyShortcut(code:0,modifiers:0,mouseButton:3)
  controller.qa=false;controller.enabled=true;controller.phase="idle"
  controller.configureHotkey()
  try check(controller.hotkeyReady,"initial listener ready")
  let press=VoiceHotkeyEvent(kind:.mouseDown,keyCode:3,time:20)
  try check(controller.hotkey.observeRuntime(press).consume,"runtime owns side down")
  controller.operationIssue={"Smart Selection is selecting"}
  controller.configureHotkey()
  try check(!controller.hotkeyReady,"temporary conflict suspends availability")
  try check(controller.hotkey.observeRuntime(.init(kind:.mouseUp,keyCode:3,time:21)) == .init(fire:false,consume:true),"controller polling retains and drains claimed release")
  controller.operationIssue={nil};controller.configureHotkey()
  try check(controller.hotkeyReady,"listener resumes after conflict")
  _=controller.hotkey.observeRuntime(.init(kind:.mouseDown,keyCode:3,time:22))
  controller.operationIssue={"Smart Selection is selecting"};controller.configureHotkey()
  controller.operationIssue={nil};controller.configureHotkey()
  try check(controller.hotkey.observeRuntime(.init(kind:.mouseUp,keyCode:3,time:23)) == .init(fire:false,consume:true),"resume before release cannot re-arm cancelled gesture")
  _=controller.hotkey.observeRuntime(.init(kind:.mouseDown,keyCode:3,time:24))
  controller.enabled=false;controller.configureHotkey()
  try check(controller.hotkey.observeRuntime(.init(kind:.mouseUp,keyCode:3,time:25)) == .init(fire:false,consume:true),"disabled feature drains already-owned release")
  try check(controller.hotkey.observeRuntime(.init(kind:.mouseDown,keyCode:3,time:26)) == .init(),"disabled feature leaves new mouse presses alone")
  try check(controller.hotkey.observeRuntime(.init(kind:.mouseUp,keyCode:3,time:27)) == .init(),"disabled feature leaves matching release alone")
  controller.qa=true;controller.applyShortcut(code:61,modifiers:0)
  let keyboard=VoiceConflictPolicy.binding(controller.store.settings)
  try check(keyboard.kind == .modifiers && keyboard.modifiers == .option,"legacy modifier identity retained")
  for mods:InputModifiers in [[],.command,.control] {
   let same=InputBinding.mouseButton(index:3,modifiers:mods)
   try check(VoiceConflictPolicy.mouseConflict(same,same),"reciprocal same-side conflict")
   try check(!VoiceConflictPolicy.mouseConflict(same,.mouseButton(index:4,modifiers:mods)),"different side button remains available")
   try check(!VoiceConflictPolicy.mouseConflict(same,.keyboard(keyCode:3,modifiers:mods)),"keyboard index differs from mouse index")
  }
  try check(!VoiceConflictPolicy.mouseConflict(.mouseButton(index:3),.mouseButton(index:3,modifiers:.command)),"different exact mouse chords can coexist")
  let settingsBeforeRemoval=try Data(contentsOf:root.appendingPathComponent("settings.json"))
  controller.qa=false;controller.enabled=true;controller.phase="recording";controller.rawText="unfinished"
  controller.setFeatureAdded(false)
  try check(!controller.enabled && !controller.hotkeyReady && controller.phase=="idle","feature removal cancels recording and disables listener")
  try check(try String(contentsOf:root.appendingPathComponent("enabled"),encoding:.utf8)=="false","off survives restart")
  try check(try Data(contentsOf:root.appendingPathComponent("settings.json"))==settingsBeforeRemoval,"removal preserves shortcuts, vocabulary, prompt and service preferences byte-for-byte")
  _=request(["action":"enabled","enabled":true]);try check(!controller.enabled,"stale hidden page cannot enable")
  controller.resume();controller.configureHotkey();try check(!controller.hotkeyReady,"wake cannot revive a hidden shortcut")
  controller.setFeatureAdded(true);try check(!controller.enabled && !controller.hotkeyReady,"re-add stays off")
  _=request(["action":"enabled","enabled":true]);try check(controller.enabled,"explicit switch enables after re-add")
  controller.shutdown();try check(!FileManager.default.fileExists(atPath:root.appendingPathComponent("runtime.json").path),"shutdown removes own runtime")
  controller.shutdown();try check(controller.stopping,"shutdown idempotent")
  print("PASS \(count) formal controller lifecycle/result/localization checks; no microphone, event tap or API use")
 }
}
