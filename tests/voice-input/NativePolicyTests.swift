import AppKit
import Carbon

@main struct NativePolicyTests {
    @MainActor static func main() {
        var count = 0
        func check(_ condition: @autoclosure () -> Bool, _ title: String) {
            guard condition() else { fatalError("FAIL: \(title)") }
            count += 1
        }
        check(VoiceInsertionPolicy.expectedValue(original:"你好世界",range:CFRange(location:2,length:0),inserted:"新") == "你好新世界","insert into CJK field")
        check(VoiceInsertionPolicy.expectedValue(original:"a😀b",range:CFRange(location:1,length:2),inserted:"X") == "aXb","UTF16 selection replacement")
        check(VoiceInsertionPolicy.expectedValue(original:"old",range:CFRange(location:0,length:3),inserted:"new") == "new","selected full value")
        check(VoiceInsertionPolicy.expectedValue(original:"abc",range:CFRange(location:-1,length:0),inserted:"x") == nil,"reject negative location")
        check(VoiceInsertionPolicy.expectedValue(original:"abc",range:CFRange(location:2,length:2),inserted:"x") == nil,"reject overflowing selection")
        check(VoiceInsertionPolicy.expectedValue(original:"abc",range:CFRange(location:2,length:Int.max),inserted:"x") == nil,"reject integer overflow")
        check(VoiceInsertionPolicy.expectedValue(original:"abc",range:CFRange(location:3,length:0),inserted:"x") == "abcx","append at last position")
        check(VoiceInsertionPolicy.expectedValue(original:"a😀b",range:CFRange(location:2,length:0),inserted:"x") == nil,"do not split UTF16 surrogate pair")
        check(VoiceInsertionPolicy.sensitive(role:"AXTextField",subrole:"AXSecureTextField",protected:false),"secure subrole")
        check(VoiceInsertionPolicy.sensitive(role:"AXSecureTextField",subrole:nil,protected:false),"secure role")
        check(VoiceInsertionPolicy.sensitive(role:"AXTextArea",subrole:nil,protected:true),"protected attribute")
        check(!VoiceInsertionPolicy.sensitive(role:"AXTextArea",subrole:nil,protected:false),"normal text area")
        check(!VoiceInsertionPolicy.supportedRoles.contains("AXWebArea"),"unknown web container cannot auto insert")
        // Regression: a real text target remains eligible when optional AX text/range
        // accessors are absent. The old capture guard rejected these before paste.
        check(VoiceInsertionPolicy.editable(role:"AXTextArea",explicitlyEditable:false,selectedTextSettable:false),"WeChat/Electron text area does not require setter or readable value")
        check(VoiceInsertionPolicy.editable(role:"AXTextField",explicitlyEditable:false,selectedTextSettable:false),"browser text field does not require selected range")
        check(VoiceInsertionPolicy.editable(role:"AXGroup",explicitlyEditable:true,selectedTextSettable:false),"custom focused editor with explicit editing capability")
        check(VoiceInsertionPolicy.editable(role:"AXWebArea",explicitlyEditable:false,selectedTextSettable:true),"editable web content requires positive editing evidence")
        check(!VoiceInsertionPolicy.editable(role:"AXWebArea",explicitlyEditable:false,selectedTextSettable:false),"generic web page cannot receive automatic paste")
        check(!VoiceInsertionPolicy.editable(role:"AXButton",explicitlyEditable:false,selectedTextSettable:true),"nontext role cannot become a paste target")
        check(VoiceInsertionPolicy.compatibilityAllowed(bundleID:"com.tencent.xinWeChat",windowTitle:"微信",focusRole:nil),"WeChat opaque window supports guarded compatibility without AX focus")
        check(VoiceInsertionPolicy.compatibilityAllowed(bundleID:"com.tencent.xinWeChat",windowTitle:"微信",focusRole:"AXWindow"),"WeChat window placeholder supports compatibility")
        check(!VoiceInsertionPolicy.compatibilityAllowed(bundleID:"com.google.Chrome",windowTitle:nil,focusRole:nil),"opaque compatibility never broadens to other apps")
        check(!VoiceInsertionPolicy.compatibilityAllowed(bundleID:nil,windowTitle:nil,focusRole:nil),"missing bundle identity cannot use compatibility")
        check(!VoiceInsertionPolicy.compatibilityAllowed(bundleID:"com.tencent.xinWeChat",windowTitle:"登录微信",focusRole:nil),"known login window cannot use compatibility")
        check(!VoiceInsertionPolicy.compatibilityAllowed(bundleID:"com.tencent.xinWeChat",windowTitle:"Log In",focusRole:nil),"English login window cannot use compatibility")
        check(!VoiceInsertionPolicy.compatibilityAllowed(bundleID:"com.tencent.xinWeChat",windowTitle:"微信",focusRole:"AXButton"),"exposed WeChat button remains ineligible")
        check(!VoiceInsertionPolicy.compatibilityFocusChanged(originalAvailable:true,currentAvailable:false,sameElement:false),"temporary missing opaque focus is tolerated")
        check(!VoiceInsertionPolicy.compatibilityFocusChanged(originalAvailable:false,currentAvailable:true,sameElement:false),"newly exposed focus does not contradict absent original identity")
        check(VoiceInsertionPolicy.compatibilityFocusChanged(originalAvailable:true,currentAvailable:true,sameElement:false),"confirmed WeChat focus switch invalidates target")
        check(!VoiceInsertionPolicy.rangeChanged(nil,nil),"missing optional selection at both observations is not a change")
        check(!VoiceInsertionPolicy.valueChanged(nil,nil),"missing optional value is not a change")
        check(!VoiceInsertionPolicy.rangeChanged(CFRange(location:2,length:0),nil),"temporary unavailable selection is not a confirmed edit")
        check(!VoiceInsertionPolicy.valueChanged("draft",nil),"temporary unavailable value is not a confirmed edit")
        check(VoiceInsertionPolicy.rangeChanged(CFRange(location:2,length:0),CFRange(location:3,length:0)),"readable caret movement blocks insertion")
        check(VoiceInsertionPolicy.valueChanged("draft","draft changed"),"readable text change blocks insertion")
        check(!VoiceInsertionPolicy.invalidates(.unchanged),"duplicate AX value/focus notifications do not invalidate unchanged target")
        check(!VoiceInsertionPolicy.invalidates(.unavailable("focus_unavailable")),"transient AX failure is retried instead of permanently cancelling")
        check(!VoiceInsertionPolicy.invalidates(.changed("focus_changed")),"temporary focus change allows return before delivery")
        check(!VoiceInsertionPolicy.invalidates(.changed("selection_changed")),"selection is checked at delivery rather than invalidated forever")
        check(VoiceInsertionPolicy.releaseReady(modifiersDown:false,triggerDown:false),"unrelated stale pressed keys no longer veto a released shortcut")
        check(!VoiceInsertionPolicy.releaseReady(modifiersDown:true,triggerDown:false),"held modifier delays paste")
        check(!VoiceInsertionPolicy.releaseReady(modifiersDown:false,triggerDown:true),"held trigger delays paste")
        check(VoiceInsertionPolicy.allows(sameApplication:true,sameElement:true,sameWindow:true,sameRange:true,sameValue:true,invalidated:false,secure:false),"unchanged target allows insertion")
        for failure in 0..<7 {
            check(!VoiceInsertionPolicy.allows(sameApplication:failure != 0,sameElement:failure != 1,sameWindow:failure != 2,sameRange:failure != 3,sameValue:failure != 4,invalidated:failure == 5,secure:failure == 6),"guard rejects changed target factor \(failure)")
        }
        let controlOption = UInt64(NSEvent.ModifierFlags([.control,.option]).rawValue)
        check(VoiceInsertionPolicy.isTrigger(keyCode:49,modifiers:controlOption,triggerCode:49,triggerModifiers:controlOption),"second toggle is not treated as a user edit")
        check(!VoiceInsertionPolicy.isTrigger(keyCode:0,modifiers:controlOption,triggerCode:49,triggerModifiers:controlOption),"other keys invalidate target even with same modifiers")
        check(!VoiceInsertionPolicy.isTrigger(keyCode:49,modifiers:0,triggerCode:49,triggerModifiers:controlOption),"ordinary space still counts as editing")
        check(VoiceHotkeyPolicy.valid(keyCode:49,modifiers:controlOption),"default shortcut")
        check(VoiceHotkeyPolicy.valid(keyCode:0,modifiers:0),"single ordinary key supported")
        check(VoiceHotkeyPolicy.valid(keyCode:0,modifiers:UInt64(NSEvent.ModifierFlags.shift.rawValue)),"shift chord supported")
        check(VoiceHotkeyPolicy.valid(keyCode:55,modifiers:0),"single modifier tap supported")
        check(VoiceHotkeyPolicy.valid(keyCode:122,modifiers:0),"F1 can be standalone")
        check(!VoiceHotkeyPolicy.valid(keyCode:53,modifiers:controlOption),"Escape reserved for cancellation")
        check(!VoiceHotkeyPolicy.valid(keyCode:55,modifiers:controlOption),"modifier cannot be trigger key")
        check(!VoiceHotkeyPolicy.valid(keyCode:999,modifiers:controlOption),"invalid keycode")
        check(VoiceHotkey.label(keyCode:49,modifiers:controlOption) == "⌃⌥Space","stable shortcut display")
        let screen = NSRect(x:0,y:0,width:1512,height:982)
        let visible = NSRect(x:0,y:80,width:1512,height:870)
        let layout = VoiceNotchLayout.place(screen:screen,visible:visible,safeTop:32,left:NSRect(x:0,y:950,width:650,height:32),right:NSRect(x:862,y:950,width:650,height:32))
        check(layout.cap != nil,"notched display cap")
        check(layout.body.maxY == 950,"body below physical camera")
        check(layout.body.midX == screen.midX,"notch centered")
        check(layout.cap!.maxY == screen.maxY,"cap joins top edge")
        let plain = VoiceNotchLayout.place(screen:screen,visible:visible,safeTop:0,left:nil,right:nil)
        check(plain.cap == nil,"external screen no cap")
        check(plain.body.maxY == visible.maxY - 8,"external screen margin")
        let left = VoiceNotchLayout.place(screen:NSRect(x:-1920,y:0,width:1920,height:1080),visible:NSRect(x:-1920,y:0,width:1920,height:1055),safeTop:0,left:nil,right:nil)
        check(left.body.midX == -960,"secondary display negative coordinates")
        check(layout.body.height == 44 && layout.body.width == 220,"compact single-line notch")
        check(!VoiceNotchPhase.success.isVisible,"successful insertion hides notch immediately")
        check(VoiceNotchPhase.error.isVisible && VoiceNotchPhase.recording.isVisible,"recording and pending/error remain visible")
        check(!VoiceCapture.hasUsableSignal(duration:0.1,peakPower:-10),"reject accidental short trigger")
        check(!VoiceCapture.hasUsableSignal(duration:1,peakPower:-100),"reject digital silence")
        check(VoiceCapture.hasUsableSignal(duration:1,peakPower:-60),"retain very quiet audio")
        check(!VoiceCapture.hasUsableSignal(duration:1,peakPower:.nan),"reject invalid meter value")
        check(VoiceInsertionPolicy.invalidates(.changed("value_changed")),"editing draft permanently blocks stale automatic paste")
        check(!VoiceInsertionPolicy.invalidates(.changed("application_changed")),"switching away and back can recover before delivery")
        for phase in ["idle","done","error"] {
            check(VoiceSessionPolicy.action(phase:phase,preview:false,recordingShortcut:false) == .start,"start independent of focused editor in \(phase)")
        }
        check(VoiceSessionPolicy.action(phase:"recording",preview:false,recordingShortcut:false) == .stop,"second shortcut ends recording and selects destination")
        check(VoiceSessionPolicy.action(phase:"pending",preview:false,recordingShortcut:false) == .insertPending,"pending shortcut delivers existing result without new ASR")
        check(VoiceSessionPolicy.action(phase:"pending",preview:true,recordingShortcut:false) == .start,"explicit trial button can discard pending result and begin again")
        for phase in ["starting","transcribing","cleaning","inserting"] {
            check(VoiceSessionPolicy.action(phase:phase,preview:false,recordingShortcut:false) == .ignore,"no overlapping session during \(phase)")
        }
        for phase in ["starting","recording","transcribing","cleaning","inserting","pending"] {
            check(VoiceSessionPolicy.cancellable(phase),"Esc cancels \(phase)")
            check(VoiceSessionPolicy.action(phase:phase,preview:false,recordingShortcut:true) == .ignore,"shortcut recorder cannot trigger \(phase)")
        }
        check(!VoiceSessionPolicy.cancellable("done"),"completed insertion does not claim Esc")
        print("PASS \(count) native policy checks; no microphone, permissions, global shortcuts or pasteboard used.")
    }
}
