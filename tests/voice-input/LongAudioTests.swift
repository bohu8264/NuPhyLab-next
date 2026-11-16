import Foundation
import AVFoundation
import Darwin

private actor ChunkFixture {
    var active = 0, peak = 0, cancelled = 0
    func run(_ chunk: VoiceAudioChunk, fail: Bool = false) async throws -> String {
        active += 1; peak = max(peak, active)
        defer { active -= 1 }
        do { try await Task.sleep(nanoseconds: chunk.start == 0 ? 35_000_000 : 5_000_000) }
        catch { cancelled += 1; throw error }
        if fail && chunk.start == 1 { throw VoiceAPIError.http(429) }
        return "第\(chunk.start)段"
    }
    func state() -> (Int, Int, Int) { (active, peak, cancelled) }
}

@main struct LongAudioTests {
    static var checks = 0
    static func check(_ value: Bool, _ message: String) {
        guard value else { fputs("FAIL: \(message)\n", stderr); exit(1) }
        checks += 1
    }
    static func generated(_ url: URL, silence: Bool) throws {
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
        let writer = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 24000)!
        buffer.frameLength = 24000
        for second in 0..<245 {
            for i in 0..<24000 {
                buffer.int16ChannelData![0][i] = silence && (second == 112 || second == 220) ? 0 : Int16(1000 + second + i % 500)
            }
            try writer.write(from: buffer)
        }
    }
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("voice-long-fixture-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        for silence in [false, true] {
            let url = root.appendingPathComponent(silence ? "pauses.wav" : "continuous.wav")
            try generated(url, silence: silence)
            let chunks = try VoiceAudioChunks.plan(url: url, secondsPerRequest: 115)
            check(chunks.count == 3, "245-second recording needs three DeepSeek requests")
            check(chunks.first!.start == 0 && chunks.last!.end == 245 * 24000, "head and final seconds retained")
            let source = try VoiceAudioChunks.open(url)
            let all = AVAudioPCMBuffer(pcmFormat: source.processingFormat, frameCapacity: 24000)!
            var original = Data()
            while source.framePosition < source.length {
                try source.read(into: all)
                guard all.frameLength > 0 else { throw VoiceAPIError.incomplete }
                original.append(UnsafeRawPointer(all.int16ChannelData![0]).assumingMemoryBound(to: UInt8.self), count: Int(all.frameLength) * 2)
            }
            check(original.count == 245 * 48000, "complete source fixture before sample comparison")
            for (index, chunk) in chunks.enumerated() {
                let wav = try VoiceAudioChunks.wav(url: url, chunk: chunk)
                check(wav.count < 8 * 1024 * 1024, "each request fits provider size")
                check(chunk.end - chunk.start <= 115 * 24000, "each request fits provider duration")
                check(wav.dropFirst(44) == original[(Int(chunk.start) * 2)..<(Int(chunk.end) * 2)], "all generated samples preserved")
                let partURL = root.appendingPathComponent("part.wav")
                try wav.write(to: partURL)
                check(try VoiceAudioChunks.open(partURL).length == chunk.end - chunk.start, "WAV is decodable with exact duration")
                if index > 0 {
                    check(chunk.start <= chunks[index - 1].end, "no audio gap between requests")
                    check(chunk.overlapsPrevious == !silence, "silence cut avoids overlap; continuous speech keeps context")
                }
            }
            check(try VoiceAudioChunks.plan(url: url, secondsPerRequest: 480).count == 1, "OpenAI keeps under-size long recording in one request")
        }
        var settings = VoiceSettings()
        check(VoiceAudioChunks.secondsPerRequest(settings: settings) == 480, "OpenAI file budget")
        settings.asrProvider = "deepseek"
        check(VoiceAudioChunks.secondsPerRequest(settings: settings) == 115, "DeepSeek duration budget")
        settings.asrProvider = "openai"; settings.asrEndpoint = "https://api.siliconflow.cn/v1/audio/transcriptions"
        check(VoiceAudioChunks.secondsPerRequest(settings: settings) == 900, "SiliconFlow file budget")
        settings.asrEndpoint = "https://gateway.example/v1/audio/transcriptions"
        check(VoiceAudioChunks.secondsPerRequest(settings: settings) == 115, "unknown gateway conservative budget")

        let chunks = (0..<6).map { VoiceAudioChunk(start: Int64($0), end: Int64($0 + 1), overlapsPrevious: false) }
        let fixture = ChunkFixture()
        let text = try await VoiceAPI.transcribeChunks(chunks) { try await fixture.run($0) }
        check(text == (0..<6).map { "第\($0)段" }.joined(separator: "\n"), "out-of-order results restored to recording order")
        check(await fixture.state().1 == 2, "at most two concurrent requests")
        let failing = ChunkFixture()
        do { _ = try await VoiceAPI.transcribeChunks(chunks) { try await failing.run($0, fail: true) }; check(false, "partial failure accepted") }
        catch { check(await failing.state().0 == 0, "failure drains and cancels outstanding requests") }
        let cancellable = ChunkFixture()
        let work = Task { try await VoiceAPI.transcribeChunks(chunks) { try await cancellable.run($0) } }
        try await Task.sleep(nanoseconds: 2_000_000); work.cancel()
        do { _ = try await work.value; check(false, "cancelled result returned") }
        catch { check(error is CancellationError, "Esc-style cancellation returns no partial text") }
        check(await cancellable.state().0 == 0, "cancellation leaves no active upload")
        let overlaps = [chunks[0], VoiceAudioChunk(start: 1, end: 2, overlapsPrevious: true)]
        check(VoiceAudioChunks.join(["开头，这是连续的一句话", "这是连续的一句话，尾句"], chunks: overlaps) == "开头，这是连续的一句话，尾句", "only artificial overlap is deduplicated")
        check(VoiceAudioChunks.join(["必须保留重复的话", "必须保留重复的话"], chunks: Array(chunks.prefix(2))) == "必须保留重复的话\n必须保留重复的话", "separate thoughts never deduplicated locally")
        print("PASS \(checks) long-audio checks; generated 245-second WAVs, mock requests only; no microphone/provider calls")
    }
}
