import Foundation
import Darwin

enum DragArchiveError: Error, LocalizedError {
    case invalid, unsafePath, links, password, changed, limit
    var errorDescription: String? {
        switch self {
        case .invalid: return "压缩包损坏或编码暂不支持 / Damaged or unsupported archive"
        case .unsafePath: return "压缩包包含异常路径或重名条目，已停止解压 / Unsafe or duplicate archive paths"
        case .links: return "暂不处理符号链接、硬链接或特殊文件 / Links and special files are not supported yet"
        case .password: return "带密码的压缩包暂不支持 / Password-protected archives are not supported yet"
        case .changed: return "文件在打包时发生变化，请重试 / A source changed while packing; try again"
        case .limit: return "超过 20,000 项或 8 GB 展开大小的处理上限 / Limit: 20,000 entries or 8 GB expanded"
        }
    }
}

/// Uses the macOS libarchive ABI. No shell, network, global working-directory
/// changes, or archive-provided path is ever passed to an extraction command.
enum DragArchiveConverter {
    static let maxEntries = 20_000
    static let maxBytes: Int64 = 8 * 1024 * 1024 * 1024
    private struct Item { let url: URL; let name: String; let info: stat }
    private static func key(_ name: String) -> String { name.precomposedStringWithCanonicalMapping.lowercased() }
    static func safeComponents(_ name: String) throws -> [String] {
        guard !name.hasPrefix("/"), !name.contains("\\"), !name.contains("\0"), name.utf8.count <= 2048,
              name.range(of: "^[A-Za-z]:", options: .regularExpression) == nil else { throw DragArchiveError.unsafePath }
        let components = name.split(separator: "/", omittingEmptySubsequences: true).map(String.init).filter { $0 != "." }
        guard components.count <= 64, !components.contains(".."), components.allSatisfy({ $0.utf8.count <= 255 }) else { throw DragArchiveError.unsafePath }
        return components
    }
    private static func metadata(_ url: URL) throws -> stat {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { throw DragConvertError.unreadable }
        let type = info.st_mode & S_IFMT
        guard type == S_IFREG || type == S_IFDIR else { throw DragArchiveError.links }
        return info
    }
    private static func manifest(_ urls: [URL], control: DragJobControl) throws -> [Item] {
        var seen = Set<String>(), tops: [URL] = []
        for url in urls.map(\.standardizedFileURL) where seen.insert(url.path).inserted { tops.append(url) }
        // Finder can supply both a parent and its selected child. Store it once.
        tops = tops.filter { url in !tops.contains { other in other != url && url.path.hasPrefix(other.path + "/") } }
        var names = Set<String>(), pending: [(URL, String)] = [], items: [Item] = [], bytes: Int64 = 0
        for url in tops {
            let base = url.lastPathComponent; var name = base, n = 1
            while names.contains(key(name)) {
                n += 1
                let ext = url.pathExtension
                name = ext.isEmpty ? "\(base)-\(n)" : "\(url.deletingPathExtension().lastPathComponent)-\(n).\(ext)"
            }
            names.insert(key(name)); pending.append((url, name))
        }
        while let (url, name) = pending.popLast() {
            try control.check(); _ = try safeComponents(name)
            let info = try metadata(url)
            guard items.count < maxEntries else { throw DragArchiveError.limit }
            items.append(Item(url: url, name: name, info: info))
            if info.st_mode & S_IFMT == S_IFDIR {
                let children = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)
                guard children.count + pending.count + items.count <= maxEntries else { throw DragArchiveError.limit }
                for child in children.sorted(by: { $0.lastPathComponent > $1.lastPathComponent }) { pending.append((child, name + "/" + child.lastPathComponent)) }
            } else {
                guard info.st_size >= 0, info.st_size <= maxBytes - bytes else { throw DragArchiveError.limit }; bytes += info.st_size
            }
        }
        return items
    }
    static func convert(_ urls: [URL], to format: DragFormat, preferences: DragConvertPreferences, control: DragJobControl) throws -> URL {
        guard !urls.isEmpty, urls.count <= 128, urls.allSatisfy(\.isFileURL) else { throw DragConvertError.unsupported }
        let access = urls.map { ($0, $0.startAccessingSecurityScopedResource()) }
        defer { access.forEach { if $0.1 { $0.0.stopAccessingSecurityScopedResource() } } }
        if format == .extract {
            let input = urls[0]
            try DragOutput.validate(input, maxBytes: 4 * 1024 * 1024 * 1024)
            let originQuarantine=try quarantine(input)
            return try DragOutput.write(input: input, preferences: preferences, ext: "", directoryOutput: true, baseName: baseName(input)) { destination in
                try extract(input, to: destination, control: control)
                if let marker=try quarantine(input) ?? originQuarantine {try applyQuarantine(marker,to:destination,control:control)}
            }
        }
        guard [.zip, .zipEach, .zipFast, .tarGz].contains(format) else { throw DragConvertError.unsupported }
        // Enumerate before creating staging, including when the output location
        // happens to be inside an input folder. Never add our own growing output.
        let items = try manifest(urls, control: control)
        let originQuarantine=try items.lazy.compactMap{try quarantine($0.url)}.first
        let name = urls.count == 1 ? urls[0].lastPathComponent : "Archive"
        return try DragOutput.write(input: urls[0], preferences: preferences, ext: format.fileExtension, baseName: name) { destination in
            try pack(items, to: destination, format: format, control: control)
            // A download may finish writing its quarantine marker while the
            // file is being packed. Recheck before publishing the archive.
            let completedQuarantine=try items.lazy.compactMap{try quarantine($0.url)}.first
            if let marker=completedQuarantine ?? originQuarantine {try applyQuarantine(marker,to:destination,control:control)}
        }
    }
    // Download provenance is a security attribute, not optional archive metadata.
    // Keep the original marker byte-for-byte and fail before publishing if it
    // cannot be written. Never execute extracted content or clear quarantine.
    private static func quarantine(_ url:URL) throws -> Data? {
        let name="com.apple.quarantine"
        let length=getxattr(url.path,name,nil,0,0,XATTR_NOFOLLOW)
        if length < 0 {
            if errno == ENOATTR {return nil}
            throw DragConvertError.unreadable
        }
        guard length<=65_536 else{throw DragConvertError.unreadable}
        var data=Data(count:length)
        let received=data.withUnsafeMutableBytes{getxattr(url.path,name,$0.baseAddress,length,0,XATTR_NOFOLLOW)}
        guard received==length else{throw DragConvertError.unreadable}
        return data
    }
    private static func applyQuarantine(_ marker:Data,to root:URL,control:DragJobControl) throws {
        var pending=[root],count=0
        while let url=pending.popLast() {
            try control.check();count+=1
            guard count<=maxEntries*65+1 else{throw DragArchiveError.limit}
            let info=try metadata(url)
            let result=marker.withUnsafeBytes{setxattr(url.path,"com.apple.quarantine",$0.baseAddress,marker.count,0,XATTR_NOFOLLOW)}
            guard result==0 else{throw DragConvertError.output}
            if info.st_mode & S_IFMT == S_IFDIR {
                pending.append(contentsOf:try FileManager.default.contentsOfDirectory(at:url,includingPropertiesForKeys:nil))
            }
        }
    }
    static func baseName(_ input: URL) -> String {
        let name = input.lastPathComponent
        for suffix in [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".tbz", ".txz", ".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz"] where name.lowercased().hasSuffix(suffix) {
            let stem = String(name.dropLast(suffix.count)); return stem.isEmpty ? "Extracted" : stem
        }
        return input.deletingPathExtension().lastPathComponent
    }
    private static func pack(_ items: [Item], to output: URL, format: DragFormat, control: DragJobControl) throws {
        guard let writer = archive_write_new() else { throw DragConvertError.encoding }
        defer { archive_write_free(writer) }
        if format == .tarGz {
            guard archive_write_set_format_pax_restricted(writer) == ARCHIVE_OK,
                  archive_write_add_filter_gzip(writer) == ARCHIVE_OK else { throw DragConvertError.encoding }
        } else {
            // GUI launches need not have a UTF-8 C locale. Declare the ZIP
            // filename encoding explicitly so other readers don't assume CP437.
            guard archive_write_set_format_zip(writer) == ARCHIVE_OK,
                  archive_write_set_options(writer, "zip:hdrcharset=UTF-8") == ARCHIVE_OK else { throw DragConvertError.encoding }
            if format == .zipFast, archive_write_set_options(writer, "zip:compression=store") != ARCHIVE_OK { throw DragConvertError.encoding }
        }
        guard archive_write_open_filename(writer, output.path) == ARCHIVE_OK else { throw DragConvertError.output }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        let total = items.reduce(Int64(0)) { $0 + ($1.info.st_mode & S_IFMT == S_IFREG ? $1.info.st_size : 0) }
        var completed: Int64 = 0
        for (index, item) in items.enumerated() {
            try control.check()
            guard let entry = archive_entry_new() else { throw DragConvertError.encoding }
            defer { archive_entry_free(entry) }
            let directory = item.info.st_mode & S_IFMT == S_IFDIR
            archive_entry_set_pathname_utf8(entry, item.name)
            archive_entry_set_filetype(entry, directory ? UInt32(S_IFDIR) : UInt32(S_IFREG))
            archive_entry_set_perm(entry, directory ? 0o755 : (item.info.st_mode & 0o111 != 0 ? 0o755 : 0o644))
            archive_entry_set_size(entry, directory ? 0 : item.info.st_size)
            archive_entry_set_mtime(entry, item.info.st_mtimespec.tv_sec, item.info.st_mtimespec.tv_nsec)
            guard archive_write_header(writer, entry) == ARCHIVE_OK else { throw DragConvertError.encoding }
            if !directory {
                let fd = open(item.url.path, O_RDONLY | O_NOFOLLOW)
                guard fd >= 0 else { throw DragConvertError.unreadable }
                defer { close(fd) }
                var current = stat()
                guard fstat(fd, &current) == 0, same(current, item.info) else { throw DragArchiveError.changed }
                var readBytes: Int64 = 0
                while true {
                    try control.check()
                    let amount = Darwin.read(fd, &buffer, buffer.count)
                    if amount < 0 && errno == EINTR { continue }
                    guard amount >= 0 else { throw DragConvertError.unreadable }
                    if amount == 0 { break }
                    guard Int64(amount) <= item.info.st_size - readBytes else { throw DragArchiveError.changed }
                    let written = buffer.withUnsafeBytes { archive_write_data(writer, $0.baseAddress, amount) }
                    guard written == amount else { throw DragConvertError.output }
                    readBytes += Int64(amount); completed += Int64(amount)
                    control.update(Double(completed) / Double(max(1, total)))
                }
                guard readBytes == item.info.st_size, fstat(fd, &current) == 0, same(current, item.info) else { throw DragArchiveError.changed }
            }
            guard archive_write_finish_entry(writer) == ARCHIVE_OK else { throw DragConvertError.output }
            if total == 0 { control.update(Double(index + 1) / Double(max(1, items.count))) }
        }
        guard archive_write_close(writer) == ARCHIVE_OK else { throw DragConvertError.output }
        try control.check(); control.update(1)
    }
    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_size == b.st_size &&
        a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec
    }
    private static func ensureDirectory(_ root: URL, components: [String]) throws -> URL {
        var current = root
        for part in components {
            current.appendPathComponent(part)
            if mkdir(current.path, 0o700) != 0 && errno != EEXIST { throw DragConvertError.output }
            var info = stat()
            guard lstat(current.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw DragArchiveError.unsafePath }
        }
        return current
    }
    private static func extract(_ input: URL, to root: URL, control: DragJobControl) throws {
        guard let reader = archive_read_new() else { throw DragArchiveError.invalid }
        defer { archive_read_free(reader) }
        // Only in-process codecs and archive readers. In particular, do not
        // register mtree or filters that could invoke external helper programs.
        archive_read_support_format_zip(reader); archive_read_support_format_tar(reader)
        archive_read_support_format_7zip(reader); archive_read_support_format_rar(reader); archive_read_support_format_rar5(reader)
        archive_read_support_filter_gzip(reader); archive_read_support_filter_bzip2(reader); archive_read_support_filter_xz(reader)
        let lower = input.lastPathComponent.lowercased()
        let raw = ["gz", "bz2", "xz"].contains(input.pathExtension.lowercased()) && ![".tar.gz", ".tar.bz2", ".tar.xz"].contains(where: lower.hasSuffix)
        if raw { archive_read_support_format_raw(reader) }
        guard archive_read_open_filename(reader, input.path, 64 * 1024) == ARCHIVE_OK else { throw DragArchiveError.invalid }
        let compressed = max(1, (try input.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 1)
        var entries = 0, bytes: Int64 = 0, paths = Set<String>(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
        var entry: OpaquePointer?
        while true {
            try control.check()
            let result = archive_read_next_header(reader, &entry)
            if result == ARCHIVE_EOF { break }
            guard result == ARCHIVE_OK, let entry else { throw DragArchiveError.invalid }
            if raw, archive_format(reader) == ARCHIVE_FORMAT_RAW, archive_filter_code(reader, 0) == ARCHIVE_FILTER_NONE { throw DragArchiveError.invalid }
            guard archive_entry_is_encrypted(entry) == 0 else { throw DragArchiveError.password }
            entries += 1; guard entries <= maxEntries else { throw DragArchiveError.limit }
            guard archive_entry_symlink(entry) == nil, archive_entry_hardlink(entry) == nil else { throw DragArchiveError.links }
            let type = archive_entry_filetype(entry)
            guard type == S_IFDIR || type == S_IFREG else { throw DragArchiveError.links }
            guard let cName = archive_entry_pathname_utf8(entry) ?? archive_entry_pathname(entry), let decoded = String(validatingCString: cName) else { throw DragArchiveError.invalid }
            let name = raw && archive_format(reader) == ARCHIVE_FORMAT_RAW ? input.deletingPathExtension().lastPathComponent : decoded
            let parts = try safeComponents(name)
            if parts.isEmpty {
                guard type == S_IFDIR, archive_read_data_skip(reader) == ARCHIVE_OK else { throw DragArchiveError.unsafePath }; continue
            }
            let normalized = key(parts.joined(separator: "/"))
            guard paths.insert(normalized).inserted else { throw DragArchiveError.unsafePath }
            if type == S_IFDIR {
                _ = try ensureDirectory(root, components: parts)
                guard archive_read_data_skip(reader) == ARCHIVE_OK else { throw DragArchiveError.invalid }
                continue
            }
            let size = archive_entry_size(entry)
            guard size >= 0, size <= maxBytes - bytes else { throw DragArchiveError.limit }
            let parent = try ensureDirectory(root, components: Array(parts.dropLast()))
            let output = parent.appendingPathComponent(parts.last!)
            let fd = open(output.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw errno == EEXIST ? DragArchiveError.unsafePath : DragConvertError.output }
            defer { close(fd) }
            var entryBytes: Int64 = 0
            while true {
                try control.check()
                let amount = archive_read_data(reader, &buffer, buffer.count)
                guard amount >= 0 else { throw DragArchiveError.invalid }
                if amount == 0 { break }
                guard Int64(amount) <= maxBytes - bytes else { throw DragArchiveError.limit }
                var offset = 0
                while offset < amount {
                    let written = buffer.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), amount - offset) }
                    if written < 0 && errno == EINTR { continue }
                    guard written > 0 else { throw DragConvertError.output }; offset += written
                }
                bytes += Int64(amount); entryBytes += Int64(amount)
                control.update(min(0.98, Double(archive_filter_bytes(reader, -1)) / Double(compressed)))
            }
            if archive_entry_size_is_set(entry) != 0, entryBytes != size { throw DragArchiveError.invalid }
            if archive_entry_perm(entry) & 0o100 != 0 { guard fchmod(fd, 0o700) == 0 else { throw DragConvertError.output } }
        }
        guard archive_read_close(reader) == ARCHIVE_OK else { throw DragArchiveError.invalid }
        try control.check(); control.update(1)
    }
}
