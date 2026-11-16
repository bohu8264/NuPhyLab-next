import Foundation

/// Speculates with the unchanged cleanup request while speech is still arriving.
/// Reuse requires exact final ASR text (ignoring outer whitespace only).
@MainActor final class VoiceCleanupPrefetch {
    private let cleanup: (String) async throws -> String
    private let debounceNanoseconds: UInt64
    private let maximumRequests: Int
    private let finalDebounceNanoseconds: UInt64
    private var stopping=false
    private let requiresSentenceBoundary:Bool
    private var debounce: Task<Void, Never>?
    private var running: (id: Int, text: String, task: Task<String?, Never>)?
    private var cache: [String: String] = [:]
    private var latest = ""
    private var stable: String?
    private var attempts = 0
    private var sequence = 0
    private var finished = false
    private var cancelled = false
    private var latestLength = 0
    private var lastAttemptText = ""
    private var lastAttemptLength = 0
    private var finalLength = 0
    private var completedRequests = 0
    private var failedRequests = 0
    private var cancelRequests = 0
    private var finalMatchesLatest: Bool?
    private var finalMatchesLastAttempt: Bool?
    private var finishReason = "pending"
    private var prepareFinalReason = "notCalled"

    // Content-free telemetry. Never expose either partial or final text via diagnostics.
    var diagnostics: [String: Any] {
        ["attempts": attempts, "maximumRequests": maximumRequests, "completed": completedRequests,
         "failed": failedRequests, "cancelRequested": cancelRequests,
         "latestPartialLength": latestLength, "lastAttemptLength": lastAttemptLength,
         "finalLength": finalLength, "finalMatchesLatest": finalMatchesLatest.map { $0 as Any } ?? NSNull(),
         "finalMatchesLastAttempt": finalMatchesLastAttempt.map { $0 as Any } ?? NSNull(),
         "finishReason": finishReason, "prepareFinalReason": prepareFinalReason]
    }

    convenience init(api: VoiceAPI, settings: VoiceSettings, key: String, prompt: String) {
        self.init(requiresSentenceBoundary:true) { text in try await api.cleanup(text: text, settings: settings, key: key, prompt: prompt) }
    }

    // Internal injection for deterministic offline scheduling tests.
    init(debounceNanoseconds: UInt64 = 800_000_000, maximumRequests: Int = 1, finalDebounceNanoseconds: UInt64 = 180_000_000, requiresSentenceBoundary:Bool=false,
         cleanup: @escaping (String) async throws -> String) {
        self.debounceNanoseconds = debounceNanoseconds
        self.maximumRequests = max(0, min(1, maximumRequests))
        self.finalDebounceNanoseconds=finalDebounceNanoseconds
        self.requiresSentenceBoundary=requiresSentenceBoundary
        self.cleanup = cleanup
    }

    func observe(_ partial: String) {
        guard !finished, !cancelled else { return }
        let text = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.count <= 65536, !text.contains("\0"), text != latest else { return }
        latest = text
        latestLength = text.count
        stable = nil
        debounce?.cancel()
        if running?.text != text { cancelRunning() }
        guard cache[text] == nil, attempts < maximumRequests else { return }
        schedule(text)
    }

    private func schedule(_ text:String) {
        // Do not spend the one allowed request on a stalled ASR fragment. This is
        // only an eligibility hint; exact final equality still decides all reuse.
        guard !requiresSentenceBoundary || Self.endsSentence(text) else { return }
        let delay=stopping ? finalDebounceNanoseconds : debounceNanoseconds
        debounce = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(nanoseconds: delay) }
            catch { return }
            guard !Task.isCancelled, !finished, !cancelled, latest == text else { return }
            stable = text
            launchIfReady()
        }
    }

    /// After stop, let trailing deltas settle briefly instead of spending the only
    /// request on a known lagging partial. Final ASR never waits for this debounce.
    /// Only finish(finalText:) may authorize exact reuse.
    func prepareFinal() {
        guard !finished, !cancelled, !latest.isEmpty else { prepareFinalReason = "unavailable"; return }
        stopping=true
        debounce?.cancel(); debounce = nil
        if cache[latest] != nil { prepareFinalReason = "cached"; return }
        if let running, running.text == latest, !running.task.isCancelled {
            prepareFinalReason = "alreadyInFlight"; return
        }
        guard attempts < maximumRequests else { prepareFinalReason = "budgetExhausted"; return }
        prepareFinalReason = "settlingTail"
        stable = nil
        cancelRunning()
        schedule(latest)
    }

    static func endsSentence(_ text:String)->Bool {
        let trimmed=text.trimmingCharacters(in:.whitespacesAndNewlines)
            .trimmingCharacters(in:CharacterSet(charactersIn:"\"'”’」』）)】]"))
        return trimmed.last.map { "。！？.!?".contains($0) } ?? false
    }

    private func launchIfReady() {
        guard !finished, !cancelled, running == nil, let stable, stable == latest,
              cache[stable] == nil, attempts < maximumRequests else { return }
        attempts += 1
        sequence += 1
        let id = sequence, text = stable
        lastAttemptText = text
        lastAttemptLength = text.count
        self.stable = nil
        let task = Task<String?, Never> { [cleanup] in
            do {
                try Task.checkCancellation()
                let result = try await cleanup(text)
                try Task.checkCancellation()
                return result
            } catch { return nil }
        }
        running = (id, text, task)
        Task { [weak self] in
            let result = await task.value
            guard let self, running?.id == id else { return }
            running = nil
            if !cancelled, let result { cache[text] = result; completedRequests += 1 }
            else if !task.isCancelled { failedRequests += 1 }
            // A cancelled request must actually finish before another request may start.
            launchIfReady()
        }
    }

    func finish(finalText: String) async -> String? {
        guard !finished, !cancelled, !Task.isCancelled else { cancel(); return nil }
        finished = true
        debounce?.cancel(); debounce = nil; stable = nil
        let text = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        finalLength = text.count
        finalMatchesLatest = text == latest
        finalMatchesLastAttempt = text == lastAttemptText
        if let result = cache[text] {
            finishReason = "exactCacheHit"
            cancelRunning()
            return !cancelled && !Task.isCancelled ? result : nil
        }
        guard let running, running.text == text, !running.task.isCancelled else {
            if text != latest { finishReason = "finalDiffersFromLatestPartial" }
            else if attempts >= maximumRequests && text != lastAttemptText { finishReason = "budgetExhausted" }
            else if text != lastAttemptText { finishReason = "latestPartialNotRequested" }
            else if self.running?.task.isCancelled == true { finishReason = "matchingRequestCancelled" }
            else { finishReason = "matchingRequestFailed" }
            cancelRunning()
            // A stale request is never a dependency of the final cleanup. A provider
            // may ignore cancellation; do not delay correct text waiting for it.
            return nil
        }
        return await withTaskCancellationHandler {
            finishReason = "waitingForExactRequest"
            let result = await running.task.value
            guard !cancelled, !Task.isCancelled else { return nil }
            finishReason = result == nil ? "matchingRequestFailed" : "exactInFlightHit"
            return result
        } onCancel: { Task { @MainActor [weak self] in self?.cancel() } }
    }

    func cancel() {
        cancelled = true
        finished = true
        sequence += 1
        debounce?.cancel(); debounce = nil
        cancelRunning()
        if finishReason == "pending" || finishReason == "waitingForExactRequest" { finishReason = "cancelled" }
        cache.removeAll(); latest = ""; lastAttemptText = ""; stable = nil
    }

    private func cancelRunning() {
        if let running, !running.task.isCancelled {
            cancelRequests += 1
            running.task.cancel()
        }
    }
}
