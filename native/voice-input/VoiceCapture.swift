import AppKit
import AVFoundation

enum VoiceCaptureError: LocalizedError {
    case permission, unavailable, cancelled, empty, silent
    var errorDescription: String? {
        switch self {
        case .permission: return "需要麦克风权限才能开始录音，请在系统设置中允许此实验版使用麦克风。"
        case .unavailable: return "麦克风暂时不可用，请检查输入设备后重试。"
        case .cancelled: return "录音已取消。"
        case .empty: return "没有可用的录音，请重新说话。"
        case .silent: return "录音太短或几乎没有输入声音，请检查麦克风后重新说话。"
        }
    }
}

// One PCM stream feeds both Realtime and the fallback WAV: no second microphone,
// no independently resampled audio and no missing tail when stop is pressed.
final class VoicePCMWriter: @unchecked Sendable {
    static let sampleRate = 24_000.0
    private let queue = DispatchQueue(label:"local.nuphylab.voiceinput.pcm",qos:.userInitiated)
    private let submissionLock=NSLock()
    private let inputFormat:AVAudioFormat
    private var accepting=true
    private let converter:AVAudioConverter
    private let output:AVAudioFormat
    private var file:AVAudioFile?
    private var pending=Data()
    private var frames:Int64=0
    private var peak:Float = -.infinity
    private var average:Double = 0
    private var failure:Error?
    private var closed=false
    init(input:AVAudioFormat,url:URL) throws {
        guard input.sampleRate>0,input.channelCount>0,let output=AVAudioFormat(commonFormat:.pcmFormatInt16,sampleRate:Self.sampleRate,channels:1,interleaved:true),let converter=AVAudioConverter(from:input,to:output) else {throw VoiceCaptureError.unavailable}
        inputFormat=input;self.output=output;self.converter=converter
        file=try AVAudioFile(forWriting:url,settings:output.settings,commonFormat:.pcmFormatInt16,interleaved:true)
    }
    func enqueue(_ input:AVAudioPCMBuffer) {
        // Serialize the copy+submission with final draining. Otherwise stop can close
        // the WAV while an already-running callback is still copying its last buffer.
        submissionLock.lock();defer{submissionLock.unlock()}
        guard accepting else{return}
        guard input.format==inputFormat else {
            queue.async { [self] in failure=VoiceCaptureError.unavailable };return
        }
        guard input.frameLength>0 else{return}
        // The hardware owns the render buffer. Copy before its callback returns.
        guard let copy=AVAudioPCMBuffer(pcmFormat:input.format,frameCapacity:input.frameLength) else {
            queue.async { [self] in failure=VoiceCaptureError.unavailable };return
        }
        copy.frameLength=input.frameLength
        let from=UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating:input.audioBufferList))
        let to=UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for i in 0..<min(from.count,to.count) {
            if let source=from[i].mData,let destination=to[i].mData {memcpy(destination,source,Int(from[i].mDataByteSize));to[i].mDataByteSize=from[i].mDataByteSize}
        }
        queue.async { [self] in
            guard !closed,failure==nil else{return}
            var supplied=false
            let capacity=AVAudioFrameCount(ceil(Double(copy.frameLength)*Self.sampleRate/copy.format.sampleRate)+64)
            guard let result=AVAudioPCMBuffer(pcmFormat:output,frameCapacity:capacity) else{failure=VoiceCaptureError.unavailable;return}
            var error:NSError?
            let status=converter.convert(to:result,error:&error) { _,state in
                if supplied {state.pointee = .noDataNow;return nil}
                supplied=true;state.pointee = .haveData;return copy
            }
            if status == .error {failure=error ?? VoiceCaptureError.unavailable as NSError;return}
            consume(result)
        }
    }
    private func consume(_ result:AVAudioPCMBuffer) {
        guard result.frameLength>0,let samples=result.int16ChannelData?[0] else{return}
        do {try file?.write(from:result)} catch {failure=error;return}
        let count=Int(result.frameLength)
        var sum=0.0,maximum=0.0
        for i in 0..<count {let value=Double(samples[i])/32768;sum += value*value;maximum=max(maximum,abs(value))}
        peak=max(peak,maximum>0 ? Float(20*log10(maximum)) : -.infinity)
        average=min(1,max(0,pow(sqrt(sum/Double(count)),20.0/35.0)))
        frames += Int64(count)
        pending.append(UnsafeRawPointer(samples).assumingMemoryBound(to:UInt8.self),count:count*2)
    }
    func drain(final:Bool=false)->(Data,Double,Float,Double,Error?) {
        submissionLock.lock();defer{submissionLock.unlock()}
        if final {accepting=false}
        return queue.sync {
            if final && !closed {
                // Drain resampler latency before closing the WAV and committing the turn.
                if let tail=AVAudioPCMBuffer(pcmFormat:output,frameCapacity:256) {
                    var error:NSError?
                    let status=converter.convert(to:tail,error:&error){ _,state in state.pointee = .endOfStream;return nil }
                    if status != .error {consume(tail)} else {failure=error ?? VoiceCaptureError.unavailable as NSError}
                }
                closed=true;file=nil
            }
            let data=pending;pending=Data()
            return (data,Double(frames)/Self.sampleRate,peak,average,failure)
        }
    }
}

// All hardware setup and teardown stay on one worker queue. Starting the audio
// device must not block the main run loop that paints the notch or handles Esc.
typealias VoiceCaptureDrain = (Data, Double, Float, Double, Error?)
protocol VoiceCaptureDevice: AnyObject {
    var startupTimings:[String:Double] { get }
    func start() async throws
    func drain() -> VoiceCaptureDrain
    func finish() throws -> VoiceCaptureDrain
    func cancel()
    func waitForCancellation()
}
extension VoiceCaptureDevice {func waitForCancellation() {};var startupTimings:[String:Double] {[:]}}
final class VoiceAudioDevice: VoiceCaptureDevice, @unchecked Sendable {
    private let queue = DispatchQueue(label:"local.nuphylab.voiceinput.device",qos:.userInitiated)
    private let lock = NSLock()
    private var cancelled = false
    private var engine: VoiceAudioInput?
    private var lease: VoiceAudioPreparation.Pool.Lease?
    private let startupGroup=DispatchGroup()
    private var measuredStartup:[String:Double]=[:]
    private var writer: VoicePCMWriter?
    private let url: URL
    private let onError: () -> Void
    init(url:URL,onError:@escaping () -> Void) { self.url=url;self.onError=onError }
    private var isCancelled:Bool { lock.lock();defer{lock.unlock()};return cancelled }
    var startupTimings:[String:Double] {queue.sync {measuredStartup}}
    func start() async throws {
        startupGroup.enter();defer{startupGroup.leave()}
        guard !isCancelled else{throw VoiceCaptureError.cancelled}
        let began=ProcessInfo.processInfo.systemUptime
        let acquired=try await VoiceAudioPreparation.shared.pool.take(cancelled:{[self] in isCancelled})
        let acquiredAt=ProcessInfo.processInfo.systemUptime
        try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Void,Error>) in
            queue.async { [self] in
                lease=acquired;engine=acquired.resource
                do {
                    guard !isCancelled else{throw VoiceCaptureError.cancelled}
                    let engine=acquired.resource
                    let writer=try VoicePCMWriter(input:engine.format,url:url)
                    self.writer=writer
                    try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
                    guard !isCancelled else{throw VoiceCaptureError.cancelled}
                    let startingAt=ProcessInfo.processInfo.systemUptime
                    try engine.start(sink:{writer.enqueue($0)},onError:onError)
                    let startedAt=ProcessInfo.processInfo.systemUptime
                    guard !isCancelled else{throw VoiceCaptureError.cancelled}
                    measuredStartup=["engineAcquire":acquiredAt-began,"captureSetup":startingAt-acquiredAt,"hardwareStart":startedAt-startingAt]
                    continuation.resume()
                } catch {
                    endEngine(reusable:false);_ = writer?.drain(final:true);writer=nil
                    Self.removeFile(url)
                    continuation.resume(throwing:error)
                }
            }
        }
    }
    private func endEngine(reusable:Bool=true) {
        engine?.stop();engine=nil
        if let lease {self.lease=nil;VoiceAudioPreparation.shared.pool.putBack(lease,reusable:reusable)}
    }
    func drain()->VoiceCaptureDrain { queue.sync { writer?.drain() ?? (Data(),0,-.infinity,0,nil) } }
    func finish() throws -> VoiceCaptureDrain {
        try queue.sync {
            guard !isCancelled,let writer else{throw VoiceCaptureError.empty}
            endEngine();let result=writer.drain(final:true);self.writer=nil;return result
        }
    }
    func cancel() {
        lock.lock();cancelled=true;lock.unlock()
        VoiceAudioPreparation.shared.pool.cancelWaiting()
        queue.async { [self] in endEngine();_ = writer?.drain(final:true);writer=nil;Self.removeFile(url) }
    }
    func waitForCancellation() {startupGroup.wait();queue.sync {}}
    // Queue-owned cleanup also covers cancellation during a slow engine.start().
    private static func removeFile(_ url:URL) { VoiceRecordingFiles.remove(url) }
}
enum VoiceRecordingFiles {
    static func remove(_ url:URL) {
        let parent=url.deletingLastPathComponent().standardizedFileURL
        guard url.lastPathComponent=="speech.wav",parent.lastPathComponent.hasPrefix("nuphy-voice-input-"),parent.deletingLastPathComponent()==FileManager.default.temporaryDirectory.standardizedFileURL else{return}
        try? FileManager.default.removeItem(at:parent)
    }
}

@MainActor final class VoiceCapture: NSObject {
    var onLevel: ((Double, TimeInterval) -> Void)?
    var onPCM: ((Data) -> Void)?
    var onError: ((Error) -> Void)?
    private var device: VoiceCaptureDevice?
    private var timer:Timer?
    private var generation=0
    private var maximumPower:Float = -.infinity
    private let permission: () async -> Bool
    private let makeDevice: (URL,@escaping () -> Void)->VoiceCaptureDevice
    private(set) var currentURL:URL?
    private(set) var duration:TimeInterval=0
    private(set) var peakLevel:Double=0
    private(set) var startupTimings:[String:Double]=[:]
    init(permission:@escaping () async -> Bool = VoiceCapture.requestPermission,
         makeDevice:@escaping (URL,@escaping () -> Void)->VoiceCaptureDevice = {VoiceAudioDevice(url:$0,onError:$1)}) {
        self.permission=permission;self.makeDevice=makeDevice;super.init()
    }
    nonisolated static func requestPermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for:.audio) {
        case .authorized:return true
        case .notDetermined:return await AVCaptureDevice.requestAccess(for:.audio)
        default:return false
        }
    }
    static var microphoneStatus:String {
        switch AVCaptureDevice.authorizationStatus(for:.audio) {
        case .authorized:return "authorized"
        case .notDetermined:return "notDetermined"
        case .denied:return "denied"
        case .restricted:return "restricted"
        @unknown default:return "unknown"
        }
    }
    func start() async throws -> URL {
        try Task.checkCancellation()
        cancel();let expected=generation
        let allowed=await permission()
        guard generation==expected,!Task.isCancelled else{throw VoiceCaptureError.cancelled}
        guard allowed else{throw VoiceCaptureError.permission}
        let folder=FileManager.default.temporaryDirectory.appendingPathComponent("nuphy-voice-input-"+UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let url=folder.appendingPathComponent("speech.wav");currentURL=url
        let next=makeDevice(url) { [weak self] in
            Task { @MainActor in
                guard let self,self.generation==expected,self.device != nil else{return}
                self.cancel();self.onError?(VoiceCaptureError.unavailable)
            }
        }
        device=next;duration=0;peakLevel=0;maximumPower = -.infinity;startupTimings=[:]
        do {
            try await next.start()
            guard generation==expected,!Task.isCancelled else{next.cancel();throw VoiceCaptureError.cancelled}
            startupTimings=next.startupTimings
            let tick=Timer(timeInterval:0.05,repeats:true){[weak self] _ in MainActor.assumeIsolated{self?.meter()}}
            timer=tick;RunLoop.main.add(tick,forMode:.common)
            return url
        } catch {
            // An older start may return after a new session has already begun.
            if generation==expected {cancel()} else {next.cancel()}
            throw error
        }
    }
    private func meter() {
        guard let device else{return}
        let (data,seconds,power,level,error)=device.drain()
        if error != nil {cancel();onError?(VoiceCaptureError.unavailable);return}
        duration=seconds;maximumPower=power;peakLevel=max(peakLevel,level)
        if !data.isEmpty {onPCM?(data)}
        onLevel?(level,duration)
    }
    func stop() throws -> URL {
        guard let device,let url=currentURL else{throw VoiceCaptureError.empty}
        timer?.invalidate();timer=nil
        let (data,seconds,power,_,error)=try device.finish()
        self.device=nil;currentURL=nil;duration=seconds;maximumPower=power
        if !data.isEmpty {onPCM?(data)}
        if error != nil {Self.removeRecording(at:url);throw VoiceCaptureError.unavailable}
        guard Self.hasUsableSignal(duration:duration,peakPower:maximumPower) else{Self.removeRecording(at:url);throw VoiceCaptureError.silent}
        return url
    }
    func cancel(waitForDevice:Bool=false) {
        generation += 1;timer?.invalidate();timer=nil
        if let device {device.cancel();if waitForDevice {device.waitForCancellation()}} else if let url=currentURL {Self.removeRecording(at:url)}
        device=nil;currentURL=nil
    }
    static func removeRecording(at url:URL) { VoiceRecordingFiles.remove(url) }
    static func hasUsableSignal(duration:TimeInterval,peakPower:Float)->Bool {duration>=0.2 && peakPower.isFinite && peakPower > -65}
}
