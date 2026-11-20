// Generate solid test cards. This executable never asks for screen access.
import AVFoundation
import AppKit

private enum Check: Error { case failed(String) }
private func check(_ value: Bool, _ label: String) throws {
    if !value { throw Check.failed(label) }
}
private func card(_ value: UInt8, width:Int, height:Int) throws -> CVPixelBuffer {
    var pixel: CVPixelBuffer?
    let status = CVPixelBufferCreate(nil,width,height,kCVPixelFormatType_32BGRA,
                                     [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,&pixel)
    guard status == kCVReturnSuccess, let pixel else { throw Check.failed("pixel allocation") }
    CVPixelBufferLockBaseAddress(pixel,[])
    let stride = CVPixelBufferGetBytesPerRow(pixel), base = CVPixelBufferGetBaseAddress(pixel)!
    memset(base,Int32(value),stride * height)
    CVPixelBufferUnlockBaseAddress(pixel,[])
    return pixel
}
private func validateMP4(_ url:URL, duration:Double, width:Int, height:Int, expectedFirst:UInt8? = nil) async throws {
    let asset = AVURLAsset(url:url)
    let actual = try await asset.load(.duration).seconds
    let video = try await asset.loadTracks(withMediaType:.video)
    let audio = try await asset.loadTracks(withMediaType:.audio)
    try check(abs(actual - duration) < 0.07,"duration \(actual) vs \(duration)")
    try check(video.count == 1 && audio.isEmpty,"one silent video track")
    let size = try await video[0].load(.naturalSize)
    try check(Int(size.width) == width && Int(size.height) == height,"output dimensions")
    let image = AVAssetImageGenerator(asset:asset)
    image.requestedTimeToleranceAfter = CMTime(value:2,timescale:30)
    image.requestedTimeToleranceBefore = .zero
    for seek in [0.05,max(0.05,actual - 0.1)] {
        let frame = try await image.image(at:CMTime(seconds:seek,preferredTimescale:600)).image
        try check(frame.width == width && frame.height == height,"decoded first/last frame")
        if seek == 0.05, let expectedFirst {
            var rgb:[UInt8] = [0,0,0,255]
            let context = CGContext(data:&rgb,width:1,height:1,bitsPerComponent:8,bytesPerRow:4,
                                    space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue)!
            context.draw(frame,in:CGRect(x:0,y:0,width:1,height:1))
            try check(abs(Int(rgb[0])-Int(expectedFirst)) < 15,"start after trim / content value \(rgb) expected \(expectedFirst)")
        }
    }
}
@main enum ScreenReplayChecks {
    static func main() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("NuPhy-Replay-QA-\(UUID())")
        defer { try? FileManager.default.removeItem(at:folder) }
        let width = 1920, height = 1080
        try check(ReplayCapture.dimensions(width:3840,height:2160) == (1920,1080),"landscape")
        try check(ReplayCapture.dimensions(width:2160,height:3840) == (1080,1920),"portrait")
        let encoder = try ReplayEncoder(width:width,height:height)
        defer { encoder.close() }
        let cards = try [24,80,136,208].map { try card($0,width:width,height:height) }
        func time(_ step:Int) -> CMTime { CMTime(value:Int64(30_000 + step),timescale:30) }
        func push(_ pixel: CVPixelBuffer,_ i:Int) throws {
            try check(encoder.encode(pixel,at:time(i)),"encoder accepted frame \(i)")
            if i % 2 == 0 { encoder.flush(through:time(i)) }
        }
        var short: ReplayClip?
        for i in 0...1080 {
            try push(cards[(i / 30) % cards.count],i)
            if i == 90 {
                encoder.flush(through:time(i))
                short = try encoder.buffer.snapshot(at:time(i))
            }
        }
        encoder.flush(through:.invalid)
        // The press can precede delivery of an already queued, newer frame.
        let now = 1066
        let rolling = try encoder.buffer.snapshot(at:time(now))
        try check(rolling.samples.last!.presentationTimeStamp <= time(now),"no frame from after button")
        let total = rolling.samples.reduce(0){$0 + $1.totalSampleSize}
        try check(total <= ReplayBuffer.byteLimit && rolling.samples.count <= 481,"time and byte bounds")
        let first = rolling.samples.first!
        let tiny = ReplayBuffer(limit:first.totalSampleSize-1)
        tiny.append(first)
        do {
            _ = try tiny.snapshot(at:first.presentationTimeStamp)
            throw Check.failed("oversize group rejection")
        } catch ReplayError.empty {}
        let a=folder.appendingPathComponent("a.mp4"), b=folder.appendingPathComponent("b.mp4")
        try await short!.write(to:a)
        try await validateMP4(a,duration:3,width:width,height:height,expectedFirst:24)
        try await rolling.write(to:b)
        try await validateMP4(b,duration:15,width:width,height:height,expectedFirst:24)
        let staticFirst = 1200
        for i in stride(from:staticFirst,through:staticFirst+600,by:30) {
            try push(cards[3],i)
        }
        encoder.flush(through:.invalid)
        let still = try encoder.buffer.snapshot(at:time(staticFirst+609))
        encoder.buffer.clear()
        do {
            _ = try encoder.buffer.snapshot(at:time(staticFirst+609))
            throw Check.failed("off did not empty buffer")
        } catch ReplayError.empty {}
        let c=folder.appendingPathComponent("static.mp4")
        try await still.write(to:c)
        try await validateMP4(c,duration:15,width:width,height:height,expectedFirst:208)
        let blocked = folder.appendingPathComponent("regular-file")
        try Data("fixture".utf8).write(to:blocked)
        do {
            try await rolling.write(to:blocked.appendingPathComponent("invalid.mp4"))
            throw Check.failed("expected filesystem failure")
        } catch is CocoaError {}
        let names = try FileManager.default.contentsOfDirectory(atPath:folder.path)
        try check(Set(names)==["a.mp4","b.mp4","static.mp4","regular-file"],"no partial exports")
        print("PASS hardware H.264, 1920x1080, early export 3 s, rolling export 15 s, still desktop 15 s, no audio, first/last frames decoded, no future frames, overflow, clear, export failure cleanup. Synthetic clip encoded bytes: \(total).")
    }
}
