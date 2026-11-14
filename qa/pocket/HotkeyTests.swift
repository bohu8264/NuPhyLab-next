import Foundation
import CoreGraphics

@main
@MainActor
struct HotkeyTests {
    static var checks = 0
    static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        checks += 1
        if try !condition() { throw NSError(domain:"HotkeyTests", code:checks, userInfo:[NSLocalizedDescriptionKey:message]) }
    }
    static func rejects(_ message: String, _ block: () throws -> Void) throws {
        do { try block() } catch { checks += 1; return }
        throw NSError(domain:"HotkeyTests", code:-1, userInfo:[NSLocalizedDescriptionKey:"Expected rejection: " + message])
    }
    static func main() throws {
        // Exercise the actual asynchronous dispatcher without a system tap,
        // clipboard or synthetic keystrokes. No activation notification is sent.
        var front:pid_t?=101
        var permitted=true
        var queued=[()->Void]()
        var deliveries=[String]()
        func enqueue(_ action:String="use") {
            PocketSlotDispatch.enqueue(action:action,index:2,originPID:front,currentPID:{front},permitted:{permitted},
                deliver:{action,index,pid in deliveries.append("\(action):\(index):\(pid)")},schedule:{queued.append($0)})
        }
        enqueue();front=202;queued.removeFirst()()
        try expect(deliveries.isEmpty,"queued retrieve must not follow A-to-B app switch before callback")
        front=101;enqueue("capture");front=nil;queued.removeFirst()()
        try expect(deliveries.isEmpty,"queued capture cancels when original application disappears")
        front=101;enqueue();permitted=false;queued.removeFirst()()
        try expect(deliveries.isEmpty,"queued action still honors changed generation or authorization")
        permitted=true;enqueue();queued.removeFirst()()
        try expect(deliveries==["use:2:101"],"unchanged origin retains action and slot")
        front=nil;enqueue()
        try expect(queued.isEmpty,"no foreground at recognition cannot later acquire a target")

        for (names,flags) in [(["control"],CGEventFlags.maskControl),(["option"],.maskAlternate),(["fn"],.maskSecondaryFn),(["control","shift"],[.maskControl,.maskShift])] {
            var repeatSettings=PocketSettings();repeatSettings.enabled=true;repeatSettings.useModifiers=names;repeatSettings.captureModifiers=["command","option","shift"]
            var repeatMatcher=PocketSlotMatcher();try repeatMatcher.configure(repeatSettings)
            for _ in 0..<40 {
                try expect(repeatMatcher.handle(.flagsChanged,flags:flags).preview == .show("use"),"Every fresh prefix press opens preview after previous release")
                try expect(repeatMatcher.handle(.flagsChanged,flags:[]).preview == .hide,"Each release hides exactly its own preview")
            }
        }
        let fresh = PocketSettings()
        try expect(!fresh.enabled && fresh.previewEnabled, "new installs default OFF with preview preference ON")
        try expect(fresh.slotOrder == Array(0..<9) && fresh.useTriggerKeyCode == nil && fresh.captureTriggerKeyCode == nil, "new prefix and order defaults")
        var defaults = fresh
        defaults.enabled = true
        try defaults.validate()
        try expect(defaults.useModifiers == ["fn"] && defaults.captureModifiers == ["fn","shift"], "default independent Fn mappings")
        try expect(defaults.slotKeyCodes == [18,19,20,21,23,22,26,28,25], "hardware digit keycode order")
        try expect(defaults.slotKeyNames == (1...9).map(String.init), "physical digit display names")
        try expect(defaults.dictionary["slotKeyCodes"] as? [Int] == defaults.slotKeyCodes.map(Int.init), "JSON bridge keycodes")
        try expect(defaults.dictionary["retainDays"] as? Int == 0, "all preferences exposed")

        let legacy = Data(#"{"enabled":false,"shortcut":"commandShift","clearAfterUse":true,"plainText":true,"sequential":true,"sequenceIndex":7,"retainDays":30}"#.utf8)
        let migrated = try JSONDecoder().decode(PocketSettings.self, from:legacy)
        try expect(!migrated.enabled && migrated.shortcut == "commandShift", "legacy enabled and panel shortcut preserved")
        try expect(migrated.clearAfterUse && migrated.plainText && migrated.sequential && migrated.sequenceIndex == 7 && migrated.retainDays == 30, "legacy preferences preserved")
        try expect(migrated.useModifiers == ["fn"] && migrated.captureModifiers == ["fn","shift"], "new modifier fields migrated independently")
        try expect(migrated.slotKeyCodes == defaults.slotKeyCodes, "new slot fields default without erasing preferences")
        let empty = try JSONDecoder().decode(PocketSettings.self, from:Data("{}".utf8))
        try expect(!empty.enabled && empty.previewEnabled && empty.slotKeyCodes == defaults.slotKeyCodes, "empty legacy object defaults safely OFF")
        let enabledLegacy = try JSONDecoder().decode(PocketSettings.self, from:Data(#"{"enabled":true}"#.utf8))
        try expect(enabledLegacy.enabled, "saved ON value survives migration")
        let partial = try JSONDecoder().decode(PocketSettings.self, from:Data(#"{"useModifiers":["command"],"plainText":true}"#.utf8))
        try expect(partial.useModifiers == ["command"] && partial.captureModifiers == ["fn","shift"] && partial.plainText, "one new field does not replace another")
        for field in ["useModifiers", "captureModifiers", "slotKeyCodes"] {
            let corrupted = try JSONDecoder().decode(PocketSettings.self, from:Data("{\"\(field)\":true,\"plainText\":true}".utf8))
            try expect(corrupted.plainText, "invalid new field still preserves older preferences")
            try rejects("present malformed shortcut data must not silently rebind") { try corrupted.validate() }
        }
        let roundTrip = try JSONDecoder().decode(PocketSettings.self, from:JSONEncoder().encode(migrated))
        try expect(roundTrip.dictionary as NSDictionary == migrated.dictionary as NSDictionary, "Codable retains every preference")

        var changed = defaults
        changed.apply(["useModifiers":[" COMMAND ","option"]])
        try changed.validate()
        try expect(changed.useModifiers == ["command","option"] && changed.captureModifiers == defaults.captureModifiers, "apply use independently and normalize")
        changed.apply(["captureModifiers":["control","shift"]])
        try changed.validate()
        try expect(changed.useModifiers == ["command","option"] && changed.captureModifiers == ["control","shift"], "apply capture independently")
        changed.apply(["slotKeyCodes":[0,1,2,3,4,5,6,7,8], "slotKeyNames":["injected name"]])
        try changed.validate()
        try expect(changed.slotKeyCodes == [0,1,2,3,4,5,6,7,8] && changed.slotKeyNames[0] == "A", "shared mapping accepts real keycodes and derives names")
        var retain = migrated
        retain.apply(["plainText":false])
        try expect(retain.retainDays == 30 && retain.sequenceIndex == 7 && retain.clearAfterUse, "independent old preference edits preserve others")

        for field in ["useModifiers","captureModifiers"] {
            for value: Any in [[], ["bogus"], ["fn","fn"], "fn", NSNull()] {
                var invalid = defaults
                invalid.apply([field:value])
                try rejects("invalid modifier field \(field)") { try invalid.validate() }
            }
        }
        var same = defaults
        same.useModifiers = ["fn","shift"]
        same.captureModifiers = ["shift","fn"]
        try rejects("same sets independent of ordering") { try same.validate() }
        for key in PocketSettings.implicitFunctionKeys {
            var aliased=defaults
            aliased.useModifiers=[];aliased.captureModifiers=["fn"]
            aliased.useTriggerKeyCode=key;aliased.captureTriggerKeyCode=key
            try rejects("implicit Fn cannot select different actions for a function/arrow prefix") { try aliased.validate() }
            aliased.captureModifiers=["shift"]
            try aliased.validate()
            try expect(aliased.captureModifiers==["shift"],"explicit unrelated modifier distinguishes function key")
            aliased.useTriggerKeyCode=nil;aliased.captureTriggerKeyCode=nil
            aliased.useModifiers=["control"];aliased.captureModifiers=["control","fn"];aliased.slotKeyCodes[0]=key
            try rejects("implicit Fn slot cannot select different modifier-only actions") { try aliased.validate() }
        }
        let badCodes: [[Any]] = [[], [18,19], [18,18,20,21,23,22,26,28,25], [-1,19,20,21,23,22,26,28,25],
                                 [65536,19,20,21,23,22,26,28,25], [18.5,19,20,21,23,22,26,28,25], [true,19,20,21,23,22,26,28,25],
                                 ["18",19,20,21,23,22,26,28,25], [NSNull(),19,20,21,23,22,26,28,25], [52,19,20,21,23,22,26,28,25],
                                 [63,19,20,21,23,22,26,28,25], [57,19,20,21,23,22,26,28,25], [127,19,20,21,23,22,26,28,25]]
        for codes in badCodes {
            var invalid = defaults
            invalid.apply(["slotKeyCodes":codes])
            try rejects("invalid physical keycodes") { try invalid.validate() }
        }
        for panel in ["controlOption","controlShift","commandShift"] {
            for code: UInt16 in [1,9,49] {
                for capture in [false,true] {
                    var conflict = defaults
                    conflict.shortcut = panel
                    conflict.slotKeyCodes[0] = code
                    if capture { conflict.captureModifiers = conflict.panelModifiers }
                    else { conflict.useModifiers = conflict.panelModifiers }
                    try conflict.validate()
                    try expect(conflict.slotKeyCodes[0] == code,"unregistered legacy panel chord remains available")
                }
            }
        }

        var matcher = PocketSlotMatcher()
        try matcher.configure(defaults)
        try expect(!matcher.functionObserved, "configuration does not claim Fn support")
        try expect(matcher.handle(.keyDown,keyCode:122,flags:.maskSecondaryFn).action == nil, "hardware Fn-to-F1 never becomes digit one")
        _ = matcher.handle(.keyUp,keyCode:122)
        try expect(!matcher.functionObserved, "F1 implicit function flag is not Fn observation")
        _ = matcher.handle(.flagsChanged,flags:.maskShift)
        try expect(!matcher.functionObserved, "unrelated modifiers do not observe Fn")
        _ = matcher.handle(.flagsChanged,flags:.maskSecondaryFn)
        try expect(matcher.functionObserved, "real Fn flagsChanged observes function")
        for (index, code) in defaults.slotKeyCodes.enumerated() {
            let use = matcher.handle(.keyDown,keyCode:code,flags:.maskSecondaryFn)
            try expect(use.swallow && use.action == "use" && use.index == index, "Fn digit uses exact slot")
            try expect(matcher.handle(.keyDown,keyCode:code,flags:.maskSecondaryFn,isRepeat:true) == .init(swallow:true), "claimed repeats swallowed without actions")
            try expect(matcher.handle(.keyDown,keyCode:code,flags:[],isRepeat:true) == .init(swallow:true), "releasing modifier while holding keeps repeat suppressed")
            _ = matcher.handle(.flagsChanged,flags:[])
            try expect(matcher.handle(.keyUp,keyCode:code,flags:[]).swallow, "matching keyup swallowed after modifier release")
            try expect(!matcher.handle(.keyUp,keyCode:code,flags:[]).swallow, "later unclaimed keyup passes")
            let capture = matcher.handle(.keyDown,keyCode:code,flags:[.maskSecondaryFn,.maskShift])
            try expect(capture == .init(swallow:true,action:"capture",index:index), "Fn shift digit captures exact slot")
            try expect(matcher.handle(.keyUp,keyCode:code).swallow, "capture keyup swallowed")
            try expect(matcher.handle(.keyDown,keyCode:code,flags:[]) == .init(), "ordinary digit untouched")
            try expect(!matcher.handle(.keyUp,keyCode:code).swallow, "ordinary digit keyup untouched")
        }
        try expect(matcher.handle(.keyDown,keyCode:0,flags:.maskSecondaryFn) == .init(), "non-slot Fn letter passes")
        _ = matcher.handle(.keyUp,keyCode:0)
        try expect(matcher.handle(.keyDown,keyCode:18,flags:[.maskSecondaryFn,.maskCommand]) == .init(), "extra command prevents default use")
        _ = matcher.handle(.keyUp,keyCode:18)
        try expect(matcher.handle(.keyDown,keyCode:18,flags:[.maskSecondaryFn,.maskShift,.maskAlternate]) == .init(), "extra option prevents capture")
        _ = matcher.handle(.keyUp,keyCode:18)
        try expect(matcher.handle(.keyDown,keyCode:18,flags:[.maskSecondaryFn,.maskAlphaShift,.maskNonCoalesced]).action == "use", "unrelated caps and event flags ignored")
        _ = matcher.handle(.keyUp,keyCode:18)

        _ = matcher.handle(.keyDown,keyCode:18)
        _ = matcher.handle(.flagsChanged,flags:.maskSecondaryFn)
        try expect(matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn,isRepeat:true) == .init(), "held ordinary key does not become shortcut on modifier change")
        _ = matcher.handle(.keyUp,keyCode:18)
        try expect(matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn).action == "use", "release rearms held key")
        _ = matcher.handle(.interrupted)
        try expect(matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn,isRepeat:true) == .init(), "tap recovery never triggers existing repeat")
        try expect(matcher.handle(.keyUp,keyCode:18) == .init(), "interrupted stale claim cleared")
        try expect(matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn).action == "use", "fresh press works after interruption")
        try expect(matcher.handle(.keyDown,keyCode:19,flags:.maskSecondaryFn,secureInput:true) == .init(), "secure input passes without action")
        try expect(matcher.handle(.keyUp,keyCode:18,secureInput:true) == .init(), "secure input clears previous claims")
        try expect(matcher.handle(.keyDown,keyCode:19,flags:.maskSecondaryFn,isRepeat:true) == .init(), "secure-input resume repeat does not trigger")
        _ = matcher.handle(.keyUp,keyCode:19)
        try expect(matcher.handle(.keyDown,keyCode:19,flags:.maskSecondaryFn,permitted:false) == .init(), "untrusted shortcuts pass")
        try expect(matcher.handle(.keyDown,keyCode:19,flags:.maskSecondaryFn,isRepeat:true) == .init(), "permission resume repeat does not trigger")
        _ = matcher.handle(.keyUp,keyCode:19)
        var disabled = defaults
        disabled.enabled = false
        try matcher.configure(disabled)
        try expect(matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn) == .init(), "disabled mapping passes")
        var unobserved = PocketSlotMatcher()
        try unobserved.configure(defaults)
        _ = unobserved.handle(.flagsChanged,flags:.maskSecondaryFn,secureInput:true)
        _ = unobserved.handle(.flagsChanged,flags:.maskSecondaryFn,permitted:false)
        try expect(!unobserved.functionObserved, "untrusted and secure flags do not observe Fn")

        // Check all 31 supported modifier combinations against the same nine
        // physical keys. Each extra configured modifier must prevent a match.
        let combinations = (1..<32).map { mask in PocketSettings.modifierNames.enumerated().compactMap { mask & (1 << $0.offset) != 0 ? $0.element : nil } }
        for (position, useModifiers) in combinations.enumerated() {
            var settings = defaults
            settings.useModifiers = useModifiers
            settings.captureModifiers = combinations[(position + 1) % combinations.count]
            try matcher.configure(settings)
            for (index, code) in settings.slotKeyCodes.enumerated() {
                let use = matcher.handle(.keyDown,keyCode:code,flags:PocketSlotMatcher.flags(useModifiers))
                try expect(use.action == "use" && use.index == index && use.swallow, "all modifier combinations use independently")
                _ = matcher.handle(.keyUp,keyCode:code)
                let capture = matcher.handle(.keyDown,keyCode:code,flags:PocketSlotMatcher.flags(settings.captureModifiers))
                try expect(capture.action == "capture" && capture.index == index && capture.swallow, "all modifier combinations capture independently")
                _ = matcher.handle(.keyUp,keyCode:code)
            }
        }
        var custom = defaults
        custom.useModifiers = ["control"]
        custom.captureModifiers = ["command"]
        custom.slotKeyCodes = [122,120,99,118,96,97,98,100,101]
        try matcher.configure(custom)
        try expect(matcher.handle(.keyDown,keyCode:122,flags:[.maskControl,.maskSecondaryFn]).action == "use", "non-Fn explicit F1 mapping tolerates implicit function flag")
        _ = matcher.handle(.keyUp,keyCode:122)
        try expect(matcher.handle(.keyDown,keyCode:122,flags:[.maskCommand,.maskSecondaryFn]).action == "capture", "non-Fn capture F1 mapping tolerates implicit function flag")
        _ = matcher.handle(.keyUp,keyCode:122)
        try expect(matcher.handle(.keyDown,keyCode:18,flags:.maskControl) == .init(), "custom mapping does not retain old digits")
        try expect(PocketHotkeys.ownEventMarker == 0x4E504B54, "host copy-paste marker contract")
        try testPrefixes(defaults)
        try testHostGate(defaults)
        print("HotkeyTests: \(checks) passed (pure state only; no event taps, injected input, permission changes or pasteboard access)")
    }

    static func testPrefixes(_ defaults: PocketSettings) throws {
        var settings = defaults
        settings.apply(["previewEnabled":false, "slotOrder":Array((0..<9).reversed()), "useModifiers":[], "useTriggerKeyCode":0,
                        "captureModifiers":[], "captureTriggerKeyCode":122])
        try settings.validate()
        try expect(!settings.previewEnabled && settings.slotOrder == Array((0..<9).reversed()), "preview and order apply independently")
        try expect(settings.useTriggerKeyCode == 0 && settings.captureTriggerKeyCode == 122 && settings.slotKeyCodes == defaults.slotKeyCodes, "trigger keys leave slot identities intact")
        let roundTrip = try JSONDecoder().decode(PocketSettings.self, from:JSONEncoder().encode(settings))
        try expect(roundTrip.dictionary as NSDictionary == settings.dictionary as NSDictionary, "R3 settings round trip")
        settings.apply(["useModifiers":["fn"], "useTriggerKeyCode":NSNull()])
        try settings.validate()
        try expect(settings.useTriggerKeyCode == nil && settings.captureTriggerKeyCode == 122, "nil trigger restores pure modifier independently")
        try expect(settings.dictionary["useTriggerKeyCode"] is NSNull, "nil trigger exposed as JSON null")
        for field in ["useTriggerKeyCode", "captureTriggerKeyCode"] {
            for value: Any in [-1, 65536, 18, 63, 0.5, true, "A"] {
                var invalid = defaults
                invalid.apply([field:value])
                try rejects("invalid or overlapping trigger key") { try invalid.validate() }
            }
            let invalid = try JSONDecoder().decode(PocketSettings.self, from:Data("{\"\(field)\":true}".utf8))
            try rejects("invalid saved trigger fails closed") { try invalid.validate() }
        }
        for value: Any in [[], [0,1], [0,1,2,3,4,5,6,7,7], [0,1,2,3,4,5,6,7,9], [0,1,2,3,4,5,6,7,8.5], [0,1,2,3,4,5,6,7,true], "bad"] {
            var invalid = defaults
            invalid.apply(["slotOrder":value])
            try rejects("display order must be a complete permutation") { try invalid.validate() }
        }
        var identical = defaults
        identical.useModifiers = []; identical.captureModifiers = []
        identical.useTriggerKeyCode = 0; identical.captureTriggerKeyCode = 0
        try rejects("same single-key prefix") { try identical.validate() }
        identical.captureTriggerKeyCode = 122
        try identical.validate()
        try expect(identical.useModifiers.isEmpty && identical.captureModifiers.isEmpty, "different dedicated keys may share empty modifiers")
        for code: UInt16 in [1,9,49] {
            var collision = defaults
            collision.useModifiers = collision.panelModifiers
            collision.useTriggerKeyCode = code
            try collision.validate()
            try expect(collision.useTriggerKeyCode == code,"unregistered Carbon shortcut cannot reserve a trigger")
        }
        var noPreview = defaults
        noPreview.previewEnabled = false
        noPreview.useModifiers = noPreview.panelModifiers
        noPreview.useTriggerKeyCode = 49
        try noPreview.validate()
        try expect(noPreview.useTriggerKeyCode == 49, "disabled panel preview releases its legacy Space chord")

        var matcher = PocketSlotMatcher()
        try matcher.configure(defaults)
        try expect(matcher.handle(.flagsChanged,flags:.maskSecondaryFn).preview == .show("use"), "holding pure Fn shows use preview")
        try expect(matcher.handle(.flagsChanged,flags:.maskSecondaryFn).preview == nil, "unchanged flags do not reopen preview")
        try expect(matcher.handle(.flagsChanged,flags:[.maskSecondaryFn,.maskShift]).preview == .show("capture"), "adding Shift switches to capture preview")
        try expect(matcher.handle(.flagsChanged,flags:.maskSecondaryFn).preview == .hide, "releasing Shift hides without reopening use preview")
        try expect(matcher.handle(.flagsChanged,flags:.maskSecondaryFn).preview == nil, "residual Fn does not reopen on redundant flags event")
        _ = matcher.handle(.flagsChanged,flags:[])
        _ = matcher.handle(.flagsChanged,flags:.maskSecondaryFn)
        let selected = matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn)
        try expect(selected.action == "use" && selected.index == 0 && selected.preview == .hide && selected.swallow, "slot selection hides before one action")
        try expect(matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn,isRepeat:true).action == nil, "selected slot repeat never fires again")
        try expect(matcher.handle(.keyUp,keyCode:18,flags:.maskSecondaryFn).swallow, "selected slot release still swallowed while Fn held")
        try expect(matcher.handle(.keyDown,keyCode:19,flags:.maskSecondaryFn).action == nil, "same prefix hold cannot select a second slot")
        _ = matcher.handle(.keyUp,keyCode:19,flags:.maskSecondaryFn)
        let released = matcher.handle(.flagsChanged,flags:[])
        try expect(released.action == nil && released.preview == nil, "prefix release does not re-fire or re-show selected action")
        try expect(matcher.handle(.flagsChanged,flags:.maskSecondaryFn).preview == .show("use"), "fresh prefix hold rearms preview")
        let escape = matcher.handle(.keyDown,keyCode:53,flags:.maskSecondaryFn)
        try expect(escape.swallow && escape.action == nil && escape.preview == .hide, "Esc claims itself and cancels preview")
        try expect(matcher.handle(.keyUp,keyCode:53,flags:.maskSecondaryFn).swallow, "canceling Esc release balanced")
        try expect(matcher.handle(.flagsChanged,flags:[.maskSecondaryFn,.maskShift]).preview == nil, "Esc cancellation waits for prefix release")
        _ = matcher.handle(.flagsChanged,flags:[])
        _ = matcher.handle(.flagsChanged,flags:.maskSecondaryFn)
        let ordinary = matcher.handle(.keyDown,keyCode:11,flags:.maskSecondaryFn)
        try expect(!ordinary.swallow && ordinary.preview == .hide && ordinary.action == nil, "ordinary unrelated key passes and cancels preview")
        _ = matcher.handle(.keyUp,keyCode:11,flags:.maskSecondaryFn)
        try expect(matcher.handle(.flagsChanged,flags:[.maskSecondaryFn,.maskShift]).preview == nil, "ordinary-key cancellation cannot reopen on residual flags")
        _ = matcher.handle(.flagsChanged,flags:[])
        _ = matcher.handle(.flagsChanged,flags:.maskSecondaryFn)
        try expect(matcher.handle(.mouseDown,flags:.maskSecondaryFn).preview == .hide, "mouse down cancels preview")
        try expect(matcher.handle(.flagsChanged,flags:[.maskSecondaryFn,.maskShift]).preview == nil, "mouse cancellation locks current hold")

        var keyed = defaults
        keyed.useModifiers = []; keyed.captureModifiers = []
        keyed.useTriggerKeyCode = 0; keyed.captureTriggerKeyCode = 122
        try matcher.configure(keyed)
        let keyStart = matcher.handle(.keyDown,keyCode:0)
        try expect(keyStart.swallow && keyStart.preview == .show("use") && keyStart.action == nil, "dedicated A prefix is claimed immediately")
        try expect(matcher.handle(.keyDown,keyCode:0,isRepeat:true) == .init(swallow:true), "dedicated prefix repeat is suppressed")
        let keyedSelection = matcher.handle(.keyDown,keyCode:19)
        try expect(keyedSelection.action == "use" && keyedSelection.index == 1 && keyedSelection.preview == .hide, "held A plus digit selects logical slot")
        try expect(matcher.handle(.keyUp,keyCode:19).swallow, "keyed slot up swallowed")
        try expect(matcher.handle(.keyDown,keyCode:20).action == nil, "keyed hold selects only once")
        _ = matcher.handle(.keyUp,keyCode:20)
        let prefixUp = matcher.handle(.keyUp,keyCode:0)
        try expect(prefixUp.swallow && prefixUp.action == nil && prefixUp.preview == nil, "selected prefix up has no extra action or replay")
        _ = matcher.handle(.keyDown,keyCode:0)
        let unused = matcher.handle(.keyUp,keyCode:0)
        try expect(unused.swallow && unused.preview == .hide && unused.action == nil, "unused dedicated key is never replayed")
        try expect(!matcher.handle(.keyDown,keyCode:0,flags:.maskCommand).swallow, "extra modifier preserves ordinary Command-A")
        _ = matcher.handle(.keyUp,keyCode:0,flags:.maskCommand)
        _ = matcher.handle(.keyDown,keyCode:0)
        let passB = matcher.handle(.keyDown,keyCode:11)
        try expect(!passB.swallow && passB.preview == .hide, "unrelated key after dedicated prefix passes without replay")
        _ = matcher.handle(.keyUp,keyCode:11)
        try expect(matcher.handle(.keyDown,keyCode:18).action == nil, "unrelated-key cancellation retires dedicated hold")
        _ = matcher.handle(.keyUp,keyCode:18)
        _ = matcher.handle(.keyUp,keyCode:0)
        let fStart = matcher.handle(.keyDown,keyCode:122,flags:.maskSecondaryFn)
        try expect(fStart.swallow && fStart.preview == .show("capture"), "explicit F1 prefix tolerates its implicit function flag")
        let fSelection = matcher.handle(.keyDown,keyCode:25)
        try expect(fSelection.action == "capture" && fSelection.index == 8, "F1 prefix uses digit identity rather than treating F1 as digit one")
        _ = matcher.handle(.keyUp,keyCode:25)
        _ = matcher.handle(.keyUp,keyCode:122)
        try matcher.configure(keyed)
        let resumedRepeat = matcher.handle(.keyDown,keyCode:0,isRepeat:true)
        try expect(resumedRepeat.swallow && resumedRepeat.preview == nil && resumedRepeat.action == nil, "resumed dedicated repeat is drained without a new session")
        try expect(matcher.handle(.keyDown,keyCode:18).action == nil, "resumed held prefix cannot trigger a slot")
        _ = matcher.handle(.keyUp,keyCode:18)
        _ = matcher.handle(.keyUp,keyCode:0)
        try expect(matcher.handle(.keyDown,keyCode:0).preview == .show("use"), "release and fresh press rearms dedicated key")
        let focusCancel = matcher.cancelSession()
        try expect(focusCancel.preview == .hide, "focus cancellation hides old preview")
        try expect(matcher.handle(.keyDown,keyCode:0,isRepeat:true).swallow, "focus cancellation still drains claimed prefix repeats")
        try expect(matcher.handle(.keyDown,keyCode:19).action == nil, "focus cancellation cannot continue an old prefix into a new app")
        _ = matcher.handle(.keyUp,keyCode:19)
        try expect(matcher.handle(.keyUp,keyCode:0).swallow, "focus cancellation balances original claimed keyup")
        try expect(matcher.handle(.keyDown,keyCode:0).preview == .show("use"), "new app needs a fresh prefix press")
        try expect(matcher.handle(.mouseDown).preview == .hide, "mouse cancels a dedicated hold")
        try expect(matcher.handle(.flagsChanged,flags:.maskShift).preview == nil, "dedicated mouse cancellation survives modifier changes")
        _ = matcher.handle(.keyUp,keyCode:0)

        keyed.useModifiers = ["control"]
        try matcher.configure(keyed)
        try expect(matcher.handle(.keyDown,keyCode:0,flags:.maskControl).preview == .show("use"), "modifier plus ordinary prefix supported")
        let combo = matcher.handle(.keyDown,keyCode:20,flags:.maskControl)
        try expect(combo.action == "use" && combo.index == 2, "modifier plus ordinary prefix selects slot")
        _ = matcher.handle(.keyUp,keyCode:20,flags:.maskControl)
        _ = matcher.handle(.keyUp,keyCode:0,flags:.maskControl)
        try expect(matcher.handle(.keyDown,keyCode:0,flags:.maskControl).preview == .show("use"), "ordinary prefix can be re-pressed while its modifier remains held")
        try expect(matcher.handle(.flagsChanged,flags:[]).preview == .hide, "releasing required modifier cancels keyed prefix")
        try expect(matcher.handle(.flagsChanged,flags:.maskControl).preview == nil, "re-adding modifier does not revive still-held ordinary prefix")
        _ = matcher.handle(.keyUp,keyCode:0)

        var hidden = defaults
        hidden.previewEnabled = false
        hidden.slotOrder = Array((0..<9).reversed())
        try matcher.configure(hidden)
        try expect(matcher.handle(.flagsChanged,flags:.maskSecondaryFn).preview == nil, "preview switch suppresses pure-prefix window requests")
        let hiddenUse = matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn)
        try expect(hiddenUse.action == "use" && hiddenUse.index == 0 && hiddenUse.preview == nil, "preview OFF and reordered display preserve logical slot action")
        var off = keyed
        off.enabled = false
        try matcher.configure(off)
        try expect(matcher.handle(.keyDown,keyCode:0,flags:.maskControl) == .init(), "total OFF leaves dedicated key ordinary")
        try expect(matcher.handle(.flagsChanged,flags:.maskSecondaryFn) == .init(), "total OFF never requests a preview")
        for mode in 0..<3 {
            try matcher.configure(keyed)
            _ = matcher.handle(.keyDown,keyCode:0,flags:.maskControl)
            let interrupted = mode == 0 ? matcher.handle(.interrupted) : matcher.handle(.flagsChanged,flags:.maskControl,permitted:mode != 1,secureInput:mode == 2)
            try expect(interrupted.preview == .hide && interrupted.action == nil, "interruption, revoked permission and secure input hide preview without action")
        }
    }
    static func testHostGate(_ defaults:PocketSettings) throws {
        for showPreview in [true,false] {
            var settings=defaults;settings.previewEnabled=showPreview
            var matcher=PocketSlotMatcher();try matcher.configure(settings)
            let deniedStart=matcher.handle(.flagsChanged,flags:.maskSecondaryFn,allowed:false)
            try expect(!deniedStart.swallow && deniedStart.preview == nil,"host denial passes modifiers without a preview")
            let deniedSlot=matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn,allowed:false)
            try expect(!deniedSlot.swallow && deniedSlot.action == nil,"host denial does not consume a new slot")
            try expect(!matcher.handle(.keyUp,keyCode:18,flags:.maskSecondaryFn,allowed:false).swallow,"unclaimed denied slot up passes")
            try expect(matcher.handle(.flagsChanged,flags:.maskSecondaryFn).preview == nil,"host recovery does not reuse a held prefix")
            let stale=matcher.handle(.keyDown,keyCode:19,flags:.maskSecondaryFn)
            try expect(!stale.swallow && stale.action == nil,"old prefix remains blocked after host recovery")
            _=matcher.handle(.keyUp,keyCode:19,flags:.maskSecondaryFn)
            _=matcher.handle(.flagsChanged,flags:[])
            let fresh=matcher.handle(.flagsChanged,flags:.maskSecondaryFn)
            try expect(fresh.preview == (showPreview ? .show("use"):nil),"fresh post-recovery prefix may open preview")
            let chosen=matcher.handle(.keyDown,keyCode:20,flags:.maskSecondaryFn)
            try expect(chosen.swallow && chosen.action == "use","fresh post-recovery slot works")
            let deniedRepeat=matcher.handle(.keyDown,keyCode:20,flags:.maskSecondaryFn,isRepeat:true,allowed:false)
            try expect(deniedRepeat.swallow && deniedRepeat.action == nil,"host denial drains existing claimed slot repeats")
            try expect(matcher.handle(.keyUp,keyCode:20,flags:.maskSecondaryFn,allowed:false).swallow,"host denial drains existing claimed slot up")
            try expect(!matcher.handle(.keyDown,keyCode:21,flags:.maskSecondaryFn,allowed:false).swallow,"denial does not claim a different slot")
            _=matcher.handle(.keyUp,keyCode:21,flags:.maskSecondaryFn,allowed:false)
            _=matcher.handle(.flagsChanged,flags:[],allowed:false)
            try expect(matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn).action == "use","release during denial rearms next fresh chord")

            try matcher.configure(settings)
            _=matcher.handle(.flagsChanged,flags:[.maskSecondaryFn,.maskShift])
            let interrupted=matcher.handle(.flagsChanged,flags:[.maskSecondaryFn,.maskShift],allowed:false)
            try expect(interrupted.preview == (showPreview ? .hide:nil),"host interruption hides capture preview")
            _=matcher.handle(.flagsChanged,flags:.maskSecondaryFn)
            let partialRelease=matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn)
            try expect(!partialRelease.swallow && partialRelease.action == nil,"partial modifier release cannot turn old capture into use")
            _=matcher.handle(.keyUp,keyCode:18,flags:.maskSecondaryFn)
            _=matcher.handle(.flagsChanged,flags:[])
            try expect(matcher.handle(.keyDown,keyCode:18,flags:.maskSecondaryFn).action == "use","all old modifiers released rearms use")

            settings.useModifiers=[];settings.useTriggerKeyCode=0
            settings.captureModifiers=[];settings.captureTriggerKeyCode=122
            try matcher.configure(settings)
            let passed=matcher.handle(.keyDown,keyCode:0,allowed:false)
            try expect(!passed.swallow && passed.preview == nil,"dedicated key remains ordinary while host denies new sessions")
            try expect(!matcher.handle(.keyDown,keyCode:0,isRepeat:true,allowed:false).swallow,"ordinary held repeat stays ordinary during denial")
            try expect(!matcher.handle(.keyDown,keyCode:0,isRepeat:true).swallow,"recovery does not steal repeat after unclaimed physical down")
            let noSlot=matcher.handle(.keyDown,keyCode:18)
            try expect(!noSlot.swallow && noSlot.action == nil,"unclaimed old prefix cannot select after recovery")
            _=matcher.handle(.keyUp,keyCode:18)
            try expect(!matcher.handle(.keyUp,keyCode:0).swallow,"unclaimed prefix up stays ordinary")
            let newPrefix=matcher.handle(.keyDown,keyCode:0)
            try expect(newPrefix.swallow && newPrefix.preview == (showPreview ? .show("use"):nil),"fresh dedicated prefix after recovery works")
            let cancel=matcher.handle(.keyDown,keyCode:11,allowed:false)
            try expect(!cancel.swallow && cancel.preview == (showPreview ? .hide:nil),"unrelated input passes while host cancels claimed prefix")
            try expect(matcher.handle(.keyDown,keyCode:0,isRepeat:true,allowed:false).swallow,"owned dedicated repeat stays drained")
            try expect(matcher.handle(.keyUp,keyCode:0,allowed:false).swallow,"owned dedicated release stays drained")
            _=matcher.handle(.keyUp,keyCode:11,allowed:false)
            try expect(matcher.handle(.keyDown,keyCode:0).swallow,"fresh dedicated press rearms after draining")
        }
    }

}
