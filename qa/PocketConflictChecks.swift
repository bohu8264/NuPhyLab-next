import Foundation

@main struct PocketConflictChecks {
    static func main() {
        var count=0
        func check(_ value:Bool,_ name:String) {precondition(value,name);count += 1}
        let slots:[UInt16]=[18,19,20,21,23,22,26,28,25]
        let fn=PocketConflictPolicy.Prefix(modifiers:["fn"],keyCode:nil)
        let fnShift=PocketConflictPolicy.Prefix(modifiers:["fn","shift"],keyCode:nil)
        func result(_ selection:InputBinding?,_ reserved:Set<UInt32>=[],use:PocketConflictPolicy.Prefix?=nil,capture:PocketConflictPolicy.Prefix?=nil,keys:[UInt16]?=nil,previewEnabled:Bool=true)->PocketConflictPolicy.Conflict? {
            PocketConflictPolicy.conflict(use:use ?? fn,capture:capture ?? fnShift,slotKeyCodes:keys ?? slots,previewEnabled:previewEnabled,selection:selection,reservedKeys:reserved)
        }
        check(result(nil) == nil,"unassigned shortcut")
        check(result(.disabled) == nil,"disabled selection")
        check(result(.fnGlobe) == .selection,"same modifier prefix must not race")
        check(result(.modifierChord(.shift)) == .selection,"capture prefix's first modifier is reserved")
        check(result(.modifierChord([.shift,.function])) == .selection,"capture prefix collision")
        check(result(.modifierChord([.command,.function])) == .selection,"Pocket prefix starts before longer selection")
        check(result(.modifierChord(.command)) == nil,"unrelated modifier remains usable")
        check(result(.mouseButton(index:4)) == nil,"mouse bindings use runtime activity arbitration")
        check(result(.keyboard(keyCode:18,modifiers:.function)) == .selection,"slot chord collision")
        check(result(.keyboard(keyCode:18,modifiers:[.function,.shift])) == .selection,"capture slot collision")
        check(result(.keyboard(keyCode:18,modifiers:.command)) == nil,"same key with unrelated modifiers")
        check(result(.keyboard(keyCode:0,modifiers:.function)) == .selection,"visible pure-prefix preview conflicts with a non-slot keyboard binding")
        check(result(.keyboard(keyCode:0,modifiers:.function),previewEnabled:false) == nil,"hidden preview preserves unrelated non-slot binding")
        let control=PocketConflictPolicy.Prefix(modifiers:["control"],keyCode:nil)
        let controlShift=PocketConflictPolicy.Prefix(modifiers:["control","shift"],keyCode:nil)
        check(result(.keyboard(keyCode:0,modifiers:.control),use:control,capture:controlShift) == .selection,"Control preview cannot race Selection Control-A")
        check(result(.keyboard(keyCode:0,modifiers:.control),use:control,capture:controlShift,previewEnabled:false) == nil,"Control-A remains distinct when passive preview is OFF")
        check(result(.keyboard(keyCode:18,modifiers:.control),use:control,capture:controlShift,previewEnabled:false) == .selection,"preview OFF still reserves actual slot chords")
        check(result(nil,[122]) == nil,"unrelated AI key")
        check(result(nil,[122],keys:[122]+slots.dropFirst()) == .aiKeyboard,"Fn does not protect an AI function key")
        let command=PocketConflictPolicy.Prefix(modifiers:["command"],keyCode:nil)
        let commandShift=PocketConflictPolicy.Prefix(modifiers:["command","shift"],keyCode:nil)
        check(result(nil,[122],use:command,capture:commandShift,keys:[122]+slots.dropFirst()) == nil,"modified AI key is a distinct chord")
        let ordinary=PocketConflictPolicy.Prefix(modifiers:[],keyCode:0)
        check(result(nil,[0],use:ordinary) == .aiKeyboard,"ordinary trigger reserved by AI")
        check(result(.keyboard(keyCode:0),use:ordinary) == .selection,"ordinary prefix reserved by selection")
        check(result(.keyboard(keyCode:18),use:ordinary) == .selection,"ordinary held prefix does not change modifier matching")
        check(result(.keyboard(keyCode:0,modifiers:.shift),use:ordinary) == nil,"ordinary prefix retains different modified shortcuts")
        check(result(nil,use:fn,capture:fn) == .identicalPrefixes,"identical store/retrieve denied")
        let function=PocketConflictPolicy.Prefix(modifiers:["fn"],keyCode:122)
        check(result(.keyboard(keyCode:122),use:function) == .selection,"implicit Fn normalization matches selection")
        check(result(.keyboard(keyCode:122,modifiers:.command),use:function) == nil,"implicit Fn does not erase explicit modifiers")
        for code in PocketSettings.implicitFunctionKeys {
            let arrow=PocketConflictPolicy.Prefix(modifiers:["control"],keyCode:code)
            let other=PocketConflictPolicy.Prefix(modifiers:["option"],keyCode:nil)
            check(result(.keyboard(keyCode:code,modifiers:[.control,.function]),use:arrow,capture:other) == .selection,"Fn alias selection conflicts with Pocket function/arrow prefix")
            check(result(.keyboard(keyCode:code,modifiers:[.control,.function]),use:control,capture:other,keys:[code]+slots.dropFirst(),previewEnabled:false) == .selection,"Fn alias selection conflicts with hidden Pocket slot")
            check(result(.keyboard(keyCode:code,modifiers:[.command,.function]),use:arrow,capture:other) == nil,"different explicit modifiers remain distinct")
            check(result(.keyboard(keyCode:18,modifiers:[.control,.function]),use:arrow,capture:other) == .selection,"keyed prefix normalizes implicit Fn while selecting an ordinary slot")
        }
        let keyedLetter=PocketConflictPolicy.Prefix(modifiers:["control"],keyCode:0)
        let otherPrefix=PocketConflictPolicy.Prefix(modifiers:["option"],keyCode:nil)
        check(result(.keyboard(keyCode:126,modifiers:[.control,.function]),use:keyedLetter,capture:otherPrefix,keys:[126]+slots.dropFirst()) == nil,"ordinary prefix does not normalize Fn from an arrow slot")
        // Check every non-empty modifier set and subset. This prevents a future
        // two-key prefix from opening Smart Selection on its first held modifier.
        let names=["control","shift","option","command","fn"]
        for raw in UInt8(1)...31 {
            let prefix=PocketConflictPolicy.Prefix(modifiers:names.enumerated().compactMap{raw & (1 << $0.offset) != 0 ? $0.element:nil},keyCode:0)
            for wanted in UInt8(1)...31 {
                let binding=InputBinding.modifierChord(InputModifiers(rawValue:wanted))
                let other=PocketConflictPolicy.Prefix(modifiers:[],keyCode:11)
                let actual=result(binding,use:prefix,capture:other)
                check((actual == .selection) == ((wanted & raw) == wanted),"modifier subset \(raw)/\(wanted)")
            }
        }
        var settings=PocketSettings()
        settings.enabled=false
        settings.useModifiers=["fn"];settings.captureModifiers=["fn","shift"]
        settings.useTriggerKeyCode=nil;settings.captureTriggerKeyCode=nil;settings.slotKeyCodes=slots
        check(PocketConflictPolicy.conflict(settings:settings,selection:.fnGlobe,reservedKeys:[]) == nil,"OFF preserves conflicting saved settings")
        settings.enabled=true
        let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys]
        let prior=try! encoder.encode(settings)
        check(PocketConflictPolicy.conflict(settings:settings,selection:.fnGlobe,reservedKeys:[]) == .selection,"ON sees conflict")
        check(try! encoder.encode(settings) == prior,"policy does not mutate persisted preferences")
        for issue in [PocketConflictPolicy.Conflict.selection,.aiKeyboard,.identicalPrefixes] {
            check(!issue.message(english:false).isEmpty && !issue.message(english:true).isEmpty,"localized conflict message")
        }
        print("Pocket conflict checks passed: \(count)")
    }
}
