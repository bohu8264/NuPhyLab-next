import AppKit
import ApplicationServices

@main @MainActor struct ClipboardTests {
 static func main() async throws {
  let board=NSPasteboard(name:.init("local.nuphylab.voice.qa."+UUID().uuidString))
  defer {board.releaseGlobally()}
  var count=0
  func check(_ value:Bool,_ label:String){count+=1;precondition(value,label)}
  let insertion=VoiceInsertion(clipboard:board)
  let text="整理后的语音正文\nA second line, exactly as returned."
  board.clearContents();board.setString("prior fixture",forType:.string)
  let result=await insertion.insert(text:text,target:nil)
  if case .copied=result {check(true,"missing text field falls back to clipboard")}else{check(false,"missing text field falls back to clipboard")}
  check(board.string(forType:.string)==text,"exact Unicode and multiline result can be pasted")
  check(result.copiedToClipboard && VoiceNotchPhase.copied.isVisible,"copied notice remains visible briefly")
  check(result.message.contains("⌘V"),"clipboard fallback explains direct paste")
  let countBeforeEmpty=board.changeCount
  let empty=await insertion.insert(text:"  \n",target:nil)
  if case .manual=empty{check(true,"empty transcript not copied")}else{check(false,"empty transcript not copied")}
  check(board.changeCount==countBeforeEmpty,"empty result does not erase clipboard")
  let cancelled=Task { @MainActor in await insertion.insert(text:"cancelled result",target:nil) }
  cancelled.cancel();_=await cancelled.value
  check(board.changeCount==countBeforeEmpty,"cancelled session leaves existing clipboard alone")
  // A stale target never sends keystrokes. The token guard precedes all AX reads.
  let element=AXUIElementCreateApplication(getpid())
  let stale=VoiceTarget(pid:getpid(),element:element,window:element,range:nil,value:nil,compatibility:false,compatibilityFocus:nil,token:UUID(),screen:nil)
  let failed=await insertion.insert(text:"fallback after target changed",target:stale)
  if case .copied=failed {check(true,"invalid destination retains completed result")}else{check(false,"invalid destination retains completed result")}
  check(board.string(forType:.string)=="fallback after target changed","failed insertion is manually pasteable")
  board.clearContents();board.setString("user's newer copy",forType:.string)
  try await Task.sleep(nanoseconds:250_000_000)
  check(board.string(forType:.string)=="user's newer copy","no delayed restoration overwrites a newer clipboard")
  VoiceL10n.english=true
  check(VoiceL10n.text(result.message)=="Text copied to the clipboard. Press ⌘V to paste.","fallback localized")
  print("PASS \(count) clipboard fallback checks; isolated named pasteboard, no AX actions or key injection")
 }
}
