import AppKit
PendingAppUpdate.finishRelaunchIfNeeded()
let instanceDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Air Studio")
let instanceLock: AppInstanceLock
do {
    switch try AppInstanceLock.acquire(directory: instanceDirectory,
                                      bundleIdentifier: Bundle.main.bundleIdentifier ?? "local.airstudio.desktop",
                                      executableURL: Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])) {
    case .acquired(let lock):
        instanceLock = lock
        PendingAppUpdate.acknowledgeGUIRelaunch()
    case .existing(let owner):
        // Activate only the exact recorded owner. A development copy sharing a
        // bundle identifier must not choose or terminate an unrelated process.
        if let owner = owner,
           let running = NSRunningApplication(processIdentifier: owner.pid),
           running.bundleIdentifier == owner.bundleIdentifier,
           running.executableURL?.resolvingSymlinksInPath().path == owner.executablePath {
            running.activate(options: [.activateIgnoringOtherApps])
        }
        exit(0)
    }
} catch {
    // Failing closed avoids a second writer opening the same user library.
    fputs("NuPhy Lab could not acquire its application instance lock.\n", stderr)
    exit(1)
}
let app=NSApplication.shared
let delegate=AppDelegate();app.delegate=delegate;app.setActivationPolicy(.regular);app.run()
withExtendedLifetime(instanceLock) {}
