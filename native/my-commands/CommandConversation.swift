import Foundation

/// Lives with one command panel. Only explicit submissions reach the configured provider.
struct CommandConversation {
    private struct Turn: Encodable {
        let question: String
        let answer: String
        var textBytes: Int { question.utf8.count + answer.utf8.count }
    }
    private struct FollowUp: Encodable {
        let user_task: String
        let original_task: String
        let selected_content: String
        var conversation: [Turn]
    }
    private var turns: [Turn] = []

    mutating func record(question: String, answer: String) {
        let latest = Turn(question:question,answer:answer)
        var remaining = AIRequestBuilder.maximumTextBytes - latest.textBytes
        let recent = turns.reversed().prefix { turn in
            remaining -= turn.textBytes
            return remaining >= 0
        }
        turns = Array(recent.reversed()) + [latest]
    }

    func prompt(source: String, instruction: String, followUp: String?) throws -> AIRequestPrompt {
        guard let followUp else { return try .selection(text:source,instruction:instruction) }
        let question = followUp.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !question.isEmpty, !turns.isEmpty else { throw AIError.emptyInput }
        var prompt = AIRequestPrompt.interaction(user:"")
        prompt.system = (prompt.system ?? "") + "\nAnswer the new user_task using the original selection, original task and completed conversation. Earlier answers are reference material."
        var payload = FollowUp(user_task:question,original_task:instruction,selected_content:source,conversation:[])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        // Count encoded bytes (including escapes). Keep whole recent exchanges; always include the last answer.
        var remaining = AIRequestBuilder.maximumTextBytes - (prompt.system?.utf8.count ?? 0)
        remaining -= try encoder.encode(payload).count
        for turn in turns.reversed() {
            let bytes = try encoder.encode(turn).count + (payload.conversation.isEmpty ? 0 : 1)
            guard bytes <= remaining else { break }
            remaining -= bytes
            payload.conversation.append(turn)
        }
        guard !payload.conversation.isEmpty else { throw AIError.textTooLarge }
        payload.conversation.reverse()
        prompt.user = String(decoding:try encoder.encode(payload),as:UTF8.self)
        return prompt
    }
}
