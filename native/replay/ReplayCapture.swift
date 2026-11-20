import ScreenCaptureKit
import VideoToolbox

private final class ReplayStreamDelegate: NSObject, SCStreamDelegate {
    let ended: (Error) -> Void
    init(_ ended: @escaping (Error) -> Void) { self.ended = ended }
    func stream(_ stream: SCStream, didStopWithError error: Error) { ended(error) }
}

final class ReplayCapture: NSObject, SCStreamOutput {
    static func dimensions(width: Int, height: Int) -> (Int, Int) {
        // Rotate the 1080p envelope along with portrait displays.
        let long = max(width, height), short = min(width, height)
        let scale = min(1, 1920 / Double(max(1, long)), 1080 / Double(max(1, short)))
        func even(_ n: Int) -> Int { max(2, Int(Double(n) * scale) / 2 * 2) }
        return (even(width), even(height))
    }
    let displayID: CGDirectDisplayID
    private let queue = DispatchQueue(label:"local.airstudio.replay.frames", qos:.userInitiated)
    private let encoder: ReplayEncoder
    private let stream: SCStream
    private let delegate: ReplayStreamDelegate
    private var heartbeat: DispatchSourceTimer?
    private var lastImage: CVPixelBuffer?
    private var lastTime = CMTime.invalid
    private var closed = false

    init(display: SCDisplay, filter: SCContentFilter, ended: @escaping (Error) -> Void) throws {
        displayID = display.displayID
        delegate = ReplayStreamDelegate(ended)
        let mode = CGDisplayCopyDisplayMode(display.displayID)
        let width = mode?.pixelWidth ?? display.width, height = mode?.pixelHeight ?? display.height
        let rotated = (display.width > display.height) != (width > height)
        let (w,h) = Self.dimensions(width:rotated ? height : width, height:rotated ? width : height)
        encoder = try ReplayEncoder(width:w, height:h)
        let config = SCStreamConfiguration()
        config.width = w; config.height = h
        config.queueDepth = 3
        config.minimumFrameInterval = CMTime(value:1,timescale:30)
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.showsCursor = true
        config.capturesAudio = false
        stream = SCStream(filter:filter, configuration:config, delegate:delegate)
        super.init()
        encoder.failed = { code in ended(ReplayError.encoder(code)) }
        try stream.addStreamOutput(self, type:.screen, sampleHandlerQueue:queue)
    }

    func start() async throws {
        try await stream.startCapture()
        queue.sync {
            guard !closed else { return }
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline:.now() + 1, repeating: .seconds(1), leeway:.milliseconds(50))
            timer.setEventHandler { [weak self] in
                guard let self, !self.closed, let image = self.lastImage else { return }
                let now = CMClockGetTime(CMClockGetHostTimeClock())
                if (now - self.lastTime).seconds >= 0.8 { self.submit(image, at:now) }
            }
            heartbeat = timer
            timer.resume()
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !closed, type == .screen,
              let info = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary:false) as? [[SCStreamFrameInfo:Any]])?.first,
              let raw = info[.status] as? Int, let status = SCFrameStatus(rawValue:raw) else { return }
        switch status {
        case .complete:
            guard let image = sample.imageBuffer else { return }
            lastImage = image
            submit(image, at:CMClockGetTime(CMClockGetHostTimeClock()))
        case .blank, .suspended, .stopped:
            // Never fill a suspended or locked interval with old desktop pixels.
            lastImage = nil
            encoder.flush(through:.invalid)
            encoder.buffer.clear()
        default: break
        }
    }

    private func submit(_ image:CVPixelBuffer, at time:CMTime) {
        if encoder.encode(image, at:time) { lastTime = time }
    }

    func clip(at trigger: CMTime, completion: @escaping (Result<ReplayClip, Error>) -> Void) {
        queue.async {
            guard !self.closed else { completion(.failure(ReplayError.empty)); return }
            self.encoder.flush(through:trigger)
            completion(Result { try self.encoder.buffer.snapshot(at:trigger) })
        }
    }

    // Synchronously release uncommitted pixels before returning to the UI.
    func discard() {
        queue.sync {
            guard !closed else { return }
            closed = true
            heartbeat?.cancel(); heartbeat = nil
            lastImage = nil
            encoder.close()
        }
    }
    func finishStopping() async { try? await stream.stopCapture() }
}
