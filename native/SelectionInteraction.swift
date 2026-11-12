import AppKit
import Carbon
import SwiftUI

struct LabShortcut: Codable,Equatable {
 var keyCode:UInt32=12;var modifiers:UInt32=UInt32(optionKey|shiftKey);var label="⌥ ⇧ Q"
 var modifierOnly:Bool? = nil
 var buttonIndex:Int? = nil
 var binding:InputBinding {
  var flags:InputModifiers=[]
  if modifiers & UInt32(controlKey) != 0 { flags.insert(.control) }
  if modifiers & UInt32(optionKey) != 0 { flags.insert(.option) }
  if modifiers & UInt32(shiftKey) != 0 { flags.insert(.shift) }
  if modifiers & UInt32(cmdKey) != 0 { flags.insert(.command) }
  if modifiers & (1<<23) != 0 { flags.insert(.function) }
  if let buttonIndex { return .mouseButton(index:buttonIndex,modifiers:flags) }
  return modifierOnly == true ? .modifierChord(flags) : .keyboard(keyCode:UInt16(clamping:keyCode),modifiers:flags)
 }
 func conflictsWithKeyboard(_ reserved:Set<UInt32>)->Bool {buttonIndex == nil && modifierOnly != true && modifiers & UInt32(cmdKey|controlKey|optionKey|shiftKey)==0 && reserved.contains(keyCode)}
 func validate() throws {
  guard keyCode<=126,modifiers & ~(UInt32(cmdKey|controlKey|optionKey|shiftKey)|(1<<23))==0,!label.isEmpty,label.count<60 else{throw LabIssue("快捷键格式无效。")}
  if buttonIndex != nil {guard keyCode==0,modifierOnly != true else{throw LabIssue("快捷键格式无效。")}}
  if buttonIndex == nil,modifierOnly != true,[20,21,23].contains(keyCode),modifiers==UInt32(cmdKey|shiftKey){throw LabIssue("此组合用于系统截图，请选其他按键。")}
  if let issue=InputBindingPolicy.issue(for:binding){switch issue {
   case .escapeReserved:throw LabIssue("Esc 用于取消框选，请选其他按键。")
   case .capsLockToggle:throw LabIssue("Caps Lock 是锁定开关，请选择可按住的按键。")
   default:throw LabIssue("此组合由系统保留，请选其他按键或组合。")
  }}
 }
 var dragReservation:String? {buttonIndex == nil ? DragTrigger.selectionReservation(keyCode:keyCode,modifiers:modifiers,modifierOnly:modifierOnly == true) : nil}
 func displayLabel(language:AppLanguage)->String {buttonIndex == nil ? label : binding.label(language:language)}
 static func mouseButton(_ index:Int,modifiers:UInt32=0)->LabShortcut {
  var value=LabShortcut(keyCode:0,modifiers:modifiers,label:"Mouse",buttonIndex:index)
  value.label=value.binding.label(language:.zh);return value
 }
 static func modifiers(_ flags:NSEvent.ModifierFlags)->UInt32 {
  (flags.contains(.command) ? UInt32(cmdKey):0)|(flags.contains(.shift) ? UInt32(shiftKey):0)|(flags.contains(.option) ? UInt32(optionKey):0)|(flags.contains(.control) ? UInt32(controlKey):0)|(flags.contains(.function) ? (1<<23):0)
 }
 static func label(code:UInt16,modifiers:UInt32,only:Bool=false)->String {
  let letters:[UInt16:String]=[0:"A",1:"S",2:"D",3:"F",4:"H",5:"G",6:"Z",7:"X",8:"C",9:"V",11:"B",12:"Q",13:"W",14:"E",15:"R",16:"Y",17:"T",31:"O",32:"U",34:"I",35:"P",37:"L",38:"J",40:"K",45:"N",46:"M",49:"Space"]
  let prefix=[modifiers & UInt32(controlKey) != 0 ? "⌃":"",modifiers & UInt32(optionKey) != 0 ? "⌥":"",modifiers & UInt32(shiftKey) != 0 ? "⇧":"",modifiers & UInt32(cmdKey) != 0 ? "⌘":"",modifiers & (1<<23) != 0 ? "Fn":""].filter{!$0.isEmpty}
  return (prefix+(only ? []:[letters[code] ?? InputBinding.keyLabel(code)])).joined(separator:" ")
 }
}
enum LabSideGeometry {
 static func appKit(_ bounds:IntentBounds,primaryTop:CGFloat)->NSRect {
  NSRect(x:bounds.x,y:primaryTop-bounds.y-bounds.height,width:bounds.width,height:bounds.height)
 }
}

/// Records only side buttons (macOS indices 3...31). A consumed press owns
/// its release even after cancellation, including duplicate standard/NX events.
/// It never installs a tap or changes any mouse driver settings.
struct LabSideButtonRecorder {
 private var index:Int?
 private var down=false
 private var representations=Set<Int>()
 private var lastTimestamp:TimeInterval=0
 private var pending:LabShortcut?
 var isHolding:Bool {down && pending != nil}
 mutating func cancel(){pending=nil}
 private mutating func edge(_ button:Int,pressed:Bool,representation:Int,time:TimeInterval,modifiers:UInt32,capturing:Bool)->(Bool,LabShortcut?) {
  guard (3...31).contains(button) else{return (false,nil)}
  if index==button {
   if !pressed {
    let result=down && capturing ? pending:nil
    down=false;pending=nil;lastTimestamp=max(lastTimestamp,time)
    return (true,result)
   }
   // One physical press may arrive through both macOS representations.
   if down && (!representations.contains(representation) || time<=lastTimestamp) {
    representations.insert(representation);lastTimestamp=max(lastTimestamp,time);return (true,nil)
   }
   if !down && time<=lastTimestamp {return (true,nil)}
   index=nil;down=false;pending=nil;representations=[]
  }
  guard capturing,index==nil || !down,pressed else{return (false,nil)}
  index=button;down=true;representations=[representation];lastTimestamp=time
  pending=LabShortcut.mouseButton(button,modifiers:modifiers)
  return (true,nil)
 }
 mutating func receive(_ event:NSEvent,capturing:Bool)->(event:NSEvent?,shortcut:LabShortcut?) {
  let modifiers=LabShortcut.modifiers(event.modifierFlags)
  switch event.type {
  case .otherMouseDown,.otherMouseUp:
   let result=edge(event.buttonNumber,pressed:event.type == .otherMouseDown,representation:0,time:event.timestamp,modifiers:modifiers,capturing:capturing)
   return (result.0 ? nil:event,result.1)
  case .otherMouseDragged:
   return (index==event.buttonNumber && down ? nil:event,nil)
  case .systemDefined:
   guard event.subtype.rawValue==7,let changed=Self.mask(event.data1),let state=Self.mask(event.data2),changed != 0 else{return (event,nil)}
   var suppressed:UInt32=0;var shortcut:LabShortcut?
   for button in 3..<32 where changed & (UInt32(1)<<button) != 0 {
    let result=edge(button,pressed:state & (UInt32(1)<<button) != 0,representation:1,time:event.timestamp,modifiers:modifiers,capturing:capturing && shortcut==nil)
    if result.0 {suppressed |= UInt32(1)<<button};if let value=result.1 {shortcut=value}
   }
   let remaining=changed & ~suppressed
   if remaining==0 {return (nil,shortcut)}
   var owned=suppressed;if down,let index {owned |= UInt32(1)<<index}
   guard suppressed != 0 || state & owned != 0 else{return (event,shortcut)}
   // Preserve simultaneous left/right/middle and other side-button changes.
   let replacement=NSEvent.otherEvent(with:.systemDefined,location:event.locationInWindow,modifierFlags:event.modifierFlags,timestamp:event.timestamp,windowNumber:event.windowNumber,context:nil,subtype:7,data1:Int(remaining),data2:Int(state & ~owned))
   return (replacement ?? event,shortcut)
  default:return (event,nil)
  }
 }
 private static func mask(_ value:Int)->UInt32? {
  if let value=UInt32(exactly:value){return value}
  return Int32(exactly:value).map{UInt32(bitPattern:$0)}
 }
}

enum LabAction:String,Codable,CaseIterable {case translate,summarize,explain,reply
 var title:String{switch self{case .translate:return "翻译";case .summarize:return "总结";case .explain:return "解释";case .reply:return "回复"}}
 func title(in language:AppLanguage)->String{LabText.text(title,language:language)}
 func submissionID(instruction:String)->String{self == .reply || instruction.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? rawValue:"ask"}
 func selectionAction(translationTarget:String,instruction:String="")->SelectionAction {
  let base:SelectionAction
  switch self{case .translate:base = .translate(targetLanguage:translationTarget);case .summarize:base = .summarize;case .explain:base = .explain;case .reply:base = .reply(instruction:"")}
  return base.applyingInstruction(instruction)
 }
 func stepped(_ direction:Int)->LabAction{let all=Self.allCases;return all[((all.firstIndex(of:self) ?? 0)+direction+all.count)%all.count]}
}
struct LabModifierRecorder {
 var accumulated:UInt32=0
 mutating func observe(_ mask:UInt32)->UInt32? {
  if mask != 0{accumulated |= mask;return nil}
  guard accumulated != 0 else{return nil};let chord=accumulated;accumulated=0;return chord
 }
}
struct LabPreferences:Codable {
 var enabled=false;var shortcut=LabShortcut();var configuration=AIConfiguration();var voiceEnabled=false;var defaultAction=LabAction.translate
 var translationLanguage=LabTranslationLanguage.simplifiedChinese
 var translationAction:SelectionAction{.translate(targetLanguage:translationLanguage.englishName)}
 func prompt(for work:SelectionWork,language:AppLanguage)throws->AIRequestPrompt {
  try work.prompt(outputLanguage:language == .en ? "English":"Simplified Chinese",translationTargetLanguage:translationLanguage.englishName)
 }
 enum CodingKeys:String,CodingKey{case enabled,shortcut,configuration,voiceEnabled,defaultAction,translationLanguage}
 init(){}
 init(from decoder:Decoder)throws{let c=try decoder.container(keyedBy:CodingKeys.self);enabled=try c.decodeIfPresent(Bool.self,forKey:.enabled) ?? false;shortcut=try c.decodeIfPresent(LabShortcut.self,forKey:.shortcut) ?? LabShortcut();configuration=try c.decodeIfPresent(AIConfiguration.self,forKey:.configuration) ?? AIConfiguration();voiceEnabled=try c.decodeIfPresent(Bool.self,forKey:.voiceEnabled) ?? false;defaultAction=try c.decodeIfPresent(LabAction.self,forKey:.defaultAction) ?? .translate;translationLanguage=try c.decodeIfPresent(LabTranslationLanguage.self,forKey:.translationLanguage) ?? .simplifiedChinese}
}
/// Gates submission on an actual region and the last held input. A shortcut tap
/// arms mouse selection; a release during drag waits for the mouse release.
struct LabHoldState {
 var keyboard=false;var mouse=false;var hasRegion=false;var committed=false
 mutating func releaseKeyboard()->Bool{keyboard=false;return commitIfReady()}
 mutating func releaseMouse(validRegion:Bool)->Bool{mouse=false;hasRegion=validRegion;return commitIfReady()}
 private mutating func commitIfReady()->Bool{guard hasRegion,!keyboard,!mouse,!committed else{return false};committed=true;return true}
}
struct LabWheelState {
 var last:TimeInterval = -.infinity;var total:CGFloat=0
 mutating func step(delta:CGFloat,precise:Bool,momentum:Bool,time:TimeInterval)->Int? {
  guard !momentum,delta.isFinite,delta != 0 else{return nil}
  if time-last>0.5{total=0};total += delta
  guard time-last>=0.18,abs(total)>=(precise ? 14:1) else{return nil}
  let step=total>0 ? -1:1;last=time;total=0;return step
 }
}
@MainActor final class SelectionPanelState:ObservableObject {
 @Published var language=AppLanguage.zh
 @Published var translationLanguage=LabTranslationLanguage.simplifiedChinese
 func t(_ text:String)->String{LabText.text(text,language:language)}
 @Published var text="";@Published var image:NSImage?;@Published var question="";@Published var answer=""{didSet{answerBlocks=LabAnswerMarkdown.blocks(answer)}};@Published var issue=""
 @Published private(set) var answerBlocks:[LabMarkdownBlock]=[]
 @Published var busy=false;@Published var includeImage=false;@Published var canUseImage=false;@Published var destination="";@Published var phase="等待框选"
 @Published var hasCameraHousing=false;@Published var contentWidth:CGFloat=340;@Published var maximumContentWidth:CGFloat=10000;@Published var expanded=false;@Published var contentOverflow=false
 var isCompact:Bool{busy && answer.isEmpty && issue.isEmpty && missingPermissions.isEmpty && !showQuestion}
 var readingWidth:CGFloat{LabAnswerSizing.width(expanded:expanded,available:maximumContentWidth)}
 var modeTitle:String{action == .reply || (question.isEmpty && !showQuestion) ? action.title(in:language):t("提问")}
 var questionAction:String{action == .reply ? "reply":"ask"}
 var questionPlaceholder:String{t(action == .reply ? "希望怎么回复…":"继续提问…")}
 var questionLabel:String{t(action == .reply ? "调整回复":"继续提问")}
 var submitLabel:String{t(action == .reply ? "生成回复":"发送问题")}
 var showsTranslationLanguage:Bool{missingPermissions.isEmpty && action == .translate && !showQuestion && question.isEmpty && !isCompact}
 var chromeHeight:CGFloat{LabAnswerSizing.chromeHeight+(showsTranslationLanguage ? 24:0)}
 var chooseTranslationLanguage:((LabTranslationLanguage)->Void)?
 var beginTyping:(()->Void)?;var expansion:(()->Void)?
 @Published var action=LabAction.translate;@Published var missingPermissions:[String]=[];@Published var showQuestion=false
 var disableVoice:(()->Void)?;var submit:((String)->Void)?;var cancel:(()->Void)?;var close:(()->Void)?;var reselect:(()->Void)?;var settings:(()->Void)?;var permission:((String)->Void)?;var size:((LabAnswerMeasurement)->Void)?;var switchAction:((LabAction)->Void)?
}
final class SelectionOverlayWindow:NSPanel{override var canBecomeKey:Bool{true};override var canBecomeMain:Bool{false}}
final class SelectionResultPanel:NSPanel{override var canBecomeKey:Bool{true};override var canBecomeMain:Bool{false}}
final class SelectionHostingView<Content:View>:NSHostingView<Content>{override func acceptsFirstMouse(for event:NSEvent?)->Bool{true}}
final class SelectionOverlayView:NSView{
 var language=AppLanguage.zh{didSet{needsDisplay=true}}
 var invalid:(()->Void)?;var finish:((NSRect)->Void)?;var start:(()->Void)?;var cancel:(()->Void)?;var mode:((Int)->Void)?
 var action=LabAction.translate{didSet{needsDisplay=true}};var speech=""{didSet{needsDisplay=true}}
 var sideButtonSelection=false
 func showSideRegion(_ global:NSRect?){
  guard let global,let window else{rectangle = .zero;needsDisplay=true;return}
  let local=NSRect(x:global.minX-window.frame.minX,y:global.minY-window.frame.minY,width:global.width,height:global.height).intersection(bounds)
  rectangle=local.isNull ? .zero:local;needsDisplay=true
 }
 var topInset:CGFloat=0;var cameraWidth:CGFloat=0;var listening=false{didSet{needsDisplay=true}}
 private var origin:NSPoint?;private var rectangle:NSRect = .zero;private var wheel=LabWheelState()
 private var reveal:CGFloat=1;private var revealTimer:Timer?
 override var acceptsFirstResponder:Bool{true}
 override func acceptsFirstMouse(for event:NSEvent?)->Bool{true}
 override func viewDidMoveToWindow(){
  revealTimer?.invalidate();window?.makeFirstResponder(self)
  guard window != nil,!NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else{reveal=1;return}
  reveal=0;let began=ProcessInfo.processInfo.systemUptime
  let timer=Timer(timeInterval:1/60,repeats:true){[weak self] timer in
   guard let self,self.window?.isVisible==true else{timer.invalidate();return}
   let fraction=min(1,(ProcessInfo.processInfo.systemUptime-began)/0.22)
   self.reveal=1-pow(1-fraction,3);self.needsDisplay=true
   if fraction>=1{timer.invalidate();self.revealTimer=nil}
  };revealTimer=timer;RunLoop.main.add(timer,forMode:.common)
 }
 deinit{revealTimer?.invalidate()}
 override func resetCursorRects(){addCursorRect(bounds,cursor:.crosshair)}
 override func keyDown(with event:NSEvent){if event.keyCode==53{cancel?()}}
 override func mouseDown(with event:NSEvent){guard !sideButtonSelection else{return};window?.makeKey();origin=convert(event.locationInWindow,from:nil);rectangle = .zero;start?();needsDisplay=true}
 override func mouseDragged(with event:NSEvent){guard !sideButtonSelection,let start=origin else{return};let end=convert(event.locationInWindow,from:nil);rectangle=NSRect(x:min(start.x,end.x),y:min(start.y,end.y),width:abs(end.x-start.x),height:abs(end.y-start.y)).intersection(bounds);needsDisplay=true}
 override func mouseUp(with event:NSEvent){guard !sideButtonSelection else{return};mouseDragged(with:event);guard rectangle.width>=8,rectangle.height>=8 else{origin=nil;rectangle = .zero;needsDisplay=true;invalid?();return};finish?(rectangle)}
 override func rightMouseDown(with event:NSEvent){cancel?()}
 override func scrollWheel(with event:NSEvent){if let direction=wheel.step(delta:event.scrollingDeltaY,precise:event.hasPreciseScrollingDeltas,momentum:!event.momentumPhase.isEmpty,time:event.timestamp){mode?(direction)}}
 override func draw(_ dirtyRect:NSRect){
  NSColor.black.withAlphaComponent(0.18).setFill();bounds.fill()
  if !rectangle.isEmpty{NSColor.clear.setFill();rectangle.fill(using:.copy);let border=NSBezierPath(roundedRect:rectangle,xRadius:5,yRadius:5);NSColor.black.withAlphaComponent(0.3).setStroke();border.lineWidth=4;border.stroke();NSColor(white:0.88,alpha:1).setStroke();border.lineWidth=1.5;border.stroke()
   for point in [NSPoint(x:rectangle.minX,y:rectangle.minY),NSPoint(x:rectangle.maxX,y:rectangle.minY),NSPoint(x:rectangle.minX,y:rectangle.maxY),NSPoint(x:rectangle.maxX,y:rectangle.maxY)]{NSColor.white.setFill();NSBezierPath(roundedRect:NSRect(x:point.x-3,y:point.y-3,width:6,height:6),xRadius:2,yRadius:2).fill()}}
  let width=min(bounds.width-32,cameraWidth>0 ? cameraWidth:156)
  let height:CGFloat=24,top=bounds.height-topInset
  let box=NSRect(x:bounds.midX-width/2,y:top-height*reveal,width:width,height:height*reveal)
  NSColor.black.setFill()
  if cameraWidth>0 {
   let s=LabNotchLayout.shoulder,cap=NSRect(x:box.minX-s,y:top,width:width+2*s,height:topInset)
   SelectionNotchCapView.path(in:cap,shoulder:s).fill()
  }
  if let context=NSGraphicsContext.current?.cgContext{context.addPath(LabNotchStyle.bodyPath(in:box,camera:cameraWidth>0,flipped:false));context.fillPath()}
  guard reveal>0.7 else{return}
  let title=(action == .reply || speech.isEmpty ? action.title(in:language):LabText.text("提问",language:language)) as NSString
  let attrs:[NSAttributedString.Key:Any]=[.font:NSFont.systemFont(ofSize:12,weight:.medium),.foregroundColor:NSColor.white.withAlphaComponent(0.88)]
  let size=title.size(withAttributes:attrs)
  title.draw(at:NSPoint(x:box.midX-size.width/2,y:box.midY-size.height/2),withAttributes:attrs)

 }
}
