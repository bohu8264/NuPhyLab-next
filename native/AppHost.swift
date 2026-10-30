import AppKit
import WebKit
import Carbon
import Darwin
import ApplicationServices
import IOKit.hidsystem
#if canImport(Sparkle)
import Sparkle
#endif

let functionKeyCodes: [UInt32:String] = [122:"F1",120:"F2",99:"F3",118:"F4",96:"F5",97:"F6",98:"F7",100:"F8",101:"F9",109:"F10",103:"F11",111:"F12"]

struct WorkerRestartPolicy {
    private var failures = [TimeInterval]()
    mutating func nextDelay(now:TimeInterval) -> TimeInterval? {
        failures.removeAll{now - $0 >= 60}
        guard failures.count < 3 else{return nil}
        let delay=[0.5,1.5,4.0][failures.count];failures.append(now);return delay
    }
}

struct PendingAppUpdate: Codable {
    let targetVersion: String
    let createdAt: TimeInterval
    static let relaunchArgument = "--nuphylab-update-gui-relaunch"
    static var fileURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Air Studio/pending-app-update.json")
    }
    func needsGUIRelaunch(version: String, arguments: [String], now: TimeInterval) -> Bool {
        targetVersion == version && now >= createdAt && now - createdAt < 86400 && !arguments.contains(Self.relaunchArgument)
    }
    static func stage(version: String) throws {
        let data = try JSONEncoder().encode(Self(targetVersion:version,createdAt:Date().timeIntervalSince1970))
        try data.write(to:fileURL,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:fileURL.path)
    }
    // Sparkle can relaunch from its installer agent's bootstrap context. On
    // macOS 26 that context may not reach the user's TCC or accessibility
    // services. Before AppKit or HID starts, reopen in this same user's normal
    // session once. Existing permission grants are neither changed nor reset.
    static var handoffURL: URL { fileURL.deletingLastPathComponent().appendingPathComponent("app-update-handoff.json") }
    static func acknowledgeGUIRelaunch() {
        guard let index=CommandLine.arguments.firstIndex(of:relaunchArgument),CommandLine.arguments.count>index+1,
              let version=Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String,
              var handoff=AppUpdateHandoff.read(from:handoffURL),
              handoff.isCurrent(token:CommandLine.arguments[index+1],version:version,now:Date().timeIntervalSince1970) else{return}
        handoff.acknowledgedPID=getpid()
        try? handoff.write(to:handoffURL)
    }
    static func finishRelaunchIfNeeded() {
        guard let data=try? Data(contentsOf:fileURL),
              let pending=try? JSONDecoder().decode(Self.self,from:data),
              let version=Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String else{return}
        let relaunch=pending.needsGUIRelaunch(version:version,arguments:CommandLine.arguments,now:Date().timeIntervalSince1970)
        guard pending.targetVersion == version || Date().timeIntervalSince1970 - pending.createdAt >= 86400 else{return}
        do {try FileManager.default.removeItem(at:fileURL)} catch {return}
        guard relaunch else{return}
        let handoff=AppUpdateHandoff(token:UUID().uuidString,sourcePID:getpid(),targetVersion:version,
                                    createdAt:Date().timeIntervalSince1970,acknowledgedPID:nil)
        do {try handoff.write(to:handoffURL)} catch {return}
        let process=Process();process.executableURL=URL(fileURLWithPath:"/bin/launchctl")
        process.arguments=["asuser",String(getuid()),"/usr/bin/open","-n",Bundle.main.bundleURL.path,"--args",relaunchArgument,handoff.token]
        do {try process.run()} catch {recordRelaunch(outcome:"dispatcher-start-failed",status:nil,acknowledgedPID:nil);return}
        // open can dispatch the new process and still return a nonzero status.
        // Wait for that process to own the singleton lock before deciding whether
        // this installer-context process may continue. Never start two workers.
        let deadline=Date().addingTimeInterval(8)
        while Date()<deadline {
            if let receipt=AppUpdateHandoff.read(from:handoffURL),
               receipt.isCurrent(token:handoff.token,version:version,now:Date().timeIntervalSince1970),
               let pid=receipt.acknowledgedPID,pid>0,pid != getpid() {
                recordRelaunch(outcome:"gui-owner-acknowledged",status:process.isRunning ? nil : process.terminationStatus,acknowledgedPID:pid)
                exit(0)
            }
            Thread.sleep(forTimeInterval:0.05)
        }
        if process.isRunning || process.terminationStatus == 0 {
            recordRelaunch(outcome:"dispatcher-accepted",status:process.isRunning ? nil : process.terminationStatus,acknowledgedPID:nil)
            exit(0)
        }
        recordRelaunch(outcome:"dispatcher-failed-without-owner",status:process.terminationStatus,acknowledgedPID:nil)
    }
    private static func recordRelaunch(outcome:String,status:Int32?,acknowledgedPID:Int32?) {
        let result:[String:Any]=["outcome":outcome,"dispatcherStatus":status.map{NSNumber(value:$0)} ?? NSNull(),
                                 "acknowledgedPID":acknowledgedPID.map{NSNumber(value:$0)} ?? NSNull(),
                                 "date":ISO8601DateFormatter().string(from:Date())]
        guard let data=try? JSONSerialization.data(withJSONObject:result,options:.sortedKeys) else{return}
        let url=fileURL.deletingLastPathComponent().appendingPathComponent("update-relaunch-result.json")
        try? data.write(to:url,options:.atomic)
        try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandlerWithReply {
    let audioCapture = AudioCapture()
    var pendingAudio: [String:Any]?
    var audioSending = false
    var window: NSWindow!
    var web: WKWebView!
    var worker: Process?
    var statusItem: NSStatusItem!
    var baseURL: URL?
    var apiToken = ""
    var hotKeys: [EventHotKeyRef?] = []
    var hotkeyHandler: EventHandlerRef?
    var hotkeysEnabled = false
    var hotkeyPollTimer: Timer?
    var hotkeyStateTask: URLSessionDataTask?
    var hotkeyPollGeneration = 0
    var keyConfiguration: [(code:String,keyCode:UInt32)] = []
    var configuredKeysEnabled = false
    var capturingKey = false
    var captureSession: String?
    var capturedFunctionKeys = Set<String>()
    var editingField = false
    var heldHotkeys = Set<UInt32>()
    var keyEventQueue = [[String:Any]]()
    var keyEventSending = false
    var registeredCodes: [String] = []
    var failedCodes: [String] = []
    var carbonRegisteredCodes: [String] = []
    var nextCaptureRetry = Date.distantPast
    var captureAttemptOverride: (() -> Bool)? // In-process tests only; never configured by IPC.
    typealias DriverBrowser = (url:URL,bundleID:String)
    var driverBrowserCandidatesOverride: (() -> [DriverBrowser])? // Offline tests only; never configured by IPC.
    var driverBrowserOpenOverride: ((URL,URL,@escaping(Bool,String?)->Void)->Void)?
    var driverKeyboardReleaseOverride: ((@escaping(Bool,String?)->Void)->Void)? // Offline tests only.
    var driverReleaseTimeoutOverride: TimeInterval? // Offline timeout tests only; never configured by IPC.
    var driverOpenInFlight = false
    var driverOpenReplies = [([String:Any]?,String?)->Void]()
    var driverReturnPending = false
    var driverReturnSawInactive = false
    var driverReturnInFlight = false
    var driverReturnGeneration = 0
    var driverReturnTask: URLSessionDataTask?
    var driverApplicationIsActiveOverride: (() -> Bool)? // Offline lifecycle tests only.
    var driverReturnCommandOverride: ((String,@escaping(Bool,String?)->Void)->Void)? // Offline tests only.
    var lastKeyReport = Date.distantPast
    var lastKeyReportSignature = ""
    var lastPermissionReportSignature = ""
    var lastPermissionReport = Date.distantPast
    var keyRevision = -1
    var setupRevision = 0
    var localKeyMonitor: Any?
    var reservedKeyTap: CFMachPort?
    var reservedKeySource: CFRunLoopSource?
    let workerLogQueue = DispatchQueue(label: "AirStudio.WorkerLog")
    var terminating = false
    #if canImport(Sparkle)
    var updaterController: SPUStandardUpdaterController?
    #endif
    var pendingUpdateInstall: (() -> Void)?
    var pendingUpdateVersion: String?
    var preparingUpdate = false
    var workerRestartPolicy = WorkerRestartPolicy()
    let windowFrameName = "AirStudio.CompactWindow.v1"
    let dataDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Air Studio")
    var workerLogURL: URL { dataDirectory.appendingPathComponent("Logs/worker.log") }
    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem=NSStatusBar.system.statusItem(withLength:NSStatusItem.squareLength)
        statusItem.button?.image=NSImage(systemSymbolName:"keyboard",accessibilityDescription:"NuPhy Lab")
        if let data=try? Data(contentsOf:dataDirectory.appendingPathComponent("library.json")),
           let library=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
           let settings=library["settings"] as? [String:Any] { english=settings["language"] as? String == "en" }
        audioCapture.report = { [weak self] packet in self?.sendAudio(packet) }
        buildMenus()
        #if canImport(Sparkle)
        updaterController = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
        #endif
        window=NSWindow(contentRect:NSRect(origin:.zero,size:defaultWindowSize()),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title="NuPhy Lab";window.contentMinSize=NSSize(width:720,height:520);window.delegate=self;window.isReleasedWhenClosed=false
        if !window.setFrameUsingName(windowFrameName) {window.center()}
        window.setFrameAutosaveName(windowFrameName)
        let config=WKWebViewConfiguration();config.preferences.javaScriptCanOpenWindowsAutomatically=false
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"codexKeys")
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"audioControl")
        web=WKWebView(frame:.zero,configuration:config);web.navigationDelegate=self;web.uiDelegate=self
        window.contentView=web;show();startWorker()
        // Targeted events delivered to this window do not always become Carbon
        // global-hotkey events. Share the same held-key gate and action path.
        localKeyMonitor=NSEvent.addLocalMonitorForEvents(matching:[.keyDown,.keyUp]){[weak self] event in
            guard let self=self else{return event}
            if self.handleFunctionKey(UInt32(event.keyCode),down:event.type == .keyDown,repeated:event.isARepeat,
                modified:!event.modifierFlags.intersection([.command,.control,.option,.shift]).isEmpty) {return nil}
            guard self.hotkeysEnabled,
                  event.modifierFlags.intersection([.command,.control,.option,.shift]).isEmpty,
                  let index=self.keyConfiguration.firstIndex(where:{$0.keyCode==UInt32(event.keyCode)}) else{return event}
            let id=UInt32(index+1)
            if event.type == .keyUp {
                if self.heldHotkeys.remove(id) != nil {self.activateSlot(index,phase:"up")}
            }
            else if !event.isARepeat && self.heldHotkeys.insert(id).inserted {self.activateSlot(index)}
            return nil
        }
        NSWorkspace.shared.notificationCenter.addObserver(self,selector:#selector(willSleep),name:NSWorkspace.willSleepNotification,object:nil)
        NSWorkspace.shared.notificationCenter.addObserver(self,selector:#selector(didWake),name:NSWorkspace.didWakeNotification,object:nil)
    }
    var english=false
    let englishText:[String:String]=[
        "关于 NuPhy Lab": "About NuPhy Lab",
        "退出 NuPhy Lab": "Quit NuPhy Lab",
        "编辑": "Edit",
        "撤销": "Undo",
        "重做": "Redo",
        "剪切": "Cut",
        "复制": "Copy",
        "粘贴": "Paste",
        "全选": "Select All",
        "窗口": "Window",
        "恢复默认窗口大小": "Reset Window Size",
        "打开 NuPhy Lab": "Open NuPhy Lab",
        "暂停 / 继续": "Pause / Resume",
        "停止并恢复键盘灯效": "Stop and Restore Lighting",
        "无法启动 NuPhy Lab": "Unable to Start NuPhy Lab",
        "未能确认键盘恢复": "Keyboard Restore Unconfirmed",
        "未能确认功能键恢复": "Function Key Restore Unconfirmed",
        "退出检查未完成": "Quit Checks Incomplete",
        "部分功能键尚未确认恢复，按键适配备份已保留。重新打开 NuPhy Lab 后会再次尝试恢复。": "Some function keys could not be verified as restored. The key mapping backup is preserved. Reopen NuPhy Lab to retry.",
        "服务已经停止，但退出检查未全部通过。详细原因已记录在日志中。": "The service stopped, but some quit checks did not pass. Details have been saved in the log.",
        "灯光服务已停止": "Lighting Service Stopped",
        "原始灯效备份仍保留在本机。连接键盘后重新打开 NuPhy Lab，可再次尝试恢复。": "The original lighting backup is preserved on this Mac. Connect the keyboard and reopen NuPhy Lab to retry restoration.",
        "服务已经停止，本次恢复结果未获完整确认。": "The service stopped before restoration could be fully confirmed.",
        "\n诊断日志未能写入本机存储。": "\nUnable to save diagnostic logs on this Mac.",
        "退出": "Quit",
        "知道了": "OK",
        "显示日志": "Show Logs",
        "为 NuPhy AIR75 V3 和 Kick75 创作灯光。": "Create lighting for NuPhy Air75 V3. An independent local project.",
        "未能开始恢复键盘灯效": "Unable to Start Lighting Restore",
        "退出请求未能发送给灯光服务。应用仍保持运行，请稍后再试。": "Unable to send the quit request to the lighting service. The app is still running; try again shortly.",
        "仍在恢复键盘灯效": "Restoring Keyboard Lighting",
        "原始备份已保存。请保持键盘连接，应用将在恢复流程结束后退出。": "The original backup is saved. Keep the keyboard connected. The app will quit when restoration finishes.",
        "确定": "OK",
        "取消": "Cancel",
        "保存": "Save",
        "诊断日志已保存在：": "Diagnostic logs saved at:",
        "无法打开 NuPhyIO 官网": "Unable to Open NuPhyIO",
        "NuPhyIO 已在默认浏览器打开。固件升级请使用 Chrome 或 Edge。": "NuPhyIO opened in the default browser. Use Chrome or Edge for firmware updates.",
        "请复制官网地址并在 Chrome 或 Edge 中打开。": "Copy the official address and open it in Chrome or Edge.",
        "复制官网地址": "Copy Official Address",
        "关闭": "Close",
        "没有找到可打开官网的浏览器。": "No browser was found to open the official website.",
        "未能确认浏览器已打开，请使用下方官网地址手动打开。": "Could not confirm that the browser opened. Open the official address below manually.",
        "软件正在退出，暂未打开官网。": "NuPhy Lab is quitting; the official website was not opened.",
        "无法确认键盘已释放，请先在设备页检查恢复记录。": "Could not confirm that the keyboard was released. Check recovery records on the Device page first.",
        "键盘释放请求超时，请先在设备页检查恢复状态。": "The keyboard release request timed out. Check recovery status on the Device page first.",
        "官网已打开，但键盘尚未确认释放。": "The website is open, but keyboard release is not confirmed.",
        "请在 NuPhyIO 完成更新，关闭官网页面后返回 NuPhy Lab。": "Finish updating in NuPhyIO, close its page, and return to NuPhy Lab.",
        "NuPhyIO 官网已打开": "NuPhyIO Website Opened"
    ]
    func T(_ text:String)->String { english ? (englishText[text] ?? text) : text }
    func buildMenus(){
        let menu=NSMenu(); let app=NSMenuItem(); menu.addItem(app); let appMenu=NSMenu();app.submenu=appMenu
        appMenu.addItem(withTitle:self.T("关于 NuPhy Lab"), action:#selector(about),keyEquivalent:"")
        let updateItem=appMenu.addItem(withTitle:english ? "Check for Updates…" : "检查更新…", action:#selector(checkForUpdates),keyEquivalent:"")
        updateItem.target=self
        appMenu.addItem(NSMenuItem.separator());appMenu.addItem(withTitle:self.T("退出 NuPhy Lab"),action:#selector(quit),keyEquivalent:"q")
        let edit=NSMenuItem();menu.addItem(edit);edit.submenu=NSMenu(title:self.T("编辑"))
        for (title,selector,key) in [(self.T("撤销"),Selector(("undo:")),"z"),(self.T("重做"),Selector(("redo:")),"Z"),(self.T("剪切"),#selector(NSText.cut(_:)),"x"),(self.T("复制"),#selector(NSText.copy(_:)),"c"),(self.T("粘贴"),#selector(NSText.paste(_:)),"v"),(self.T("全选"),#selector(NSText.selectAll(_:)),"a")] {edit.submenu?.addItem(withTitle:title,action:selector,keyEquivalent:key)}
        let windowItem=NSMenuItem();menu.addItem(windowItem)
        let windowMenu=NSMenu(title:self.T("窗口"));windowItem.submenu=windowMenu
        let resetItem=windowMenu.addItem(withTitle:self.T("恢复默认窗口大小"),action:#selector(resetWindowSize),keyEquivalent:"0");resetItem.target=self
        NSApp.mainMenu=menu;NSApp.windowsMenu=windowMenu
        let tray=NSMenu();tray.addItem(withTitle:self.T("打开 NuPhy Lab"),action:#selector(show),keyEquivalent:"")
        tray.addItem(withTitle:self.T("暂停 / 继续"),action:#selector(togglePause),keyEquivalent:"")
        tray.addItem(withTitle:self.T("停止并恢复键盘灯效"),action:#selector(restore),keyEquivalent:"")
        tray.addItem(NSMenuItem.separator());tray.addItem(withTitle:self.T("退出 NuPhy Lab"),action:#selector(quit),keyEquivalent:"")
        for item in tray.items {item.target=self};statusItem.menu=tray
    }
    func startWorker(){
        guard let resources=Bundle.main.resourceURL else{return}
        let child=Process();child.executableURL=resources.appendingPathComponent("runtime/node");child.arguments=[resources.appendingPathComponent("server/main.mjs").path];child.currentDirectoryURL=resources
        var env=ProcessInfo.processInfo.environment;env["AIR_STUDIO_HID"]=resources.appendingPathComponent("bin/HIDBridge").path;env["AIR_STUDIO_UI"]=resources.appendingPathComponent("ui/dist").path;env["AIR_STUDIO_DATA"]=dataDirectory.path;env.removeValue(forKey:"AIR_STUDIO_PORT")
        // Reuse the web origin so an app update preserves the existing unsaved canvas.
        if let data=try? Data(contentsOf:dataDirectory.appendingPathComponent("runtime.json")),
           let runtime=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
           let previous=runtime["port"] as? Int, previous>0 && previous<=65535 { env["AIR_STUDIO_PREFERRED_PORT"]=String(previous) }
        child.environment=env
        let output=Pipe();child.standardOutput=output
        let errors=Pipe();child.standardError=errors
        errors.fileHandleForReading.readabilityHandler={ [weak self] handle in
            let data=handle.availableData
            if data.isEmpty {handle.readabilityHandler=nil;return}
            self?.appendWorkerLog(data)
        }
        var pending=Data()
        output.fileHandleForReading.readabilityHandler={ [weak self] handle in
            let data=handle.availableData;if data.isEmpty{return};pending.append(data)
            while let newline=pending.firstIndex(of:10){let line=pending.prefix(upTo:newline);pending.removeSubrange(...newline)
                if let message=(try? JSONSerialization.jsonObject(with:line)) as? [String:Any],message["event"] as? String=="ready",let url=message["url"] as? String {DispatchQueue.main.async {self?.ready(url)}}
            }
        }
        child.terminationHandler={ [weak self] stopped in
            guard let self=self else{return}
            errors.fileHandleForReading.readabilityHandler=nil
            let remaining=errors.fileHandleForReading.readDataToEndOfFile()
            if !remaining.isEmpty {self.appendWorkerLog(remaining)}
            let status=stopped.terminationStatus
            let signaled=stopped.terminationReason == .uncaughtSignal
            self.appendWorkerLog(Data("\n[\(ISO8601DateFormatter().string(from:Date()))] Worker exited: status=\(status), signaled=\(signaled)\n".utf8))
            // Flush queued log writes before presenting an error or allowing AppKit to exit.
            self.workerLogQueue.async { [weak self] in
                DispatchQueue.main.async {self?.workerDidExit(status:status,signaled:signaled)}
            }
        }
        do{try child.run();worker=child}catch{
            appendWorkerLog(Data("Worker launch failed: \(error.localizedDescription)\n".utf8))
            let alert=NSAlert();alert.messageText=self.T("无法启动 NuPhy Lab");alert.informativeText=error.localizedDescription;alert.runModal()
        }
    }
    func appendWorkerLog(_ bytes:Data){
        workerLogQueue.async { [weak self] in
            guard let self=self else{return}
            let manager=FileManager.default, url=self.workerLogURL
            do {
                try manager.createDirectory(at:url.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                if let size=(try? manager.attributesOfItem(atPath:url.path)[.size]) as? NSNumber,size.intValue>1_048_576 {
                    let previous=url.appendingPathExtension("previous")
                    if manager.fileExists(atPath:previous.path){try manager.removeItem(at:previous)}
                    try manager.moveItem(at:url,to:previous)
                }
                if !manager.fileExists(atPath:url.path){manager.createFile(atPath:url.path,contents:nil,attributes:[.posixPermissions:0o600])}
                let handle=try FileHandle(forWritingTo:url)
                defer {try? handle.close()}
                try handle.seekToEnd()
                if bytes.count>65_536 {try handle.write(contentsOf:Data("[stderr chunk truncated]\n".utf8))}
                try handle.write(contentsOf:bytes.suffix(65_536))
                try handle.synchronize()
            } catch {
                // A logging failure cannot mask the worker's nonzero exit status.
            }
        }
    }
    func workerDidExit(status:Int32,signaled:Bool){
        stopHotkeyMonitoring()
        worker=nil
        baseURL=nil;apiToken=""
        if !terminating, let delay=workerRestartPolicy.nextDelay(now:ProcessInfo.processInfo.systemUptime) {
            audioCapture.stop();pendingAudio=nil
            appendWorkerLog(Data("Restarting local service after unexpected exit in \(delay)s.\n".utf8))
            DispatchQueue.main.asyncAfter(deadline:.now()+delay){[weak self] in
                guard let self=self,!self.terminating,self.worker==nil else{return}
                self.startWorker()
            }
            return
        }
        let failed=status != 0 || signaled
        if failed || !terminating {
            let alert=NSAlert()
            alert.alertStyle=failed ? .warning : .informational
            let lightingFiles=["original-lighting.json","original-lighting.profile-0.json","original-lighting.profile-1.json"]
            let deviceDirectories=(try? FileManager.default.contentsOfDirectory(at:dataDirectory.appendingPathComponent("devices"),includingPropertiesForKeys:nil)) ?? []
            let hasBackup=([dataDirectory]+deviceDirectories).contains { directory in
                lightingFiles.contains {FileManager.default.fileExists(atPath:directory.appendingPathComponent($0).path)}
            }
            let hasKeyBackup=([dataDirectory]+deviceDirectories).contains { directory in
                ["key-mapping-backup.json","function-key-backup.json"].contains { FileManager.default.fileExists(atPath:directory.appendingPathComponent($0).path) }
            }
            alert.messageText=english ? "Unable to finish this time" : "暂时未能完成"
            let backupMessage=(hasBackup || hasKeyBackup) ? (english ? "Your keyboard settings are saved. Reconnect it and reopen NuPhy Lab to continue." : "键盘设置已保留。请重新连接键盘并打开 NuPhy Lab，软件会继续处理。") : (english ? "Please reopen NuPhy Lab. Your work and settings are kept." : "请重新打开 NuPhy Lab。作品和设置会保留。")
            let logExists=FileManager.default.fileExists(atPath:workerLogURL.path)
            alert.informativeText=backupMessage
            alert.addButton(withTitle:terminating ? self.T("退出") : self.T("知道了"))
            if logExists {alert.addButton(withTitle:self.T("显示日志"))}
            NSApp.activate(ignoringOtherApps:true)
            if alert.runModal() == .alertSecondButtonReturn {NSWorkspace.shared.activateFileViewerSelecting([workerLogURL])}
        }
        if terminating {NSApp.reply(toApplicationShouldTerminate:true)}
    }
    func ready(_ address:String){
        guard !terminating,worker?.isRunning==true,let url=URL(string:address) else{return};baseURL=url
        if let bytes=try? Data(contentsOf:dataDirectory.appendingPathComponent("runtime.json")),let data=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any]{apiToken=data["token"] as? String ?? ""}
        web.load(URLRequest(url:url))
        startHotkeyMonitoring()
    }
    @objc func show(){window?.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)}
    func defaultWindowSize() -> NSSize {
        let visible=(window?.screen ?? NSScreen.main)?.visibleFrame.size ?? NSSize(width:1440,height:900)
        return NSSize(width:max(720,min(1100,visible.width * 0.85)),height:max(520,min(700,visible.height * 0.82 - 28)))
    }
    @objc func resetWindowSize(){
        window.setContentSize(defaultWindowSize());window.center()
        window.saveFrame(usingName:windowFrameName)
        show()
    }
    @objc func about(){NSApp.orderFrontStandardAboutPanel(options:[.applicationName:"NuPhy Lab",.applicationVersion:(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development"),.credits:NSAttributedString(string:self.T("为 NuPhy AIR75 V3 和 Kick75 创作灯光。"))])}
    @objc func togglePause(){post(["op":"pause"])}
    @objc func restore(){post(["op":"restore"])}
    @objc func quit(){NSApp.terminate(nil)}
    @objc func checkForUpdates(){
        if pendingUpdateInstall != nil { prepareUpdateInstallation(); return }
        #if canImport(Sparkle)
        updaterController?.checkForUpdates(nil)
        #endif
    }
    func prepareUpdateInstallation(){
        guard !preparingUpdate, pendingUpdateInstall != nil, let base=baseURL else {return}
        guard let version=pendingUpdateVersion else{return}
        do {try PendingAppUpdate.stage(version:version)} catch {
            appendWorkerLog(Data("Unable to prepare update relaunch: \(error.localizedDescription)\n".utf8))
            let alert=NSAlert();alert.messageText=english ? "Unable to install the update yet" : "暂时无法安装更新"
            alert.informativeText=english ? "Please try again later. Your app and work are kept." : "请稍后重试。当前软件和作品会保留。"
            alert.addButton(withTitle:english ? "OK" : "知道了");alert.runModal();return
        }
        preparingUpdate=true
        setExitPresentation(true)
        var request=URLRequest(url:base.appendingPathComponent("api/command"),timeoutInterval:60)
        request.httpMethod="POST";request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token")
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try? JSONSerialization.data(withJSONObject:["op":"prepareAppUpdate"])
        URLSession.shared.dataTask(with:request){[weak self] data,response,error in
            DispatchQueue.main.async {
                guard let self=self else{return};self.preparingUpdate=false
                let result=data.flatMap{try? JSONSerialization.jsonObject(with:$0)} as? [String:Any]
                if error == nil,(response as? HTTPURLResponse)?.statusCode==200,result?["ok"] as? Bool==true {
                    self.stopHotkeyMonitoring();self.audioCapture.stop();self.pendingAudio=nil
                    let install=self.pendingUpdateInstall;self.pendingUpdateInstall=nil;install?()
                } else {
                    self.setExitPresentation(false)
                    self.appendWorkerLog(Data("Update preparation failed: \(error?.localizedDescription ?? String(describing:result?["error"]))\n".utf8))
                    let alert=NSAlert();alert.messageText=self.english ? "Update paused" : "更新暂时暂停"
                    alert.informativeText=self.english ? "Reconnect your keyboard and try again. Your current app and work are kept." : "请重新连接键盘后重试。当前软件和作品会保留。"
                    alert.addButton(withTitle:self.english ? "Try Again" : "重试");alert.addButton(withTitle:self.english ? "Later" : "稍后")
                    if alert.runModal() == .alertFirstButtonReturn {self.prepareUpdateInstallation()}
                }
            }
        }.resume()
    }
    @objc func willSleep(){ audioCapture.stop();pendingAudio=nil }
    @objc func didWake(){ if !terminating && !preparingUpdate {post(["op":"resumeConnection"])} }
    func post(_ data:[String:Any]){guard let base=baseURL else{return};var request=URLRequest(url:base.appendingPathComponent("api/command"));request.httpMethod="POST";request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token");request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.httpBody=try? JSONSerialization.data(withJSONObject:data);URLSession.shared.dataTask(with:request).resume()}
    func activateSlot(_ index:Int,phase:String="down"){
        guard hotkeysEnabled,!terminating,keyConfiguration.indices.contains(index) else{return}
        enqueueKey(["op":"codexKey","code":keyConfiguration[index].code,"phase":phase])
    }
    func enqueueKey(_ data:[String:Any]) {
        keyEventQueue.append(data);sendNextKey()
    }
    func sendNextKey() {
        guard !keyEventSending,!keyEventQueue.isEmpty,let base=baseURL else{return}
        keyEventSending=true
        var request=URLRequest(url:base.appendingPathComponent("api/command"),timeoutInterval:5)
        request.httpMethod="POST";request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token")
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try? JSONSerialization.data(withJSONObject:keyEventQueue.removeFirst())
        URLSession.shared.dataTask(with:request){[weak self] _,_,_ in
            DispatchQueue.main.async {self?.keyEventSending=false;self?.sendNextKey()}
        }.resume()
    }
    func sendAudio(_ packet:[String:Any]) {
        guard !terminating,let base=baseURL else{return}
        if packet["op"] as? String == "audioInventory" {post(packet);return}
        pendingAudio=packet
        guard !audioSending else{return}
        sendPendingAudio(base)
    }
    func sendPendingAudio(_ base:URL) {
        guard !terminating,let packet=pendingAudio else{return}
        pendingAudio=nil;audioSending=true
        var request=URLRequest(url:base.appendingPathComponent("api/command"),timeoutInterval:2)
        request.httpMethod="POST";request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token")
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try? JSONSerialization.data(withJSONObject:packet)
        URLSession.shared.dataTask(with:request){[weak self] _,_,_ in DispatchQueue.main.async {
            guard let self=self else{return};self.audioSending=false
            if self.pendingAudio != nil {self.sendPendingAudio(base)}
        }}.resume()
    }
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage,replyHandler:@escaping(Any?,String?)->Void){
        guard message.frameInfo.isMainFrame,let url=message.frameInfo.request.url,
              url.host==baseURL?.host,url.port==baseURL?.port,
              let body=message.body as? [String:Any] else{replyHandler(nil,"Invalid origin");return}
        if message.name == "audioControl" {
            guard let permission=body["permission"] as? String,["microphone","system"].contains(permission) else{replyHandler(nil,"Invalid permission");return}
            let pane=permission == "microphone" ? "Privacy_Microphone" : "Privacy_AudioCapture"
            NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?"+pane)!)
            replyHandler(true,nil);return
        }
        switch body["kind"] as? String {
        case "checkForUpdates":
            checkForUpdates();replyHandler(["opened":true],nil);return
        case "openOfficialDriver":
            // Only the fixed official URL can leave this bridge. Website
            // access does not flash firmware. Release USB first because an already
            // authorised NuPhyIO tab can immediately connect through WebHID.
            openOfficialDriver { result,error in replyHandler(result,error) }
            return
        case "permission":
            guard let permission=body["permission"] as? String,
                  let result=requestNativePermission(permission) else{replyHandler(nil,"Invalid permission");return}
            replyHandler(result,nil);return
        case "permissions","refreshPermissions":
            refreshHotkeys()
            // The caller sends this exact snapshot with its helper refresh.
            // A fire-and-forget POST here races that refresh and can leave the
            // response using the host's previous (denied) permissions.
            replyHandler(nativePermissionSnapshot(),nil);return
        case "capture":
            let session=body["session"] as? String
            if body["active"] as? Bool == true {
                captureSession=session;capturingKey=true;capturedFunctionKeys.removeAll()
            } else if session==captureSession {
                captureSession=nil;capturingKey=false;capturedFunctionKeys.removeAll()
            }
            refreshHotkeys()
        case "editing": editingField=body["active"] as? Bool==true;refreshHotkeys()
        case "config": applyKeyConfiguration(body["value"] as? [String:Any])
        default: replyHandler(nil,"Invalid operation");return
        }
        replyHandler(true,nil)
    }
    func nativePermissionSnapshot()->[String:Any] {
        // Query current TCC authorization. CoreGraphics preflight can retain a
        // denied result from before the first grant for this process lifetime.
        // IOHIDCheckAccess is a public, read-only API; unknown stays denied.
        ["inputMonitoring":IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted,
         "accessibility":AXIsProcessTrusted(),
         "canPostEvents":IOHIDCheckAccess(kIOHIDRequestTypePostEvent) == kIOHIDAccessTypeGranted,"promptsRequested":false]
    }
    func reportNativePermissions(force:Bool=false) {
        guard baseURL != nil,!terminating else{return}
        let permissions=nativePermissionSnapshot()
        let signature=["inputMonitoring","accessibility","canPostEvents"].map{permissions[$0] as? Bool == true ? "1":"0"}.joined()
        guard force || signature != lastPermissionReportSignature || Date().timeIntervalSince(lastPermissionReport)>5 else{return}
        lastPermissionReportSignature=signature;lastPermissionReport=Date()
        post(["op":"nativePermissions","permissions":permissions])
    }
    func requestNativePermission(_ permission:String)->[String:Any]? {
        let pane:String
        switch permission {
        case "inputMonitoring":
            pane="Privacy_ListenEvent"
            if IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted { _ = CGRequestListenEventAccess() }
        case "accessibility":
            pane="Privacy_Accessibility"
            if !AXIsProcessTrusted() {
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
            }
        default:return nil
        }
        // Request from the signed app itself, so a clean Mac gets a NuPhy Lab
        // entry to enable. Opening the settings URL alone does not register it.
        let opened=NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?"+pane)!)
        reportNativePermissions(force:true)
        refreshHotkeys()
        return ["opened":opened,"permission":permission,"permissions":nativePermissionSnapshot()]
    }
    func applicationDidBecomeActive(_ notification:Notification){
        reportNativePermissions(force:true);refreshHotkeys();resumeAfterOfficialDriverIfNeeded()
    }
    func applicationDidResignActive(_ notification:Notification){
        if driverOpenInFlight || driverReturnPending {driverReturnSawInactive=true}
        refreshHotkeys()
    }
    var driverApplicationIsActive:Bool {driverApplicationIsActiveOverride?() ?? (NSApp?.isActive ?? false)}
    func resetOfficialDriverReturn() {
        driverReturnGeneration += 1;driverReturnPending=false;driverReturnSawInactive=false;driverReturnInFlight=false
        driverReturnTask?.cancel();driverReturnTask=nil
    }
    // Returning to NuPhy Lab is the user's request to reconnect after updating.
    // Never poll/reopen USB in the background while NuPhyIO is in front, and
    // consume the handoff once so old firmware or a failed probe cannot loop.
    func resumeAfterOfficialDriverIfNeeded() {
        guard driverReturnPending,driverReturnSawInactive,!driverReturnInFlight,!driverOpenInFlight,
              !terminating,driverApplicationIsActive else{return}
        driverReturnPending=false;driverReturnInFlight=true
        let generation=driverReturnGeneration
        func finish(_ error:String?) {
            guard generation==self.driverReturnGeneration else{return}
            self.driverReturnInFlight=false;self.driverReturnTask=nil
            if let error=error,self.baseURL != nil {
                self.appendWorkerLog(Data("[NuPhyIO return] \(error)\n".utf8))
            }
        }
        sendOfficialDriverReturnCommand("connect") { success,error in
            guard generation==self.driverReturnGeneration else{return}
            guard success,!self.terminating,self.driverApplicationIsActive else{finish(error);return}
            self.sendOfficialDriverReturnCommand("checkFirmware") { _,error in
                guard generation==self.driverReturnGeneration else{return};finish(error)
            }
        }
    }
    func sendOfficialDriverReturnCommand(_ op:String,completion:@escaping(Bool,String?)->Void) {
        guard ["connect","checkFirmware"].contains(op),!terminating,driverApplicationIsActive else {
            completion(false,nil);return
        }
        var completed=false
        func finish(_ success:Bool,_ error:String?) {
            DispatchQueue.main.async {guard !completed else{return};completed=true;completion(success,error)}
        }
        if let override=driverReturnCommandOverride {override(op,finish);return}
        guard let base=baseURL,!apiToken.isEmpty else {finish(false,"Local service is unavailable.");return}
        var request=URLRequest(url:base.appendingPathComponent("api/command"),timeoutInterval:30)
        request.httpMethod="POST";request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token")
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try? JSONSerialization.data(withJSONObject:["op":op])
        driverReturnTask=URLSession.shared.dataTask(with:request){data,response,error in
            let value=data.flatMap{try? JSONSerialization.jsonObject(with:$0)} as? [String:Any]
            if error == nil,(response as? HTTPURLResponse)?.statusCode==200,value?["ok"] as? Bool==true {
                finish(true,nil)
            } else {finish(false,(value?["error"] as? String) ?? error?.localizedDescription ?? "Local service did not accept the request.")}
        }
        driverReturnTask?.resume()
    }
    let officialDriverURL = URL(string:"https://drive.nuphy.io/?lang=zh-CN")!
    func driverBrowserCandidates()->[DriverBrowser] {
        if let override=driverBrowserCandidatesOverride {return override()}
        var result=[DriverBrowser]()
        for bundleID in ["com.google.Chrome","com.microsoft.edgemac"] {
            if let url=NSWorkspace.shared.urlForApplication(withBundleIdentifier:bundleID) {
                result.append((url,bundleID))
            }
        }
        if let url=NSWorkspace.shared.urlForApplication(toOpen:officialDriverURL),
           !result.contains(where:{$0.url.standardizedFileURL==url.standardizedFileURL}) {
            result.append((url,Bundle(url:url)?.bundleIdentifier ?? ""))
        }
        return result
    }
    // A permitted NuPhyIO page connects over WebHID as soon as it opens. Restore
    // and release our handle first. A failed release is returned separately and
    // never suppresses access to the fixed official website.
    func prepareOfficialDriver(completion:@escaping(Bool,String?)->Void) {
        var completed=false
        func finish(_ released:Bool,_ error:String?) {
            DispatchQueue.main.async {
                guard !completed else{return};completed=true
                completion(released,error)
            }
        }
        let timeout=driverReleaseTimeoutOverride ?? 48
        DispatchQueue.main.asyncAfter(deadline:.now()+timeout) {
            finish(false,self.T("键盘释放请求超时，请先在设备页检查恢复状态。"))
        }
        if let override=driverKeyboardReleaseOverride {override(finish);return}
        guard let base=baseURL,!apiToken.isEmpty else {
            finish(false,T("无法确认键盘已释放，请先在设备页检查恢复记录。"));return
        }
        var request=URLRequest(url:base.appendingPathComponent("api/command"),timeoutInterval:45)
        request.httpMethod="POST";request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token")
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try? JSONSerialization.data(withJSONObject:["op":"prepareFirmwareUpdate"])
        URLSession.shared.dataTask(with:request){data,response,error in
            let value=data.flatMap{try? JSONSerialization.jsonObject(with:$0)} as? [String:Any]
            let result=value?["result"] as? [String:Any]
            if error == nil,(response as? HTTPURLResponse)?.statusCode == 200,
               value?["ok"] as? Bool == true,result?["url"] as? String == self.officialDriverURL.absoluteString {
                finish(true,nil)
            } else {
                finish(false,(value?["error"] as? String) ?? error?.localizedDescription ?? self.T("无法确认键盘已释放，请先在设备页检查恢复记录。"))
            }
        }.resume()
    }
    func openOfficialDriver(completion:@escaping([String:Any]?,String?)->Void) {
        guard !terminating else {completion(nil,T("软件正在退出，暂未打开官网。"));return}
        driverOpenReplies.append(completion)
        guard !driverOpenInFlight else{return}
        resetOfficialDriverReturn()
        driverOpenInFlight=true
        let browsers=driverBrowserCandidates()
        func finish(_ result:[String:Any]?,_ error:String?) {
            let replies=self.driverOpenReplies
            self.driverOpenReplies.removeAll();self.driverOpenInFlight=false
            for reply in replies {reply(result,error)}
        }
        guard !browsers.isEmpty else {
            finish(nil,T("没有找到可打开官网的浏览器。")+" "+T("请复制官网地址并在 Chrome 或 Edge 中打开。")+" "+officialDriverURL.absoluteString)
            return
        }
        prepareOfficialDriver { released,prepareError in
            guard !self.terminating else {finish(nil,self.T("软件正在退出，暂未打开官网。"));return}
            if let error=prepareError,self.baseURL != nil {
                self.appendWorkerLog(Data("[NuPhyIO handoff] \(error)\n".utf8))
            }
            self.launchOfficialDriver(browsers:browsers) { value,error in
                guard var result=value else {finish(nil,error);return}
                self.driverReturnPending=true
                if !self.driverApplicationIsActive {self.driverReturnSawInactive=true}
                result["safeReleased"]=released
                if let error=prepareError {result["prepareError"]=error}
                finish(result,error)
            }
        }
    }
    func launchOfficialDriver(browsers:[DriverBrowser],completion:@escaping([String:Any]?,String?)->Void) {
        guard !browsers.isEmpty else {
            completion(nil,T("没有找到可打开官网的浏览器。")+" "+T("请复制官网地址并在 Chrome 或 Edge 中打开。")+" "+officialDriverURL.absoluteString)
            return
        }
        var finished=false
        func finish(_ result:[String:Any]?,_ error:String?) {
            guard !finished else{return};finished=true
            if let error=error,self.baseURL != nil {
                self.appendWorkerLog(Data("[NuPhyIO website] \(error)\n".utf8))
            }
            completion(result,error)
        }
        func attempt(_ index:Int) {
            guard !finished else{return}
            guard !self.terminating else {finish(nil,self.T("软件正在退出，暂未打开官网。"));return}
            guard index<browsers.count else {
                finish(nil,self.T("无法打开 NuPhyIO 官网")+"。"+self.T("请复制官网地址并在 Chrome 或 Edge 中打开。")+" "+self.officialDriverURL.absoluteString)
                return
            }
            let browser=browsers[index]
            let opened:(Bool,String?)->Void = { success,error in
                DispatchQueue.main.async {
                    guard !finished else{return}
                    if success {
                        let supportsUSB=["com.google.Chrome","com.microsoft.edgemac"].contains(browser.bundleID)
                        let name=(Bundle(url:browser.url)?.object(forInfoDictionaryKey:"CFBundleDisplayName") as? String)
                            ?? (Bundle(url:browser.url)?.object(forInfoDictionaryKey:"CFBundleName") as? String)
                            ?? browser.url.deletingPathExtension().lastPathComponent
                        finish(["opened":true,"url":self.officialDriverURL.absoluteString,"browser":name,
                                "browserBundleId":browser.bundleID,"browserSupportsUSB":supportsUSB,
                                "needsSupportedBrowser":!supportsUSB,
                                "message":supportsUSB ? "" : self.T("NuPhyIO 已在默认浏览器打开。固件升级请使用 Chrome 或 Edge。")],nil)
                    } else {
                        if self.baseURL != nil {
                            self.appendWorkerLog(Data("[NuPhyIO website] Browser \(browser.bundleID) failed: \(error ?? "unknown error")\n".utf8))
                        }
                        attempt(index+1)
                    }
                }
            }
            if let override=self.driverBrowserOpenOverride {override(self.officialDriverURL,browser.url,opened);return}
            let config=NSWorkspace.OpenConfiguration();config.activates=true
            NSWorkspace.shared.open([self.officialDriverURL],withApplicationAt:browser.url,configuration:config) { application,error in
                opened(application != nil && error == nil,error?.localizedDescription)
            }
        }
        // A hung launch service must not leave the web view's promise pending
        // forever. Late completions do not open extra fallback browsers.
        DispatchQueue.main.asyncAfter(deadline:.now()+15) {
            finish(nil,self.T("未能确认浏览器已打开，请使用下方官网地址手动打开。")+" "+self.officialDriverURL.absoluteString)
        }
        attempt(0)
    }
    func presentOfficialDriverMessage(_ message:String,error:Bool) {
        let alert=NSAlert();alert.alertStyle=error ? .warning : .informational
        alert.messageText=T(error ? "无法打开 NuPhyIO 官网" : "NuPhyIO 官网已打开")
        alert.informativeText=message+"\n\n"+officialDriverURL.absoluteString
        alert.addButton(withTitle:T("复制官网地址"));alert.addButton(withTitle:T("关闭"))
        let copy:(NSApplication.ModalResponse)->Void = { [weak self] response in
            guard response == .alertFirstButtonReturn,let self=self else{return}
            NSPasteboard.general.clearContents();NSPasteboard.general.setString(self.officialDriverURL.absoluteString,forType:.string)
        }
        if let window=window {alert.beginSheetModal(for:window,completionHandler:copy)}
        else {copy(alert.runModal())}
    }
    func applyKeyConfiguration(_ value:[String:Any]?){
        if let revision=value?["revision"] as? Int {
            guard revision>=keyRevision else{return};keyRevision=revision
        }
        if let revision=value?["setupRevision"] as? Int,revision != setupRevision {
            setupRevision=revision;setHotkeysEnabled(false)
        }
        let raw=value?["bindings"] as? [[String:Any]] ?? []
        let next=raw.compactMap { item -> (code:String,keyCode:UInt32)? in
            guard let code=item["code"] as? String,let n=item["keyCode"] as? Int,n>=0,n<=127 else{return nil}
            return (code,UInt32(n))
        }
        let valid=next.count==12 && Set(next.map{$0.code}).count==12 && Set(next.map{$0.keyCode}).count==12
        configuredKeysEnabled=valid && value?["enabled"] as? Bool==true
        if keyConfiguration.map({$0.code}) != next.map({$0.code}) || keyConfiguration.map({$0.keyCode}) != next.map({$0.keyCode}) {
            setHotkeysEnabled(false);keyConfiguration=valid ? next : []
        }
        refreshHotkeys()
    }
    func refreshHotkeys(){
        setHotkeysEnabled(configuredKeysEnabled && !capturingKey && !(editingField && NSApp.isActive) && !terminating && hotkeyPollTimer != nil)
        if hotkeysEnabled { refreshReservedKeyCapture() }
        if capturingKey && NSApp.isActive && !terminating { _ = startReservedKeyCapture() }
        else if !hotkeysEnabled { stopReservedKeyCapture() }
        reportHotkeys()
    }
    func reportHotkeys(){
        guard baseURL != nil,!terminating else{return}
        let suspended=capturingKey || (editingField && NSApp.isActive)
        let signature="\(registeredCodes)|\(failedCodes)|\(suspended)"
        guard signature != lastKeyReportSignature || Date().timeIntervalSince(lastKeyReport)>5 else{return}
        lastKeyReportSignature=signature;lastKeyReport=Date()
        post(["op":"codexKeyStatus","registered":registeredCodes,"failed":failedCodes,"suspended":suspended])
    }
    func startHotkeyMonitoring(){
        stopHotkeyMonitoring()
        keyRevision = -1
        reportNativePermissions(force:true)
        let timer=Timer(timeInterval:0.5,repeats:true){[weak self] _ in self?.pollHotkeySetting()}
        hotkeyPollTimer=timer;RunLoop.main.add(timer,forMode:.common)
        pollHotkeySetting()
    }
    func stopHotkeyMonitoring(){
        audioCapture.stop();pendingAudio=nil
        hotkeyPollGeneration+=1
        hotkeyPollTimer?.invalidate();hotkeyPollTimer=nil
        hotkeyStateTask?.cancel();hotkeyStateTask=nil
        setHotkeysEnabled(false)
        stopReservedKeyCapture()
    }
    func pollHotkeySetting(){
        guard !terminating,hotkeyPollTimer != nil,hotkeyStateTask == nil,let base=baseURL else{return}
        reportNativePermissions()
        let generation=hotkeyPollGeneration
        var request=URLRequest(url:base.appendingPathComponent("api/state"),cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:3)
        request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token")
        hotkeyStateTask=URLSession.shared.dataTask(with:request){[weak self] data,response,_ in
            let state=data.flatMap{(try? JSONSerialization.jsonObject(with:$0)) as? [String:Any]}
            let settings=state?["settings"] as? [String:Any]
            let codex=state?["codex"] as? [String:Any]
            let keys=(response as? HTTPURLResponse)?.statusCode==200 ? codex?["keys"] as? [String:Any] : nil
            DispatchQueue.main.async {
                guard let self=self,self.hotkeyPollGeneration==generation else{return}
                self.hotkeyStateTask=nil
                if let value=settings?["language"] as? String, ["en","zh-CN"].contains(value), self.english != (value == "en") { self.english = value == "en"; self.buildMenus() }
                self.applyKeyConfiguration(keys)
                self.audioCapture.sync((state?["audio"] as? [String:Any])?["capture"] as? [String:Any])
            }
        }
        hotkeyStateTask?.resume()
    }
    func setHotkeysEnabled(_ enabled:Bool){
        if enabled {
            guard !hotkeysEnabled else{return}
            hotkeysEnabled=true;installHotkeys()
        } else {
            if !capturingKey {stopReservedKeyCapture()}
            for id in heldHotkeys {
                let index=Int(id)-1
                if keyConfiguration.indices.contains(index) {enqueueKey(["op":"codexKey","code":keyConfiguration[index].code,"phase":"up"])}
            }
            hotkeysEnabled=false
            for key in hotKeys {if let key=key {UnregisterEventHotKey(key)}}
            hotKeys.removeAll();heldHotkeys.removeAll();registeredCodes.removeAll();failedCodes.removeAll();carbonRegisteredCodes.removeAll();nextCaptureRetry = .distantPast
            if let handler=hotkeyHandler {RemoveEventHandler(handler);hotkeyHandler=nil}
        }
    }
    func installHotkeys(){
        guard hotkeysEnabled,hotKeys.isEmpty,hotkeyHandler==nil else{return}
        var eventTypes=[EventTypeSpec(eventClass:OSType(kEventClassKeyboard),eventKind:UInt32(kEventHotKeyPressed)),EventTypeSpec(eventClass:OSType(kEventClassKeyboard),eventKind:UInt32(kEventHotKeyReleased))]
        let status=InstallEventHandler(GetApplicationEventTarget(),{_,event,user in
            guard let event=event,let user=user else{return noErr};var ident=EventHotKeyID();GetEventParameter(event,EventParamName(kEventParamDirectObject),EventParamType(typeEventHotKeyID),nil,MemoryLayout<EventHotKeyID>.size,nil,&ident)
            let host=Unmanaged<AppDelegate>.fromOpaque(user).takeUnretainedValue()
            guard host.hotkeysEnabled,!host.terminating else{return OSStatus(eventNotHandledErr)}
            if GetEventKind(event)==UInt32(kEventHotKeyReleased) {
                if host.heldHotkeys.remove(ident.id) != nil {host.activateSlot(Int(ident.id)-1,phase:"up")}
            }
            else if host.heldHotkeys.insert(ident.id).inserted {host.activateSlot(Int(ident.id)-1)}
            return noErr
        },2,&eventTypes,Unmanaged.passUnretained(self).toOpaque(),&hotkeyHandler)
        guard status==noErr else {hotkeysEnabled=false;failedCodes=keyConfiguration.map{$0.code};return}
        for (i,binding) in keyConfiguration.enumerated(){
            var key:EventHotKeyRef?
            let result=RegisterEventHotKey(binding.keyCode,0,EventHotKeyID(signature:0x41495253,id:UInt32(i+1)),GetApplicationEventTarget(),0,&key)
            if result==noErr {hotKeys.append(key);registeredCodes.append(binding.code)}
            else {failedCodes.append(binding.code);appendWorkerLog(Data("Hotkey \(binding.code) unavailable: \(result)\n".utf8))}
        }
        carbonRegisteredCodes = registeredCodes
        refreshReservedKeyCapture(force:true)
    }
    func refreshReservedKeyCapture(force:Bool=false,now:Date=Date()) {
        guard hotkeysEnabled else{return}
        let functions=keyConfiguration.filter{functionKeyCodes[$0.keyCode] != nil}.map{$0.code}
        guard !functions.isEmpty else{return}
        // Permission may be granted after registration. Retry without requiring
        // a mode toggle or app restart, and rebuild reports from actual capture.
        guard force || reservedKeyTap != nil || now >= nextCaptureRetry else{return}
        nextCaptureRetry=now.addingTimeInterval(2)
        let captured=startReservedKeyCapture()
        registeredCodes=keyConfiguration.map{$0.code}.filter{carbonRegisteredCodes.contains($0) || (captured && functions.contains($0))}
        failedCodes=keyConfiguration.map{$0.code}.filter{!registeredCodes.contains($0) || (!captured && $0=="F11")}
        // A key needing the event tap is not ready merely because Carbon
        // accepted a registration that macOS can intercept first.
        registeredCodes.removeAll{failedCodes.contains($0)}
    }
    func stopReservedKeyCapture(){
        if let tap=reservedKeyTap {CGEvent.tapEnable(tap:tap,enable:false);CFMachPortInvalidate(tap)}
        if let source=reservedKeySource {CFRunLoopRemoveSource(CFRunLoopGetMain(),source,.commonModes)}
        reservedKeyTap=nil;reservedKeySource=nil
    }
    func startReservedKeyCapture()->Bool {
        if let attempt=captureAttemptOverride {return attempt()}
        if let tap=reservedKeyTap {
            if !CGEvent.tapIsEnabled(tap:tap) {CGEvent.tapEnable(tap:tap,enable:true)}
            return CGEvent.tapIsEnabled(tap:tap)
        }
        let mask=(CGEventMask(1)<<CGEventType.keyDown.rawValue)|(CGEventMask(1)<<CGEventType.keyUp.rawValue)
        guard let tap=CGEvent.tapCreate(tap:.cghidEventTap,place:.headInsertEventTap,options:.defaultTap,eventsOfInterest:mask,callback:{_,type,event,context in
            guard let context=context else{return Unmanaged.passUnretained(event)}
            let host=Unmanaged<AppDelegate>.fromOpaque(context).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if host.hotkeysEnabled || host.capturingKey,let tap=host.reservedKeyTap {CGEvent.tapEnable(tap:tap,enable:true)}
                return Unmanaged.passUnretained(event)
            }
            return host.handleReservedKey(type,event) ? nil : Unmanaged.passUnretained(event)
        },userInfo:Unmanaged.passUnretained(self).toOpaque()),let source=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,tap,0) else{return false}
        reservedKeyTap=tap;reservedKeySource=source
        CFRunLoopAddSource(CFRunLoopGetMain(),source,.commonModes);CGEvent.tapEnable(tap:tap,enable:true)
        return true
    }
    func handleReservedKey(_ type:CGEventType,_ event:CGEvent)->Bool {
        guard [CGEventType.keyDown,.keyUp].contains(type) else{return false}
        return handleFunctionKey(UInt32(event.getIntegerValueField(.keyboardEventKeycode)),down:type == .keyDown,
            repeated:event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
            modified:!event.flags.intersection([.maskCommand,.maskControl,.maskAlternate,.maskShift]).isEmpty)
    }
    func handleFunctionKey(_ keyCode:UInt32,down:Bool,repeated:Bool,modified:Bool)->Bool {
        guard !terminating,let code=functionKeyCodes[keyCode] else{return false}
        if capturingKey && NSApp.isActive {
            if !down,capturedFunctionKeys.remove(code) != nil {sendCapturedFunctionKey(code,phase:"up");return true}
            guard !modified else{return false}
            if down && !repeated && capturedFunctionKeys.insert(code).inserted {sendCapturedFunctionKey(code,phase:"down")}
            return true
        }
        guard hotkeysEnabled,let index=keyConfiguration.firstIndex(where:{$0.keyCode==keyCode}) else{return false}
        let id=UInt32(index+1)
        if !down,heldHotkeys.remove(id) != nil {
            activateSlot(index,phase:"up");return true
        }
        guard !modified else{return false}
        if down && !repeated && heldHotkeys.insert(id).inserted {
            activateSlot(index)
        }
        return true
    }
    func sendCapturedFunctionKey(_ code:String,phase:String) {
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('nuphylab:function-key',{detail:{code:'\(code)',phase:'\(phase)'}}));",completionHandler:nil)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{return false}
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows:Bool)->Bool{show();return true}
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply{
        if terminating{return .terminateLater}
        resetOfficialDriverReturn()
        stopHotkeyMonitoring()
        guard let worker=worker else{return .terminateNow}
        // A stopped process may still have a queued termination callback and log flush.
        // Let that callback surface a nonzero exit instead of bypassing it on a second quit.
        terminating=true
        setExitPresentation(true)
        guard worker.isRunning else{return .terminateLater}
        // Signal only Node. Its shutdown handler must keep HIDBridge alive until
        // restore and helper shutdown finish; Process.terminate() can hit its group.
        let workerPID=worker.processIdentifier
        let signalResult=workerPID>0 ? Darwin.kill(workerPID,SIGTERM) : -1
        let signalError=workerPID>0 ? errno : EINVAL
        if signalResult != 0 && signalError != ESRCH {
            terminating=false
            setExitPresentation(false)
            appendWorkerLog(Data("Worker shutdown signal failed: pid=\(workerPID), errno=\(signalError)\n".utf8))
            startHotkeyMonitoring()
            let alert=NSAlert();alert.alertStyle = .warning;alert.messageText=self.T("未能开始恢复键盘灯效");alert.informativeText=self.T("退出请求未能发送给灯光服务。应用仍保持运行，请稍后再试。");alert.runModal()
            return .terminateCancel
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+45){if worker.isRunning{let alert=NSAlert();alert.messageText=self.T("仍在恢复键盘灯效");alert.informativeText=self.T("原始备份已保存。请保持键盘连接，应用将在恢复流程结束后退出。");alert.beginSheetModal(for:self.window){_ in }}}
        return .terminateLater
    }
    func setExitPresentation(_ active: Bool) {
        web.evaluateJavaScript("window.__AIR_EXITING__ = \(active ? "true" : "false"); window.dispatchEvent(new Event('nuphylab:shutdown'));", completionHandler:nil)
    }
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){
        guard let url=navigationAction.request.url else{decisionHandler(.cancel);return}
        if navigationAction.shouldPerformDownload {decisionHandler(.download);return}
        if url.scheme=="blob"||url.host=="127.0.0.1"{decisionHandler(.allow);return}
        decisionHandler(.cancel)
        guard ["https","http"].contains(url.scheme ?? "") else{return}
        if url.scheme=="https", url.host=="drive.nuphy.io" {
            openOfficialDriver { [weak self] result,error in
                guard let self=self else{return}
                if let error=error {self.presentOfficialDriverMessage(error,error:true)}
                else if result?["prepareError"] as? String != nil {
                    self.presentOfficialDriverMessage(self.T("请在 NuPhyIO 完成更新，关闭官网页面后返回 NuPhy Lab。"),error:false)
                } else if result?["needsSupportedBrowser"] as? Bool == true {
                    self.presentOfficialDriverMessage(result?["message"] as? String ?? "",error:false)
                }
            }
            return
        }
        NSWorkspace.shared.open(url)
    }
    func webView(_ webView:WKWebView,navigationAction:WKNavigationAction,didBecome download:WKDownload){download.delegate=self}
    func webView(_ webView:WKWebView,navigationResponse:WKNavigationResponse,didBecome download:WKDownload){download.delegate=self}
    func download(_ download:WKDownload,decideDestinationUsing response:URLResponse,suggestedFilename:String,completionHandler:@escaping(URL?)->Void){let name=URL(fileURLWithPath:suggestedFilename).lastPathComponent;let dir=FileManager.default.urls(for:.downloadsDirectory,in:.userDomainMask)[0];let url=dir.appendingPathComponent("NuPhy Lab-\(Int(Date().timeIntervalSince1970))-\(name)");completionHandler(url)}
    func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping([URL]?)->Void){let panel=NSOpenPanel();panel.canChooseDirectories=false;panel.allowsMultipleSelection=parameters.allowsMultipleSelection;panel.beginSheetModal(for:window){result in completionHandler(result == .OK ? panel.urls:nil)}}
    func webView(_ webView:WKWebView,runJavaScriptAlertPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping()->Void){let alert=NSAlert();alert.messageText=message;alert.beginSheetModal(for:window){_ in completionHandler()}}
    func webView(_ webView:WKWebView,runJavaScriptConfirmPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(Bool)->Void){let alert=NSAlert();alert.messageText=message;alert.addButton(withTitle:self.T("确定"));alert.addButton(withTitle:self.T("取消"));alert.beginSheetModal(for:window){completionHandler($0 == .alertFirstButtonReturn)}}
    func webView(_ webView:WKWebView,runJavaScriptTextInputPanelWithPrompt prompt:String,defaultText:String?,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(String?)->Void){let alert=NSAlert();alert.messageText=prompt;alert.addButton(withTitle:self.T("保存"));alert.addButton(withTitle:self.T("取消"));let field=NSTextField(string:defaultText ?? "");field.frame=NSRect(x:0,y:0,width:300,height:28);alert.accessoryView=field;alert.beginSheetModal(for:window){completionHandler($0 == .alertFirstButtonReturn ? field.stringValue:nil)}}
}

#if canImport(Sparkle)
extension AppDelegate: SPUUpdaterDelegate {
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        pendingUpdateInstall=installHandler
        pendingUpdateVersion=item.versionString
        prepareUpdateInstallation()
        return true
    }
}
#endif
