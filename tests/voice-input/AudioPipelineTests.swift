import Foundation
import AVFoundation

@main struct AudioPipelineTests {
    static var checks=0
    static func check(_ value:Bool,_ label:String){guard value else{fatalError(label)};checks += 1}
    @MainActor static func main() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("voice-pcm-test-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false)
        defer{try? FileManager.default.removeItem(at:root)}
        for sampleRate in [16_000.0,24_000.0,44_100.0,48_000.0] {
            let input=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:sampleRate,channels:1,interleaved:false)!
            let url=root.appendingPathComponent("\(Int(sampleRate)).wav")
            let writer=try VoicePCMWriter(input:input,url:url)
            var transmitted=Data()
            for part in 0..<10 {
                let count=AVAudioFrameCount(sampleRate/10)
                let buffer=AVAudioPCMBuffer(pcmFormat:input,frameCapacity:count)!
                buffer.frameLength=count
                for i in 0..<Int(count) {buffer.floatChannelData![0][i]=Float(sin(2*Double.pi*440*(Double(part)*sampleRate/10+Double(i))/sampleRate)*0.5)}
                writer.enqueue(buffer)
                let tick=writer.drain();transmitted.append(tick.0)
            }
            let final=writer.drain(final:true);transmitted.append(final.0)
            check(final.4==nil,"conversion failed")
            check(abs(final.1-1)<0.012,"wrong duration / dropped frames")
            check(final.2 > -7 && final.2 < -5,"wrong peak")
            let file=try AVAudioFile(forReading:url,commonFormat:.pcmFormatInt16,interleaved:true)
            check(file.processingFormat.sampleRate==24_000 && file.processingFormat.channelCount==1,"wrong format")
            let decoded=AVAudioPCMBuffer(pcmFormat:file.processingFormat,frameCapacity:AVAudioFrameCount(file.length))!
            try file.read(into:decoded)
            let disk=Data(bytes:decoded.int16ChannelData![0],count:Int(decoded.frameLength)*2)
            check(disk==transmitted,"realtime bytes differ from fallback WAV")
            check(writer.drain(final:true).0.isEmpty,"tail duplicated after second stop")
        }
        let format=AVAudioFormat(commonFormat:.pcmFormatInt16,sampleRate:24_000,channels:1,interleaved:true)!
        let oneSecond=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:24_000)!
        oneSecond.frameLength=24_000
        for i in 0..<24_000 {oneSecond.int16ChannelData![0][i]=1000}
        let cappedURL=root.appendingPathComponent("long-recording.wav")
        let capped=try VoicePCMWriter(input:format,url:cappedURL)
        // Both transports retain audio beyond the former two-minute cutoff.
        for _ in 0..<122 {capped.enqueue(oneSecond)}
        let limit=capped.drain(final:true)
        check(limit.4==nil && limit.1==122,"recording must continue past two minutes")
        check(limit.0.count==24_000*2*122,"stream must include audio after two minutes")
        let cappedFile=try AVAudioFile(forReading:cappedURL)
        check(cappedFile.length==24_000*122,"disk audio must include the tail past two minutes")
        capped.enqueue(oneSecond)
        let closed=capped.drain(final:true)
        check(closed.0.isEmpty && closed.1==limit.1,"late device callback reopened a finished turn")
        let mismatch=try VoicePCMWriter(input:format,url:root.appendingPathComponent("changed-device.wav"))
        let otherFormat=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:48_000,channels:2,interleaved:false)!
        let deviceBuffer=AVAudioPCMBuffer(pcmFormat:otherFormat,frameCapacity:64)!
        deviceBuffer.frameLength=64
        mismatch.enqueue(deviceBuffer)
        let failed=mismatch.drain(final:true)
        check(failed.4 != nil,"device format change must report failure before conversion")
        check(failed.0.isEmpty && failed.1==0,"incompatible device audio must not reach either transport")
        let capture=VoiceCapture()
        let cancelled=Task { @MainActor in try await capture.start() }
        cancelled.cancel()
        do {_ = try await cancelled.value;check(false,"cancelled start unexpectedly began recording")}
        catch {check(error is CancellationError,"cancelled start must exit before requesting microphone")}
        check(capture.currentURL==nil,"cancelled start created a recording")
        print("PASS \(checks) audio pipeline checks; generated sine waves only, no microphone or API")
    }
}
