import AppKit
import AVFoundation

// Controlled device: never opens a microphone or sends audio. Complete startup
// in arbitrary order to reproduce cancel/restart races deterministically.
final class DeferredDevice:VoiceCaptureDevice {
    var continuation:CheckedContinuation<Void,Error>?
    var cancellations=0
    var finishes=0
    var waits=0
    let url:URL
    let failure:()->Void
    init(_ url:URL,_ failure:@escaping ()->Void) { self.url=url;self.failure=failure;try! Data([1,2]).write(to:url) }
    func start() async throws {try await withCheckedThrowingContinuation{continuation=$0}}
    func complete(_ error:Error?=nil) {let pending=continuation;continuation=nil;if let error{pending?.resume(throwing:error)}else{pending?.resume()}}
    func drain()->VoiceCaptureDrain {(Data(),0.5,-10,0.5,nil)}
    func finish() throws ->VoiceCaptureDrain {finishes += 1;return(Data([7,8]),0.5,-10,0.5,nil)}
    func waitForCancellation() {waits += 1}
    func cancel() {cancellations += 1;VoiceRecordingFiles.remove(url)}
}

@main struct CaptureStartupTests {
    @MainActor static func main() async throws {
        var checks=0
        func check(_ value:Bool,_ label:String){guard value else{fatalError(label)};checks += 1}
        var devices:[DeferredDevice]=[]
        var errors=0
        let capture=VoiceCapture(permission:{true},makeDevice:{url,failure in let d=DeferredDevice(url,failure);devices.append(d);return d})
        capture.onError={_ in errors += 1}
        let first=Task {try await capture.start()}
        while devices.first?.continuation == nil {await Task.yield()}
        check(capture.currentURL==devices[0].url,"pending start has isolated recording")
        let cancelBegan=ProcessInfo.processInfo.systemUptime
        capture.cancel();first.cancel()
        check(ProcessInfo.processInfo.systemUptime-cancelBegan<0.1,"cancel does not wait for slow device start")
        check(capture.currentURL==nil && devices[0].cancellations==1,"Esc clears pending device immediately")
        let second=Task {try await capture.start()}
        while devices.count<2 || devices[1].continuation==nil {await Task.yield()}
        devices[1].complete()
        let secondURL=try await second.value
        check(capture.currentURL==secondURL,"second session becomes ready")
        devices[0].complete()
        do {_ = try await first.value;fatalError("cancelled startup succeeded")} catch {checks += 1}
        check(capture.currentURL==secondURL && devices[1].cancellations==0,"late old start cannot cancel new microphone")
        devices[0].failure();await Task.yield()
        check(errors==0,"late old hardware notification ignored")
        check(!FileManager.default.fileExists(atPath:devices[0].url.path),"cancelled startup leaves no audio file")
        var tail=Data();capture.onPCM={tail.append($0)}
        let result=try capture.stop()
        check(result==secondURL && tail==Data([7,8]),"normal stop preserves last PCM before processing")
        check(devices[1].finishes==1 && capture.currentURL==nil,"normal stop relinquishes device")
        check(FileManager.default.fileExists(atPath:result.path),"completed WAV remains available for ASR")
        VoiceCapture.removeRecording(at:result)
        let third=Task {try await capture.start()}
        while devices.count<3 || devices[2].continuation==nil {await Task.yield()}
        devices[2].complete(VoiceCaptureError.unavailable)
        do {_ = try await third.value;fatalError("failed device startup succeeded")} catch {checks += 1}
        check(capture.currentURL==nil && devices[2].cancellations>0,"failed start releases file/device")
        var madeDenied=false
        let denied=VoiceCapture(permission:{false},makeDevice:{_,_ in madeDenied=true;fatalError("must not make device")})
        do {_ = try await denied.start();fatalError("ungranted microphone started")} catch {checks += 1}
        check(!madeDenied && denied.currentURL==nil,"permission denial never creates recording")
        var permissionContinuation:CheckedContinuation<Bool,Never>?
        let waiting=VoiceCapture(permission:{await withCheckedContinuation{permissionContinuation=$0}},makeDevice:{_,_ in fatalError("cancelled permission must not create device")})
        let pendingPermission=Task {try await waiting.start()}
        while permissionContinuation==nil {await Task.yield()}
        waiting.cancel();pendingPermission.cancel();permissionContinuation?.resume(returning:true)
        do {_ = try await pendingPermission.value;fatalError("late permission started recording")}catch {checks += 1}
        check(waiting.currentURL==nil,"late permission after Esc cannot open microphone")
        let quitting=Task {try await capture.start()}
        while devices.count<4 || devices[3].continuation==nil {await Task.yield()}
        devices[3].complete();_ = try await quitting.value
        capture.cancel(waitForDevice:true)
        check(devices[3].waits==1 && !FileManager.default.fileExists(atPath:devices[3].url.path),"app quit waits for device cleanup")
        check(devices[0].waits==0,"Esc cancellation never blocks the interface")
        print("PASS \(checks) startup/cancel/restart tests; no microphone, API or insertion")
    }
}
