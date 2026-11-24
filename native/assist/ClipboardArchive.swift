import Foundation
import SQLite3

enum ClipKind: String, CaseIterable, Codable {
    case text, link, image, files
    func name(_ en: Bool) -> String {
        switch self {
        case .text: return en ? "Text" : "文字"
        case .link: return en ? "Links" : "链接"
        case .image: return en ? "Images" : "图片"
        case .files: return en ? "Files" : "文件"
        }
    }
}

struct ClipSummary: Identifiable, Equatable {
    let id: String
    let kind: ClipKind
    let text: String
    let source: String
    let appID: String
    let date: Date
    let pinned: Bool
}

struct ClipContent {
    let kind: ClipKind
    var text: String
    var format: String = ""
    var data: Data = Data()
}

struct AssistIssue: LocalizedError {
    let zh: String
    let en: String
    init(_ zh: String, _ en: String) { self.zh = zh; self.en = en }
    var errorDescription: String? { en }
    func message(_ english: Bool) -> String { english ? en : zh }
}

/// Payloads, metadata, pins and retention changes commit together. No external asset files.
final class ClipboardArchive {
    private var db: OpaquePointer?
    private static let transient = unsafeBitCast(-1, to:sqlite3_destructor_type.self)
    private let failed = AssistIssue("无法读写本地剪贴板历史。","Could not access local clipboard history.")
    static let payloadLimit = 12 * 1024 * 1024
    static let textLimit = 512 * 1024
    private let budget = 128 * 1024 * 1024

    init(directory: URL) throws {
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let file = directory.appendingPathComponent("history.sqlite")
        guard sqlite3_open_v2(file.path,&db,SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,nil) == SQLITE_OK else { throw failed }
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        sqlite3_busy_timeout(db,1200)
        try sql("PRAGMA secure_delete=ON")
        try sql("CREATE TABLE IF NOT EXISTS clips(id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, format TEXT NOT NULL, payload BLOB, app TEXT NOT NULL, bundle TEXT NOT NULL, stamp REAL NOT NULL, pin INTEGER NOT NULL DEFAULT 0)")
        let columns = try statement("SELECT name FROM pragma_table_info('clips') WHERE name='ocr_pending'") { sqlite3_step($0) == SQLITE_ROW }
        if !columns {
            try transaction {
                try sql("ALTER TABLE clips ADD COLUMN ocr_pending INTEGER NOT NULL DEFAULT 0")
                try sql("UPDATE clips SET ocr_pending=1 WHERE kind='image' AND text=''")
            }
        }
        try sql("CREATE INDEX IF NOT EXISTS clip_age ON clips(stamp DESC)")
    }
    deinit { sqlite3_close_v2(db) }

    private func sql(_ sql: String) throws {
        guard sqlite3_exec(db,sql,nil,nil,nil) == SQLITE_OK else { throw failed }
    }
    private func statement<T>(_ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,sql,-1,&stmt,nil) == SQLITE_OK, let stmt else { throw failed }
        defer { sqlite3_finalize(stmt) }
        return try body(stmt)
    }
    private func bind(_ s: OpaquePointer, _ i: Int32, _ value: String) {
        value.withCString { _ = sqlite3_bind_text(s,i,$0,Int32(value.utf8.count),Self.transient) }
    }
    private func string(_ s: OpaquePointer, _ i: Int32) -> String {
        guard let bytes = sqlite3_column_text(s,i) else { return "" }
        return String(decoding:UnsafeBufferPointer(start:bytes,count:Int(sqlite3_column_bytes(s,i))),as:UTF8.self)
    }
    private func done(_ s: OpaquePointer) throws {
        guard sqlite3_step(s) == SQLITE_DONE else { throw failed }
    }
    private func transaction<T>(_ body: () throws -> T) throws -> T {
        try sql("BEGIN IMMEDIATE")
        do { let result = try body(); try sql("COMMIT"); return result }
        catch { try? sql("ROLLBACK"); throw error }
    }
    func add(_ content: ClipContent, app: String, bundle: String, days: Int, limit: Int, now: Date = Date()) throws -> String {
        guard content.data.count <= Self.payloadLimit, content.text.utf8.count <= Self.textLimit else {
            throw AssistIssue("内容超过本地历史容量限制。","This item exceeds the local history size limit.")
        }
        let id = UUID().uuidString
        return try transaction {
            try statement("INSERT INTO clips(id,kind,text,format,payload,app,bundle,stamp,ocr_pending) VALUES(?,?,?,?,?,?,?,?,?)") { s in
                bind(s,1,id); bind(s,2,content.kind.rawValue); bind(s,3,content.text); bind(s,4,content.format)
                _ = content.data.withUnsafeBytes { sqlite3_bind_blob(s,5,$0.baseAddress,Int32($0.count),Self.transient) }
                bind(s,6,app); bind(s,7,bundle)
                sqlite3_bind_double(s,8,now.timeIntervalSince1970); sqlite3_bind_int(s,9,content.kind == .image ? 1 : 0)
                try done(s)
            }
            try pruneRows(days:days,limit:limit,now:now)
            return id
        }
    }
    func prune(days: Int, limit: Int, now: Date = Date()) throws {
        try transaction { try pruneRows(days:days,limit:limit,now:now) }
    }
    private func pruneRows(days: Int, limit: Int, now: Date) throws {
        let cutoff = now.addingTimeInterval(-Double(max(1,days)) * 86400)
        try statement("DELETE FROM clips WHERE pin=0 AND stamp<?") { s in
            sqlite3_bind_double(s,1,cutoff.timeIntervalSince1970); try done(s)
        }
        // Pins count toward the limits and stay available if all remaining entries are pinned.
        try statement("DELETE FROM clips WHERE pin=0 AND id IN (SELECT id FROM clips ORDER BY pin DESC,stamp DESC,rowid DESC LIMIT -1 OFFSET ?)") { s in
            sqlite3_bind_int(s,1,Int32(max(1,limit))); try done(s)
        }
        try statement("""
            DELETE FROM clips WHERE pin=0 AND id IN (
              SELECT id FROM (SELECT id,SUM(length(CAST(text AS BLOB))+coalesce(length(payload),0)) OVER
              (ORDER BY pin DESC,stamp DESC,rowid DESC) AS total FROM clips) WHERE total>?)
            """) { s in sqlite3_bind_int(s,1,Int32(budget)); try done(s) }
    }
    func list() throws -> [ClipSummary] {
        try statement("SELECT id,kind,substr(text,1,12000),app,bundle,stamp,pin FROM clips ORDER BY pin DESC,stamp DESC,rowid DESC") { s in
            var result: [ClipSummary] = []
            var step = sqlite3_step(s)
            while step == SQLITE_ROW {
                if let kind = ClipKind(rawValue:string(s,1)) {
                    result.append(.init(id:string(s,0),kind:kind,text:string(s,2),source:string(s,3),appID:string(s,4),
                                        date:Date(timeIntervalSince1970:sqlite3_column_double(s,5)),pinned:sqlite3_column_int(s,6) != 0))
                }
                step = sqlite3_step(s)
            }
            guard step == SQLITE_DONE else { throw failed }
            return result
        }
    }
    func matchingIDs(_ keyword: String) throws -> Set<String> {
        try statement("SELECT id FROM clips WHERE instr(lower(text),lower(?))>0 OR instr(lower(app),lower(?))>0") { s in
            bind(s,1,keyword); bind(s,2,keyword)
            var result = Set<String>()
            var step = sqlite3_step(s)
            while step == SQLITE_ROW { result.insert(string(s,0)); step = sqlite3_step(s) }
            guard step == SQLITE_DONE else { throw failed }
            return result
        }
    }
    func content(_ id: String) throws -> ClipContent {
        try statement("SELECT kind,text,format,payload FROM clips WHERE id=?") { s in
            bind(s,1,id)
            guard sqlite3_step(s) == SQLITE_ROW, let kind = ClipKind(rawValue:string(s,0)) else {
                throw AssistIssue("这条记录已删除或已到期。","This entry was removed or expired.")
            }
            let data = sqlite3_column_blob(s,3).map { Data(bytes:$0,count:Int(sqlite3_column_bytes(s,3))) } ?? Data()
            return ClipContent(kind:kind,text:string(s,1),format:string(s,2),data:data)
        }
    }
    func pendingOCR(privacy: AssistPrivacy) throws -> [String] {
        try statement("SELECT id,bundle FROM clips WHERE ocr_pending=1 ORDER BY stamp") { s in
            var result: [String] = []
            var step = sqlite3_step(s)
            while step == SQLITE_ROW {
                if privacy.allows(string(s,1)) { result.append(string(s,0)) }
                step = sqlite3_step(s)
            }
            guard step == SQLITE_DONE else { throw failed }
            return result
        }
    }
    func setOCR(_ text: String, id: String) throws {
        try statement("UPDATE clips SET text=?,ocr_pending=0 WHERE id=? AND kind='image'") { s in bind(s,1,text); bind(s,2,id); try done(s) }
    }
    func togglePin(_ id: String) throws {
        try statement("UPDATE clips SET pin=1-pin WHERE id=?") { s in bind(s,1,id); try done(s) }
    }
    func remove(_ id: String) throws {
        try statement("DELETE FROM clips WHERE id=?") { s in bind(s,1,id); try done(s) }
    }
}
