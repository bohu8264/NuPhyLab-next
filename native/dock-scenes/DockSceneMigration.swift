import Darwin
import Foundation

enum DockMigrationError: Error {
    case experimentRunning
    case incompleteDestination
}

/// Publish the original pins, scene definitions and recovery journal together. The
/// experimental app uses this same lock while its copy of the profile is open.
func migrateDockScenes(from legacy: URL, to destination: URL) throws {
    let files = FileManager.default
    if files.fileExists(atPath: destination.path) {
        guard try DockSceneStore(directory: destination).load() != nil else {
            throw DockMigrationError.incompleteDestination
        }
        return
    }
    let legacyStore = DockSceneStore(directory: legacy)
    guard files.fileExists(atPath: legacyStore.fileURL.path) else { return }
    let lock = open(legacy.appendingPathComponent("instance.lock").path,
                    O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard lock >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EACCES) }
    defer { Darwin.close(lock) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw DockMigrationError.experimentRunning }

    let parent = destination.deletingLastPathComponent()
    try files.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let temporary = parent.appendingPathComponent(".dock-scenes-import-" + UUID().uuidString)
    try files.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { if files.fileExists(atPath: temporary.path) { try? files.removeItem(at: temporary) } }
    try files.copyItem(at: legacyStore.fileURL, to: DockSceneStore(directory: temporary).fileURL)
    guard try DockSceneStore(directory: temporary).load() != nil else { throw DockSceneError.invalidState }
    let journal = legacy.appendingPathComponent("switch-status.plist")
    if files.fileExists(atPath: journal.path) {
        // Preserve even an unconfirmed journal. The controller offers recovery on explicit request.
        try files.copyItem(at: journal, to: temporary.appendingPathComponent(journal.lastPathComponent))
    }
    try files.moveItem(at: temporary, to: destination)
}
