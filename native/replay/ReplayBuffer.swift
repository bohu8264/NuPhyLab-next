import AVFoundation
import VideoToolbox

enum ReplayError: LocalizedError {
    case unavailable, encoder(OSStatus), empty, export
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Screen recording is unavailable."
        case .encoder(let code): return "The hardware video encoder failed (\(code))."
        case .empty: return "The first frame is not ready yet."
        case .export: return "The replay could not be saved."
        }
    }
}

struct ReplayClip {
    let samples: [CMSampleBuffer]
    let start: CMTime
    let end: CMTime

    // The first sample is always a keyframe. MP4 edit timing trims any leading
    // part of that group so the public clip ends at the original button press.
    func write(to destination: URL) async throws {
        guard let format = samples.first?.formatDescription else { throw ReplayError.empty }
        let fm = FileManager.default
        let folder = destination.deletingLastPathComponent()
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let temporary = folder.appendingPathComponent(".\(UUID().uuidString).mp4")
        defer { try? fm.removeItem(at: temporary) }
        let writer = try AVAssetWriter(outputURL: temporary, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: format)
        guard writer.canAdd(input) else { throw ReplayError.export }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? ReplayError.export }
        defer { if writer.status == .writing { writer.cancelWriting() } }
        writer.startSession(atSourceTime: start)
        for sample in samples {
            let timeout = ProcessInfo.processInfo.systemUptime + 8
            while !input.isReadyForMoreMediaData {
                guard writer.status == .writing, ProcessInfo.processInfo.systemUptime < timeout else {
                    throw writer.error ?? ReplayError.export
                }
                try await Task.sleep(nanoseconds: 3_000_000)
            }
            try Task.checkCancellation()
            guard input.append(sample) else { throw writer.error ?? ReplayError.export }
        }
        writer.endSession(atSourceTime: end)
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? ReplayError.export }
        try Task.checkCancellation()
        try fm.moveItem(at: temporary, to: destination)
    }
}

final class ReplayBuffer {
    static let duration = CMTime(value: 15, timescale: 1)
    static let byteLimit = 16 * 1024 * 1024
    private struct Group {
        let start: CMTime
        var samples: [CMSampleBuffer] = []
        var bytes = 0
    }
    private let lock = NSLock()
    private let limit: Int
    private var groups: [Group] = []
    private var acceptsSamples = true
    private var nextFrameTime = -Double.infinity
    // The hardware bitrate is a target. Pace unusually large frames so rapid
    // full-screen motion keeps its time span inside the same memory budget.
    private static let bytesPerSecond = 650_000.0
    func acceptsFrame(at time: CMTime) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return acceptsSamples && time.seconds >= nextFrameTime
    }
    private var bytes = 0

    init(limit: Int = ReplayBuffer.byteLimit) { self.limit = limit }

    func append(_ sample: CMSampleBuffer) {
        let pts = sample.presentationTimeStamp
        guard pts.isNumeric, sample.dataReadiness == .ready else { return }
        let flags = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]])?.first
        let key = flags?[kCMSampleAttachmentKey_NotSync as String] as? Bool != true
        lock.lock(); defer { lock.unlock() }
        guard acceptsSamples else { return }
        if let last = groups.last?.samples.last, pts <= last.presentationTimeStamp { return }
        if key { groups.append(Group(start: pts)) }
        guard !groups.isEmpty else { return }
        let size = sample.totalSampleSize
        nextFrameTime = max(nextFrameTime, pts.seconds - 0.35) + Double(size) / Self.bytesPerSecond
        groups[groups.count-1].samples.append(sample)
        groups[groups.count-1].bytes += size
        bytes += size
        // Allow for frames already queued between the physical press and the snapshot.
        let cutoff = pts - Self.duration - CMTime(value:1,timescale:1)
        while groups.count > 1 && (groups[1].start <= cutoff || bytes > limit) {
            bytes -= groups.removeFirst().bytes
        }
        if bytes > limit { groups.removeAll(); bytes = 0 }
    }

    func snapshot(at trigger: CMTime) throws -> ReplayClip {
        lock.lock(); defer { lock.unlock() }
        guard let first = groups.first?.start, first <= trigger else { throw ReplayError.empty }
        let start = CMTimeMaximum(first, trigger - Self.duration)
        let index = groups.lastIndex(where: { $0.start <= start }) ?? 0
        let samples = groups[index...].flatMap(\.samples).prefix { $0.presentationTimeStamp <= trigger }
        guard let last = samples.last, (trigger - last.presentationTimeStamp).seconds < 2.5 else { throw ReplayError.empty }
        return ReplayClip(samples: Array(samples), start: start, end: CMTimeMaximum(start + CMTime(value:1,timescale:600), trigger))
    }

    func clear(closing: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        if closing { acceptsSamples = false }
        nextFrameTime = -Double.infinity
        groups.removeAll(); bytes = 0
    }
}

final class ReplayEncoder {
    let buffer = ReplayBuffer()
    private var session: VTCompressionSession?
    private let slots = DispatchSemaphore(value: 3)
    var failed: (OSStatus) -> Void = { _ in }

    init(width: Int, height: Int) throws {
        let spec = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264, encoderSpecification: spec, imageBufferAttributes: nil,
            compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &session)
        guard status == noErr, let session else { throw ReplayError.encoder(status) }
        let props: [CFString: Any] = [kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_AllowFrameReordering: false, kVTCompressionPropertyKey_AverageBitRate: 4_000_000,
            kVTCompressionPropertyKey_MaxKeyFrameInterval: 30, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 1,
            kVTCompressionPropertyKey_ExpectedFrameRate: 30]
        var result = VTSessionSetProperties(session, propertyDictionary: props as CFDictionary)
        if result == noErr {
            // Some encoder/OS pairs only implement the average target.
            VTSessionSetProperty(session,key:kVTCompressionPropertyKey_DataRateLimits,value:[750_000,1] as CFArray)
            result = VTCompressionSessionPrepareToEncodeFrames(session)
        }
        guard result == noErr else { VTCompressionSessionInvalidate(session); throw ReplayError.encoder(result) }
    }

    // Called on the screen output queue. Dropping a frame is preferable to
    // retaining a backlog of full-sized surfaces when the encoder is busy.
    @discardableResult func encode(_ image: CVPixelBuffer, at time: CMTime) -> Bool {
        guard let session, buffer.acceptsFrame(at:time), slots.wait(timeout: .now()) == .success else { return false }
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: image, presentationTimeStamp: time,
            duration: .invalid, frameProperties: nil, infoFlagsOut: nil) { [buffer, slots, failed] status, _, sample in
                defer { slots.signal() }
                if status != noErr { failed(status) }
                else if let sample { buffer.append(sample) }
            }
        if status != noErr { slots.signal(); failed(status) }
        return status == noErr
    }

    func flush(through time: CMTime) {
        if let session { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: time) }
    }
    func close() {
        if let session { VTCompressionSessionInvalidate(session) }
        session = nil
        buffer.clear(closing:true)
    }
    deinit { close() }
}
