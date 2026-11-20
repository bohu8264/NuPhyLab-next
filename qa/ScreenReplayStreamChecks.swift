import AppKit
import ScreenCaptureKit
import AVFoundation

struct Failure: Error { let text: String; init(_ text:String) {self.text=text} }
@main enum LiveCards {
    @MainActor static func main() async throws {
        // This filter can only include this test process's one synthetic panel.
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let frame = NSRect(x:30,y:58,width:320,height:200)
        let panel = NSPanel(contentRect:frame,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = true
        panel.backgroundColor = NSColor.systemIndigo
        panel.orderBack(nil)
        defer { panel.orderOut(nil); panel.close() }
        try await Task.sleep(nanoseconds:500_000_000)
        let content = try await SCShareableContent.currentProcess
        guard let window = content.windows.first(where: { $0.windowID == CGWindowID(panel.windowNumber) && $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier }),
              let display = content.displays.first(where:{$0.displayID == CGMainDisplayID()}) else { throw Failure("missing generated test panel") }
        let fixture = SCContentFilter(desktopIndependentWindow:window)
        let source = try ReplayCapture(display:display,filter:fixture) { error in print("Stream event",error.localizedDescription) }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("NuPhy-generated-cards-"+UUID().uuidString)
        defer {source.discard();try? FileManager.default.removeItem(at:folder)}
        try await source.start()
        func save(_ name:String) async throws -> Double {
            let when = CMClockGetTime(CMClockGetHostTimeClock())
            let clip:ReplayClip = try await withCheckedThrowingContinuation { cont in
                source.clip(at:when){cont.resume(with:$0)}
            }
            let url = folder.appendingPathComponent(name+".mp4")
            try await clip.write(to:url)
            let asset=AVURLAsset(url:url)
            let seconds=try await asset.load(.duration).seconds
            guard try await asset.loadTracks(withMediaType:.audio).isEmpty else { throw Failure("unexpected audio") }
            _ = try await AVAssetImageGenerator(asset:asset).image(at:.zero)
            return seconds
        }
        for color in [NSColor.systemRed,.systemTeal,.systemIndigo,.systemBlue] {
            panel.backgroundColor = color
            panel.displayIfNeeded()
            try await Task.sleep(nanoseconds:400_000_000)
        }
        let short = try await save("early")
        try await Task.sleep(nanoseconds:16_200_000_000)
        let full = try await save("still")
        source.discard()
        await source.finishStopping()
        let after:Result<ReplayClip,Error> = await withCheckedContinuation { c in
            source.clip(at:CMClockGetTime(CMClockGetHostTimeClock())) { c.resume(returning:$0) }
        }
        guard case .failure = after, short>0, short<4, abs(full-15)<0.07 else {throw Failure("clip durations or stop")}
        print("PASS real ScreenCaptureKit generated-window frames, static heartbeat, two playable silent MP4 saves, disabled capture rejected. Durations",short,full)
    }
}
