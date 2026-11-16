import Foundation

enum VoiceSessionAction: Equatable { case start, stop, insertPending, ignore }

enum VoiceSessionPolicy {
    static let processing = ["starting", "recording", "transcribing", "cleaning", "inserting"]
    static func action(phase: String, preview: Bool, recordingShortcut: Bool) -> VoiceSessionAction {
        guard !recordingShortcut else { return .ignore }
        if phase == "recording" { return .stop }
        if processing.contains(phase) { return .ignore }
        if phase == "pending", !preview { return .insertPending }
        return .start
    }
    static func cancellable(_ phase: String) -> Bool { processing.contains(phase) || phase == "pending" }
}
