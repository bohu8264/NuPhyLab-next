import AppKit
import ApplicationServices
import AVFoundation
import Speech
import IOKit.hid

// Read-only, same-signed-executable probe: no app, event tap, HID or permission
// prompt is created. Never treat a fresh-process grant as usable in this process.
struct LabPermissionSnapshot: Codable, Equatable {
    var accessibility: Bool
    var inputMonitoring: Bool
    var screenRecording: Bool
    var microphone: Bool
    var speechRecognition: Bool
    var microphoneState: String = "unknown"
    var speechRecognitionState: String = "unknown"
    static func current() -> Self {
        let mic = AVCaptureDevice.authorizationStatus(for: .audio)
        let speech = SFSpeechRecognizer.authorizationStatus()
        func state(_ raw: Int) -> String { [0:"notDetermined",1:"restricted",2:"denied",3:"authorized"][raw] ?? "unknown" }
        return .init(accessibility: AXIsProcessTrusted(), inputMonitoring: SelectionHoldMonitor.inputAccessGranted,
                     screenRecording: CGPreflightScreenCaptureAccess(), microphone: mic == .authorized,
                     speechRecognition: speech == .authorized, microphoneState: state(mic.rawValue),
                     speechRecognitionState: state(speech.rawValue))
    }
    var dictionary: [String:Any] { (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(self))) as? [String:Any] ?? [:] }
    func missing(voice: Bool) -> [String] {
        let keys = ["accessibility","inputMonitoring","screenRecording"] + (voice ? ["microphone","speechRecognition"] : [])
        return keys.filter { dictionary[$0] as? Bool != true }
    }
    // A fresh child can confirm a grant that the host has not applied yet.
    // Use this view for permission labels, never for enabling capture.
    func confirmingGrants(from fresh: Self?) -> Self {
        guard let fresh else { return self }
        return .init(accessibility: accessibility || fresh.accessibility,
                     inputMonitoring: inputMonitoring || fresh.inputMonitoring,
                     screenRecording: screenRecording || fresh.screenRecording,
                     microphone: microphone || fresh.microphone,
                     speechRecognition: speechRecognition || fresh.speechRecognition,
                     microphoneState: !microphone && fresh.microphone ? fresh.microphoneState : microphoneState,
                     speechRecognitionState: !speechRecognition && fresh.speechRecognition ? fresh.speechRecognitionState : speechRecognitionState)
    }
    func requiresRelaunch(fresh: Self, voice: Bool) -> Bool {
        let missingPermissions = missing(voice: voice)
        let verified = fresh.dictionary
        return !missingPermissions.isEmpty && missingPermissions.allSatisfy { verified[$0] as? Bool == true }
    }
}
// Permission grants alone are not proof that a working global listener exists.
// This pure state boundary is also used by onboarding regression checks.
enum LabSetupState: String {
    case unsupported, disabled, recording, configuration, permissions, relaunch, shortcutConflict, secureInput, monitorPaused, ready
    static func resolve(supported:Bool = true, enabled:Bool, recording:Bool, configured:Bool,
                        permissions:Bool, relaunch:Bool, conflict:Bool, secureInput:Bool, monitorReady:Bool) -> Self {
        if !supported { return .unsupported }
        if !enabled { return .disabled }
        if recording { return .recording }
        if !configured { return .configuration }
        if relaunch { return .relaunch }
        if !permissions { return .permissions }
        if conflict { return .shortcutConflict }
        if secureInput { return .secureInput }
        return monitorReady ? .ready : .monitorPaused
    }
}
struct LabMonitorRecovery {
    private(set) var failures = 0
    private(set) var nextAttempt:TimeInterval = 0
    mutating func reset() { failures = 0; nextAttempt = 0 }
    mutating func failed(at now:TimeInterval) { failures += 1; nextAttempt = now + min(4,pow(2,Double(failures-1))) }
    func canAttempt(at now:TimeInterval,eligible:Bool) -> Bool { eligible && failures < 3 && now >= nextAttempt }
}
enum SelectionPermissionProbe {
    static let argument = "--nuphylab-selection-permission-probe"
    static func decode(_ data: Data) -> LabPermissionSnapshot? {
        guard data.count <= 2048 else { return nil }
        return try? JSONDecoder().decode(LabPermissionSnapshot.self, from: data)
    }
    static func runIfRequested() {
        guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == argument else { return }
        guard let data = try? JSONEncoder().encode(LabPermissionSnapshot.current()) else { exit(1) }
        FileHandle.standardOutput.write(data); exit(0)
    }
}

@MainActor protocol SelectionFeature: AnyObject {
    var showSettings: (() -> Void)? { get set }
    var requestRelaunch: (() -> Bool)? { get set }
    var recordingChanged: ((Bool) -> Void)? { get set }
    var voiceActivityChanged: ((Bool) -> Void)? { get set }
    var fileDragActive: (() -> Bool)? { get set }
    var isBusy: Bool { get }
    var dragReservedTrigger: String? { get }
    func updateLanguage(_ language: AppLanguage)
    func updateReservedKeys(_ codes: Set<UInt32>)
    func handle(_ body: [String:Any], reply: @escaping (Any?, String?) -> Void)
    func consumeLocal(_ event: NSEvent) -> Bool
    func cancel(animatePanel: Bool)
    func cancelShortcutRecording()
    func refreshAuthorization()
    func shutdown()
}
extension SelectionFeature { var dragReservedTrigger:String? {nil}; func cancel() { cancel(animatePanel: false) } }

@MainActor enum SelectionFeatureFactory {
    static func make(directory: URL) -> any SelectionFeature {
        if #available(macOS 14, *) { return SelectionLab(directory: directory) }
        return UnavailableSelectionFeature()
    }
}
// Keep the existing keyboard application usable on its original macOS 13.5
// minimum. Only the single-frame capture/notch feature requires macOS 14.
@MainActor private final class UnavailableSelectionFeature: SelectionFeature {
    private var language=AppLanguage.zh
    func updateLanguage(_ language:AppLanguage){self.language=language}
    var showSettings: (() -> Void)?
    var fileDragActive: (() -> Bool)?
    var requestRelaunch: (() -> Bool)?
    var recordingChanged: ((Bool) -> Void)?
    var voiceActivityChanged: ((Bool) -> Void)?
    var isBusy: Bool { false }
    func updateReservedKeys(_ codes: Set<UInt32>) {}
    func handle(_ body: [String:Any], reply: @escaping (Any?, String?) -> Void) {
        if body["op"] as? String == "language",let value=body["language"] as? String,["en","zh-CN"].contains(value){updateLanguage(value == "en" ? .en:.zh);reply(["supported":false],nil);return}
        if body["op"] as? String == "status" {
            var result = LabPermissionSnapshot.current().dictionary
            result.merge(["supported":false,"ready":false,"setupState":"unsupported","hasKey":false,"shortcutRegistered":false,
                "preferences":(try? JSONSerialization.jsonObject(with:JSONEncoder().encode(LabPreferences()))) ?? [:],
                "issue":LabText.text("框选提问需要 macOS 14 或更新版本；键盘功能可继续使用。",language:language),
                "shortcutNotice":"","phase":LabText.text("系统版本不支持",language:language)],uniquingKeysWith: { _,new in new })
            reply(result,nil)
        } else { reply(nil,LabText.text("框选提问需要 macOS 14 或更新版本。",language:language)) }
    }
    func consumeLocal(_ event: NSEvent) -> Bool { false }
    func cancel(animatePanel: Bool) {}
    func cancelShortcutRecording() {}
    func refreshAuthorization() {}
    func shutdown() {}
}
