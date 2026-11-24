import Foundation

struct SelectionCommand: Codable, Equatable {
    var id: String
    var name: String
    var instruction: String
    var pinned = false
    var template: String?

    static let templates = [
        (id: "requirements", zh: "整理成产品需求", en: "Write product requirements",
         zhRule: "将选中文字整理为产品需求，列出目标、需求和验收条件。原文未说明的信息标为待确认。",
         enRule: "Turn the selection into product requirements with goals, requirements, and acceptance criteria. Mark missing details as open questions."),
        (id: "proofread", zh: "只改错别字和病句", en: "Correct spelling and grammar",
         zhRule: "只改正错别字和病句，保留原文语言、语气、意思和换行。只返回修改后的文字。",
         enRule: "Correct only spelling and grammar. Preserve the language, tone, meaning, and line breaks. Return only the corrected text."),
        (id: "todos", zh: "提取待办", en: "Extract action items",
         zhRule: "从选中文字提取待办事项，每项一行。仅在原文明确提到时列出负责人和截止时间。",
         enRule: "Extract action items, one per line. Include an owner or deadline only when the selection specifies one.")
    ]

    func localized(_ english: Bool) -> SelectionCommand {
        guard let item = Self.templates.first(where: { $0.id == template }) else { return self }
        var copy = self
        copy.name = english ? item.en : item.zh
        copy.instruction = english ? item.enRule : item.zhRule
        return copy
    }
}

enum SelectionCommandError: Error {
    case invalidCommand, missingCommand, unreadableLibrary, emptyText, tooLong, unavailable, copyFailed
    func message(_ english: Bool) -> String {
        switch self {
        case .invalidCommand: return english ? "Enter a name (up to 80 characters) and an instruction (up to 8,000 characters)." : "请填写名称（最多 80 字）和处理要求（最多 8,000 字）。"
        case .missingCommand: return english ? "This command no longer exists." : "这条指令已移除。"
        case .unreadableLibrary: return english ? "Couldn't read your saved commands. Check the settings file before editing." : "无法读取已保存的指令，请先检查设置文件。"
        case .emptyText: return english ? "Select or paste the text to process." : "请先选中或粘贴要处理的文字。"
        case .tooLong: return english ? "Select a shorter passage (up to 100 KB)." : "请缩短选区文字（最多 100 KB）。"
        case .unavailable: return english ? "Add Smart Selection in Feature Center first." : "请先在功能中心添加智能框选。"
        case .copyFailed: return english ? "Couldn't write to the clipboard. Try copying again." : "写入剪贴板失败，请重新复制。"
        }
    }
}

struct CommandLibrary {
    private struct Document: Codable {
        var commands: [SelectionCommand]
    }
    private let file: URL
    private(set) var commands: [SelectionCommand] = []
    private(set) var loadFailed = false

    init(file: URL) {
        self.file = file
        do {
            commands = try JSONDecoder().decode(Document.self, from: Data(contentsOf: file)).commands
            guard Set(commands.map(\.id)).count == commands.count else { throw SelectionCommandError.unreadableLibrary }
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            commands = SelectionCommand.templates.map { .init(id: $0.id, name: $0.zh, instruction: $0.zhRule, template: $0.id) }
        } catch {
            commands = []
            loadFailed = true
        }
    }

    func ordered(_ english: Bool) -> [SelectionCommand] {
        let all = commands.map { $0.localized(english) }
        return all.filter(\.pinned) + all.filter { !$0.pinned }
    }

    static func validated(name: String, instruction: String, id: String) throws -> SelectionCommand {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let rule = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !rule.isEmpty, name.count <= 80, rule.count <= 8000 else {
            throw SelectionCommandError.invalidCommand
        }
        return .init(id: id, name: name, instruction: rule)
    }

    mutating func update(operation: String, body: [String: Any], english: Bool) throws {
        guard !loadFailed else { throw SelectionCommandError.unreadableLibrary }
        var items = ordered(english)
        let id = body["id"] as? String
        let index = items.firstIndex { $0.id == id }
        if operation == "save" {
            var item = try Self.validated(name: body["name"] as? String ?? "", instruction: body["instruction"] as? String ?? "", id: id ?? UUID().uuidString)
            if let index {
                item.pinned = items[index].pinned
                items[index] = item
            } else {
                guard id == nil else { throw SelectionCommandError.missingCommand }
                items.append(item)
            }
        } else {
            guard let index else { throw SelectionCommandError.missingCommand }
            switch operation {
            case "delete": items.remove(at: index)
            case "pin": items[index].pinned.toggle()
            case "duplicate":
                var item = items[index]
                item.id = UUID().uuidString
                item.name = String(item.name.prefix(70)) + (english ? " (copy)" : "（副本）")
                item.template = nil
                items.insert(item, at: index + 1)
            case "move":
                let offset = body["offset"] as? Int
                guard offset == -1 || offset == 1 else { throw SelectionCommandError.invalidCommand }
                let dest = index + (offset ?? 0)
                guard items.indices.contains(dest), items[index].pinned == items[dest].pinned else { return }
                items.swapAt(index, dest)
            default: throw SelectionCommandError.invalidCommand
            }
        }
        let data = try JSONEncoder().encode(Document(commands: items))
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
        commands = items
    }
}
