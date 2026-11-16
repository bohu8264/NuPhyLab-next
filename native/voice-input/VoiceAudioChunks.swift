import Foundation
import AVFoundation

// Record to disk without a time cutoff. File APIs receive bounded WAV parts only
// after Stop. Prefer silence; a forced cut overlaps 600 ms to retain word endings.
struct VoiceAudioChunk: Sendable {
    let start: Int64
    let end: Int64
    let overlapsPrevious: Bool
}

enum VoiceAudioChunks {
    static let sampleRate = 24_000
    static func secondsPerRequest(settings: VoiceSettings) -> Int {
        if settings.asrProvider == "deepseek" { return 115 }
        if settings.asrProvider == "alibaba" {return 140} // Base64 WAV + vocabulary stays below the documented 10 MB input cap.
        let origin = (try? VoiceSettings.endpointURL(settings.asrEndpoint)).map(VoiceSettings.origin)
        if origin == "https://api.openai.com:443" { return 480 }
        if origin == "https://api.siliconflow.cn:443" { return 900 }
        return 115 // Conservative default for compatible gateways with unknown limits.
    }

    static func open(_ url: URL) throws -> AVAudioFile {
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatInt16, interleaved: true)
        guard file.processingFormat.sampleRate == Double(sampleRate), file.processingFormat.channelCount == 1,
              file.length > 0 else { throw VoiceAPIError.invalid("录音格式不兼容，未发送。") }
        return file
    }

    static func plan(url: URL, secondsPerRequest: Int) throws -> [VoiceAudioChunk] {
        let file = try open(url)
        let budget = Int64(max(2, secondsPerRequest) * sampleRate)
        let overlap = Int64(sampleRate * 3 / 5)
        var start: Int64 = 0, overlaps = false
        var chunks: [VoiceAudioChunk] = []
        while start < file.length {
            try Task.checkCancellation()
            let end = min(start + budget, file.length)
            if end == file.length {
                chunks.append(.init(start: start, end: end, overlapsPrevious: overlaps)); break
            }
            // Search the last ten seconds for >= 320 ms of quiet audio.
            let windowStart = max(start + budget / 2, end - Int64(10 * sampleRate))
            let samples = try pcm(file: file, start: windowStart, count: end - windowStart)
            let cut = silenceCut(samples, offset: windowStart)
            let boundary = cut ?? end
            chunks.append(.init(start: start, end: boundary, overlapsPrevious: overlaps))
            overlaps = cut == nil
            start = overlaps ? boundary - overlap : boundary
        }
        return chunks
    }

    private static func silenceCut(_ data: Data, offset: Int64) -> Int64? {
        let window = sampleRate / 50 // 20 ms
        var quietWindows = 0, latest: Int64?
        data.withUnsafeBytes { bytes in
            let samples = bytes.bindMemory(to: Int16.self)
            for start in stride(from: 0, through: max(-1, samples.count - window), by: window) {
                var energy = 0.0, peak = 0.0
                for i in start..<(start + window) { let v = Double(Int16(littleEndian: samples[i])); energy += v * v; peak = max(peak, abs(v)) }
                if sqrt(energy / Double(window)) < 64 && peak < 128 { quietWindows += 1 } else { quietWindows = 0 }
                if quietWindows >= 16 { latest = offset + Int64(start - 7 * window) }
            }
        }
        return latest
    }

    private static func pcm(file: AVAudioFile, start: Int64, count: Int64) throws -> Data {
        file.framePosition = start
        guard count > 0, count <= Int64(UInt32.max),
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 48_000) else {
            throw VoiceAPIError.invalid("无法读取本次录音。")
        }
        var remaining = count, data = Data()
        data.reserveCapacity(Int(count) * 2)
        while remaining > 0 {
            try Task.checkCancellation()
            try file.read(into: buffer, frameCount: AVAudioFrameCount(min(remaining, 48_000)))
            guard buffer.frameLength > 0, let samples = buffer.int16ChannelData?[0] else { throw VoiceAPIError.incomplete }
            data.append(UnsafeRawPointer(samples).assumingMemoryBound(to: UInt8.self), count: Int(buffer.frameLength) * 2)
            remaining -= Int64(buffer.frameLength)
        }
        return data
    }

    static func wav(url: URL, chunk: VoiceAudioChunk) throws -> Data {
        try Task.checkCancellation()
        let file = try open(url)
        guard chunk.start >= 0, chunk.end <= file.length, chunk.end > chunk.start else { throw VoiceAPIError.incomplete }
        let data = try pcm(file: file, start: chunk.start, count: chunk.end - chunk.start)
        var result = Data()
        func ascii(_ value: String) { result.append(Data(value.utf8)) }
        func u32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { result.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { result.append(contentsOf: $0) } }
        ascii("RIFF"); u32(UInt32(data.count + 36)); ascii("WAVEfmt "); u32(16)
        u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        ascii("data"); u32(UInt32(data.count)); result.append(data)
        return result
    }

    // Only join at artificial, overlapping cuts. Leave semantic deduplication to
    // the unchanged full-text cleanup prompt; never deduplicate separate thoughts.
    static func join(_ parts: [String], chunks: [VoiceAudioChunk]) -> String {
        var result = ""
        for (i, part) in parts.enumerated() {
            var next = part.trimmingCharacters(in: .whitespacesAndNewlines)
            var joinedOverlap = false
            if i > 0, chunks[i].overlapsPrevious {
                let tail = Array(result.suffix(80)), head = Array(next.prefix(80))
                let maximum = min(tail.count, head.count)
                if maximum >= 6 {
                    for count in stride(from: maximum, through: 6, by: -1) {
                        if Array(tail.suffix(count)) == Array(head.prefix(count)) {
                            next = String(next.dropFirst(count)); joinedOverlap = true; break
                        }
                    }
                }
            }
            if !next.isEmpty { result += (result.isEmpty || joinedOverlap ? "" : "\n") + next }
        }
        return result
    }
}
