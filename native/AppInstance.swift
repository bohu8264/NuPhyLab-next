import Foundation
import Darwin

struct AppInstanceOwner: Codable {
    let pid: Int32
    let bundleIdentifier: String
    let executablePath: String
}

// The descriptor stays open for the host lifetime, but must never reach Node or
// HIDBridge. The kernel releases this lock even after an unexpected host exit.
final class AppInstanceLock {
    enum Acquisition {
        case acquired(AppInstanceLock)
        case existing(AppInstanceOwner?)
    }
    private let descriptor: Int32
    private init(descriptor: Int32) { self.descriptor = descriptor }
    deinit { Darwin.close(descriptor) }

    static func acquire(directory: URL, bundleIdentifier: String, executableURL: URL) throws -> Acquisition {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent("app-instance.lock")
        let fd = Darwin.open(file.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var keep = false
        defer { if !keep { Darwin.close(fd) } }
        var attributes = stat()
        guard fstat(fd, &attributes) == 0, attributes.st_uid == getuid(),
              attributes.st_mode & S_IFMT == S_IFREG, attributes.st_nlink == 1 else {
            throw POSIXError(.EPERM)
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            guard code == EWOULDBLOCK || code == EAGAIN else {
                throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
            }
            var bytes = [UInt8](repeating: 0, count: 8192)
            let count = pread(fd, &bytes, bytes.count, 0)
            let owner = count > 0 ? try? JSONDecoder().decode(AppInstanceOwner.self, from: Data(bytes.prefix(count))) : nil
            return .existing(owner)
        }
        let owner = AppInstanceOwner(pid: getpid(), bundleIdentifier: bundleIdentifier,
                                     executablePath: executableURL.resolvingSymlinksInPath().path)
        let bytes = try JSONEncoder().encode(owner)
        guard ftruncate(fd, 0) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let written = bytes.withUnsafeBytes { buffer in pwrite(fd, buffer.baseAddress, buffer.count, 0) }
        guard written == bytes.count else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        keep = true
        return .acquired(AppInstanceLock(descriptor: fd))
    }
}

struct AppUpdateHandoff: Codable {
    let token: String
    let sourcePID: Int32
    let targetVersion: String
    let createdAt: TimeInterval
    var acknowledgedPID: Int32?

    func isCurrent(token: String, version: String, now: TimeInterval) -> Bool {
        self.token == token && targetVersion == version && now >= createdAt && now - createdAt < 60
    }

    static func read(from file: URL) -> Self? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }

    func write(to file: URL) throws {
        try JSONEncoder().encode(self).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
