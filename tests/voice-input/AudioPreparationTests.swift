import Foundation
import CoreAudio

final class LockedValue<T>: @unchecked Sendable {
    private let lock=NSLock()
    private var value:T
    init(_ value:T){self.value=value}
    func read()->T {lock.lock();defer{lock.unlock()};return value}
    func change(_ action:(inout T)->Void) {lock.lock();defer{lock.unlock()};action(&value)}
}
final class FakePreparedAudio {let route:Int;init(_ route:Int){self.route=route}}
@main struct AudioPreparationTests {
    static func main() async throws {
        var checks=0
        func check(_ ok:Bool,_ label:String){guard ok else{fatalError(label)};checks += 1}
        func until(_ condition:()->Bool) async throws {
            for _ in 0..<1000 {if condition(){return};try await Task.sleep(nanoseconds:1_000_000)}
            fatalError("timed out waiting for test transition")
        }
        let inputs=[VoiceMicrophone(id:1,uid:"built-in",name:"Mac"),VoiceMicrophone(id:2,uid:"usb-mic",name:"USB")]
        check(VoiceMicrophones.resolve(uid:"",inputs:inputs,systemDefault:2)==2,"automatic follows default")
        check(VoiceMicrophones.resolve(uid:"built-in",inputs:inputs,systemDefault:2)==1,"explicit mic ignores different default")
        check(VoiceMicrophones.resolve(uid:"usb-mic",inputs:inputs,systemDefault:1)==2,"explicit selection remains after system route switch")
        check(VoiceMicrophones.resolve(uid:"usb-mic",inputs:[inputs[0]],systemDefault:1)==0,"disconnected fixed device never falls back")
        check(VoiceMicrophones.resolve(uid:"usb-mic",inputs:[VoiceMicrophone(id:8,uid:"usb-mic",name:"USB")],systemDefault:1)==8,"stable UID resolves new device ID after reconnection")
        check(VoiceMicrophones.resolve(uid:"",inputs:[],systemDefault:0)==0,"no microphone stays unavailable")
        check(VoiceAudioRoute(input:1,output:2,selection:"") != VoiceAudioRoute(input:1,output:2,selection:"built-in"),"follow-system and fixed route policies are distinct")
        check(VoiceAudioRoute(input:1,output:2,inputRate:24000) != VoiceAudioRoute(input:1,output:2,inputRate:48000),"same hardware with changed format invalidates preparation")
        let route=LockedValue(1),allowed=LockedValue(true),created=LockedValue(0),disposed=LockedValue(0)
        typealias Pool=VoicePreparedResource<FakePreparedAudio,Int>
        let pool=Pool(currentRoute:{route.read()},mayPrepare:{allowed.read()},make:{key in created.change{$0 += 1};return FakePreparedAudio(key)},dispose:{_ in disposed.change{$0 += 1}})
        pool.prewarm();pool.drain()
        check(created.read()==1 && pool.diagnostics["prepared"] as? Bool == true,"startup prepares one stopped resource")
        pool.prewarm();pool.prewarm();pool.drain()
        check(created.read()==1,"repeated preparation does not reopen device")
        let first=try await pool.take(cancelled:{false})
        check(first.resource.route==1 && pool.diagnostics["borrowed"] as? Bool == true,"prepared route is borrowed exclusively")
        let cancelled=LockedValue(false)
        let waiting=Task {try await pool.take(cancelled:{cancelled.read()})}
        try await until{pool.diagnostics["waiting"] as? Int == 1}
        check(created.read()==1,"a second start does not initialize a competing device")
        cancelled.change{$0=true};pool.cancelWaiting()
        do {_ = try await waiting.value;fatalError("cancelled waiter succeeded")}catch{checks += 1}
        check(pool.diagnostics["borrowed"] as? Bool == true,"cancelling waiter preserves active capture")
        pool.putBack(first,reusable:true);pool.drain()
        let second=try await pool.take(cancelled:{false})
        check(first.resource === second.resource && first.token != second.token,"stopped engine is reused with a fresh lease")
        pool.putBack(first,reusable:true);pool.drain()
        check(pool.diagnostics["borrowed"] as? Bool == true,"duplicate old return cannot release new recording")
        let next=Task {try await pool.take(cancelled:{false})}
        try await until{pool.diagnostics["waiting"] as? Int == 1}
        pool.putBack(second,reusable:true)
        let third=try await next.value
        check(third.resource === first.resource && created.read()==1,"next session waits for old teardown and reuses engine")
        pool.invalidate(onlyIfRouteChanged:true);pool.drain()
        check(disposed.read()==0,"unchanged default device notification does not discard engine")
        route.change{$0=2};pool.invalidate(onlyIfRouteChanged:true);pool.drain()
        check(created.read()==1 && disposed.read()==0,"device change never disposes an active borrower")
        pool.putBack(third,reusable:true);pool.drain()
        check(created.read()==2 && disposed.read()==1,"old device discarded and new route prepared after stop")
        let fourth=try await pool.take(cancelled:{false})
        check(fourth.resource.route==2,"next recording follows current default microphone")
        pool.invalidate(resource:first.resource);pool.drain()
        pool.putBack(fourth,reusable:true);pool.drain()
        check(created.read()==2,"late config event from retired engine does not invalidate new engine")
        pool.invalidate(resource:fourth.resource);pool.drain()
        check(created.read()==3 && disposed.read()==2,"current idle engine configuration change rebuilds it")
        let fifth=try await pool.take(cancelled:{false})
        pool.putBack(fifth,reusable:false);pool.drain()
        check(created.read()==4 && disposed.read()==3,"failed start engine is not reused")
        let sixth=try await pool.take(cancelled:{false})
        let duringQuit=Task {try await pool.take(cancelled:{false})}
        try await until{pool.diagnostics["waiting"] as? Int == 1}
        pool.shutdown()
        do {_ = try await duringQuit.value;fatalError("quit waiter succeeded")}catch{checks += 1}
        check(disposed.read()==3,"shutdown does not destroy a running borrow")
        pool.putBack(sixth,reusable:true);pool.drain()
        check(disposed.read()==4 && pool.diagnostics["prepared"] as? Bool == false,"final stopped engine is disposed on shutdown")
        do {_ = try await pool.take(cancelled:{false});fatalError("closed pool started")}catch{checks += 1}
        pool.prewarm();pool.drain();check(created.read()==4,"closed pool cannot restart preparation")

        // Route changes and Esc can arrive during the expensive lazy initializer.
        let gate=DispatchSemaphore(value:0),entered=LockedValue(false),slowRoute=LockedValue(1),slowCancelled=LockedValue(false),slowDisposed=LockedValue(0)
        let slow=Pool(currentRoute:{slowRoute.read()},mayPrepare:{true},make:{key in entered.change{$0=true};gate.wait();return FakePreparedAudio(key)},dispose:{_ in slowDisposed.change{$0 += 1}})
        let cold=Task {try await slow.take(cancelled:{slowCancelled.read()})}
        try await until{entered.read()}
        slowCancelled.change{$0=true};gate.signal()
        do {_ = try await cold.value;fatalError("late cancelled initialization succeeded")}catch{checks += 1}
        check(slow.diagnostics["prepared"] as? Bool == true,"cancelled cold start can retain stopped initialized engine")
        slowRoute.change{$0=2};gate.signal()
        let newRoute=try await slow.take(cancelled:{false})
        check(newRoute.resource.route==2 && slowDisposed.read()==1,"checkout rechecks route even before listener notification")
        slow.putBack(newRoute,reusable:true);slow.drain();slow.shutdown()

        let noPermissionCreates=LockedValue(0)
        let ungranted=Pool(currentRoute:{1},mayPrepare:{false},make:{key in noPermissionCreates.change{$0 += 1};return FakePreparedAudio(key)},dispose:{_ in})
        ungranted.prewarm();ungranted.drain();check(noPermissionCreates.read()==0,"background preparation never requests microphone permission")
        ungranted.shutdown()
        print("PASS \(checks) preparation ownership/route/cancellation tests; fake resources only, no microphone or API")
    }
}
