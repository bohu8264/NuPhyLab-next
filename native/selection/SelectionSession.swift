import Foundation

/// New host-facing extraction of Chord's InteractionSession / fixed-action
/// policies. One transient selection only. No persistence or group requests.
public struct SelectedContent: Equatable, Sendable {
    public let text: String
    public let imagePNG: Data?
    public let requiresScreenPermission: Bool
    public init(text: String, imagePNG: Data? = nil, requiresScreenPermission: Bool = false) {
        self.text = text
        self.imagePNG = imagePNG
        self.requiresScreenPermission = requiresScreenPermission || imagePNG != nil
    }
}

public enum SelectionAction: Equatable, Sendable {
    case translate(targetLanguage: String)
    case summarize, rewrite, explain, extractText
    case ask(instruction: String)
    case reply(instruction: String)

    public var instruction: String {
        switch self {
        case .translate(let target): return "Translate the selected text into \(target). Preserve its meaning and useful formatting. Return only the translation."
        case .summarize: return "Summarize the selected content concisely. Preserve the main points and important qualifications."
        case .rewrite: return "Rewrite the selected text for clarity and fluency while preserving its meaning. Return only the rewritten text."
        case .explain: return "Explain the selected content clearly and concisely. Distinguish visible facts from inferences."
        case .ask(let instruction): return instruction
        case .reply(let instruction):
            return """
            Draft a natural, concise message that the user can send in reply to the selected conversation. Use the surrounding conversation to identify the other person's latest relevant message, and write the response from the user's perspective to that person. Follow the user's requested intent, tone, points to include, and language. With no extra requirements, use a friendly, context-appropriate tone.
            Return only the ready-to-send reply text, without a heading, explanation, quotation marks around the whole message, or unsolicited alternatives. Do not answer the user with advice on how to reply, and do not merely rewrite the other person's message. Do not invent facts, commitments, dates, prices or personal details that the user has not supplied. If an essential fact is missing, phrase the draft as a brief clarifying question to the other person. This is a draft for review; never claim it has been sent.
            User's reply requirements: \(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "No extra requirements." : instruction)
            """
        case .extractText: return ""
        }
    }
    /// Spoken requirements refine Reply instead of turning it into a generic Q&A.
    public func applyingInstruction(_ value: String) -> SelectionAction {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return self }
        if case .reply = self { return .reply(instruction: text) }
        return .ask(instruction: text)
    }
}

public struct SelectionSafety: Equatable, Sendable {
    public var paused: Bool
    public var secureInput: Bool
    public var accessibility: Bool
    public var inputMonitoring: Bool
    public var screenCapture: Bool
    public init(paused: Bool, secureInput: Bool, accessibility: Bool, inputMonitoring: Bool, screenCapture: Bool) {
        self.paused = paused; self.secureInput = secureInput; self.accessibility = accessibility
        self.inputMonitoring = inputMonitoring; self.screenCapture = screenCapture
    }
    public func permits(_ content: SelectedContent) -> Bool {
        !paused && !secureInput && accessibility && inputMonitoring && (!content.requiresScreenPermission || screenCapture)
    }
}

public enum SelectionPhase: String, Sendable {
    case idle, holding, finishing, awaitingAction, requesting, completed, failed, cancelled
}

public enum SelectionFlowError: Error, Equatable {
    case captureFailed, unreadableSelection, missingInstruction, noRecognizedText, missingTranslationLanguage
}

public struct SelectionGesture: Equatable, Sendable {
    public let id: UUID
    public let captureID: UUID
    public let voiceID: UUID?
}

public struct SelectionWork: Sendable {
    public let sessionID: UUID
    public let requestID: UUID
    public let content: SelectedContent
    public let action: SelectionAction
    /// Fixed text transformations use OCR without uploading screenshots when
    /// usable text is available. An explicit visual question retains its image.
    public var includesImage: Bool {
        guard content.imagePNG != nil else { return false }
        switch action {
        case .translate, .summarize, .rewrite, .explain:
            return content.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .ask, .reply: return true
        case .extractText: return false
        }
    }
    public func prompt(outputLanguage: String, translationTargetLanguage: String? = nil) throws -> AIRequestPrompt {
        var instruction = action.instruction
        if case .ask = action, let target = translationTargetLanguage, !target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            instruction += "\nTranslation preference: only when this task asks for translation and gives no target language, use \(target). An explicit target takes precedence. Do not translate non-translation tasks."
        }
        if case .reply = action {
            instruction += "\nUse the language of the selected conversation unless the user's reply requirements specify another language. If the conversation's language is unclear, use \(outputLanguage). The translation target preference does not apply to replies."
        } else if !outputLanguage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            instruction += "\nPreferred answer language: \(outputLanguage). An explicit target or output language in the user's instruction takes precedence."
        }
        // The system prompt and JSON serialization separate user instructions
        // from the untrusted selected page/document content.
        return try AIRequestPrompt.selection(text: content.text, instruction: instruction)
    }
    public var images: [AIImageAttachment] {
        guard includesImage, let png = content.imagePNG else { return [] }
        return [.init(label: "Selected region", png: png)]
    }
}

public struct SelectionSession: Sendable {
    public private(set) var gesture: SelectionGesture?
    public private(set) var phase: SelectionPhase = .idle
    public private(set) var content: SelectedContent?
    public private(set) var result = ""
    public private(set) var preview = ""
    public private(set) var error: SelectionFlowError?
    public private(set) var released = false
    public private(set) var activeRequest: UUID?
    private var capturePending = false
    private var voicePending = false
    private var action: SelectionAction?
    private var finalSpeech = ""

    public init() {}

    @discardableResult public mutating func begin(voiceExpected: Bool, defaultAction: SelectionAction? = nil) -> SelectionGesture {
        self = SelectionSession()
        let handle = SelectionGesture(id: UUID(), captureID: UUID(), voiceID: voiceExpected ? UUID() : nil)
        gesture = handle; phase = .holding; capturePending = true; voicePending = voiceExpected
        action = defaultAction
        return handle
    }

    public mutating func captured(_ value: SelectedContent?, for handle: SelectionGesture) {
        guard gesture == handle, capturePending, [.holding, .finishing].contains(phase) else { return }
        capturePending = false
        guard let value else { error = .captureFailed; phase = .failed; return }
        content = value
        settle()
    }

    /// Invoke once at recognizer termination, including best final text at its
    /// deadline. Live partial transcripts must never invoke this method.
    public mutating func voiceFinished(_ text: String?, for handle: SelectionGesture) {
        guard gesture == handle, handle.voiceID != nil, voicePending, [.holding, .finishing].contains(phase) else { return }
        voicePending = false
        finalSpeech = String((text ?? "").prefix(16_000)).trimmingCharacters(in: .whitespacesAndNewlines)
        settle()
    }

    /// Recognition/audio failure is distinct from silence. Keep the one
    /// selection for an explicit action; never submit an interim instruction
    /// or fall through to a configured automatic default after failure.
    public mutating func voiceFailed(for handle: SelectionGesture) {
        guard gesture == handle, handle.voiceID != nil, voicePending, [.holding, .finishing].contains(phase) else { return }
        voicePending = false; finalSpeech = ""; action = nil
        settle()
    }

    public mutating func release(_ handle: SelectionGesture) {
        guard gesture == handle, phase == .holding, !released else { return }
        released = true; phase = .finishing
        settle()
    }

    /// An explicit task button or typed instruction can submit the current
    /// selection after release. Completed tasks require a fresh gesture.
    public mutating func choose(_ value: SelectionAction) {
        guard [.awaitingAction, .failed].contains(phase), content != nil, !capturePending, !voicePending, released else { return }
        action = value; finalSpeech = ""; error = nil; phase = .awaitingAction
    }

    public mutating func takeWork(safety: SelectionSafety) throws -> SelectionWork? {
        guard phase == .awaitingAction, released, !capturePending, !voicePending,
              activeRequest == nil, let handle = gesture, let content else { return nil }
        guard safety.permits(content) else { cancel(); return nil }
        guard !content.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(content.imagePNG?.isEmpty ?? true) else {
            error = .unreadableSelection; throw SelectionFlowError.unreadableSelection
        }
        let selectedAction = finalSpeech.isEmpty ? action : (action?.applyingInstruction(finalSpeech) ?? .ask(instruction: finalSpeech))
        guard let selectedAction else { return nil }
        if case .translate(let target) = selectedAction, target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            error = .missingTranslationLanguage; throw SelectionFlowError.missingTranslationLanguage
        }
        if case .extractText = selectedAction {
            guard !content.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                error = .noRecognizedText; throw SelectionFlowError.noRecognizedText
            }
        } else if selectedAction.instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            error = .missingInstruction; throw SelectionFlowError.missingInstruction
        }
        let request = UUID()
        activeRequest = request; phase = .requesting; preview = ""; error = nil
        return SelectionWork(sessionID: handle.id, requestID: request, content: content, action: selectedAction)
    }

    public mutating func append(_ delta: String, for work: SelectionWork) {
        guard accepts(work), preview.utf8.count + delta.utf8.count <= 2 * 1024 * 1024 else { return }
        preview += delta
    }

    public mutating func complete(_ text: String, for work: SelectionWork) {
        guard accepts(work) else { return }
        result = text; preview = ""; activeRequest = nil; phase = .completed
    }

    public mutating func fail(_ work: SelectionWork) {
        guard accepts(work) else { return }
        preview = ""; activeRequest = nil; phase = .failed
    }

    public func accepts(_ work: SelectionWork) -> Bool {
        phase == .requesting && gesture?.id == work.sessionID && activeRequest == work.requestID
    }

    public mutating func cancel() {
        self = SelectionSession(); phase = .cancelled
    }

    private mutating func settle() {
        guard released, !capturePending, !voicePending else { return }
        phase = .awaitingAction
    }
}
