import AppKit
import Foundation

/// Pure event sequences only: no event taps, permission requests, keyboard posting or user defaults.
@main struct HotkeyTests {
    static var passed = 0
    static var failed = 0
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        if condition() { passed += 1 } else { failed += 1; print("FAIL: \(message)") }
    }
    static func event(_ kind: VoiceHotkeyEventKind, _ code: UInt32 = 0, _ flags: UInt64 = 0,
                      _ time: TimeInterval = 1, repeat repeated: Bool = false, owned: Bool = false) -> VoiceHotkeyEvent {
        .init(kind: kind, keyCode: code, flags: flags, time: time, isRepeat: repeated, owned: owned)
    }
    @MainActor static func main() {
        let command: UInt64 = 1 << 20, option: UInt64 = 1 << 19
        let shift: UInt64 = 1 << 17, control: UInt64 = 1 << 18, fn: UInt64 = 1 << 23

        for code: UInt32 in [0, 1, 8, 36, 48, 49, 51, 114, 115, 116, 117, 119, 121, 123, 124, 125, 126] {
            check(VoiceHotkeyPolicy.valid(keyCode: code, modifiers: 0), "ordinary single key \(code)")
            check(VoiceHotkeyPolicy.valid(keyCode: code, modifiers: shift), "shift chord \(code)")
            check(VoiceHotkeyPolicy.valid(keyCode: code, modifiers: control | option), "existing chord \(code)")
        }
        check(VoiceHotkeyPolicy.functionCodes.count == 20, "all twenty function keys represented")
        for code in VoiceHotkeyPolicy.functionCodes {
            check(VoiceHotkeyPolicy.valid(keyCode: code, modifiers: 0), "standalone F key \(code)")
            var machine = VoiceHotkeyState(keyCode: code, modifiers: 0)
            check(machine.observe(event(.down, code, fn)).fire, "implicit Fn accepted for F key \(code)")
            check(machine.observe(event(.up, code, fn, 1.1)).consume, "F key up consumed \(code)")
        }
        for code: UInt32 in [53, 57, 128, 999] {
            check(!VoiceHotkeyPolicy.valid(keyCode: code, modifiers: 0), "reserved/out-of-range key \(code)")
        }
        check(!VoiceHotkeyPolicy.valid(keyCode: 0, modifiers: fn), "Fn ordinary chord is not a saved combination")
        check(!VoiceHotkeyPolicy.valid(keyCode: 0, modifiers: 1 << 16), "Caps Lock is not a modifier shortcut")
        check(VoiceHotkey.label(keyCode: 100, modifiers: 0) == "F8", "default F8 label")
        check(VoiceHotkey.label(keyCode: 49, modifiers: control | option) == "⌃⌥Space", "existing combination label retained")
        check(VoiceHotkey.defaultModifiers == 0, "new default is a single key")

        // Left/right modifiers remain distinct. Their original events always pass through.
        for code in VoiceHotkeyPolicy.modifierCodes.sorted() {
            let info = VoiceHotkeyPolicy.modifiers[code]!
            let flags = info.flag | info.side
            check(VoiceHotkeyPolicy.valid(keyCode: code, modifiers: 0), "modifier allowed \(code)")
            check(!VoiceHotkeyPolicy.valid(keyCode: code, modifiers: control), "modifier combination forbidden \(code)")
            check(VoiceHotkey.label(keyCode: code, modifiers: 0) == info.name, "side-specific label \(code)")
            var machine = VoiceHotkeyState(keyCode: code, modifiers: 0)
            check(machine.observe(event(.flags, code, flags)) == .init(), "modifier down passes without firing \(code)")
            check(machine.observe(event(.flags, code, 0, 1.2)) == .init(fire: true), "modifier released tap fires \(code)")
            check(machine.observe(event(.flags, code, 0, 1.2)) == .init(), "duplicate modifier release ignored \(code)")
            check(machine.observe(event(.flags, code, flags, 2)) == .init(), "second modifier down no fire \(code)")
            check(machine.observe(event(.flags, code, 0, 2.2)).fire, "second modifier tap stops recording \(code)")

            var chord = VoiceHotkeyState(keyCode: code, modifiers: 0)
            _ = chord.observe(event(.flags, code, flags))
            check(chord.observe(event(.down, 8, flags, 1.1)) == .init(), "normal key chord passes \(code)")
            check(chord.observe(event(.up, 8, flags, 1.2)) == .init(), "normal key chord release passes \(code)")
            check(chord.observe(event(.flags, code, 0, 1.3)) == .init(), "modifier chord never fires \(code)")

            var ordinaryFirst = VoiceHotkeyState(keyCode: code, modifiers: 0)
            _ = ordinaryFirst.observe(event(.down, 8, 0, 1))
            _ = ordinaryFirst.observe(event(.flags, code, flags, 1.1))
            check(!ordinaryFirst.observe(event(.flags, code, 0, 1.2)).fire, "ordinary key held before modifier cancels tap \(code)")
            _ = ordinaryFirst.observe(event(.up, 8, 0, 1.3))
            _ = ordinaryFirst.observe(event(.flags, code, flags, 2))
            check(ordinaryFirst.observe(event(.flags, code, 0, 2.2)).fire, "fresh tap works after prior key is released \(code)")

            var mouse = VoiceHotkeyState(keyCode: code, modifiers: 0)
            _ = mouse.observe(event(.flags, code, flags))
            check(mouse.observe(event(.mouse, 0, flags, 1.1)) == .init(), "mouse click passes \(code)")
            check(!mouse.observe(event(.flags, code, 0, 1.2)).fire, "modifier-click never fires \(code)")

            var mouseFirst = VoiceHotkeyState(keyCode: code, modifiers: 0)
            _ = mouseFirst.observe(event(.mouseDown, 0, 0, 1))
            _ = mouseFirst.observe(event(.flags, code, flags, 1.1))
            check(!mouseFirst.observe(event(.flags, code, 0, 1.2)).fire, "mouse held before modifier prevents activation \(code)")
            _ = mouseFirst.observe(event(.mouseUp, 0, 0, 1.3))
            _ = mouseFirst.observe(event(.flags, code, flags, 2))
            check(mouseFirst.observe(event(.flags, code, 0, 2.2)).fire, "modifier tap works after mouse release \(code)")
            var initialKeys = VoiceHotkeyState(keyCode: code, modifiers: 0, initialKeys: [8])
            _ = initialKeys.observe(event(.flags, code, flags))
            check(initialKeys.observe(event(.flags, code, 0, 1.2)).fire, "unconfirmed initial key snapshot cannot block fresh modifier tap \(code)")
            _ = initialKeys.observe(event(.up, 8, 0, 1.3))
            _ = initialKeys.observe(event(.flags, code, flags, 2))
            check(initialKeys.observe(event(.flags, code, 0, 2.2)).fire, "preheld key release unblocks listener \(code)")
            var initialMouse = VoiceHotkeyState(keyCode: code, modifiers: 0, initialMouseButtons: [0])
            _ = initialMouse.observe(event(.flags, code, flags))
            check(!initialMouse.observe(event(.flags, code, 0, 1.2)).fire, "mouse held before listener startup prevents activation \(code)")

            var held = VoiceHotkeyState(keyCode: code, modifiers: 0, initialFlags: flags)
            check(!held.observe(event(.flags, code, 0, 1.2)).fire, "preheld modifier release ignored \(code)")
            _ = held.observe(event(.flags, code, flags, 2))
            check(held.observe(event(.flags, code, 0, 2.2)).fire, "fresh tap after preheld release works \(code)")

            var long = VoiceHotkeyState(keyCode: code, modifiers: 0)
            _ = long.observe(event(.flags, code, flags))
            check(long.observe(event(.flags, code, 0, 2)).fire, "deliberate single modifier press has same semantics as shortcut recording \(code)")
            var longer = VoiceHotkeyState(keyCode:code,modifiers:0)
            _ = longer.observe(event(.flags,code,flags,1))
            check(longer.observe(event(.flags,code,0,6)).fire,"five-second standalone press still toggles once on release \(code)")
            check(!longer.observe(event(.flags,code,0,6.1)).fire,"long press release never toggles twice \(code)")

            var lostRelease=VoiceHotkeyState(keyCode:code,modifiers:0)
            _ = lostRelease.observe(event(.down,8,0,1))
            lostRelease.reconcileReleasedInputs(ordinaryKeys:[],mouseButtons:[])
            _ = lostRelease.observe(event(.flags,code,flags,2))
            check(lostRelease.observe(event(.flags,code,0,2.2)).fire,"confirmed physical release recovers missing ordinary key-up \(code)")
            var reallyHeld=VoiceHotkeyState(keyCode:code,modifiers:0)
            _ = reallyHeld.observe(event(.down,8,0,1))
            reallyHeld.reconcileReleasedInputs(ordinaryKeys:[8],mouseButtons:[])
            _ = reallyHeld.observe(event(.flags,code,flags,2))
            check(!reallyHeld.observe(event(.flags,code,0,2.2)).fire,"reconciliation retains actually held ordinary key \(code)")
            var lostMouse=VoiceHotkeyState(keyCode:code,modifiers:0,initialMouseButtons:[0])
            lostMouse.reconcileReleasedInputs(ordinaryKeys:[0,2],mouseButtons:[])
            _ = lostMouse.observe(event(.flags,code,flags,2))
            check(lostMouse.observe(event(.flags,code,0,2.2)).fire,"released mouse no longer blocks and stale unrelated CG keys are not imported \(code)")
            var chordReleased=VoiceHotkeyState(keyCode:code,modifiers:0)
            _ = chordReleased.observe(event(.flags,code,flags,1))
            _ = chordReleased.observe(event(.down,8,flags,1.1))
            chordReleased.reconcileReleasedInputs(ordinaryKeys:[],mouseButtons:[])
            check(!chordReleased.observe(event(.flags,code,0,2)).fire,"physical cleanup never rearms a chord as standalone modifier \(code)")

            var aggregate = VoiceHotkeyState(keyCode: code, modifiers: 0)
            _ = aggregate.observe(event(.flags, code, info.flag))
            check(aggregate.observe(event(.flags, code, 0, 1.2)).fire, "aggregate-only modifier device \(code)")

            var duplicated = VoiceHotkeyState(keyCode: code, modifiers: 0)
            _ = duplicated.observe(event(.flags, code, flags))
            check(!duplicated.observe(event(.flags, code, flags)).fire, "same flags event cannot flip held state \(code)")
            check(duplicated.observe(event(.flags, code, 0, 1.2)).fire, "duplicate event does not spoil real release \(code)")

            var interrupted = VoiceHotkeyState(keyCode: code, modifiers: 0)
            _ = interrupted.observe(event(.flags, code, flags))
            _ = interrupted.observe(event(.interrupted, 0, flags, 1.1))
            check(!interrupted.observe(event(.flags, code, 0, 1.2)).fire, "tap interruption discards stale modifier \(code)")

            var injected = VoiceHotkeyState(keyCode: code, modifiers: 0)
            check(injected.observe(event(.flags, code, flags, 1, owned: true)) == .init(), "own modifier down ignored \(code)")
            check(injected.observe(event(.flags, code, 0, 1.2, owned: true)) == .init(), "own modifier up ignored \(code)")
            _ = injected.observe(event(.flags, code, flags, 2))
            _ = injected.observe(event(.down, 9, command, 2.1, owned: true))
            check(!injected.observe(event(.flags, code, 0, 2.2)).fire, "own paste cancels an in-flight modifier tap \(code)")

            var capture = VoiceShortcutCaptureState()
            check(capture.observe(event(.flags, code, flags)) == .pass, "recorder modifier down passes \(code)")
            check(capture.observe(event(.flags, code, 0, 1.2)) == .complete(.init(keyCode: code, modifiers: 0)), "recorder captures single modifier on release \(code)")
            var deliberate = VoiceShortcutCaptureState(initialKeys:[0,2])
            _ = deliberate.observe(event(.flags,code,flags|0x100,2))
            check(deliberate.observe(event(.flags,code,0x100,4)) == .complete(.init(keyCode:code,modifiers:0)),"recording allows deliberate long press and ignores stale A/D snapshots \(code)")
            var repeatHeld = VoiceHotkeyState(keyCode:code,modifiers:0,initialKeys:[8])
            _ = repeatHeld.observe(event(.down,8,0,1,repeat:true))
            _ = repeatHeld.observe(event(.flags,code,flags,1.1))
            check(!repeatHeld.observe(event(.flags,code,0,1.2)).fire,"real repeat confirms preheld ordinary key and blocks modifier tap \(code)")
            _ = repeatHeld.observe(event(.up,8,0,1.3))
            _ = repeatHeld.observe(event(.flags,code,flags,2))
            check(repeatHeld.observe(event(.flags,code,0,2.2)).fire,"fresh tap works after confirmed repeat is released \(code)")
            var staleRelease = VoiceHotkeyState(keyCode:code,modifiers:0,initialKeys:[0,2])
            _ = staleRelease.observe(event(.flags,code,flags,1))
            _ = staleRelease.observe(event(.up,0,flags,1.1))
            check(staleRelease.observe(event(.flags,code,0,1.2)).fire,"late stale-key release does not spoil a fresh modifier tap \(code)")
            var repeatFlags = VoiceHotkeyState(keyCode:code,modifiers:0)
            _ = repeatFlags.observe(event(.flags,code,info.flag,1))
            _ = repeatFlags.observe(event(.flags,code,info.flag,1.1))
            check(repeatFlags.observe(event(.flags,code,0,1.2)).fire,"aggregate-only duplicate flags delivery cannot simulate release \(code)")
        }

        // Literal macOS NX_DEVICE layouts plus NX_NONCOALSESCEDMASK. Do not derive
        // expected sides from the production lookup: that would hide mapping bugs.
        let physical:[(UInt32,UInt64,String)]=[(54,0x100110,"右 Command"),(55,0x100108,"左 Command"),(56,0x020102,"左 Shift"),(60,0x020104,"右 Shift"),(58,0x080120,"左 Option"),(61,0x080140,"右 Option"),(59,0x040101,"左 Control"),(62,0x042100,"右 Control"),(63,0x800100,"Fn")]
        for (code,flags,label) in physical {
            var delivery=VoiceShortcutDelivery(),recorder=VoiceShortcutCaptureState()
            let down=event(.flags,code,flags,10),up=event(.flags,code,0x100,12)
            check(delivery.shouldProcess(down,origin:.tap),"CG tap accepts physical modifier \(label)")
            check(recorder.observe(down) == .pass,"CG modifier down remains pass-through \(label)")
            var local=down;local.flags &= VoiceHotkeyPolicy.physicalFlagMask
            check(!delivery.shouldProcess(local,origin:.local),"local replay with stripped side bits is deduplicated \(label)")
            check(delivery.shouldProcess(up,origin:.tap),"CG tap accepts modifier release \(label)")
            check(recorder.observe(up) == .complete(.init(keyCode:code,modifiers:0)),"literal physical flags record correct side after two-second press \(label)")
            check(!delivery.shouldProcess(up,origin:.local),"local release replay is deduplicated \(label)")
            check(VoiceHotkey.label(keyCode:code,modifiers:0)==label,"literal layout has correct display label \(label)")
            var machine=VoiceHotkeyState(keyCode:code,modifiers:0,initialKeys:[0,2])
            _ = machine.observe(event(.flags,code,flags,20))
            check(machine.observe(event(.flags,code,0x100,20.2)).fire,"selected modifier triggers with literal physical flags despite stale snapshot \(label)")
        }
        var localOnly=VoiceShortcutDelivery()
        check(localOnly.shouldProcess(event(.flags,61,0x080140,1),origin:.local),"local monitor remains fallback when event tap misses event")
        check(localOnly.shouldProcess(event(.flags,61,0x100,1.2),origin:.local),"local-only release remains available")

        // Every other physical modifier, including the opposite side, cancels the tap.
        for first in VoiceHotkeyPolicy.modifierCodes.sorted() {
            let a = VoiceHotkeyPolicy.modifiers[first]!
            for second in VoiceHotkeyPolicy.modifierCodes.sorted() where second != first {
                let b = VoiceHotkeyPolicy.modifiers[second]!
                var machine = VoiceHotkeyState(keyCode: first, modifiers: 0)
                _ = machine.observe(event(.flags, first, a.flag | a.side))
                check(!machine.observe(event(.flags, second, a.flag | a.side | b.flag | b.side, 1.1)).fire, "two modifiers cannot fire \(first)/\(second)")
                check(!machine.observe(event(.flags, second, a.flag | a.side, 1.2)).fire, "second modifier release cannot rearm \(first)/\(second)")
                check(!machine.observe(event(.flags, first, 0, 1.3)).fire, "modifier chord final release ignored \(first)/\(second)")
            }
        }
        var sameFamily = VoiceHotkeyState(keyCode: 55, modifiers: 0)
        _ = sameFamily.observe(event(.flags, 55, command))
        _ = sameFamily.observe(event(.flags, 54, command, 1.1))
        _ = sameFamily.observe(event(.flags, 54, command, 1.2))
        check(!sameFamily.observe(event(.flags, 55, 0, 1.3)).fire, "aggregate-only two Command keys do not trigger")
        var wrongSide = VoiceHotkeyState(keyCode: 55, modifiers: 0)
        _ = wrongSide.observe(event(.flags, 54, command | 0x10))
        check(!wrongSide.observe(event(.flags, 54, 0, 1.2)).fire, "right Command does not trigger left Command binding")

        var normal = VoiceHotkeyState(keyCode: 0, modifiers: 0)
        check(normal.observe(event(.down, 0)) == .init(fire: true, consume: true), "single ordinary key fires and suppresses typed character")
        check(normal.observe(event(.down, 0, 0, 1.1, repeat: true)) == .init(consume: true), "ordinary repeat suppressed without firing")
        check(normal.observe(event(.up, 0, shift, 1.2)) == .init(consume: true), "claimed key-up consumed even if modifier changed")
        check(normal.observe(event(.down, 0, command, 2)) == .init(), "normal Command+A stays untouched")
        check(normal.observe(event(.up, 0, command, 2.1)) == .init(), "unclaimed combination key-up passes")
        check(normal.observe(event(.down, 0, fn, 3)) == .init(), "Fn+A does not trigger plain A")
        check(normal.observe(event(.down, 0, 0, 4, repeat: true)) == .init(), "unclaimed repeated key never begins recording")
        check(normal.observe(event(.down, 0, 0, 5)).fire, "fresh ordinary down works")
        check(normal.observe(event(.down, 0, 0, 6)).fire, "fresh down recovers missed key-up")
        _ = normal.observe(event(.interrupted, 0, 0, 6.1))
        check(normal.observe(event(.up, 0, 0, 6.2)) == .init(), "interruption removes stale suppression")

        var oldChord = VoiceHotkeyState(keyCode: 49, modifiers: control | option)
        check(oldChord.observe(event(.down, 49, control | option | 0x21)) == .init(fire: true, consume: true), "existing Ctrl Option Space still works with device flags")
        _ = oldChord.observe(event(.up, 49, control | option, 1.1))
        check(oldChord.observe(event(.down, 49, control | option | shift, 2)) == .init(), "extra modifier does not activate exact chord")
        var paste = VoiceHotkeyState(keyCode: 9, modifiers: command)
        check(paste.observe(event(.down, 9, command, 1, owned: true)) == .init(), "own Cmd V cannot trigger shortcut or get swallowed")
        check(paste.observe(event(.up, 9, command, 1.1, owned: true)) == .init(), "own paste key-up passes")
        check(paste.observe(event(.down, 9, command, 2)).fire, "human Cmd V binding still works")

        var recordOrdinary = VoiceShortcutCaptureState()
        check(recordOrdinary.observe(event(.down, 0)) == .consume, "recorder suppresses ordinary key-down")
        check(recordOrdinary.observe(event(.down, 0, 0, 1.1, repeat: true)) == .consume, "recorder suppresses repeat without completing")
        check(recordOrdinary.observe(event(.up, 0, 0, 1.2)) == .complete(.init(keyCode: 0, modifiers: 0)), "recorder saves normal single key on release")
        var recordCombo = VoiceShortcutCaptureState()
        _ = recordCombo.observe(event(.flags, 59, control | 1))
        _ = recordCombo.observe(event(.flags, 58, control | option | 0x21, 1.1))
        check(recordCombo.observe(event(.down, 49, control | option | 0x21, 1.2)) == .consume, "recorder accepts existing modifier chord")
        check(recordCombo.observe(event(.up, 49, control | option | 0x21, 1.3)) == .complete(.init(keyCode: 49, modifiers: control | option)), "recorder retains chord modifiers")
        var recordF8 = VoiceShortcutCaptureState()
        _ = recordF8.observe(event(.flags, 63, fn))
        _ = recordF8.observe(event(.down, 100, fn, 1.1))
        check(recordF8.observe(event(.up, 100, fn, 1.2)) == .complete(.init(keyCode: 100, modifiers: 0)), "Mac Fn F8 records F8, not Fn")
        var recordPreheld = VoiceShortcutCaptureState(initialFlags: command)
        check(recordPreheld.observe(event(.flags, 55, 0, 1.1)) == .pass, "recorder ignores modifier held before recording")
        check(recordPreheld.observe(event(.down, 53, 0, 1.2)) == .cancel, "Escape cancels capture")
        var recordInvalid = VoiceShortcutCaptureState()
        _ = recordInvalid.observe(event(.down, 0))
        _ = recordInvalid.observe(event(.down, 1, 0, 1.1))
        check(recordInvalid.observe(event(.up, 0, 0, 1.2)) == .consume, "multi-key capture waits for all keys to drain")
        check(recordInvalid.observe(event(.up, 1, 0, 1.3)) == .invalid, "two ordinary keys rejected")
        _ = recordInvalid.observe(event(.down, 100, 0, 2))
        check(recordInvalid.observe(event(.up, 100, 0, 2.1)) == .complete(.init(keyCode: 100, modifiers: 0)), "recorder recovers from invalid chord")
        var recordOwned = VoiceShortcutCaptureState()
        check(recordOwned.observe(event(.down, 9, command, 1, owned: true)) == .pass, "recorder ignores own paste")
        check(recordOwned.observe(event(.up, 9, command, 1.1, owned: true)) == .pass, "recorder ignores own paste release")
        _ = recordOwned.observe(event(.flags, 55, command | 8, 2))
        _ = recordOwned.observe(event(.down, 9, command, 2.1, owned: true))
        check(recordOwned.observe(event(.flags, 55, 0, 2.2)) == .pass, "own paste also cancels a pending modifier recording")
        check(recordOwned.observe(event(.interrupted)) == .cancel, "recorder interruption cancels")

        var esc = VoiceEscapeState()
        check(esc.observe(event(.down,53),enabled:false) == .init(), "Esc passes through outside dictation")
        check(esc.observe(event(.up,53),enabled:false) == .init(), "unclaimed Esc up passes")
        check(esc.observe(event(.down,53),enabled:true) == .init(fire:true,consume:true), "active dictation claims Esc and cancels once")
        check(esc.observe(VoiceHotkeyEvent(kind:.down,keyCode:53,isRepeat:true),enabled:false) == .init(fire:false,consume:true), "repeat remains consumed after cancellation")
        check(esc.observe(event(.up,53),enabled:false) == .init(fire:false,consume:true), "cancelled Esc release does not leak to focused app")
        check(esc.observe(VoiceHotkeyEvent(kind:.down,keyCode:53,isRepeat:true),enabled:true) == .init(), "preheld Esc repeat cannot cancel a new session")
        check(esc.observe(event(.down,53,0,2,owned:true),enabled:true) == .init(), "own synthetic events cannot cancel dictation")
        check(esc.observe(event(.down,0),enabled:true) == .init(), "ordinary typing is untouched")
        check(esc.observe(event(.down,53),enabled:true).fire, "a new physical Esc cancels the next session")
        _ = esc.observe(event(.interrupted),enabled:true)
        check(esc.observe(event(.down,53),enabled:true).fire, "listener interruption clears Esc ownership")

        print("HotkeyTests: \(passed) passed, \(failed) failed (pure events; no system input or permission changes)")
        if failed > 0 { exit(1) }
    }
}
