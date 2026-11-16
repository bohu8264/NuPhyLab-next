import Foundation

// Injectable transport keeps protocol, ordering, cancellation and failure tests offline.
@MainActor protocol VoiceStreamingTransport: AnyObject {
    func resume()
    func send(_ data: Data) async throws
    func receive() async throws -> Data
    func cancel()
}

private final class VoiceStreamNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor private final class VoiceWebSocketTransport: VoiceStreamingTransport {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    init(key: String) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 3600
        session = URLSession(configuration: configuration, delegate: VoiceStreamNoRedirect(), delegateQueue: nil)
        // Fixed official origin: a custom file gateway never receives a new WebSocket request.
        var request = URLRequest(url: URL(string: "wss://api.openai.com/v1/realtime?intent=transcription")!)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 1_048_576
    }
    func resume() { socket.resume() }
    func send(_ data: Data) async throws {
        guard let text = String(data: data, encoding: .utf8) else { throw VoiceAPIError.malformed }
        try await socket.send(.string(text))
    }
    func receive() async throws -> Data {
        switch try await socket.receive() {
        case .data(let data): return data
        case .string(let string): return Data(string.utf8)
        @unknown default: throw VoiceAPIError.malformed
        }
    }
    func cancel() {
        socket.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }
}

/// One recording, one committed turn. Main-actor callbacks preserve microphone chunk order.
/// Capture must flush its final PCM chunk before calling finish(). No interim text is inserted.
@MainActor final class VoiceStreaming {
    // Speculation only: this callback must never be connected to text insertion.
    var onPartial: ((String) -> Void)?
    private let transport: VoiceStreamingTransport
    private let settings: VoiceSettings
    private let timeoutNanoseconds: UInt64
    private var started = false
    private var ready = false
    private var finishing = false
    private var commitSent = false
    private var closed = false
    private var failure: Error?
    private var pending: [Data] = []
    private var byteCount = 0
    private var itemID: String?
    private var completed: [String: String] = [:]
    private var partialItemID: String?
    private var partialText = ""
    private var waiter: CheckedContinuation<String, Error>?
    private var receiveTask: Task<Void, Never>?
    private var setupTask: Task<Void, Never>?
    private var sendTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?

    static func isSupported(settings: VoiceSettings) -> Bool {
        guard let url = try? VoiceSettings.endpointURL(settings.asrEndpoint) else { return false }
        return settings.asrProvider == "openai" && url.scheme == "https" &&
            url.host?.lowercased() == "api.openai.com" && (url.port == nil || url.port == 443) &&
            url.path == "/v1/audio/transcriptions" && settings.realtimeModel == "gpt-live-transcribe"
    }

    convenience init(settings: VoiceSettings, key: String) throws {
        let settings = try settings.validated()
        guard Self.isSupported(settings: settings) else {
            throw VoiceAPIError.invalid("此接口使用文件识别；实时模式目前支持 OpenAI 官方语音接口。")
        }
        let key = try VoiceSettingsStore.validatedKey(key)
        self.init(settings: settings, transport: VoiceWebSocketTransport(key: key))
    }

    // Internal injection is used only by offline fixtures, never selected by endpoint settings.
    init(settings: VoiceSettings, transport: VoiceStreamingTransport, timeoutNanoseconds: UInt64 = 15_000_000_000) {
        self.settings = settings
        self.transport = transport
        self.timeoutNanoseconds = timeoutNanoseconds
    }

    static func configurationEvent(settings: VoiceSettings) -> [String: Any] {
        let transcription: [String: Any] = ["model": settings.realtimeModel,
            "keywords": settings.dictionary, "delay": "medium"]
        return ["type": "session.update", "session": ["type": "transcription", "audio": ["input": [
            "format": ["type": "audio/pcm", "rate": 24000], "transcription": transcription,
            "turn_detection": NSNull()]]]]
    }

    func start() {
        guard !started, !closed else { return }
        started = true
        transport.resume()
        receiveTask = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled && !closed {
                    let data = try await transport.receive()
                    try Task.checkCancellation()
                    try accept(data)
                }
            } catch { if !closed { fail(sanitized(error)) } }
        }
        setupTask = Task { [weak self] in
            guard let self else { return }
            do { try await send(Self.configurationEvent(settings: settings)) }
            catch { if !closed { fail(sanitized(error)) } }
        }
    }

    func appendPCM(_ data: Data) {
        guard !closed, !finishing else { return }
        guard !data.isEmpty else { return }
        guard data.count % 2 == 0, pending.reduce(0, { $0 + $1.count }) + data.count <= 2 * 1024 * 1024 else {
            fail(VoiceAPIError.invalid("实时音频格式或长度异常，改用完整录音识别。")); return
        }
        byteCount += data.count
        pending.append(data)
        pump()
    }

    func finish() async throws -> String {
        try Task.checkCancellation()
        if let failure { throw failure }
        guard started, !closed, !finishing, byteCount >= 4800 else { throw VoiceAPIError.empty }
        finishing = true
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiter = continuation
                timeoutTask = Task { [weak self] in
                    guard let self else { return }
                    do { try await Task.sleep(nanoseconds: timeoutNanoseconds) }
                    catch { return }
                    if !closed { fail(VoiceAPIError.invalid("实时识别等待超时，改用完整录音识别。")) }
                }
                pump()
            }
        } onCancel: { Task { @MainActor [weak self] in self?.cancel() } }
    }

    func cancel() { if !closed { fail(CancellationError()) } }

    private func pump() {
        guard ready, !closed, sendTask == nil else { return }
        sendTask = Task { [weak self] in
            guard let self else { return }
            defer { sendTask = nil }
            do {
                while !pending.isEmpty && !closed {
                    let data = pending.removeFirst()
                    try await send(["type": "input_audio_buffer.append", "audio": data.base64EncodedString()])
                }
                if finishing && !commitSent && !closed {
                    commitSent = true
                    try await send(["type": "input_audio_buffer.commit"])
                }
            } catch { if !closed { fail(sanitized(error)) } }
        }
    }

    private func send(_ object: [String: Any]) async throws {
        try Task.checkCancellation()
        try await transport.send(JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
        try Task.checkCancellation()
    }

    private func accept(_ data: Data) throws {
        guard data.count <= 1_048_576,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { throw VoiceAPIError.malformed }
        switch type {
        case "session.updated":
            guard let session = object["session"] as? [String: Any], session["type"] as? String == "transcription" else {
                throw VoiceAPIError.malformed
            }
            ready = true
            pump()
        case "input_audio_buffer.committed":
            guard commitSent, itemID == nil, let id = object["item_id"] as? String, !id.isEmpty else { throw VoiceAPIError.malformed }
            itemID = id
            resolveIfComplete()
        case "conversation.item.input_audio_transcription.delta":
            guard let id = object["item_id"] as? String, !id.isEmpty,
                  let delta = object["delta"] as? String, !delta.contains("\0"),
                  (object["content_index"] as? Int ?? 0) == 0 else { throw VoiceAPIError.malformed }
            if partialItemID == nil { partialItemID = id }
            // One manually committed recording has one audio item. Never concatenate turns.
            guard id == partialItemID, itemID == nil || itemID == id else { return }
            guard partialText.utf8.count + delta.utf8.count <= 65536 else { throw VoiceAPIError.malformed }
            partialText += delta
            if !delta.isEmpty { onPartial?(partialText) }
        case "conversation.item.input_audio_transcription.completed":
            guard commitSent, let id = object["item_id"] as? String, !id.isEmpty,
                  let transcript = object["transcript"] as? String, transcript.utf8.count <= 65536,
                  !transcript.contains("\0"), completed.count < 4 else { throw VoiceAPIError.malformed }
            completed[id] = transcript
            resolveIfComplete()
        case "conversation.item.input_audio_transcription.failed", "error":
            // Provider messages may echo personal content; retain no response body in errors.
            throw VoiceAPIError.invalid("实时语音服务未完成识别，改用完整录音识别。")
        default: break // Deltas/session.created/rate limits never become final output.
        }
    }

    private func resolveIfComplete() {
        guard let itemID, let transcript = completed[itemID] else { return }
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { fail(VoiceAPIError.empty); return }
        let continuation = waiter
        waiter = nil
        close()
        continuation?.resume(returning: text)
    }

    private func fail(_ error: Error) {
        guard !closed else { return }
        failure = error
        let continuation = waiter
        waiter = nil
        close()
        continuation?.resume(throwing: error)
    }

    private func close() {
        closed = true
        ready = false
        pending.removeAll()
        completed.removeAll()
        partialText = ""
        partialItemID = nil
        onPartial = nil
        receiveTask?.cancel(); receiveTask = nil
        setupTask?.cancel(); setupTask = nil
        sendTask?.cancel(); sendTask = nil
        timeoutTask?.cancel(); timeoutTask = nil
        transport.cancel()
    }

    private func sanitized(_ error: Error) -> Error {
        if error is CancellationError { return CancellationError() }
        if let known = error as? VoiceAPIError { return known }
        return VoiceAPIError.invalid("实时语音连接不可用，改用完整录音识别。")
    }
}
