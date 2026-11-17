import Foundation
import Security
import LocalAuthentication

enum VoiceConfigurationError: LocalizedError {
    case invalid(String)
    case keychain(OSStatus)
    var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .keychain(let status): return "语音输入钥匙串操作失败（\(status)），请重新保存 API Key。"
        }
    }
}

struct VoiceSettings: Codable, Equatable {
    var asrEndpoint = "https://api.openai.com/v1/audio/transcriptions"
    var asrModel = "gpt-transcribe"
    var asrProvider = "openai"
    var asrMode = "realtime"
    var realtimeModel = "gpt-live-transcribe"
    var speculativeCleanup = false
    var cleanupEndpoint = "https://api.openai.com/v1/responses"
    var cleanupModel = "gpt-6.1-sol"
    var cleanupProtocol = "responses"
    var cleanupServiceTier = "default"
    var sharedKey = true
    var shortcutKeyCode: UInt16 = 61
    var shortcutModifiers: UInt64 = 0
    var shortcutMouseButton: UInt32? = nil
    var shortcutMouseModifiers: UInt64? = nil
    var activeShortcutModifiers:UInt64 {shortcutMouseButton == nil ? shortcutModifiers:(shortcutMouseModifiers ?? shortcutModifiers)}
    var dictionary: [String] = []
    var customCleanupPrompt: String? = nil
    var allowLegacyCredentials = false
    var microphoneUID = "" // Empty follows the system default; explicit UID never changes system settings.

    static func bundledCleanupPrompt() throws -> String {
        guard let url = Bundle.main.url(forResource:"cleanup-prompt",withExtension:"txt",subdirectory:"voice-input") else {
            throw VoiceConfigurationError.invalid("无法读取默认整理提示词，请重新安装 NuPhy Lab。")
        }
        return try String(contentsOf:url,encoding:.utf8)
    }

    static func validateCleanupPrompt(_ prompt: String) throws {
        guard !prompt.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {
            throw VoiceConfigurationError.invalid("整理提示词不能为空，可恢复默认后保存。")
        }
        guard prompt.count <= 16000, prompt.utf8.count <= 65536, !prompt.contains("\0") else {
            throw VoiceConfigurationError.invalid("整理提示词最多 16000 字，不能包含空字符。")
        }
    }

    func resolvedCleanupPrompt(defaultPrompt: String) throws -> String {
        let prompt = customCleanupPrompt ?? defaultPrompt
        try Self.validateCleanupPrompt(prompt)
        return prompt
    }

    static func endpointURL(_ value: String) throws -> URL {
        guard value.utf8.count <= 2048, !value.contains("\\"),
              !value.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
              let parts = URLComponents(string: value),
              let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.fragment == nil, parts.query == nil,
              !parts.path.isEmpty, parts.path != "/",
              !parts.path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              parts.port == nil || (1...65535).contains(parts.port!),
              let url = parts.url else {
            throw VoiceConfigurationError.invalid("请填写完整接口地址，不含密钥、查询参数或账号密码。")
        }
        let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard scheme == "https" || (scheme == "http" && local) else {
            throw VoiceConfigurationError.invalid("接口必须使用 HTTPS；仅本机测试地址允许 HTTP。")
        }
        return url
    }

    static func origin(_ url: URL) -> String {
        "\(url.scheme?.lowercased() ?? "")://\(url.host?.lowercased() ?? ""):\(url.port ?? (url.scheme == "https" ? 443 : 80))"
    }

    var isOfficialCleanupEndpoint: Bool {
        guard let url = try? Self.endpointURL(cleanupEndpoint) else { return false }
        let path = cleanupProtocol == "responses" ? "/v1/responses" : "/v1/chat/completions"
        return url.scheme?.lowercased() == "https" && url.host?.lowercased() == "api.openai.com" &&
            (url.port == nil || url.port == 443) && url.path == path
    }

    func validated() throws -> VoiceSettings {
        var value = self
        value.asrEndpoint = value.asrEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        value.cleanupEndpoint = value.cleanupEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        value.asrModel = value.asrModel.trimmingCharacters(in: .whitespacesAndNewlines)
        value.cleanupModel = value.cleanupModel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ["openai", "deepseek", "alibaba"].contains(value.asrProvider),
              ["responses", "chat"].contains(value.cleanupProtocol),
              ["file", "realtime"].contains(value.asrMode),
              value.realtimeModel == "gpt-live-transcribe" else {
            throw VoiceConfigurationError.invalid("不支持的语音或文字接口协议。")
        }
        let asr = try Self.endpointURL(value.asrEndpoint)
        let cleanup = try Self.endpointURL(value.cleanupEndpoint)
        guard !value.cleanupModel.isEmpty, value.cleanupModel.count <= 160,
              !value.cleanupModel.contains(where: { $0.isNewline }),
              value.asrModel.count <= 160,
              !value.asrModel.contains(where: { $0.isNewline }),
              value.asrProvider == "deepseek" || !value.asrModel.isEmpty else {
            throw VoiceConfigurationError.invalid("请填写有效的模型名称。")
        }
        if value.sharedKey && Self.origin(asr) != Self.origin(cleanup) {
            throw VoiceConfigurationError.invalid("两个接口属于不同服务地址，请关闭共用 Key 并分别配置。")
        }
        guard ["default", "fast", "ultrafast"].contains(value.cleanupServiceTier) else {
            throw VoiceConfigurationError.invalid("请选择标准、Fast 或 Ultrafast 服务。")
        }
        if value.cleanupServiceTier != "default" {
            guard value.isOfficialCleanupEndpoint else {
                throw VoiceConfigurationError.invalid("Fast / Ultrafast 仅支持 OpenAI 官方文字接口；自定义服务请使用标准选项。")
            }
            if value.cleanupServiceTier == "ultrafast" {
                guard value.cleanupProtocol == "responses", ["gpt-6.1-sol", "gpt-6-astra"].contains(value.cleanupModel) else {
                    throw VoiceConfigurationError.invalid("Ultrafast 需要 Responses 协议及 gpt-6.1-sol 或 gpt-6-astra 模型，不会自动切换模型或服务。")
                }
            } else {
                guard ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra", "gpt-6-sol"].contains(value.cleanupModel) else {
                    throw VoiceConfigurationError.invalid("此模型尚未在语音输入确认支持 Fast，请选择已支持的 GPT-6 系列模型或标准服务。")
                }
            }
        }
        let modifierKeys: Set<UInt16> = [54,55,56,58,59,60,61,62,63]
        let mouseValid=value.shortcutMouseButton.map{(3...31).contains($0)} ?? false
        let keyboardValid=value.shortcutKeyCode < 128 && ![53,57].contains(value.shortcutKeyCode) &&
            (!modifierKeys.contains(value.shortcutKeyCode) || value.shortcutModifiers == 0)
        guard value.activeShortcutModifiers & ~UInt64(0x1E0000) == 0,
              value.shortcutMouseButton == nil ? keyboardValid : mouseValid else {
            throw VoiceConfigurationError.invalid("请选择键盘按键、组合键或鼠标侧键；鼠标左键、右键、中键、Esc 和 Caps Lock 保留。")
        }
        guard value.dictionary.count <= 100 else {
            throw VoiceConfigurationError.invalid("语音输入词库最多 100 个词条。")
        }
        if let prompt = value.customCleanupPrompt { try Self.validateCleanupPrompt(prompt) }
        guard value.microphoneUID.utf8.count<=512,!value.microphoneUID.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0)}) else {
            throw VoiceConfigurationError.invalid("麦克风选择无效，请重新选择。")
        }
        var seen = Set<String>()
        value.dictionary = try value.dictionary.compactMap { raw in
            let word = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard word.count <= 80, !word.contains(where: { $0.isNewline }),
                  !word.contains("<"), !word.contains(">"), !word.contains("\0") else {
                throw VoiceConfigurationError.invalid("每个词条最多 80 字，不能包含换行或尖括号。")
            }
            return !word.isEmpty && seen.insert(word).inserted ? word : nil
        }
        return value
    }

    enum CodingKeys: String, CodingKey {
        case asrEndpoint, asrModel, asrProvider, asrMode, realtimeModel, speculativeCleanup, cleanupEndpoint, cleanupModel, cleanupProtocol
        case cleanupServiceTier, sharedKey, shortcutKeyCode, shortcutModifiers, shortcutMouseButton, shortcutMouseModifiers, dictionary, microphoneUID, allowLegacyCredentials, customCleanupPrompt
    }
    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        asrEndpoint = try c.decodeIfPresent(String.self, forKey: .asrEndpoint) ?? asrEndpoint
        asrModel = try c.decodeIfPresent(String.self, forKey: .asrModel) ?? asrModel
        asrProvider = try c.decodeIfPresent(String.self, forKey: .asrProvider) ?? asrProvider
        // Existing installations retain their file-transcription path until explicitly changed.
        asrMode = try c.decodeIfPresent(String.self, forKey: .asrMode) ?? "file"
        realtimeModel = try c.decodeIfPresent(String.self, forKey: .realtimeModel) ?? realtimeModel
        speculativeCleanup = try c.decodeIfPresent(Bool.self, forKey: .speculativeCleanup) ?? false
        cleanupEndpoint = try c.decodeIfPresent(String.self, forKey: .cleanupEndpoint) ?? cleanupEndpoint
        cleanupModel = try c.decodeIfPresent(String.self, forKey: .cleanupModel) ?? cleanupModel
        cleanupProtocol = try c.decodeIfPresent(String.self, forKey: .cleanupProtocol) ?? cleanupProtocol
        cleanupServiceTier = try c.decodeIfPresent(String.self, forKey: .cleanupServiceTier) ?? "default"
        sharedKey = try c.decodeIfPresent(Bool.self, forKey: .sharedKey) ?? sharedKey
        shortcutKeyCode = try c.decodeIfPresent(UInt16.self, forKey: .shortcutKeyCode) ?? shortcutKeyCode
        shortcutModifiers = try c.decodeIfPresent(UInt64.self, forKey: .shortcutModifiers) ?? shortcutModifiers
        shortcutMouseButton = try c.decodeIfPresent(UInt32.self, forKey: .shortcutMouseButton)
        shortcutMouseModifiers = try c.decodeIfPresent(UInt64.self, forKey: .shortcutMouseModifiers)
        dictionary = try c.decodeIfPresent([String].self, forKey: .dictionary) ?? dictionary
        customCleanupPrompt = try c.decodeIfPresent(String.self, forKey: .customCleanupPrompt)
        microphoneUID = try c.decodeIfPresent(String.self, forKey: .microphoneUID) ?? ""
        allowLegacyCredentials = try c.decodeIfPresent(Bool.self, forKey: .allowLegacyCredentials) ?? false
    }
}

final class VoiceSettingsStore {
    static let keychainService = "local.airstudio.desktop.voiceinput"
    static let legacyKeychainService = "local.nuphylab.voiceinput"
    let directory: URL
    private(set) var settings: VoiceSettings

    init(directory: URL? = nil) throws {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Air Studio/voice-input", isDirectory: true)
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true,
                                              attributes: [.posixPermissions: 0o700])
        let file = self.directory.appendingPathComponent("settings.json")
        if FileManager.default.fileExists(atPath: file.path) {
            let data = try Data(contentsOf: file)
            guard data.count <= 262144 else { throw VoiceConfigurationError.invalid("语音输入设置文件过大。") }
            settings = try JSONDecoder().decode(VoiceSettings.self, from: data).validated()
        } else { settings = VoiceSettings() }
    }

    func save(_ value: VoiceSettings) throws {
        let value = try value.validated()
        let data = try JSONEncoder().encode(value)
        guard data.count <= 262144 else { throw VoiceConfigurationError.invalid("语音输入设置文件过大。") }
        let file = directory.appendingPathComponent("settings.json")
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        settings = value
    }

    static func keyAccount(_ kind: String, settings: VoiceSettings) throws -> String {
        guard ["cleanup", "asr"].contains(kind) else {
            throw VoiceConfigurationError.invalid("未知的语音输入密钥用途。")
        }
        let endpoint = kind == "cleanup" ? settings.cleanupEndpoint : settings.asrEndpoint
        let origin = VoiceSettings.origin(try VoiceSettings.endpointURL(endpoint))
        return "\(kind)|\(origin)"
    }

    private func query(_ kind: String, settings value: VoiceSettings? = nil) throws -> [String: Any] {
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: Self.keychainService,
                kSecAttrAccount as String: try Self.keyAccount(kind, settings: value ?? settings)]
    }

    func readKey(_ kind: String) throws -> String? { try Self.readKey(kind, settings:settings) }

    private static func readKey(_ kind:String, settings:VoiceSettings, service:String = keychainService) throws -> String? {
        var query:[String:Any] = [kSecClass as String:kSecClassGenericPassword,
            kSecAttrService as String:service,kSecAttrAccount as String:try keyAccount(kind,settings:settings)]
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            if service == keychainService && settings.allowLegacyCredentials {return try readKey(kind,settings:settings,service:legacyKeychainService)}
            return nil
        }
        guard status == errSecSuccess, let data = item as? Data,
              let text = String(data: data, encoding: .utf8) else { throw VoiceConfigurationError.keychain(status) }
        return text
    }

    // Snapshot the destinations before leaving the main actor. No mutable store or
    // cache is shared with the background read, and keys never enter UI/runtime.
    static func readSessionKeys(settings:VoiceSettings) async throws -> (cleanup:String,asr:String) {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos:.userInitiated).async {
                do {
                    guard let cleanup=try readKey("cleanup",settings:settings),!cleanup.isEmpty else {
                        throw VoiceConfigurationError.invalid("请先在设置中保存 API Key。")
                    }
                    let asr=settings.sharedKey ? cleanup : (try readKey("asr",settings:settings) ?? "")
                    guard !asr.isEmpty else{throw VoiceConfigurationError.invalid("请先保存语音识别 API Key。")}
                    continuation.resume(returning:(cleanup,asr))
                } catch {continuation.resume(throwing:error)}
            }
        }
    }

    static func validatedKey(_ key: String) throws -> String {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, key.utf8.count <= 8192, !key.contains(where: { $0.isNewline }), !key.contains("\0") else {
            throw VoiceConfigurationError.invalid("API Key 不能为空或包含换行。")
        }
        return key
    }


    static func credentialOrigins(_ settings: VoiceSettings) throws -> [String: String] {
        ["cleanup": VoiceSettings.origin(try VoiceSettings.endpointURL(settings.cleanupEndpoint)),
         "asr": VoiceSettings.origin(try VoiceSettings.endpointURL(settings.asrEndpoint))]
    }

    static func submittedKeys(from body: [String: Any], settings: VoiceSettings) throws -> [String: String] {
        var keys: [String: String] = [:]
        if let key = body["cleanupKey"] as? String, !key.isEmpty { keys["cleanup"] = key }
        if !settings.sharedKey, let key = body["asrKey"] as? String, !key.isEmpty { keys["asr"] = key }
        // WKWebView represents an unused field's JSON null as NSNull. A cast of the
        // whole dictionary to [String: String] would discard even the valid origin.
        let fields = body["keyOrigins"] as? [String: Any] ?? [:]
        let origins = fields.compactMapValues { $0 as? String }
        try validateKeyDestinations(origins, settings: settings, newKeys: keys)
        return keys
    }

    // The visible key belongs to the service selected when it was entered. Never reuse it
    // merely because another provider happens to use the same key prefix.
    static func validateKeyDestinations(_ origins: [String: String], settings: VoiceSettings, newKeys: [String: String]) throws {
        let expected = try credentialOrigins(settings)
        for (kind, key) in newKeys {
            _ = try validatedKey(key)
            guard ["cleanup", "asr"].contains(kind), origins[kind] == expected[kind] else {
                throw VoiceConfigurationError.invalid("服务地址已变化，请重新填写对应服务的 API Key。")
            }
        }
    }

    static func validateKeyRequirements(settings: VoiceSettings, newKeys: [String: String], status: [String: Bool]) throws {
        guard newKeys["cleanup"] != nil || status["hasCleanupKey"] == true else {
            throw VoiceConfigurationError.invalid("请填写所选服务商的 API Key，或切回已配置的服务商。")
        }
        if !settings.sharedKey && newKeys["asr"] == nil && status["hasASRKey"] != true {
            throw VoiceConfigurationError.invalid("请填写语音识别服务的 API Key。")
        }
    }

    func saveKey(_ key: String, kind: String, settings value: VoiceSettings? = nil) throws {
        let key = try Self.validatedKey(key)
        let query = try query(kind, settings: value)
        let update: [String: Any] = [kSecValueData as String: Data(key.utf8)]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = Data(key.utf8)
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw VoiceConfigurationError.keychain(status) }
    }

    func deleteKey(_ kind: String) throws {
        let status = SecItemDelete(try query(kind) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw VoiceConfigurationError.keychain(status) }
    }

    func keyStatus(settings value: VoiceSettings? = nil) -> [String: Bool] {
        let selected = value ?? settings
        func exists(_ kind: String, legacy:Bool=false) -> Bool {
            guard var query = try? query(kind, settings: selected) else { return false }
            if legacy {query[kSecAttrService as String] = Self.legacyKeychainService}
            query[kSecReturnAttributes as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            let context = LAContext()
            context.interactionNotAllowed = true
            query[kSecUseAuthenticationContext as String] = context
            let status = SecItemCopyMatching(query as CFDictionary, nil)
            if status == errSecItemNotFound && !legacy && selected.allowLegacyCredentials {return exists(kind,legacy:true)}
            return status == errSecSuccess || status == errSecInteractionNotAllowed || status == errSecAuthFailed
        }
        let cleanup = exists("cleanup")
        return ["hasCleanupKey": cleanup, "hasASRKey": selected.sharedKey ? cleanup : exists("asr")]
    }
}
