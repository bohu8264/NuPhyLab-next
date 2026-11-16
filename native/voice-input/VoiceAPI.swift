import Foundation

enum VoiceAPIError: LocalizedError {
    case invalid(String)
    case http(Int)
    case malformed
    case incomplete
    case empty
    var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .http(let status):
            switch status {
            case 401, 403: return "接口未授权（\(status)），请检查此服务的 API Key 和模型权限。"
            case 404: return "接口或模型不存在（404），请检查完整接口地址及语音模型支持情况。"
            case 413: return "录音超过服务允许的大小，请缩短后重试。"
            case 429: return "服务限流或额度不足（429），请稍后重试。"
            case 300..<400: return "接口发生重定向，已停止发送凭据；请使用最终的 HTTPS 接口地址。"
            default: return "服务请求失败（\(status)），原始转写仍保留在本次结果中。"
            }
        case .malformed: return "接口返回格式不兼容，未自动插入。请确认协议设置。"
        case .incomplete: return "模型结果不完整或未返回普通正文，未自动插入。"
        case .empty: return "没有识别到可输入的文字。"
        }
    }
}

private final class VoiceNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct VoiceCleanupResult: Sendable {
    let text: String
    let serviceTier: String?
}

final class VoiceAPI: @unchecked Sendable {
    private let session: URLSession
    private let delegate: VoiceNoRedirectDelegate
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = false
        let delegate = VoiceNoRedirectDelegate()
        self.delegate = delegate
        session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    private static func request(url: String, key: String) throws -> URLRequest {
        let url = try VoiceSettings.endpointURL(url)
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              key.utf8.count <= 8192, !key.contains(where: { $0.isNewline }), !key.contains("\0") else {
            throw VoiceAPIError.invalid("请先保存语音输入的 API Key。")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    static func transcriptionRequest(audio: Data, fileExtension: String = "wav", settings: VoiceSettings, key: String) throws -> URLRequest {
        let settings = try settings.validated()
        let limit = settings.asrProvider == "alibaba" ? 7 * 1024 * 1024 : settings.asrProvider == "deepseek" ? 8 * 1024 * 1024 : (URL(string: settings.asrEndpoint)?.host == "api.siliconflow.cn" ? 50 : 25) * 1024 * 1024
        guard !audio.isEmpty, audio.count <= limit else { throw VoiceAPIError.invalid("录音为空或超过语音接口的大小限制。") }
        guard ["wav", "m4a", "mp3", "ogg", "webm"].contains(fileExtension) else { throw VoiceAPIError.invalid("不支持的录音格式。") }
        if settings.asrProvider == "deepseek" && !["wav", "ogg"].contains(fileExtension) {
            throw VoiceAPIError.invalid("DeepSeek 语音接口需要 WAV 或 Ogg Opus 录音。")
        }
        var request = try request(url: settings.asrEndpoint, key: key)
        if settings.asrProvider == "alibaba" {
            let mime=["wav":"audio/wav","m4a":"audio/mp4","mp3":"audio/mpeg","ogg":"audio/ogg","webm":"audio/webm"][fileExtension]!
            var messages:[[String:Any]]=[]
            if !settings.dictionary.isEmpty {messages.append(["role":"system","content":"词表："+settings.dictionary.joined(separator:"、")])}
            messages.append(["role":"user","content":[["type":"input_audio","input_audio":["data":"data:\(mime);base64,"+audio.base64EncodedString()]]]])
            let payload:[String:Any]=["model":settings.asrModel,"messages":messages,"stream":false,"asr_options":["enable_itn":false]]
            request.setValue("application/json",forHTTPHeaderField:"Content-Type")
            request.httpBody=try JSONSerialization.data(withJSONObject:payload,options:[.sortedKeys])
            return request
        }
        let boundary = "NuPhyVoice-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        func field(_ name: String, _ value: String) {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
        }
        if settings.asrProvider == "openai" {
            field("model", settings.asrModel)
            if URL(string: settings.asrEndpoint)?.host != "api.siliconflow.cn" { field("response_format", "json") }
            if URL(string: settings.asrEndpoint)?.host == "api.siliconflow.cn" {
                // This API documents file/model only. The full vocabulary still reaches cleanup.
            } else if settings.asrModel == "gpt-transcribe" {
                for word in settings.dictionary { field("keywords[]", word) }
            } else if !settings.dictionary.isEmpty {
                field("prompt", "可能涉及的名称：" + settings.dictionary.joined(separator: "、"))
            }
        }
        let mime = ["wav": "audio/wav", "m4a": "audio/mp4", "mp3": "audio/mpeg", "ogg": "audio/ogg", "webm": "audio/webm"][fileExtension]!
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.\(fileExtension)\"\r\nContent-Type: \(mime)\r\n\r\n")
        body.append(audio)
        append("\r\n--\(boundary)--\r\n")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    static func cleanupRequest(text: String, settings: VoiceSettings, key: String, prompt: String) throws -> URLRequest {
        let settings = try settings.validated()
        // Both speculative and final refinement go through this request builder.
        // A saved override replaces the built-in instructions without changing ASR.
        let prompt = try settings.resolvedCleanupPrompt(defaultPrompt:prompt)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw VoiceAPIError.empty }
        guard text.utf8.count <= 65536, !prompt.isEmpty, prompt.utf8.count <= 65536 else {
            throw VoiceAPIError.invalid("本次文字或整理规则过长，未发送。")
        }
        let input: [String: Any] = [
            "transcript": text,
            "options": ["output_shape": "auto", "insertion": "standalone", "chinese_script": "preserve", "short_chat_without_final_period": false],
            "vocabulary": settings.dictionary.map { ["canonical": $0, "aliases": []] as [String: Any] },
            "style_examples": [], "context": ["before": "", "after": ""]
        ]
        let data = try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])
        let serialized = String(data: data, encoding: .utf8)!
        var payload: [String: Any] = ["model": settings.cleanupModel, "stream": false]
        // Explicit default prevents an OpenAI project-level premium tier from silently applying.
        // Other providers keep their existing compatible payload; premium tiers fail validation.
        if settings.isOfficialCleanupEndpoint { payload["service_tier"] = settings.cleanupServiceTier }
        let noReasoning = ["gpt-6-luna", "gpt-6.1-terra"].contains(settings.cleanupModel)
        if settings.cleanupProtocol == "responses" {
            payload["store"] = false
            payload["instructions"] = prompt
            payload["input"] = [["role": "user", "content": [["type": "input_text", "text": serialized]]]]
            payload["max_output_tokens"] = 8192
            if settings.cleanupModel == "gpt-6.1-sol" { payload["reasoning"] = ["effort": "low"] }
            if noReasoning { payload["reasoning"] = ["effort": "none"] }
            if settings.cleanupModel == "deepseek-flash" { payload["reasoning"] = ["effort": "none"] }
        } else {
            payload["messages"] = [["role": "system", "content": prompt], ["role": "user", "content": serialized]]
            if settings.cleanupModel == "gpt-6.1-sol" || noReasoning {
                payload["reasoning_effort"] = noReasoning ? "none" : "low"
                payload["max_completion_tokens"] = 8192
            } else {
                payload["max_tokens"] = 8192
            }
            if settings.cleanupModel == "deepseek-flash" { payload["thinking"] = ["type": "disabled"] }
            if (try? VoiceSettings.endpointURL(settings.cleanupEndpoint)).map(VoiceSettings.origin) == "https://api.siliconflow.cn:443" { payload["enable_thinking"] = false }
            if Self.isAlibabaEndpoint(settings.cleanupEndpoint) {payload["enable_thinking"]=false}
        }
        var request = try request(url: settings.cleanupEndpoint, key: key)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        try Task.checkCancellation()
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse else { throw VoiceAPIError.malformed }
        guard (200..<300).contains(http.statusCode) else { throw VoiceAPIError.http(http.statusCode) }
        guard response.expectedContentLength <= 1_048_576 else { throw VoiceAPIError.malformed }
        var data = Data()
        for try await byte in bytes {
            if data.count >= 1_048_576 { throw VoiceAPIError.malformed }
            data.append(byte)
            if data.count % 1024 == 0 { try Task.checkCancellation() }
        }
        try Task.checkCancellation()
        return data
    }

    func transcribe(audioURL: URL, settings: VoiceSettings, key: String) async throws -> String {
        try Task.checkCancellation()
        let chunks = try VoiceAudioChunks.plan(url: audioURL, secondsPerRequest: VoiceAudioChunks.secondsPerRequest(settings: settings))
        return try await Self.transcribeChunks(chunks) { chunk in
            let audio = try VoiceAudioChunks.wav(url: audioURL, chunk: chunk)
            let request = try Self.transcriptionRequest(audio: audio, settings: settings, key: key)
            return try Self.parseTranscription(try await self.send(request),provider:settings.asrProvider)
        }
    }

    // At most two bounded uploads in flight. Preserve order even when requests finish
    // out of order, and never return a partial transcript after error/cancellation.
    static func transcribeChunks(_ chunks: [VoiceAudioChunk], request: @escaping @Sendable (VoiceAudioChunk) async throws -> String) async throws -> String {
        guard !chunks.isEmpty else { throw VoiceAPIError.empty }
        var parts = Array(repeating: "", count: chunks.count)
        try await withThrowingTaskGroup(of: (Int, String).self) { group in
            var next = 0
            func enqueue(_ index: Int) {
                group.addTask { try Task.checkCancellation(); return (index, try await request(chunks[index])) }
            }
            while next < min(2, chunks.count) { enqueue(next); next += 1 }
            while let (index, text) = try await group.next() {
                try Task.checkCancellation()
                parts[index] = text
                if next < chunks.count { enqueue(next); next += 1 }
            }
        }
        try Task.checkCancellation()
        return VoiceAudioChunks.join(parts, chunks: chunks)
    }

    func cleanup(text: String, settings: VoiceSettings, key: String, prompt: String) async throws -> String {
        try await cleanupWithMetadata(text: text, settings: settings, key: key, prompt: prompt).text
    }

    func cleanupWithMetadata(text: String, settings: VoiceSettings, key: String, prompt: String) async throws -> VoiceCleanupResult {
        let request = try Self.cleanupRequest(text: text, settings: settings, key: key, prompt: prompt)
        let result = try Self.parseCleanupResult(try await send(request), protocolName: settings.cleanupProtocol)
        // Reject gross expansion/answer leakage. This is a guard, not semantic proof.
        guard result.text.count <= max(text.count * 3, text.count + 300) else { throw VoiceAPIError.incomplete }
        return result
    }

    static func parseCleanupResult(_ data: Data, protocolName: String) throws -> VoiceCleanupResult {
        let text = try parseCleanup(data, protocolName: protocolName)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let tier = object?["service_tier"] as? String
        let accepted: Set<String> = ["default", "fast", "priority", "ultrafast", "auto", "flex"]
        return VoiceCleanupResult(text: text, serviceTier: tier.flatMap { accepted.contains($0) ? $0 : nil })
    }

    static func isAlibabaEndpoint(_ endpoint:String)->Bool {
        guard let url=try? VoiceSettings.endpointURL(endpoint),url.scheme=="https",url.port==nil || url.port==443,let host=url.host?.lowercased() else{return false}
        return ["dashscope.aliyuncs.com","dashscope-intl.aliyuncs.com"].contains(host) || host.hasSuffix(".cn-beijing.maas.aliyuncs.com") || host.hasSuffix(".ap-southeast-1.maas.aliyuncs.com")
    }
    static func parseTranscription(_ data: Data,provider:String="openai") throws -> String {
        if provider=="alibaba" {return try parseCleanup(data,protocolName:"chat")}
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["error"] == nil || object["error"] is NSNull, let text = object["text"] as? String else { throw VoiceAPIError.malformed }
        return try checkedText(text)
    }

    static func parseCleanup(_ data: Data, protocolName: String) throws -> String {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["error"] == nil || object["error"] is NSNull else { throw VoiceAPIError.malformed }
        if protocolName == "responses" {
            guard object["status"] as? String == "completed", object["incomplete_details"] == nil || object["incomplete_details"] is NSNull,
                  let output = object["output"] as? [[String: Any]] else { throw VoiceAPIError.incomplete }
            var texts: [String] = []
            for item in output {
                guard let type = item["type"] as? String else { throw VoiceAPIError.malformed }
                if type == "reasoning" { continue }
                guard type == "message", item["role"] as? String == "assistant",
                      item["status"] as? String == "completed", let contents = item["content"] as? [[String: Any]] else { throw VoiceAPIError.incomplete }
                for content in contents {
                    guard content["type"] as? String == "output_text", let text = content["text"] as? String else { throw VoiceAPIError.incomplete }
                    texts.append(text)
                }
            }
            guard !texts.isEmpty else { throw VoiceAPIError.empty }
            return try checkedText(texts.joined(separator: "\n"))
        }
        guard protocolName == "chat", let choices = object["choices"] as? [[String: Any]], choices.count == 1,
              let choice = choices.first, choice["finish_reason"] as? String == "stop",
              let message = choice["message"] as? [String: Any], message["role"] as? String == "assistant",
              absentOrEmpty(message["tool_calls"]), absentOrEmpty(message["function_call"]),
              message["refusal"] == nil || message["refusal"] is NSNull,
              let text = message["content"] as? String else { throw VoiceAPIError.incomplete }
        return try checkedText(text)
    }

    private static func absentOrEmpty(_ value: Any?) -> Bool {
        value == nil || value is NSNull || (value as? [Any])?.isEmpty == true
    }

    private static func checkedText(_ value: String) throws -> String {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw VoiceAPIError.empty }
        guard text.utf8.count <= 65536, !text.contains("\0") else { throw VoiceAPIError.malformed }
        return text
    }
}
