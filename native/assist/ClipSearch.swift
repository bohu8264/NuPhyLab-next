import Foundation
import NaturalLanguage

struct ClipSearchPlan: Decodable {
    var keywords: [String]
    var kind: ClipKind?
    var oldestDaysAgo: Int?
    var newestDaysAgo: Int?

    static func local(_ query: String) -> Self {
        var rest = query.lowercased()
        var plan = Self(keywords:[],kind:nil,oldestDaysAgo:nil,newestDaysAgo:nil)
        func remove(_ phrases: [String]) -> Bool {
            var matched = false
            for term in phrases where rest.contains(term) { rest = rest.replacingOccurrences(of:term,with:" "); matched = true }
            return matched
        }
        if remove(["前天","day before yesterday"]) { plan.oldestDaysAgo=2; plan.newestDaysAgo=2 }
        else if remove(["昨天","昨日","yesterday"]) { plan.oldestDaysAgo=1; plan.newestDaysAgo=1 }
        else if remove(["今天","今日","today"]) { plan.oldestDaysAgo=0; plan.newestDaysAgo=0 }
        else if remove(["最近一周","过去一周","last 7 days","past week"]) { plan.oldestDaysAgo=6; plan.newestDaysAgo=0 }
        if remove(["网址","链接","links","link","urls","url"]) { plan.kind = .link }
        else if remove(["图片","截图","照片","screenshots","screenshot","images","image","photos","photo"]) { plan.kind = .image }
        else if remove(["文件","files","file"]) { plan.kind = .files }
        else if remove(["文字","文本","text"]) { plan.kind = .text }
        _ = remove(["帮我","帮忙","找一下","找找","查找","搜索","复制过","复制","粘贴过","有关","相关","的","项目","那条","那个",
                    "please","search for","find","copied","the ","that ","from ","project","about ","my "])
        let tokenizer = NLTokenizer(unit:.word); tokenizer.string = rest
        tokenizer.enumerateTokens(in:rest.startIndex..<rest.endIndex) { range,_ in
            let token = String(rest[range]).trimmingCharacters(in:.whitespacesAndNewlines)
            if !token.isEmpty && !["i","a","an","for","me","to"].contains(token) { plan.keywords.append(token) }
            return plan.keywords.count < 10
        }
        return plan
    }

    static func fromModel(_ answer: String) throws -> Self {
        let cleaned = answer.trimmingCharacters(in:.whitespacesAndNewlines)
        guard cleaned.utf8.count <= 8000, let start = cleaned.firstIndex(of:"{"), let end = cleaned.lastIndex(of:"}"), start <= end else { throw AIError.invalidOutputFormat }
        let plan = try JSONDecoder().decode(Self.self,from:Data(cleaned[start...end].utf8))
        guard plan.keywords.count <= 12, plan.keywords.allSatisfy({ !$0.isEmpty && $0.count<=80 }),
              [plan.oldestDaysAgo,plan.newestDaysAgo].compactMap({$0}).allSatisfy({ (0...3660).contains($0) }),
              (plan.oldestDaysAgo ?? 3660) >= (plan.newestDaysAgo ?? 0) else { throw AIError.invalidOutputFormat }
        return plan
    }

    func results(_ rows: [ClipSummary], query: String, now: Date = Date(), calendar: Calendar = .current, useEmbedding: Bool) throws -> [ClipSummary] {
        let today = calendar.startOfDay(for:now)
        let oldest = oldestDaysAgo.flatMap { calendar.date(byAdding:.day,value:0-$0,to:today) }
        let exclusiveEnd = newestDaysAgo.flatMap { calendar.date(byAdding:.day,value:1-$0,to:today) }
        let language = NLLanguageRecognizer.dominantLanguage(for:query) ?? .english
        let embedding = useEmbedding && !keywords.isEmpty ? NLEmbedding.sentenceEmbedding(for:language) : nil
        var scored: [(ClipSummary,Double)] = []
        for row in rows {
            try Task.checkCancellation()
            guard (kind == nil || kind == row.kind), oldest.map({ row.date >= $0 }) ?? true, exclusiveEnd.map({ row.date < $0 }) ?? true else { continue }
            let searchable = row.text + " " + row.source + " " + row.appID
            var score = Double(keywords.filter { searchable.localizedCaseInsensitiveContains($0) }.count) * 3
            if score == 0, let embedding {
                let distance = embedding.distance(between:keywords.joined(separator:" "),and:String(searchable.prefix(260)))
                if distance.isFinite && distance < 0.68 { score = 1-distance }
            }
            if keywords.isEmpty || score > 0 { scored.append((row,score)) }
        }
        return scored.sorted { $0.1 == $1.1 ? $0.0.date > $1.0.date : $0.1 > $1.1 }.map(\.0)
    }
}
