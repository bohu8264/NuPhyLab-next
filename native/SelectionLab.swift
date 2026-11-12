import AppKit
import SwiftUI
import Carbon
import Security
import LocalAuthentication
import AVFoundation
import Speech
import QuartzCore

struct LabIssue: LocalizedError { let message:String; init(_ message:String){self.message=message}; var errorDescription:String?{message} }
enum LabKeychain {
 static let service="local.airstudio.desktop.selection-api"
 static func query(_ account:String)->[String:Any]{[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account]}
 static func has(_ account:String)->Bool{var q=query(account);q[kSecReturnAttributes as String]=true;let context=LAContext();context.interactionNotAllowed=true;q[kSecUseAuthenticationContext as String]=context;return SecItemCopyMatching(q as CFDictionary,nil)==errSecSuccess}
 static func read(_ account:String)throws->String{var q=query(account);q[kSecReturnData as String]=true;var item:CFTypeRef?;guard SecItemCopyMatching(q as CFDictionary,&item)==errSecSuccess,let data=item as? Data,let key=String(data:data,encoding:.utf8) else{throw LabIssue("尚未保存此服务的 API Key，请前往设置。")};return key}
 static func write(_ key:String,account:String)throws{
  guard !key.isEmpty,key.utf8.count<=8192,key.rangeOfCharacter(from:.whitespacesAndNewlines.union(.controlCharacters))==nil else{throw LabIssue("API Key 为空、过长或包含空白字符。")}
  let q=query(account),data=Data(key.utf8),code=SecItemUpdate(q as CFDictionary,[kSecValueData as String:Data(key.utf8)] as CFDictionary)
  if code==errSecItemNotFound{var add=q;add[kSecValueData as String]=data;add[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly;guard SecItemAdd(add as CFDictionary,nil)==errSecSuccess else{throw LabIssue("无法保存到 macOS 钥匙串，请解锁后重试。")}}
  else if code != errSecSuccess{throw LabIssue("更新钥匙串失败，原密钥未删除。")}
 }
 static func delete(_ account:String)throws{let code=SecItemDelete(query(account) as CFDictionary);guard code==errSecSuccess || code==errSecItemNotFound else{throw LabIssue("无法移除钥匙串中的密钥。")}}
}
@available(macOS 14, *)
@MainActor final class SelectionLab:NSObject,NSWindowDelegate,SelectionFeature {
 let directory:URL;var showSettings:(()->Void)?;var requestRelaunch:(()->Bool)?;var recordingChanged:((Bool)->Void)?;var voiceActivityChanged:((Bool)->Void)?
 var fileDragActive:(()->Bool)?
 private var language=AppLanguage.zh
 private var stopping=false
 private var keyboardReservedKeys=Set<UInt32>()
 private var shortcutConflict:Bool{preferences.shortcut.conflictsWithKeyboard(keyboardReservedKeys)}
 func updateReservedKeys(_ codes:Set<UInt32>){guard !stopping,codes != keyboardReservedKeys else{return};keyboardReservedKeys=codes;if shortcutConflict{cancel()};do{try register(preferences)}catch{registrationIssue=Self.friendly(error,language:language)}}
 var dragReservedTrigger:String? { preferences.enabled ? preferences.shortcut.dragReservation : nil }
 var isBusy:Bool{recordingReply != nil || !overlays.isEmpty || task != nil || utilityTask != nil || voicePending}
 private var freshPermissions:LabPermissionSnapshot?;private var freshAt:TimeInterval=0;private var nextProbe:TimeInterval=0;private var permissionProbe:Process?
 private var observedLocalPermissions:LabPermissionSnapshot?
 private var permissionRecheckUntil:TimeInterval=0
 private var monitorRecovery=LabMonitorRecovery()
 private var recentPermissionProbe:LabPermissionSnapshot?{
  ProcessInfo.processInfo.systemUptime-freshAt<5 ? freshPermissions : nil
 }
 private func observeLocalPermissions()->LabPermissionSnapshot{
  let local=LabPermissionSnapshot.current()
  if observedLocalPermissions != local{
   observedLocalPermissions=local
   // A probe taken before this local edge must not mask a revocation.
   freshPermissions=nil
   if let permissionProbe,permissionProbe.isRunning{permissionProbe.terminate()}
   permissionProbe=nil
   nextProbe=0
  }
  return local
 }
 private func configurationIssue(_ value:LabPreferences)->String {
  guard !value.configuration.model.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{return "请先在“模型与 API”中选择模型并保存 API Key。"}
  do{let account=try value.configuration.credentialAccount();return LabKeychain.has(account) ? "":"请先在“模型与 API”中保存此服务的 API Key。"}catch{return Self.friendly(error,language:language)}
 }
 private var preferences=LabPreferences();private let input=SelectionHoldMonitor();private let voice=LocalVoiceCapture()
 private var overlays:[SelectionOverlayWindow]=[];private var panel:SelectionResultPanel?;private var task:Task<Void,Never>?;private var utilityTask:Task<Void,Never>?
 private var utilityGeneration=UUID();private var generation=UUID();private var imagePNG:Data?;private var observers:[NSObjectProtocol]=[];private var monitor:Timer?
 private let viewState=SelectionPanelState();private var registrationIssue="";private var hold=LabHoldState();private var selectionRect:NSRect?
 private var captureReady=false;private var voicePending=false;private var speechFailed=false;private var speechStarted=false;private var voiceToken:UUID? { didSet { if (oldValue != nil) != (voiceToken != nil) { voiceActivityChanged?(voiceToken != nil) } } };private var voiceDelay:Task<Void,Never>?
 private var pendingAction:LabAction = .translate;private var permissionSignature="";private var recordingReply:((Any?,String?)->Void)?;private var recordingTimer:Timer?;private var modifierRecorder=LabModifierRecorder();private var recordedShortcut:LabShortcut?
 private var sideRecorder=LabSideButtonRecorder();private var sideMonitor:Any?
 private var sideSelection=IntentSideSelectionState();private var sidePrimaryTop:CGFloat=0
 private var panelAnchor=NSPoint.zero;private var resultWheel=LabWheelState();private var wheelMonitor:Any?;private var modeTask:Task<Void,Never>?
 private var panelScreenNumber:NSNumber?;private var panelMeasurement:LabAnswerMeasurement?
 private var surface:SelectionNotchSurface?;private var closingPanel=false
 private var preferencesURL:URL{directory.appendingPathComponent("selection-preferences.json")}
 private var selectionPermissions:Bool{LabPermissionSnapshot.current().missing(voice:false).isEmpty}
 private var voicePermissions:Bool{AVCaptureDevice.authorizationStatus(for:.audio) == .authorized && SFSpeechRecognizer.authorizationStatus() == .authorized}
 private var missing:[String]{LabPermissionSnapshot.current().missing(voice:preferences.voiceEnabled)}
 init(directory:URL){
  self.directory=directory;super.init()
  if let data=try? Data(contentsOf:preferencesURL),let value=try? JSONDecoder().decode(LabPreferences.self,from:data){preferences=value}
  input.onEvent={[weak self] event in self?.receiveInput(event)}
  input.onCancel={[weak self] in self?.cancel()};input.onFailure={[weak self] _ in self?.registrationIssue="快捷键监听暂未就绪，正在重新连接；也可点击重新检查。";self?.monitorRecovery.failed(at:ProcessInfo.processInfo.systemUptime);self?.cancel()}
  voice.language = language
  voice.onTranscript={[weak self] text in guard let self,self.voiceToken != nil else{return};self.viewState.question=text;self.overlayFeedback(speech:text)}
  voice.onRecordingStarted={[weak self] token in guard let self,self.voiceToken==token else{return};self.speechStarted=true;self.overlayFeedback()}
  voice.onResolved={[weak self] token,result in self?.voiceResolved(token,result)}
  voice.onSafetyCancelled={[weak self] in self?.cancel()}
  viewState.submit={[weak self] in self?.send($0)};viewState.cancel={[weak self] in self?.cancelRequest()};viewState.close={[weak self] in self?.cancel(animatePanel:true)}
  viewState.reselect={[weak self] in self?.startFromShortcut()};viewState.settings={[weak self] in self?.cancel();self?.showSettings?()}
  viewState.disableVoice={[weak self] in self?.disableVoice()};viewState.permission={[weak self] in self?.requestPermission($0)};viewState.size={[weak self] in self?.resizePanel($0)};viewState.switchAction={[weak self] in self?.switchAction($0)}
  viewState.translationLanguage=preferences.translationLanguage
  viewState.chooseTranslationLanguage={[weak self] in self?.changeTranslationLanguage($0)}
  viewState.beginTyping={[weak self] in self?.panel?.makeKey()}
  viewState.expansion={[weak self] in self?.layoutPanel(animated:true)}
  sideMonitor=NSEvent.addLocalMonitorForEvents(matching:[.otherMouseDown,.otherMouseUp,.otherMouseDragged,.systemDefined]){[weak self] event in
   guard let self,!self.stopping else{return event}
   let capture=self.recordingReply != nil && self.recordedShortcut==nil && !IsSecureEventInputEnabled()
   let result=self.sideRecorder.receive(event,capturing:capture)
   if let shortcut=result.shortcut{self.finishShortcutRecording(shortcut)}
   return result.event
  }
  observers.append(NotificationCenter.default.addObserver(forName:NSApplication.didResignActiveNotification,object:nil,queue:.main){[weak self] _ in MainActor.assumeIsolated{self?.cancelShortcutRecording()}})
  wheelMonitor=NSEvent.addLocalMonitorForEvents(matching:.scrollWheel){[weak self] event in
   guard let self,let panel=self.panel,event.window===panel else{return event}
   guard let content=panel.contentView else{return event};let point=content.convert(event.locationInWindow,from:nil)
   let fromTop=content.isFlipped ? point.y:content.bounds.height-point.y
   // Only the title action strip switches modes. Answer text keeps normal scrolling.
   if !self.viewState.isCompact,fromTop>=0,fromTop<32,let direction=self.resultWheel.step(delta:event.scrollingDeltaY,precise:event.hasPreciseScrollingDeltas,momentum:!event.momentumPhase.isEmpty,time:event.timestamp){self.switchAction(self.viewState.action.stepped(direction));return nil};return event
  }
  observers.append(NotificationCenter.default.addObserver(forName:NSApplication.didChangeScreenParametersNotification,object:nil,queue:.main){[weak self] _ in MainActor.assumeIsolated{self?.cancel()}})
  for name in [NSWorkspace.willSleepNotification,NSWorkspace.sessionDidResignActiveNotification]{observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName:name,object:nil,queue:.main){[weak self] _ in MainActor.assumeIsolated{self?.cancel()}})}
  let timer=Timer(timeInterval:0.5,repeats:true){[weak self] _ in MainActor.assumeIsolated{self?.pollPermissions()}};RunLoop.main.add(timer,forMode:.common);monitor=timer
  do{try register(preferences)}catch{registrationIssue=Self.friendly(error,language:language)}
 }
 func updateLanguage(_ value:AppLanguage){
  guard language != value else{return}
  language=value;viewState.language=value;voice.language=value
  panel?.title=LabText.text("框选回答",language:value)
  for window in overlays{(window.contentView as? SelectionOverlayView)?.language=value}
 }
 private func changeTranslationLanguage(_ value:LabTranslationLanguage){
  guard value != preferences.translationLanguage else{return}
  var next=preferences;next.translationLanguage=value
  do{try persist(next);preferences=next;viewState.translationLanguage=value
   if captureReady,viewState.action == .translate,viewState.question.isEmpty,!viewState.showQuestion{switchAction(.translate)}
  }catch{viewState.issue=Self.friendly(error,language:language)}
 }
 private func persist(_ value:LabPreferences)throws{try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);try JSONEncoder().encode(value).write(to:preferencesURL,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:preferencesURL.path)}
 private func register(_ value:LabPreferences)throws {
  try value.shortcut.validate();input.stop();registrationIssue=""
  permissionSignature=String(describing:LabPermissionSnapshot.current()) + "/" + configurationIssue(value) + "/" + String(describing:keyboardReservedKeys.sorted())
  guard !stopping,value.enabled,recordingReply==nil else{return}
  guard !value.shortcut.conflictsWithKeyboard(keyboardReservedKeys) else{throw LabIssue("此按键正用于 AI 键盘控制，框选快捷键已暂停。请选择其他按键或带修饰键的组合，或关闭 AI 模式。")}
  let configurationError=configurationIssue(value)
  guard configurationError.isEmpty else{registrationIssue=configurationError;return}
  guard LabPermissionSnapshot.current().missing(voice:value.voiceEnabled).isEmpty else{return}
  input.setEnabled(true)
  do{try input.start(binding:value.shortcut.binding);monitorRecovery.reset()}
  catch{monitorRecovery.failed(at:ProcessInfo.processInfo.systemUptime);throw error}
 }
 func refreshAuthorization(){guard !stopping else{return};pollPermissions(forceRegistration:true);probePermissions(force:true)}
 private func probePermissions(force:Bool=false){
  let now=ProcessInfo.processInfo.systemUptime
  guard !stopping,(preferences.enabled || now<permissionRecheckUntil || force),permissionProbe==nil,now>=nextProbe,
        force || !missing.isEmpty,let executable=Bundle.main.executableURL else{return}
  nextProbe=now+2
  let process=Process(),pipe=Pipe();permissionProbe=process
  process.executableURL=executable;process.arguments=[SelectionPermissionProbe.argument]
  process.standardInput=FileHandle.nullDevice;process.standardOutput=pipe;process.standardError=FileHandle.nullDevice
  process.terminationHandler={ [weak self] child in
   let data=pipe.fileHandleForReading.readDataToEndOfFile()
   let result=child.terminationReason == .exit && child.terminationStatus==0 ? SelectionPermissionProbe.decode(data):nil
   DispatchQueue.main.async{
    guard let self,self.permissionProbe===child else{return}
    _ = self.observeLocalPermissions()
    guard self.permissionProbe===child else{self.pollPermissions();return}
    self.permissionProbe=nil
    if let result{self.freshPermissions=result;self.freshAt=ProcessInfo.processInfo.systemUptime}
    self.pollPermissions()
   }
  }
  do{try process.run()}catch{permissionProbe=nil}
  DispatchQueue.main.asyncAfter(deadline:.now()+2){[weak self,weak process] in guard let process,self?.permissionProbe===process,process.isRunning else{return};process.terminate()}
 }
 func shutdown(){stopping=true;if let sideMonitor{NSEvent.removeMonitor(sideMonitor);self.sideMonitor=nil};input.stop();cancelShortcutRecording();input.stop();monitor?.invalidate();monitor=nil;utilityTask?.cancel();utilityTask=nil;if permissionProbe?.isRunning==true{permissionProbe?.terminate()};permissionProbe=nil;cancel()}
 private func disableVoice(){var next=preferences;next.voiceEnabled=false;do{try persist(next);preferences=next;cancel();try register(next);if next.enabled && !missing.isEmpty{showPermissionPanel()}}catch{registrationIssue=Self.friendly(error,language:language)}}
 private func pollPermissions(forceRegistration:Bool=false){
  guard !stopping else{return}
  let local=observeLocalPermissions()
  probePermissions()
  let signature=String(describing:local) + "/" + configurationIssue(preferences) + "/" + String(describing:keyboardReservedKeys.sorted())
  let changed=signature != permissionSignature
  if changed || forceRegistration{monitorRecovery.reset()}
  let canRetry=preferences.enabled && !input.isMonitoring && recordingReply==nil && !isBusy &&
   missing.isEmpty && configurationIssue(preferences).isEmpty && !shortcutConflict && !IsSecureEventInputEnabled()
  if changed || monitorRecovery.canAttempt(at:ProcessInfo.processInfo.systemUptime,eligible:canRetry){
   permissionSignature=signature
   if recordingReply==nil{do{try register(preferences)}catch{registrationIssue=Self.friendly(error,language:language)}}
  }
  if (!overlays.isEmpty || task != nil || voicePending) && (IsSecureEventInputEnabled() || !selectionPermissions || (preferences.voiceEnabled && !voicePermissions)){cancel()}
  if viewState.phase == "需要权限"{updatePermissionPanel()}
 }
 func status()->[String:Any]{var object=(try? JSONSerialization.jsonObject(with:JSONEncoder().encode(preferences))) as? [String:Any] ?? [:]
  if var shortcut=object["shortcut"] as? [String:Any]{shortcut["label"]=preferences.shortcut.displayLabel(language:language);object["shortcut"]=shortcut}
  let account=try? preferences.configuration.credentialAccount()
  let local=observeLocalPermissions()
  let fresh=recentPermissionProbe
  let authorized=local.confirmingGrants(from:fresh)
  let missingGrants=authorized.missing(voice:preferences.voiceEnabled)
  let localPermissions=local.missing(voice:preferences.voiceEnabled).isEmpty
  let needsRelaunch=fresh.map{local.requiresRelaunch(fresh:$0,voice:preferences.voiceEnabled)} ?? false
  var value=authorized.dictionary
  let setup=LabSetupState.resolve(enabled:preferences.enabled,recording:recordingReply != nil,configured:configurationIssue(preferences).isEmpty,
   permissions:localPermissions,relaunch:needsRelaunch,conflict:shortcutConflict,secureInput:IsSecureEventInputEnabled(),monitorReady:input.isReady)
  value["ready"]=setup == .ready;value["setupState"]=setup.rawValue
  value.merge(["supported":true,"preferences":object,"hasKey":account.map(LabKeychain.has) ?? false,"shortcutRegistered":input.isMonitoring,"issue":LabText.text(registrationIssue,language:language),"phase":viewState.t(viewState.phase),"shortcutNotice":preferences.shortcut.binding.activationNotice(language:language),"configurationIssue":LabText.text(configurationIssue(preferences),language:language),"needsRelaunch":needsRelaunch,"missingPermissions":missingGrants,"shortcutConflict":shortcutConflict],uniquingKeysWith:{_,new in new})
  return value
 }
 func handle(_ body:[String:Any],reply:@escaping(Any?,String?)->Void){do{switch body["op"] as? String{
  case "language":guard let value=body["language"] as? String,["en","zh-CN"].contains(value) else{throw LabIssue("设置格式无效。")};updateLanguage(value == "en" ? .en:.zh);reply(status(),nil)
  case "status":pollPermissions();if !missing.isEmpty{probePermissions(force:true)};reply(status(),nil)
  case "refresh":refreshAuthorization();reply(status(),nil)
  case "relaunch":cancel();guard requestRelaunch?()==true else{throw LabIssue("请等待当前操作完成后，再重新打开。")};reply(["relaunching":true],nil)
  case "disableVoice":disableVoice();reply(status(),nil)
  case "save":
   guard let raw=body["preferences"],let data=try? JSONSerialization.data(withJSONObject:raw) else{throw LabIssue("设置格式无效。")}
   let next=try JSONDecoder().decode(LabPreferences.self,from:data);try next.shortcut.validate();let account=try next.configuration.credentialAccount()
   guard next.configuration.model.utf8.count<=256,!next.configuration.model.contains(where:{$0.isWhitespace}),(1...16384).contains(next.configuration.maximumOutputTokens) else{throw LabIssue("模型 ID 或输出上限无效。")}
   let newlyEnabled=(next.enabled && !preferences.enabled) || (next.voiceEnabled && !preferences.voiceEnabled);cancel();utilityTask?.cancel();do{try register(next)}catch{try? register(preferences);throw error}
   do{if let key=body["apiKey"] as? String,!key.isEmpty{try LabKeychain.write(key,account:account)};try persist(next)}catch{try? register(preferences);throw error}
   preferences=next;viewState.translationLanguage=next.translationLanguage;do{try register(next)}catch{registrationIssue=Self.friendly(error,language:language)};reply(status(),nil)
   if next.enabled && !configurationIssue(next).isEmpty{showSettings?()}
   else if next.enabled && newlyEnabled && !missing.isEmpty{showPermissionPanel()}
  case "recordShortcut":beginShortcutRecording(reply:reply)
  case "cancelRecording":cancelShortcutRecording();reply(status(),nil)
  case "deleteKey":cancel();utilityTask?.cancel();try LabKeychain.delete(preferences.configuration.credentialAccount());reply(status(),nil)
  case "permission":guard let id=body["permission"] as? String,["accessibility","inputMonitoring","screenRecording","microphone","speechRecognition"].contains(id) else{throw LabIssue("权限类型无效。")};requestPermission(id);reply(status(),nil)
  case "capture":startFromShortcut();reply(status(),nil)
  case "models","test":
   let configuration=preferences.configuration,key=try LabKeychain.read(configuration.credentialAccount()),models=body["op"] as? String == "models"
   utilityTask?.cancel();let utilityID=UUID();utilityGeneration=utilityID;utilityTask=Task{defer{if utilityGeneration==utilityID{utilityTask=nil}};do{if models{let page=try await AIClient().listModelCatalog(configuration:configuration,apiKey:key);try Task.checkCancellation();reply(["models":page.models.map(\.id),"hasMore":page.nextCursor != nil],nil)}else{var check=configuration;check.maximumOutputTokens=256;_ = try await AIClient().send(configuration:check,text:"Reply with OK only.",images:[],apiKey:key);try Task.checkCancellation();reply(["message":LabText.text("连接成功，模型已返回测试响应。",language:language)],nil)}}catch{reply(nil,Self.friendly(error,language:language))}}
  default:throw LabIssue("未知操作。")
  }}catch{reply(nil,Self.friendly(error,language:language))}
 }
 func requestPermission(_ id:String){
  permissionRecheckUntil=ProcessInfo.processInfo.systemUptime+180;nextProbe=0
  cancel();let open:(String)->Void={pane in NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?"+pane)!)}
  switch id {
   case "accessibility":_ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary);open("Privacy_Accessibility")
   case "inputMonitoring":_ = CGRequestListenEventAccess();open("Privacy_ListenEvent")
   case "screenRecording":_ = CGRequestScreenCaptureAccess();open("Privacy_ScreenCapture")
   case "microphone":if AVCaptureDevice.authorizationStatus(for:.audio) == .notDetermined{AVCaptureDevice.requestAccess(for:.audio){_ in}}else{open("Privacy_Microphone")}
   case "speechRecognition":if SFSpeechRecognizer.authorizationStatus() == .notDetermined{SFSpeechRecognizer.requestAuthorization{_ in}}else{open("Privacy_SpeechRecognition")}
   default:break
  }
 }
 private func updatePermissionPanel(){
  let local=observeLocalPermissions()
  let missingGrants=local.confirmingGrants(from:recentPermissionProbe).missing(voice:preferences.voiceEnabled)
  let issue:String
  if !missingGrants.isEmpty{issue=""}
  else if local.missing(voice:preferences.voiceEnabled).isEmpty{issue="权限已就绪，按快捷键重新框选。"}
  else{issue="系统授权已更新，请重新打开以完成检查。"}
  if viewState.missingPermissions != missingGrants{viewState.missingPermissions=missingGrants}
  if viewState.issue != issue{viewState.issue=issue}
 }
 private func showPermissionPanel(){cancel();viewState.phase="需要权限";updatePermissionPanel();panelAnchor=NSEvent.mouseLocation;showPanel()}
 private func beginShortcutRecording(reply:@escaping(Any?,String?)->Void){cancelShortcutRecording();cancel();recordingReply=reply;recordingChanged?(true);input.setEnabled(false);modifierRecorder=LabModifierRecorder();recordedShortcut=nil;sideRecorder.cancel();recordingTimer=Timer.scheduledTimer(withTimeInterval:15,repeats:false){[weak self] _ in MainActor.assumeIsolated{self?.cancelShortcutRecording()}}}
 func cancelShortcutRecording(){guard let reply=recordingReply else{return};recordingReply=nil;recordingTimer?.invalidate();recordingTimer=nil;recordedShortcut=nil;sideRecorder.cancel();recordingChanged?(false);try? register(preferences);reply(nil,LabText.text("已取消快捷键录制。",language:language))}
 private func finishShortcutRecording(_ shortcut:LabShortcut){guard let reply=recordingReply else{return};recordingReply=nil;recordingTimer?.invalidate();recordingTimer=nil;recordedShortcut=nil;sideRecorder.cancel()
  defer{recordingChanged?(false)}
  do{try shortcut.validate();guard !shortcut.conflictsWithKeyboard(keyboardReservedKeys) else{throw LabIssue("此按键正在用于 AI 键盘控制，请选择其他按键或带修饰键的组合。")};var next=preferences;next.shortcut=shortcut;try register(next);try persist(next);preferences=next;reply(status(),nil)}catch{try? register(preferences);reply(nil,Self.friendly(error,language:language))}
 }
 func consumeLocal(_ event:NSEvent)->Bool{
  if fileDragActive?() == true {return false}
  if event.type == .keyDown,event.keyCode==53,panel?.isVisible==true{cancel(animatePanel:true);return true}
  if recordingReply != nil{
   if event.type == .keyDown && event.keyCode==53{cancelShortcutRecording();return true}
   if sideRecorder.isHolding{return event.type == .keyDown || event.type == .keyUp || event.type == .flagsChanged}
   if event.type == .flagsChanged{if let chord=modifierRecorder.observe(LabShortcut.modifiers(event.modifierFlags)),recordedShortcut==nil{finishShortcutRecording(LabShortcut(keyCode:0,modifiers:chord,label:LabShortcut.label(code:0,modifiers:chord,only:true),modifierOnly:true))};return true}
   if event.type == .keyDown,!event.isARepeat{var flags=LabShortcut.modifiers(event.modifierFlags);if InputBinding.functionKeyCodes.contains(event.keyCode){flags &= ~(1<<23)};recordedShortcut=LabShortcut(keyCode:UInt32(event.keyCode),modifiers:flags,label:LabShortcut.label(code:event.keyCode,modifiers:flags))}
   if event.type == .keyUp,let shortcut=recordedShortcut,shortcut.keyCode==event.keyCode{finishShortcutRecording(shortcut)};return true
  }
  guard preferences.enabled,!shortcutConflict,preferences.shortcut.buttonIndex==nil,preferences.shortcut.modifierOnly != true,UInt32(event.keyCode)==preferences.shortcut.keyCode else{return false}
  if event.type == .keyUp,hold.keyboard{shortcutReleased();return true}
  var flags=LabShortcut.modifiers(event.modifierFlags);if InputBinding.functionKeyCodes.contains(event.keyCode){flags &= ~(1<<23)}
  guard event.type == .keyDown,flags==preferences.shortcut.modifiers else{return false};if !event.isARepeat{shortcutBegan()};return true
 }
 private func receiveInput(_ event:IntentPressEvent){
  guard event.source == .mouse else{
   switch event.edge{case .began:shortcutBegan();case .released:shortcutReleased();case .cancelled:cancel();case .moved:break};return
  }
  switch event.edge{
  case .began:
   guard let point=event.point,point.isFinite else{return}
   startFromShortcut(held:true)
   guard hold.keyboard,!overlays.isEmpty else{return}
   sidePrimaryTop=NSScreen.screens.first?.frame.maxY ?? 0
   let location=NSPoint(x:point.x,y:sidePrimaryTop-point.y)
   guard let window=overlays.first(where:{$0.frame.contains(location)}) else{cancel();return}
   let frame=window.frame
   sideSelection.begin(event.token,at:point,screen:IntentBounds(x:frame.minX,y:sidePrimaryTop-frame.maxY,width:frame.width,height:frame.height))
   for overlay in overlays{(overlay.contentView as? SelectionOverlayView)?.sideButtonSelection=true}
   selectionStarted()
  case .moved:
   guard sideSelection.token==event.token,let point=event.point else{return}
   sideSelection.move(point,token:event.token)
   let rectangle=sideSelection.bounds.map{LabSideGeometry.appKit($0,primaryTop:sidePrimaryTop)}
   for overlay in overlays{(overlay.contentView as? SelectionOverlayView)?.showSideRegion(rectangle)}
  case .released:
   guard sideSelection.token==event.token else{return}
   guard case .region(let bounds)=sideSelection.finish(event.token,at:event.point),bounds.isCapturableRegion else{cancel();return}
   selectionFinished(LabSideGeometry.appKit(bounds,primaryTop:sidePrimaryTop));shortcutReleased()
  case .cancelled:
   if sideSelection.token==event.token{cancel()}
  }
 }
 private func shortcutBegan(){guard !hold.keyboard else{return};startFromShortcut(held:true)}
 private func shortcutReleased(){if hold.releaseKeyboard(){commitSelection()};overlayFeedback()}
 private func startFromShortcut(held:Bool=false){
  guard fileDragActive?() != true else{return}
  guard preferences.enabled,!held || !shortcutConflict else{return};guard configurationIssue(preferences).isEmpty else{cancel();showSettings?();return};guard !IsSecureEventInputEnabled() else{return};guard missing.isEmpty else{showPermissionPanel();return}
  cancel();hold.keyboard=held;pendingAction=preferences.defaultAction;viewState.action=pendingAction
  for screen in NSScreen.screens {
   let window=SelectionOverlayWindow(contentRect:screen.frame,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
   window.isReleasedWhenClosed=false;window.isOpaque=false;window.backgroundColor = .clear;window.hasShadow=false;window.level = .screenSaver;window.hidesOnDeactivate=false;window.becomesKeyOnlyIfNeeded=false
   window.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];window.acceptsMouseMovedEvents=true
   let view=SelectionOverlayView(frame:NSRect(origin:.zero,size:screen.frame.size));let placement=LabNotchLayout.place(on:screen,width:320,height:120);view.topInset=screen.frame.maxY-placement.frame.maxY;view.cameraWidth=placement.cameraWidth;view.action=pendingAction;view.language=language;view.cancel={[weak self] in self?.cancel()};view.start={[weak self] in self?.selectionStarted()};view.invalid={[weak self] in self?.invalidSelection()};view.mode={[weak self] in guard let self else{return};self.pendingAction=self.pendingAction.stepped($0);self.viewState.action=self.pendingAction;self.overlayFeedback()}
   view.finish={[weak self] rect in self?.selectionFinished(NSRect(x:screen.frame.minX+rect.minX,y:screen.frame.minY+rect.minY,width:rect.width,height:rect.height))}
   window.contentView=view;overlays.append(window);window.orderFrontRegardless();if screen.frame.contains(NSEvent.mouseLocation){window.makeKey()}
  };viewState.phase="正在框选"
 }
 private func selectionStarted(){hold.mouse=true;hold.hasRegion=false;selectionRect=nil
  guard preferences.voiceEnabled,voiceToken==nil else{return};let token=generation;voiceDelay?.cancel();voiceDelay=Task{try? await Task.sleep(for:.milliseconds(350));guard !Task.isCancelled,self.generation==token,(self.hold.mouse || self.hold.keyboard) else{return};self.startVoice()}
 }
 private func invalidSelection(){hold.mouse=false;hold.hasRegion=false;selectionRect=nil;voiceDelay?.cancel();voiceDelay=nil;voice.cancel();voiceToken=nil;voicePending=false;speechStarted=false;viewState.question="";overlayFeedback(speech:"")}
 private func startVoice(){guard voicePermissions,!IsSecureEventInputEnabled(),voiceToken==nil else{return};voicePending=true;speechStarted=false;overlayFeedback()
  voice.start(onPrepared:{[weak self] token in self?.voiceToken=token})
 }
 private func selectionFinished(_ rectangle:NSRect){selectionRect=rectangle;if hold.releaseMouse(validRegion:true){commitSelection()}else{overlayFeedback()}}
 private func commitSelection(){
  guard let rectangle=selectionRect else{return};voiceDelay?.cancel();voiceDelay=nil
  if voicePending{if voice.phase == .authorizing{voice.cancel();voiceToken=nil;voicePending=false}else{voice.finish()}}
  capture(rectangle)
 }
 private func voiceResolved(_ token:UUID,_ result:InteractionTranscript){guard voiceToken==token else{return};voicePending=false;voiceToken=nil
  switch result{case .final(let text):viewState.question=text.trimmingCharacters(in:.whitespacesAndNewlines)
   case .partial(let text):viewState.question=text;speechFailed=true;viewState.issue=voice.issue ?? "语音未完整识别，请检查文字后发送。";viewState.showQuestion=true
   case .unavailable:speechFailed=true;viewState.issue=voice.issue ?? "语音暂不可用，请输入问题或选择翻译。";viewState.showQuestion=true
  };settleSelection()
 }
 private func overlayFeedback(speech:String?=nil){for window in overlays{guard let view=window.contentView as? SelectionOverlayView else{continue};view.action=pendingAction;view.listening=speechStarted;if let speech{view.speech=speech}}}
 private func capture(_ rectangle:NSRect){
  let token=generation;var excluded=Set(overlays.map{CGWindowID($0.windowNumber)})
  overlays.forEach{$0.orderOut(nil)};overlays=[]
  let top=NSScreen.screens.first?.frame.maxY ?? 0,bounds=IntentBounds(x:rectangle.minX,y:top-rectangle.maxY,width:rectangle.width,height:rectangle.height)
  guard bounds.isCapturableRegion else{cancel();return};panelAnchor=NSPoint(x:rectangle.midX,y:rectangle.midY);viewState.busy=true;viewState.phase="正在识别选区";showPanel();excluded.formUnion(surface?.windowIDs ?? [])
  task=Task{do{
   let captured=try await RegionCaptureService.capture(bounds,excludingWindowIDs:excluded);try Task.checkCancellation();guard generation==token else{return}
   imagePNG=captured.imagePNG;viewState.image=NSImage(data:captured.imagePNG);viewState.text=captured.text;viewState.canUseImage=preferences.configuration.imageInputConfirmed;viewState.includeImage=preferences.configuration.imageInputConfirmed
   viewState.destination="\(preferences.configuration.provider.rawValue) · \(preferences.configuration.model)";captureReady=true;task=nil;settleSelection()
  }catch{guard generation==token,!Task.isCancelled else{return};task=nil;voice.cancel();voiceToken=nil;voicePending=false;viewState.busy=false;viewState.issue=Self.friendly(error,language:language);viewState.phase="框选未完成"}}
 }
 private func settleSelection(){guard hold.committed,captureReady else{return};if voicePending{viewState.phase="正在完成语音转写";return};viewState.busy=false
  if speechFailed{return};send(pendingAction.submissionID(instruction:viewState.question))
 }
 private func switchAction(_ action:LabAction){guard captureReady else{return};voice.cancel();voiceToken=nil;voicePending=false;viewState.action=action;viewState.question="";viewState.showQuestion=false;speechFailed=false;cancelRequest();viewState.issue="";modeTask?.cancel();let token=generation;modeTask=Task{try? await Task.sleep(for:.milliseconds(280));guard !Task.isCancelled,self.generation==token else{return};self.send(action.rawValue)}}
 private func send(_ action:String){
  guard !viewState.busy,preferences.enabled,captureReady else{return}
  if action=="extract"{viewState.answer=viewState.text;viewState.issue="";return}
  let chosen:SelectionAction
  if let mode=LabAction(rawValue:action){chosen=mode.selectionAction(translationTarget:preferences.translationLanguage.englishName,instruction:mode == .reply ? viewState.question:"")}
  else{guard !viewState.question.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{return};chosen = viewState.action == .reply ? .reply(instruction:viewState.question):.ask(instruction:viewState.question)}
  guard !viewState.text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || (viewState.includeImage && imagePNG != nil) else{viewState.issue="没有识别到文字。图片提问需要在 API 设置中选择支持图片的模型。";return}
  let requestPreferences=preferences,requestLanguage=language
  let token=generation,configuration=preferences.configuration,content=SelectedContent(text:viewState.text,imagePNG:viewState.includeImage ? imagePNG:nil)
  let work=SelectionWork(sessionID:token,requestID:UUID(),content:content,action:chosen)
  viewState.busy=true;viewState.answer="";viewState.issue="";viewState.phase=viewState.action == .reply ? "正在回复":action=="ask" ? "正在回答":"正在\(viewState.action.title)"
  task=Task{do{
   guard !IsSecureEventInputEnabled(),selectionPermissions else{throw IntentServiceError.inactiveSession}
   let key=try LabKeychain.read(configuration.credentialAccount());let images:[AIImageAttachment]
   if work.includesImage,let png=work.content.imagePNG{let prepared=try await Task.detached{try ScreenshotNetworkImage.prepare(png:png)}.value;images=[.init(label:"Selected region",png:prepared)]}else{images=[]}
   try Task.checkCancellation();guard generation==token else{return};let prompt=try requestPreferences.prompt(for:work,language:requestLanguage)
   let result=try await AIClient().sendStreaming(configuration:configuration,prompt:prompt,images:images,apiKey:key){[weak self] event in if case .delta(let delta,_)=event{await self?.append(delta,token:token)}}
   try Task.checkCancellation();guard generation==token else{return};viewState.answer=result;viewState.phase="完成";viewState.busy=false;task=nil
  }catch{guard generation==token,!Task.isCancelled else{return};viewState.issue=Self.friendly(error,language:language);viewState.busy=false;viewState.phase="请求未完成";task=nil}}
 }
 private func append(_ delta:String,token:UUID){guard generation==token else{return};viewState.answer += delta}
 private func showPanel(){
  closingPanel=false
  if panel==nil{
   let p=SelectionResultPanel(contentRect:NSRect(x:0,y:0,width:185,height:24),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
   p.title=LabText.text("框选回答",language:language);p.isReleasedWhenClosed=false;p.hidesOnDeactivate=false;p.level=NSWindow.Level(rawValue:NSWindow.Level.statusBar.rawValue+1)
   p.minSize=NSSize(width:40,height:24);p.isMovableByWindowBackground=false;p.becomesKeyOnlyIfNeeded=true
   p.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];p.isOpaque=false;p.backgroundColor = .clear;p.hasShadow=false
   let host=SelectionHostingView(rootView:SelectionAnswerView(state:viewState));host.sizingOptions=[];p.contentView=host;p.delegate=self;panel=p;surface=SelectionNotchSurface(panel:p)
  }
  let screen=NSScreen.screens.first{$0.frame.contains(panelAnchor)} ?? NSScreen.main ?? NSScreen.screens.first
  panelScreenNumber=screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber;panelMeasurement=nil
  layoutPanel(animated:false);surface?.show()
 }
 private func resizePanel(_ measurement:LabAnswerMeasurement){
  guard !closingPanel,LabAnswerSizing.accepts(measurement,width:viewState.readingWidth) else{return}
  panelMeasurement=measurement
  guard panel?.isVisible==true else{return}
  layoutPanel(animated:true)
 }
 private var answerScreen:NSScreen?{NSScreen.screens.first(where:{($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)==panelScreenNumber}) ?? NSScreen.main}
 private func layoutPanel(animated:Bool){
  guard !closingPanel,let p=panel,let screen=answerScreen else{return}
  let metrics=LabNotchLayout.place(on:screen,width:10000,height:24)
  if viewState.maximumContentWidth != metrics.frame.width{viewState.maximumContentWidth=metrics.frame.width}
  let width=viewState.isCompact ? (metrics.hasCameraHousing ? metrics.cameraWidth:156):viewState.readingWidth
  let measured=panelMeasurement.flatMap{LabAnswerSizing.accepts($0,width:width) ? $0.height:nil}
  let height=viewState.isCompact ? 24:LabAnswerSizing.height(content:measured,expanded:viewState.expanded,fallback:max(LabAnswerSizing.minimumHeight,p.frame.height),chromeHeight:viewState.chromeHeight)
  let layout=LabNotchLayout.place(on:screen,width:width,height:height)
  let overflow = !viewState.isCompact && (measured ?? 0)>layout.frame.height-viewState.chromeHeight+1
  if viewState.contentOverflow != overflow{viewState.contentOverflow=overflow}
  if viewState.hasCameraHousing != layout.hasCameraHousing{viewState.hasCameraHousing=layout.hasCameraHousing}
  if viewState.contentWidth != layout.frame.width{viewState.contentWidth=layout.frame.width}
  surface?.place(layout,animated:animated)

 }
 private func cancelRequest(){generation=UUID();task?.cancel();task=nil;viewState.busy=false;viewState.phase="已停止"}
 func cancel(animatePanel:Bool=false){
  closingPanel=true
  if animatePanel,let screen=answerScreen{let metrics=LabNotchLayout.place(on:screen,width:185,height:24);let layout=LabNotchLayout.place(on:screen,width:metrics.hasCameraHousing ? metrics.cameraWidth:156,height:24);surface?.dismiss(to:layout)}else{surface?.hide()}
  generation=UUID();task?.cancel();task=nil;modeTask?.cancel();modeTask=nil;voiceDelay?.cancel();voiceDelay=nil;voice.cancel();voiceToken=nil;voicePending=false;speechFailed=false;speechStarted=false;hold=LabHoldState();sideSelection.cancel();selectionRect=nil;captureReady=false;overlays.forEach{$0.orderOut(nil)};overlays=[];imagePNG=nil
  panelScreenNumber=nil;panelMeasurement=nil;viewState.text="";viewState.image=nil;viewState.question="";viewState.answer="";viewState.issue="";viewState.busy=false;viewState.showQuestion=false;viewState.expanded=false;viewState.contentOverflow=false;viewState.missingPermissions=[];viewState.phase="等待框选"}
 func windowWillClose(_ notification:Notification){cancel()}
 static func friendly(_ error:Error,language:AppLanguage = .zh)->String{LabText.text(untranslated(error,language:language),language:language)}
 private static func untranslated(_ error:Error,language:AppLanguage)->String{
  if let error=error as? IntentServiceError{return error.message(language)};if error is CancellationError{return "已取消。"}
  if let error=error as? AIError{switch error{
   case .authentication:return "API Key 无效，或没有此模型的访问权限。"
   case .missingModel:return "请先在设置中选择或填写模型 ID。"
   case .imagesDisabled:return "当前模型尚未确认支持图片。请使用识别文字，或在设置中确认图片能力。"
   case .unsupportedEndpoint:return "此服务不支持自动读取模型，请在服务控制台复制模型 ID。"
   case .rateLimited:return "服务额度不足或请求过于频繁，请检查服务账户。"
   case .timedOut:return "请求超时，服务可能已计费。你可以手动重试。"
   case .network:return "暂时无法连接模型服务，请检查网络和 API 地址。"
   case .cancelled:return "已停止接收，服务可能已处理本次请求。"
   default:return error.localizedDescription
  }}
  if let issue=error as? LabIssue{return issue.message};return "操作未完成，请检查设置和权限后重试。"
 }

}
