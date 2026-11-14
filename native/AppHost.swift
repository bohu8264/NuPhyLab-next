import UniformTypeIdentifiers
import AppKit
import WebKit
import Carbon
import Darwin
import CryptoKit
import ApplicationServices
import IOKit.hidsystem
#if canImport(Sparkle)
import Sparkle
#endif

let functionKeyCodes: [UInt32:String] = [122:"F1",120:"F2",99:"F3",118:"F4",96:"F5",97:"F6",98:"F7",100:"F8",101:"F9",109:"F10",103:"F11",111:"F12"]

enum NativeKeyOrigin {
    static func isHardware(_ event: CGEvent?) -> Bool {
        guard let event=event else{return false}
        return event.getIntegerValueField(.eventSourceUnixProcessID) == 0
    }
}

// Authenticity belongs to the native event path, not the web API token. The
// secret stays in memory and the worker environment; never expose it in state.
struct NativeKeySigner {
    private let key: SymmetricKey
    private(set) var sequence = 0
    init(secret: Data? = nil) {
        if let secret {
            precondition(secret.count == 32)
            key = SymmetricKey(data: secret)
        } else { key = SymmetricKey(size: .bits256) }
    }
    var environmentSecret: String { key.withUnsafeBytes { Data($0).base64EncodedString() } }
    // Domain separation keeps the helper from signing native key events.
    var physicalHoldSecret: String {
        Data(HMAC<SHA256>.authenticationCode(for:Data("nuphylab-native-hold-key-v1".utf8),using:key)).base64EncodedString()
    }
    var mappingCommitSecret:String {
        Data(HMAC<SHA256>.authenticationCode(for:Data("nuphylab-mapping-commit-key-v1".utf8),using:key)).base64EncodedString()
    }
    private static func validASCII(_ value: String, limit: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= limit && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45,46,58,95].contains($0)
        }
    }
    static func bindingEpoch(_ value: Any?) -> Int? {
        guard let number=value as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,number.doubleValue >= 0,number.doubleValue <= 9_007_199_254_740_991,
              number.doubleValue.rounded(.towardZero) == number.doubleValue else{return nil}
        return number.intValue
    }
    mutating func sign(_ packet: [String:Any], trusted: Bool = false) -> [String:Any]? {
        guard trusted,packet["op"] as? String == "codexKey",
              let code=packet["code"] as? String,Self.validASCII(code,limit:80),
              let phase=packet["phase"] as? String,["down","up"].contains(phase),
              let gestureID=packet["gestureId"] as? String,Self.validASCII(gestureID,limit:160),
              let source=packet["eventSource"] as? String,["eventTap","carbon","local"].contains(source),
              let epoch=Self.bindingEpoch(packet["nativeKeyBindingEpoch"]),
              sequence < 9_007_199_254_740_991 else{return nil}
        let next=sequence+1
        let canonical: [Any] = ["nuphylab-native-key-v2",next,code,phase,gestureID,source,epoch]
        guard let bytes=try? JSONSerialization.data(withJSONObject:canonical) else{return nil}
        let signature=HMAC<SHA256>.authenticationCode(for:bytes,using:key).map{String(format:"%02x",$0)}.joined()
        var signed=packet
        signed["nativeKeySequence"]=next;signed["nativeKeySignature"]=signature;signed["nativeKeyBindingEpoch"]=epoch
        sequence=next
        return signed
    }
    mutating func signRotary(action:String,epoch:Int,sessionID:String,trusted:Bool=false)->[String:Any]? {
        guard trusted,["left","right","pressDown","pressUp"].contains(action),epoch>0,
              epoch<=9_007_199_254_740_991,let uuid=UUID(uuidString:sessionID),
              uuid.uuidString.lowercased()==sessionID,sequence<9_007_199_254_740_991 else{return nil}
        let next=sequence+1,atMs=Int(Date().timeIntervalSince1970*1000)
        let canonical:[Any]=["nuphylab-native-rotary-v1",next,action,epoch,sessionID,atMs]
        guard let bytes=try? JSONSerialization.data(withJSONObject:canonical) else{return nil}
        let signature=HMAC<SHA256>.authenticationCode(for:bytes,using:key).map{String(format:"%02x",$0)}.joined()
        sequence=next
        return ["op":"codexRotary","action":action,"epoch":epoch,"sessionId":sessionID,"atMs":atMs,
                "nativeRotarySequence":next,"nativeRotarySignature":signature]
    }
}

// BEGIN NATIVE HOLD STATE
// Ephemeral proof of the native key's present state. This store never opens
// an application, observes HID, reads a target, or restores a previous session.
final class NativePhysicalHoldStore {
    typealias BeforeWrite = (Data, URL) throws -> Void
    private struct Identity: Equatable {
        let device: dev_t
        let inode: ino_t
        init(_ value: stat) {device=value.st_dev;inode=value.st_ino}
    }
    private struct Record {
        let gestureID: String
        let keyCode: Int
        let bindingEpoch: Int
        let held: Bool
        let recordedAtMs: Int
    }
    static let maximumSafeInteger = 9_007_199_254_740_991
    private static let modifierKeyCodes = Set(54...63)
    let directoryURL: URL
    let fileURL: URL
    private let key: SymmetricKey
    private let directoryIdentity: Identity
    private let beforeWrite: BeforeWrite?
    private let lock = NSLock()
    private var directoryFD: Int32
    private var currentIdentity: Identity?
    private var lastRecord: Record?
    private var closed = false

    init?(secret: Data, baseDirectory: URL = FileManager.default.temporaryDirectory,
          beforeWrite: BeforeWrite? = nil) {
        guard secret.count == 32,baseDirectory.isFileURL else {return nil}
        let base=baseDirectory.standardizedFileURL.resolvingSymlinksInPath()
        var template=Array(base.appendingPathComponent("nuphylab-native-hold-XXXXXX").path.utf8CString)
        guard let path=template.withUnsafeMutableBufferPointer({ buffer -> String? in
            guard let pointer=buffer.baseAddress,let result=mkdtemp(pointer) else {return nil}
            return String(cString:result)
        }) else {return nil}
        let directory=URL(fileURLWithPath:path,isDirectory:true)
        let fd=Darwin.open(path,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW)
        var metadata=stat()
        guard fd >= 0,fstat(fd,&metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,metadata.st_uid == geteuid(),
              (metadata.st_mode & 0o777) == 0o700 else {
            if fd >= 0 {Darwin.close(fd)}
            _ = Darwin.rmdir(path)
            return nil
        }
        directoryURL=directory;fileURL=directory.appendingPathComponent("current.json")
        key=SymmetricKey(data:secret);directoryFD=fd;directoryIdentity=Identity(metadata)
        self.beforeWrite=beforeWrite
    }
    deinit {close()}

    @discardableResult
    func write(gestureID: String, keyCode: Int, bindingEpoch: Int, held: Bool, nowMs: Int) -> Bool {
        lock.lock();defer {lock.unlock()}
        guard !closed,Self.validID(gestureID),keyCode >= 0,keyCode <= 127,
              !Self.modifierKeyCodes.contains(keyCode),Self.safe(bindingEpoch),Self.safe(nowMs) else {return false}
        return persist(Record(gestureID:gestureID,keyCode:keyCode,bindingEpoch:bindingEpoch,held:held,recordedAtMs:nowMs))
    }
    @discardableResult
    func invalidate(nowMs: Int) -> Bool {
        lock.lock();defer {lock.unlock()}
        guard !closed else {return true}
        guard Self.safe(nowMs),let record=lastRecord else {return removeCurrent()}
        return persist(Record(gestureID:record.gestureID,keyCode:record.keyCode,
            bindingEpoch:record.bindingEpoch,held:false,recordedAtMs:nowMs))
    }
    func close() {
        lock.lock();defer {lock.unlock()}
        guard !closed else {return}
        _ = removeCurrent()
        // Do not recursively remove a directory or follow a replacement path.
        // Unexpected entries remain untouched; rmdir succeeds only when empty.
        if directoryIsCurrent(requirePrivatePermissions:false) {_ = Darwin.rmdir(directoryURL.path)}
        closed=true
        if directoryFD >= 0 {Darwin.close(directoryFD);directoryFD = -1}
    }
    private static func safe(_ value: Int) -> Bool {value >= 0 && value <= maximumSafeInteger}
    private static func validID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 160 && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45,46,58,95].contains($0)
        }
    }
    private func directoryIsCurrent(requirePrivatePermissions: Bool = true) -> Bool {
        guard directoryFD >= 0 else {return false}
        var pathMetadata=stat(),fdMetadata=stat()
        return lstat(directoryURL.path,&pathMetadata) == 0 && fstat(directoryFD,&fdMetadata) == 0 &&
            Identity(pathMetadata) == directoryIdentity && Identity(fdMetadata) == directoryIdentity &&
            (pathMetadata.st_mode & S_IFMT) == S_IFDIR && pathMetadata.st_uid == geteuid() &&
            (!requirePrivatePermissions || (pathMetadata.st_mode & 0o777) == 0o700)
    }
    private func currentMayBeReplaced() -> Bool {
        var value=stat()
        if fstatat(directoryFD,"current.json",&value,AT_SYMLINK_NOFOLLOW) != 0 {return errno == ENOENT}
        return (value.st_mode & S_IFMT) == S_IFREG && value.st_uid == geteuid() &&
            (value.st_mode & 0o777) == 0o600 &&
            currentIdentity == Identity(value)
    }
    @discardableResult
    private func removeCurrent() -> Bool {
        lastRecord=nil
        guard directoryFD >= 0 else {currentIdentity=nil;return false}
        var value=stat()
        if fstatat(directoryFD,"current.json",&value,AT_SYMLINK_NOFOLLOW) != 0 {
            let absent=errno == ENOENT
            if absent {currentIdentity=nil}
            return absent
        }
        guard (value.st_mode & S_IFMT) == S_IFREG,value.st_uid == geteuid(),
              currentIdentity == Identity(value) else {return false}
        guard unlinkat(directoryFD,"current.json",0) == 0 else {return false}
        currentIdentity=nil;return true
    }
    private func persist(_ record: Record) -> Bool {
        var temporaryName: String?
        var temporaryIdentity: Identity?
        var temporaryFD: Int32 = -1
        defer {
            if temporaryFD >= 0 {Darwin.close(temporaryFD)}
            if let name=temporaryName,let identity=temporaryIdentity {
                var value=stat()
                if fstatat(directoryFD,name,&value,AT_SYMLINK_NOFOLLOW) == 0,
                   Identity(value) == identity {_ = unlinkat(directoryFD,name,0)}
            }
        }
        do {
            guard directoryIsCurrent(),currentMayBeReplaced() else {throw CocoaError(.fileWriteUnknown)}
            let canonical: [Any] = ["nuphylab-native-hold-v1",record.gestureID,record.keyCode,
                record.bindingEpoch,record.held,record.recordedAtMs]
            let canonicalBytes=try JSONSerialization.data(withJSONObject:canonical)
            let signature=HMAC<SHA256>.authenticationCode(for:canonicalBytes,using:key).map{String(format:"%02x",$0)}.joined()
            let payload: [String:Any] = ["gestureId":record.gestureID,"sourceKeyCode":record.keyCode,
                "bindingEpoch":record.bindingEpoch,"held":record.held,"recordedAtMs":record.recordedAtMs,"signature":signature]
            let bytes=try JSONSerialization.data(withJSONObject:payload,options:.sortedKeys)
            try beforeWrite?(bytes,fileURL)
            guard directoryIsCurrent(),currentMayBeReplaced() else {throw CocoaError(.fileWriteUnknown)}
            let name=".write-\(UUID().uuidString).tmp"
            temporaryFD=openat(directoryFD,name,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC|O_NOFOLLOW,0o600)
            guard temporaryFD >= 0 else {throw CocoaError(.fileWriteUnknown)}
            var value=stat()
            guard fstat(temporaryFD,&value) == 0 else {throw CocoaError(.fileWriteUnknown)}
            temporaryName=name;temporaryIdentity=Identity(value)
            guard (value.st_mode & S_IFMT) == S_IFREG,value.st_uid == geteuid(),
                  (value.st_mode & 0o777) == 0o600 else {throw CocoaError(.fileWriteUnknown)}
            try bytes.withUnsafeBytes { raw in
                guard let pointer=raw.baseAddress else {throw CocoaError(.fileWriteUnknown)}
                var offset=0
                while offset < raw.count {
                    let count=Darwin.write(temporaryFD,pointer.advanced(by:offset),raw.count-offset)
                    if count < 0 && errno == EINTR {continue}
                    guard count > 0 else {throw CocoaError(.fileWriteUnknown)}
                    offset+=count
                }
            }
            guard Darwin.close(temporaryFD) == 0 else {temporaryFD = -1;throw CocoaError(.fileWriteUnknown)}
            temporaryFD = -1
            guard directoryIsCurrent(),currentMayBeReplaced(),
                  renameat(directoryFD,name,directoryFD,"current.json") == 0 else {throw CocoaError(.fileWriteUnknown)}
            temporaryName=nil;currentIdentity=Identity(value);lastRecord=record
            return true
        } catch {
            // A failed release must never leave a readable held=true record.
            _ = removeCurrent()
            return false
        }
    }
}
// END NATIVE HOLD STATE

struct WorkerRestartPolicy {
    private var failures = [TimeInterval]()
    mutating func nextDelay(now:TimeInterval) -> TimeInterval? {
        failures.removeAll{now - $0 >= 60}
        guard failures.count < 3 else{return nil}
        let delay=[0.5,1.5,4.0][failures.count];failures.append(now);return delay
    }
}

struct AppUpdateReminder: Codable {
    let version: String
    let remindAfter: TimeInterval
    static let delay: TimeInterval = 24 * 60 * 60
    func allows(version: String, userInitiated: Bool, now: TimeInterval) -> Bool {
        userInitiated || self.version != version || now >= remindAfter
    }
}

enum AppUpdateAlertKind {case preparationFailed, keyboardReleaseFailed}
func makeAppUpdateAlert(_ kind: AppUpdateAlertKind, english: Bool) -> NSAlert {
    let alert=NSAlert()
    switch kind {
    case .preparationFailed:
        alert.messageText=english ? "Unable to install the update yet" : "暂时无法安装更新"
        alert.informativeText=english ? "Please try again later. Your app and work are kept." : "请稍后重试。当前软件和作品会保留。"
        alert.addButton(withTitle:english ? "OK" : "知道了")
    case .keyboardReleaseFailed:
        alert.messageText=english ? "Update paused" : "更新暂时暂停"
        alert.informativeText=english ? "Reconnect your keyboard and try again. Your current app and work are kept." : "请重新连接键盘后重试。当前软件和作品会保留。"
        alert.addButton(withTitle:english ? "Try Again" : "重试");alert.addButton(withTitle:english ? "Later" : "稍后")
    }
    return alert
}

// Release notes are embedded in the signed feed. Only select a language from
// the notes attached to this exact version; never substitute generic app copy.
func localizedAppReleaseNotes(_ text: String, version: String, english: Bool) -> String? {
    let normalized=text.replacingOccurrences(of:"\r\n",with:"\n")
    let prefix="NUPHY-RELEASE-NOTES 1\nversion:\(version)\n[zh-CN]\n"
    guard normalized.hasPrefix(prefix) else{return nil}
    let sections=String(normalized.dropFirst(prefix.count)).components(separatedBy:"\n[en]\n")
    guard sections.count == 2,sections.allSatisfy({!$0.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty}) else{return nil}
    let selected=sections[english ? 1 : 0].trimmingCharacters(in:.whitespacesAndNewlines)
    if english && selected.unicodeScalars.contains(where:{(0x3400...0x9fff).contains($0.value)}) {return nil}
    return selected
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

struct NativeFunctionKeyObservations {
    static let limit = 128
    private(set) var rows = [[String:Any]]()
    // Only these function-key candidates are observed, never characters or
    // general typing. Reaching the runtime limit stops both memory and log writes.
    mutating func record(source:NativeKeyEventSource,keyCode:UInt32,phase:String,
                         uptimeSeconds:Double?,timestampNS:UInt64?,flags:CGEventFlags,
                         repeated:Bool,consumed:Bool)->[String:Any]? {
        guard source == .eventTap || source == .local,[120,107,113].contains(keyCode),
              ["down","up"].contains(phase),rows.count < Self.limit else{return nil}
        let modifiers:[String] = [(CGEventFlags.maskCommand,"command"),(.maskControl,"control"),
            (.maskAlternate,"option"),(.maskShift,"shift"),(.maskSecondaryFn,"function"),(.maskAlphaShift,"capsLock")]
            .compactMap { flags.contains($0.0) ? $0.1 : nil }
        let seconds:Any = uptimeSeconds.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }.map { $0 as Any } ?? NSNull()
        let nanoseconds:Any = timestampNS.flatMap { $0 > 0 ? String($0) : nil }.map { $0 as Any } ?? NSNull()
        let row:[String:Any] = ["seq":rows.count+1,"source":source.rawValue,"vk":keyCode,"phase":phase,
            "uptimeSeconds":seconds,"uptimeNS":nanoseconds,"modifiers":modifiers,"repeat":repeated,"consumed":consumed]
        rows.append(row)
        return row
    }
    static func logLine(_ row:[String:Any])->Data? {
        guard let bytes=try? JSONSerialization.data(withJSONObject:row,options:.sortedKeys) else{return nil}
        var line=Data("[FunctionKeyObservation] ".utf8)
        line.append(bytes);line.append(Data("\n".utf8))
        return line
    }
}

enum NativeWindowStartupGeometry {
    static func savedFrame(_ value:String?) -> NSRect? {
        guard let value else{return nil}
        // AppKit appends system tiling state to the eight frame/screen numbers.
        // Restore only ordinary geometry, never replay that asynchronous state.
        let numbers=value.split(whereSeparator:{$0.isWhitespace}).prefix(8).compactMap{Double($0)}
        guard numbers.count==8,numbers.allSatisfy({$0.isFinite}),numbers[2]>0,numbers[3]>0 else{return nil}
        let rect=NSRect(x:numbers[0],y:numbers[1],width:numbers[2],height:numbers[3])
        return valid(rect) ? rect : nil
    }
    static func targetScreen(saved:NSRect?,screens:[NSRect],fallback:NSRect)->NSRect {
        guard let saved,valid(saved) else{return visibleFrame(fallback)}
        let matches=screens.filter(valid).map { screen -> (NSRect,CGFloat) in
            let overlap=saved.intersection(screen)
            return (screen,overlap.isEmpty ? 0 : overlap.width*overlap.height)
        }
        if let best=matches.max(by:{$0.1<$1.1}),best.1>0{return best.0}
        return visibleFrame(fallback)
    }
    static func visibleFrame(_ proposed:NSRect) -> NSRect {
        valid(proposed) ? proposed : NSRect(x:0,y:0,width:1440,height:900)
    }
    static func defaultContentSize(visible:NSSize) -> NSSize {
        let bounds=visibleFrame(NSRect(origin:.zero,size:visible)).size
        return NSSize(width:min(max(1,bounds.width-32),max(720,min(1080,bounds.width*0.85))),
            height:min(max(1,bounds.height-32),max(520,min(720,bounds.height*0.82-28))))
    }
    static func frame(restored:NSRect?,visible:NSRect,defaultSize:NSSize) -> NSRect {
        let screen=visibleFrame(visible)
        let preferred=valid(NSRect(origin:.zero,size:defaultSize)) ? defaultSize : defaultContentSize(visible:screen.size)
        let size=NSSize(width:min(preferred.width,screen.width),height:min(preferred.height,screen.height))
        let centered=NSRect(x:screen.midX-size.width/2,y:screen.midY-size.height/2,width:size.width,height:size.height)
        guard let saved=restored,valid(saved),saved.width>=min(720,size.width),saved.height>=min(520,size.height),
              saved.width<=size.width+1,saved.height<=size.height+1,
              !saved.intersection(screen).isEmpty else{return centered}
        // Ordinary user sizing is retained, but a maximized/tiled/old-display
        // frame must not make the next launch occupy the entire screen.
        return NSRect(x:min(max(saved.minX,screen.minX),screen.maxX-saved.width),
            y:min(max(saved.minY,screen.minY),screen.maxY-saved.height),width:saved.width,height:saved.height)
    }
    private static func valid(_ rect:NSRect)->Bool {
        [rect.origin.x,rect.origin.y,rect.size.width,rect.size.height].allSatisfy{$0.isFinite} && rect.size.width>0 && rect.size.height>0
    }
}

enum NativeWindowDragRegion {
    // Window coordinates, in points. Full-size content can report no titlebar
    // layout gap; the actual frame converted from screen is the drag boundary.
    static func allowsDrag(point:NSPoint,eventType:NSEvent.EventType,isSameWindow:Bool,
                           isMovable:Bool,isFullScreen:Bool,hasTitlebar:Bool,hasAttachedSheet:Bool,
                           contentRect:NSRect,contentLayoutRect:NSRect,excludedRects:[NSRect],frameRect:NSRect?=nil) -> Bool {
        let bounds=frameRect ?? contentRect
        guard eventType == .leftMouseDown,isSameWindow,isMovable,!isFullScreen,hasTitlebar,!hasAttachedSheet,
              point.x.isFinite,point.y.isFinite,valid(bounds),
              excludedRects.allSatisfy({valid($0)}) else{return false}
        // contentLayoutRect is diagnostic metadata, not a required gap. It can
        // equal contentRect or use a different height in a full-size WK window.
        let topBand=NSRect(x:bounds.minX,y:max(bounds.minY,bounds.maxY-22),
                          width:bounds.width,height:min(22,bounds.height))
        // Preserve the outer resize border/corners rather than starting a move.
        guard bounds.width > 10,bounds.height > 10 else{return false}
        let resizeInterior=bounds.insetBy(dx:5,dy:5)
        let dragRect=NSIntersectionRect(topBand,resizeInterior)
        guard !dragRect.isEmpty,NSPointInRect(point,dragRect),
              !excludedRects.contains(where:{NSPointInRect(point,$0.insetBy(dx:-4,dy:-4))}) else{return false}
        return true
    }
    static func observesTopPoint(_ point:NSPoint,frameRect:NSRect)->Bool {
        guard point.x.isFinite,point.y.isFinite,valid(frameRect) else{return false}
        return NSRect(x:frameRect.minX,y:max(frameRect.minY,frameRect.maxY-44),
            width:frameRect.width,height:min(44,frameRect.height)).contains(point)
    }
    private static func valid(_ rect:NSRect) -> Bool {
        [rect.origin.x,rect.origin.y,rect.width,rect.height].allSatisfy{$0.isFinite} && rect.width > 0 && rect.height > 0
    }
}

final class NativeTitlebarWindow: NSWindow {
    var dragGeometryObserver: (([String:Any])->Void)?
    private var dragGeometryCount=0
    override func sendEvent(_ event:NSEvent) {
        if event.type == .leftMouseDown,event.window === self {
            let frameRect=convertFromScreen(frame)
            let contentRect=contentView.map{$0.convert($0.bounds,to:nil)} ?? frameRect
            let excluded:[NSRect]=[NSWindow.ButtonType.closeButton,.miniaturizeButton,.zoomButton].compactMap { type in
                guard let button=standardWindowButton(type) else{return nil}
                return button.convert(button.bounds,to:nil)
            }
            let allowed=NativeWindowDragRegion.allowsDrag(point:event.locationInWindow,eventType:event.type,
                isSameWindow:event.window === self,isMovable:isMovable,isFullScreen:styleMask.contains(.fullScreen),
                hasTitlebar:styleMask.contains(.titled) && styleMask.contains(.fullSizeContentView),hasAttachedSheet:attachedSheet != nil,
                contentRect:contentRect,contentLayoutRect:contentLayoutRect,excludedRects:excluded,frameRect:frameRect)
            if dragGeometryCount < 8,let observer=dragGeometryObserver,
               NativeWindowDragRegion.observesTopPoint(event.locationInWindow,frameRect:frameRect) {
                dragGeometryCount+=1
                func values(_ rect:NSRect)->[Double] {[rect.minX,rect.minY,rect.width,rect.height].map(Double.init)}
                observer(["seq":dragGeometryCount,"point":[Double(event.locationInWindow.x),Double(event.locationInWindow.y)],
                    "frameRect":values(frameRect),"contentRect":values(contentRect),"contentLayoutRect":values(contentLayoutRect),
                    "excludedRects":excluded.map(values),"allowed":allowed,"isMovable":isMovable,
                    "isFullScreen":styleMask.contains(.fullScreen),"hasAttachedSheet":attachedSheet != nil])
            }
            if allowed {
                // Use the original mouseDown, once. WindowServer owns both axes,
                // resize/Space behavior and drag lifetime; no JS/currentEvent bridge.
                performDrag(with:event)
                return
            }
        }
        super.sendEvent(event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandlerWithReply {
    let audioCapture = AudioCapture()
    lazy var ambientLight: AmbientLightMonitor = {
        let monitor=AmbientLightMonitor()
        monitor.onSample = { [weak self] sample in self?.sendAmbientLight(sample) }
        return monitor
    }()
    private var ambientTask: URLSessionDataTask?
    private var pendingAmbient: [String:Any]?
    private var ambientGeneration=0
    private func sendAmbientLight(_ sample:[String:Any]) {
        guard !terminating,ambientLight.enabled,let base=baseURL else { return }
        if ambientTask != nil { pendingAmbient=sample; return }
        let generation=ambientGeneration
        var request=URLRequest(url:base.appendingPathComponent("api/command"),timeoutInterval:3)
        request.httpMethod="POST"; request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token")
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try? JSONSerialization.data(withJSONObject:["op":"ambientLightSample","sample":sample])
        ambientTask=URLSession.shared.dataTask(with:request) { [weak self] _,_,_ in DispatchQueue.main.async {
            guard let self,self.ambientGeneration==generation else { return }
            self.ambientTask=nil
            if let next=self.pendingAmbient { self.pendingAmbient=nil; self.sendAmbientLight(next) }
        }}
        ambientTask?.resume()
    }
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
    private var keySessionSuspended=false
    private var nativeKeySigner = NativeKeySigner()
    private var trustedNativeKeyGestures = Set<String>()
    private var gestureBindingEpochs = [String:Int]()
    private var keyBindingEpoch:Int?
    private var dictationKeyCodes = Set<UInt32>()
    private var typingDictationGestures = Set<String>()
    var physicalCommandCodes:Set<String> = ["F7","F8","F9","F11","F12"]
    var capturePermissionSignature:String?
    var permissionRecovery=PermissionCaptureRecovery()
    var permissionRelaunchPending=false
    var permissionShutdownCommitted=false
    private var permissionHelperReady:Bool?
    private var permissionRevision=0
    private var permissionProbeProcess:Process?
    private var permissionProbeResult:[String:Any]?
    private var permissionProbeAt:TimeInterval = -.infinity
    private var nextPermissionProbe:TimeInterval = 0
    private var lastPermissionProbeSignature:String?
    private var nativePhysicalHold:NativePhysicalHoldStore?
    private var physicalHoldGesture:NativeKeyGesture?
    private var physicalHoldEpoch:Int?
    private var physicalHoldHeartbeat:Timer?
    var keyConfiguration: [(code:String,keyCode:UInt32)] = []
    var configuredKeysEnabled = false
    var capturingKey = false
    var captureSession: String?
    var capturedFunctionKeys = Set<String>()
    var editingField = false
    var heldHotkeys = Set<UInt32>()
    var keyGestureGate = NativeKeyGestureGate()
    private var functionKeyObservations = NativeFunctionKeyObservations()
    var eventTapOwnershipOverride: (() -> Bool)? // Pure host tests only; never configured by IPC.
    var lastTapCaptureState: Bool?
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
    var updater: SPUUpdater?
    var updateUserDriver: LabUpdateUserDriver?
    #endif
    var pendingUpdateInstall: (() -> Void)?
    var pendingUpdateVersion: String?
    var preparingUpdate = false
    var updateInstallCommitted = false
    var updateAbortRecoveryRequested = false
    var updatePreparationEpoch = 0
    var applicationQuitPending = false
    var updateMusicSaveEpoch:Int?
    var updateRetiringWorker:Process?
    var workerRestartPolicy = WorkerRestartPolicy()
    var selectionShortcutRecording=false
    var pocketShortcutRecording=false
    var dragPresentationAllowed:Bool {
        !terminating && !preparingUpdate && !updateInstallCommitted && !updateAbortRecoveryRequested && !permissionRelaunchPending && !musicFlushInProgress && !keySessionSuspended && !capturingKey && !selectionShortcutRecording && !pocketShortcutRecording && !selectionLab.isBusy && !pocket.isInteracting && !pocket.isBusy && !IsSecureEventInputEnabled()
    }
    var pocketPresentationAllowed:Bool { pocketOperationAllowed() }
    func pocketOperationAllowed(acceptingDrop:Bool=false,recordingShortcut:Bool=false)->Bool {
        !terminating && !applicationQuitPending && !preparingUpdate && !updateInstallCommitted && !updateAbortRecoveryRequested && !permissionRelaunchPending && !musicFlushInProgress && !musicExportActive && !keySessionSuspended && !capturingKey && !selectionShortcutRecording && !pocketShortcutRecording && (recordingShortcut || !(editingField && NSApp.isActive)) && !musicActive && musicCaptureReasons.subtracting(["keyboardPocket"]).isEmpty && !selectionLab.isBusy && !dragConvert.busy && (acceptingDrop || !dragConvert.isFileDragActive) && !IsSecureEventInputEnabled() && worker?.isRunning == true
    }
    lazy var pocket = PocketController(directory:dataDirectory.appendingPathComponent("keyboard-pocket"))
    lazy var dragConvert = DragConvertController(directory: dataDirectory)
    lazy var typingSounds = TypingSoundController(directory: dataDirectory)
    lazy var selectionLab: any SelectionFeature = SelectionFeatureFactory.make(directory: dataDirectory)
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
        let updateDriver=LabUpdateUserDriver(hostBundle:Bundle.main,isEnglish:{ [weak self] in self?.english == true })
        updateUserDriver=updateDriver
        let appUpdater=SPUUpdater(hostBundle:Bundle.main,applicationBundle:Bundle.main,userDriver:updateDriver,delegate:self)
        updater=appUpdater
        do {try appUpdater.start()} catch {updateDriver.showUpdaterError(error,acknowledgement:{ [weak updateDriver] in updateDriver?.dismissUpdateInstallation() })}
        #endif
        window=NativeTitlebarWindow(contentRect:NSRect(origin:.zero,size:defaultWindowSize()),styleMask:[.titled,.closable,.miniaturizable,.resizable,.fullSizeContentView],backing:.buffered,defer:false)
        (window as? NativeTitlebarWindow)?.dragGeometryObserver={ [weak self] geometry in
            guard let self=self,self.worker?.isRunning == true,
                  let bytes=try? JSONSerialization.data(withJSONObject:geometry,options:.sortedKeys) else{return}
            var line=Data("[WindowDragGeometry] ".utf8);line.append(bytes);line.append(Data("\n".utf8))
            self.appendWorkerLog(line)
        }
        window.isMovable=true
        window.titlebarAppearsTransparent=true;window.titleVisibility = .hidden
        window.title="NuPhy Lab";window.contentMinSize=NSSize(width:720,height:520);window.delegate=self;window.isReleasedWhenClosed=false
        window.isRestorable=false
        let restored=NativeWindowStartupGeometry.savedFrame(UserDefaults.standard.string(forKey:"NSWindow Frame \(windowFrameName)"))
        let visible=NativeWindowStartupGeometry.targetScreen(saved:restored,screens:NSScreen.screens.map{$0.visibleFrame},
            fallback:NSScreen.main?.visibleFrame ?? .zero)
        let contentSize=NativeWindowStartupGeometry.defaultContentSize(visible:visible.size)
        window.contentMinSize=NSSize(width:min(720,contentSize.width),height:min(520,contentSize.height))
        let defaultFrame=window.frameRect(forContentRect:NSRect(origin:.zero,size:contentSize))
        window.setFrame(NativeWindowStartupGeometry.frame(restored:restored,
            visible:visible,defaultSize:defaultFrame.size),display:false)
        // Replace the old tiling payload before registering autosave; letting
        // AppKit restore it can resize the window again after this method ends.
        window.saveFrame(usingName:windowFrameName)
        window.setFrameAutosaveName(windowFrameName)
        let config=WKWebViewConfiguration();config.preferences.javaScriptCanOpenWindowsAutomatically=false
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"codexKeys")
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"audioControl")
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"selectionLab")
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"typingSounds")
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"musicFile")
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"musicControl")
        config.userContentController.addScriptMessageHandler(self, contentWorld:.page, name:"dragConvert")
        config.userContentController.addScriptMessageHandler(self, contentWorld:.page, name:"keyboardPocket")
        dragConvert.updateLanguage(english:english)
        dragConvert.canPresent = { [weak self] in self?.dragPresentationAllowed ?? false }
        dragConvert.reservedKeyCodes = { [weak self] in
            guard let self, self.configuredKeysEnabled else { return [] }
            return Set(self.keyConfiguration.map { $0.keyCode })
        }
        dragConvert.selectionReservedTrigger = { [weak self] in self?.selectionLab.dragReservedTrigger }
        dragConvert.activityChanged = { [weak self] active in self?.typingSounds.setPaused("fileDrag",active:active) }
        selectionLab.fileDragActive = { [weak self] in
            guard let self else{return true}
            return self.dragConvert.isFileDragActive || self.pocket.isInteracting || self.pocket.isBusy || self.permissionRelaunchPending || self.terminating
        }
        _ = typingSounds
        // Explicit recording may start from a focused search field. The recorder
        // consumes only foreground keys and still obeys secure-input/lifecycle gates.
        pocket.canRecordShortcut = { [weak self] in self?.pocketOperationAllowed(recordingShortcut:true) ?? false }
        pocket.recordingChanged = { [weak self] active in
            guard let self else{return};self.pocketShortcutRecording=active
            self.selectionLab.setExternalShortcutRecording(active)
            self.refreshHotkeys()
        }
        pocket.canActivate = { [weak self] in self?.pocketPresentationAllowed ?? false }
        pocket.canAcceptDrop = { [weak self] in self?.pocketOperationAllowed(acceptingDrop:true) ?? false }
        pocket.conflictIssue = { [weak self] settings in
            guard let self else { return "Unavailable" }
            return PocketConflictPolicy.conflict(settings:settings,selection:self.selectionLab.selectionReservedBinding,
                reservedKeys:self.configuredKeysEnabled ? Set(self.keyConfiguration.map { $0.keyCode }) : [])?.message(english:self.english)
        }
        pocket.activityChanged = { [weak self] active in
            self?.typingSounds.setPaused("keyboardPocket",active:active)
            self?.setMusicCapture("keyboardPocket",active:active)
        }
        pocket.updateLanguage(english:english)
        selectionLab.voiceActivityChanged = { [weak self] active in self?.typingSounds.setPaused("selectionVoice", active:active);self?.setMusicCapture("selectionVoice",active:active) }
        selectionLab.updateLanguage(english ? .en:.zh)
        selectionLab.showSettings = { [weak self] in self?.show(); self?.web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('nuphylab:navigate',{detail:'ai'}))", completionHandler:nil) }
        selectionLab.recordingChanged = { [weak self] active in self?.selectionShortcutRecording=active;self?.typingSounds.setPaused("shortcut",active:active);self?.refreshHotkeys() }
        selectionLab.requestRelaunch = { [weak self] in
            guard let self, !self.terminating, !self.preparingUpdate, !self.updateInstallCommitted, !self.driverOpenInFlight,
                  !self.applicationQuitPending, !self.permissionRelaunchPending, self.worker?.isRunning == true,
                  !self.capturingKey, !self.musicSaveFailed, !self.musicActive, !self.musicExportActive, !self.musicFlushInProgress, self.keyGestureGate.activeCount == 0, !self.selectionLab.isBusy, !self.dragConvert.busy, !self.dragConvert.isFileDragActive, !self.pocket.isBusy, !self.pocket.isInteracting else { return false }
            self.permissionShutdownCommitted=false
            self.permissionRelaunchPending = true
            self.appendWorkerLog(Data("Completing selection permission setup by a clean app relaunch.\n".utf8))
            NSApp.terminate(nil); return true
        }
        web=PocketHostWebView(frame:.zero,configuration:config);web.navigationDelegate=self;web.uiDelegate=self
        pocket.attach(web:web,window:window);pocket.resume()
        window.contentView=web;show();startWorker()
        // Targeted events delivered to this window do not always become Carbon
        // global-hotkey events. Share the same held-key gate and action path.
        localKeyMonitor=NSEvent.addLocalMonitorForEvents(matching:[.keyDown,.keyUp,.flagsChanged]){[weak self] event in
            guard let self=self else{return event}
            if self.pocketShortcutRecording {return event}
            if self.selectionLab.consumeLocal(event){return nil}
            guard event.type == .keyDown || event.type == .keyUp else{return event}
            return self.handleLocalKey(event)
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
        "无法确认键盘已释放，请返回设备页，重新连接键盘后重试。": "Could not confirm that the keyboard was released. Return to Device, reconnect the keyboard and try again.",
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
        let musicRecoveryItem=windowMenu.addItem(withTitle:english ? "Recover Performance Page…" : "恢复演奏页面…",action:#selector(recoverMusicPage),keyEquivalent:"");musicRecoveryItem.target=self
        NSApp.mainMenu=menu;NSApp.windowsMenu=windowMenu
        let tray=NSMenu();tray.addItem(withTitle:self.T("打开 NuPhy Lab"),action:#selector(show),keyEquivalent:"")
        tray.addItem(withTitle:self.T("暂停 / 继续"),action:#selector(togglePause),keyEquivalent:"")
        tray.addItem(withTitle:self.T("停止并恢复键盘灯效"),action:#selector(restore),keyEquivalent:"")
        tray.addItem(NSMenuItem.separator());tray.addItem(withTitle:self.T("退出 NuPhy Lab"),action:#selector(quit),keyEquivalent:"")
        for item in tray.items {item.target=self};statusItem.menu=tray
    }
    func startWorker(){
        guard !updateInstallCommitted,worker == nil else{return}
        guard let resources=Bundle.main.resourceURL else{return}
        closePhysicalHoldStore()
        nativeKeySigner=NativeKeySigner();trustedNativeKeyGestures.removeAll();gestureBindingEpochs.removeAll();keyBindingEpoch=nil
        if let secret=Data(base64Encoded:nativeKeySigner.physicalHoldSecret){nativePhysicalHold=NativePhysicalHoldStore(secret:secret)}
        let child=Process();child.executableURL=resources.appendingPathComponent("runtime/node");child.arguments=[resources.appendingPathComponent("server/main.mjs").path];child.currentDirectoryURL=resources
        var env=ProcessInfo.processInfo.environment;env["AIR_STUDIO_HID"]=resources.appendingPathComponent("bin/HIDBridge").path;env["AIR_STUDIO_UI"]=resources.appendingPathComponent("ui/dist").path;env["AIR_STUDIO_DATA"]=dataDirectory.path;env.removeValue(forKey:"AIR_STUDIO_PORT")
        // Reuse the web origin so an app update preserves the existing unsaved canvas.
        if let data=try? Data(contentsOf:dataDirectory.appendingPathComponent("runtime.json")),
           let runtime=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
           let previous=runtime["port"] as? Int, previous>0 && previous<=65535 { env["AIR_STUDIO_PREFERRED_PORT"]=String(previous) }
        env["AIR_STUDIO_PARENT_PID"]=String(getpid())
        env["AIR_STUDIO_NATIVE_KEY_SECRET"]=nativeKeySigner.environmentSecret
        env.removeValue(forKey:"AIR_STUDIO_NATIVE_HOLD_SECRET");env.removeValue(forKey:"AIR_STUDIO_NATIVE_HOLD_PATH")
        if let hold=nativePhysicalHold {
            env["AIR_STUDIO_NATIVE_HOLD_SECRET"]=nativeKeySigner.physicalHoldSecret
            env["AIR_STUDIO_NATIVE_HOLD_PATH"]=hold.fileURL.path
        }
        child.environment=env
        let output=Pipe();child.standardOutput=output
        let errors=Pipe();child.standardError=errors
        errors.fileHandleForReading.readabilityHandler={ [weak self] handle in
            let data=handle.availableData
            if data.isEmpty {handle.readabilityHandler=nil;return}
            self?.appendWorkerLog(data)
        }
        var pending=Data()
        output.fileHandleForReading.readabilityHandler={ [weak self,weak child] handle in
            let data=handle.availableData;if data.isEmpty{return};pending.append(data)
            while let newline=pending.firstIndex(of:10){let line=pending.prefix(upTo:newline);pending.removeSubrange(...newline)
                if let message=(try? JSONSerialization.jsonObject(with:line)) as? [String:Any],message["event"] as? String=="ready",let url=message["url"] as? String,let child {DispatchQueue.main.async {self?.ready(url,from:child)}}
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
                DispatchQueue.main.async {self?.workerDidExit(stopped,status:status,signaled:signaled)}
            }
        }
        do{try child.run();worker=child}catch{
            appendWorkerLog(Data("Worker launch failed: \(error.localizedDescription)\n".utf8))
            if updateAbortRecoveryRequested {presentUpdateRecoveryFailure();return}
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
    func workerDidExit(_ stopped:Process,status:Int32,signaled:Bool){
        // A retired worker cannot complete the current worker's shutdown ticket.
        guard worker === stopped else{return}
        workerDidExit(status:status,signaled:signaled)
    }
    func workerDidExit(status:Int32,signaled:Bool){
        if preparingUpdate {
            updatePreparationEpoch+=1;preparingUpdate=false
            setExitPresentation(false)
        }
        if updateRetiringWorker === worker {updateRetiringWorker=nil}
        if permissionRelaunchPending && (!permissionShutdownCommitted || !terminating || musicFlushInProgress) {
            // Authorization requests are not yet permission to exit. An early
            // worker exit must retire the pending WebKit save callback first.
            permissionRelaunchPending=false
            permissionRecovery.attempted=false
            permissionRecovery.grantAt=ProcessInfo.processInfo.systemUptime
            if musicFlushInProgress {
                musicFlushEpoch+=1;musicFlushInProgress=false;musicSaveFailed=true
                self.replyToTermination(false)
            }
            unlockMusicTransition()
            appendWorkerLog(Data("Permission relaunch deferred: worker exited before the saved shutdown was committed.\n".utf8))
        }
        let permissionRecoveryFailed=permissionRelaunchPending && (status != 0 || signaled)
        permissionShutdownCommitted=false
        stopHotkeyMonitoring()
        permissionHelperReady=nil
        worker=nil
        baseURL=nil;apiToken=""
        if updateInstallCommitted && !terminating {
            appendWorkerLog(Data("Local service exited after update handoff; leaving restart to the installer.\n".utf8))
            return
        }
        if permissionRelaunchPending {
            permissionRelaunchPending=false
            if status==0 && !signaled {
                do {
                    try PermissionAppRelaunch.launch()
                    selectionLab.shutdown()
                    self.replyToTermination(true);return
                }
                catch {appendWorkerLog(Data("Permission relaunch could not start.\n".utf8))}
            }
            // A recovery may not bypass failed keyboard restoration. Keep the
            // host open; the ordinary failure alert below retains diagnostics.
            terminating=false;typingSounds.setPaused("quitting",active:false);self.replyToTermination(false);setExitPresentation(false)
            dragConvert.resume();pocket.resume()
            selectionLab.refreshAuthorization()
            if status==0 && !signaled {startWorker();return}
            permissionRecovery.attempted=true
        }
        if !terminating,!permissionRecoveryFailed, let delay=workerRestartPolicy.nextDelay(now:ProcessInfo.processInfo.systemUptime) {
            audioCapture.stop();pendingAudio=nil
            appendWorkerLog(Data("Restarting local service after unexpected exit in \(delay)s.\n".utf8))
            DispatchQueue.main.asyncAfter(deadline:.now()+delay){[weak self] in
                guard let self=self,!self.terminating,!self.updateInstallCommitted,self.worker==nil else{return}
                self.startWorker()
            }
            return
        }
        if updateAbortRecoveryRequested && !terminating {presentUpdateRecoveryFailure();return}
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
        if terminating {self.replyToTermination(true)}
    }
    func ready(_ address:String,from source:Process){
        guard worker === source else{return}
        ready(address)
    }
    func ready(_ address:String){
        guard !terminating,!updateInstallCommitted,worker?.isRunning==true,let url=URL(string:address) else{return};baseURL=url
        if let bytes=try? Data(contentsOf:dataDirectory.appendingPathComponent("runtime.json")),let data=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any]{apiToken=data["token"] as? String ?? ""}
        if musicEverUsed,web.url != nil {
            // A worker restart must not replace the document holding unsaved
            // recordings. The preferred port normally keeps the same origin.
            if web.url?.host==url.host,web.url?.port==url.port,!musicDocumentLost {
                let encoded=String(data:(try? JSONSerialization.data(withJSONObject:["token":apiToken])) ?? Data("{}".utf8),encoding:.utf8) ?? "{}"
                web.evaluateJavaScript("window.__AIR_TOKEN__ = (\(encoded)).token;window.dispatchEvent(new Event('nuphylab:service-reconnected'));",completionHandler:nil)
            } else {musicSaveFailed=true;presentMusicSaveFailure()}
        } else {musicDocumentOrigin=url;web.load(URLRequest(url:url))}
        if updateAbortRecoveryRequested {updateRetiringWorker=nil;updateAbortRecoveryRequested=false;setExitPresentation(false)}
        startHotkeyMonitoring()
    }
    @objc func show(){window?.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)}
    func defaultWindowSize() -> NSSize {
        let visible=(window?.screen ?? NSScreen.main)?.visibleFrame.size ?? NSSize(width:1440,height:900)
        return NativeWindowStartupGeometry.defaultContentSize(visible:visible)
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
        if updateAbortRecoveryRequested {retryAbortedUpdateService();return}
        if pendingUpdateInstall != nil { prepareUpdateInstallation(); return }
        #if canImport(Sparkle)
        updater?.checkForUpdates()
        #endif
    }
    func prepareUpdateInstallation(){
        guard !preparingUpdate,!updateInstallCommitted,!updateAbortRecoveryRequested,!permissionRelaunchPending,!musicFlushInProgress,!musicExportActive,!terminating,pendingUpdateInstall != nil else{return}
        guard !dragConvert.busy else{presentDragBusyNotice();return}
        dragConvert.suspend();pocket.suspend()
        updateMusicSaveEpoch=musicEverUsed ? musicFlushEpoch+1 : nil
        flushMusicForTransition { [weak self] saved in
            guard let self else{return}
            self.updateMusicSaveEpoch=nil
            if saved {self.prepareUpdateAfterMusicSave()}
            else {self.presentMusicSaveFailure()}
        }
    }
    func recoverAfterAbortedUpdate(){
        guard !terminating,!updateAbortRecoveryRequested,
              updateInstallCommitted || preparingUpdate || pendingUpdateInstall != nil else{return}
        let releasedService=updateInstallCommitted || preparingUpdate
        updatePreparationEpoch+=1
        pendingUpdateInstall=nil;pendingUpdateVersion=nil;preparingUpdate=false
        let cancellingUpdateQuit=updateInstallCommitted && applicationQuitPending
        if musicFlushInProgress && (updateMusicSaveEpoch==musicFlushEpoch || cancellingUpdateQuit) {
            musicFlushEpoch+=1;musicFlushInProgress=false
        }
        updateMusicSaveEpoch=nil
        if cancellingUpdateQuit {replyToTermination(false)}
        updateInstallCommitted=false
        guard releasedService else{
            if !applicationQuitPending {setExitPresentation(false)}
            return
        }
        // The update has explicitly aborted. Keep the WebKit document and its
        // drafts alive; restart only the released local service, then unlock
        // when the replacement reports ready. No AppKit exit or relaunch ticket.
        updateAbortRecoveryRequested=true;updateRetiringWorker=worker
        dragConvert.suspend();pocket.suspend();stopHotkeyMonitoring()
        appendWorkerLog(Data("Update aborted; recovering the local service while retaining the current document.\n".utf8))
        retryAbortedUpdateService()
    }
    func retryAbortedUpdateService(){
        guard updateAbortRecoveryRequested,!terminating,!updateInstallCommitted else{return}
        if let retiring=updateRetiringWorker {
            guard worker === retiring,retiring.isRunning else{return} // Wait for its queued exit callback.
            let pid=retiring.processIdentifier
            let sent=pid>0 ? Darwin.kill(pid,SIGTERM) : -1
            let code=pid>0 ? errno : EINVAL
            if sent != 0 && code != ESRCH {presentUpdateRecoveryFailure()}
        } else if worker == nil {
            workerRestartPolicy=WorkerRestartPolicy()
            startWorker()
        }
    }
    func presentUpdateRecoveryFailure(){
        let alert=NSAlert();alert.alertStyle = .warning
        alert.messageText=english ? "Resume NuPhy Lab" : "恢复 NuPhy Lab"
        alert.informativeText=english ? "The update was cancelled. Your current page and unsaved work are still open. Retry to reconnect the local service." : "更新已取消，当前页面和未保存的作品仍保留。请重试连接本地服务。"
        alert.addButton(withTitle:english ? "Retry" : "重试")
        alert.addButton(withTitle:english ? "Stay open" : "保持打开")
        if alert.runModal() == .alertFirstButtonReturn {retryAbortedUpdateService()}
    }
    func prepareUpdateAfterMusicSave(){
        guard !preparingUpdate, !updateInstallCommitted, !updateAbortRecoveryRequested, pendingUpdateInstall != nil, let base=baseURL,let version=pendingUpdateVersion else {unlockMusicTransition();return}
        guard !dragConvert.busy else{unlockMusicTransition();presentDragBusyNotice();return}
        guard let requestWorker=worker,requestWorker.isRunning else{unlockMusicTransition();return}
        do {try PendingAppUpdate.stage(version:version)} catch {
            appendWorkerLog(Data("Unable to prepare update relaunch: \(error.localizedDescription)\n".utf8))
            unlockMusicTransition();makeAppUpdateAlert(.preparationFailed,english:english).runModal();return
        }
        preparingUpdate=true;updatePreparationEpoch+=1;let epoch=updatePreparationEpoch
        setExitPresentation(true)
        var request=URLRequest(url:base.appendingPathComponent("api/command"),timeoutInterval:60)
        request.httpMethod="POST";request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token")
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try? JSONSerialization.data(withJSONObject:["op":"prepareAppUpdate"])
        URLSession.shared.dataTask(with:request){[weak self] data,response,error in
            DispatchQueue.main.async {
                guard let self=self,self.worker === requestWorker,self.updatePreparationEpoch==epoch,!self.updateAbortRecoveryRequested else{return};self.preparingUpdate=false
                let result=data.flatMap{try? JSONSerialization.jsonObject(with:$0)} as? [String:Any]
                if error == nil,(response as? HTTPURLResponse)?.statusCode==200,result?["ok"] as? Bool==true {
                    self.updateInstallCommitted=true
                    self.dragConvert.shutdown();self.pocket.suspend();self.stopHotkeyMonitoring();self.audioCapture.stop();self.pendingAudio=nil
                    let install=self.pendingUpdateInstall;self.pendingUpdateInstall=nil;install?()
                } else {
                    self.setExitPresentation(false)
                    self.appendWorkerLog(Data("Update preparation failed: \(error?.localizedDescription ?? String(describing:result?["error"]))\n".utf8))
                    let alert=makeAppUpdateAlert(.keyboardReleaseFailed,english:self.english)
                    if alert.runModal() == .alertFirstButtonReturn {self.prepareUpdateInstallation()}
                }
            }
        }.resume()
    }
    @objc func willSleep(){ dragConvert.suspend();pocket.suspend(); stopMusic(suspend:true); selectionLab.cancel(); keySessionSuspended=true;setHotkeysEnabled(false);audioCapture.stop();pendingAudio=nil }
    @objc func didWake(){ keySessionSuspended=false;if !terminating && !preparingUpdate && !updateInstallCommitted && !updateAbortRecoveryRequested {dragConvert.resume();pocket.resume();post(["op":"resumeConnection"]);refreshHotkeys()} }
    func post(_ data:[String:Any]){guard let base=baseURL else{return};var request=URLRequest(url:base.appendingPathComponent("api/command"));request.httpMethod="POST";request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token");request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.httpBody=try? JSONSerialization.data(withJSONObject:data);URLSession.shared.dataTask(with:request).resume()}
    func activateSlot(_ index:Int,phase:String="down",gesture:NativeKeyGesture?=nil,
                      source:NativeKeyEventSource?=nil,eventTime:Double?=nil){
        guard hotkeysEnabled,!terminating,keyConfiguration.indices.contains(index) else{return}
        enqueueKey(gesture?.packet(phase:phase,source:source,eventTime:eventTime) ??
            ["op":"codexKey","code":keyConfiguration[index].code,"phase":phase])
    }
    func dispatchBoundKey(_ index:Int,down:Bool,repeated:Bool,source:NativeKeyEventSource,
                          eventTime:Double?,timestampNS:UInt64?=nil,owner:NativeKeyEventSource?=nil,
                          hardwareVerified:Bool=false){
        guard hotkeysEnabled,!terminating,keyConfiguration.indices.contains(index) else{return}
        let binding=keyConfiguration[index],id=UInt32(index+1)
        if down {
            if let gesture=keyGestureGate.press(keyCode:binding.keyCode,code:binding.code,source:source,
                eventTime:eventTime,timestampNS:timestampNS,repeated:repeated,owner:owner) {
                // Trust can be established only by the fresh raw down, never
                // by a duplicate, a Carbon notification or an API field.
                if let epoch=keyBindingEpoch {
                    gestureBindingEpochs[gesture.id]=epoch
                    if hardwareVerified && source != .carbon {trustedNativeKeyGestures.insert(gesture.id)}
                    if hardwareVerified && source != .carbon && dictationKeyCodes.contains(binding.keyCode) {
                        beginPhysicalHold(gesture,epoch:epoch)
                    }
                }
                heldHotkeys.insert(id);activateSlot(index,gesture:gesture,source:source,eventTime:eventTime)
            }
        } else if let gesture=keyGestureGate.release(keyCode:binding.keyCode,eventTime:eventTime,timestampNS:timestampNS) {
            if physicalHoldGesture?.id == gesture.id {cancelPhysicalHold()}
            heldHotkeys.remove(id);activateSlot(index,phase:"up",gesture:gesture,source:source,eventTime:eventTime)
        }
    }
    private func physicalHoldNowMs()->Int {Int(ProcessInfo.processInfo.systemUptime*1000)}
    private func beginPhysicalHold(_ gesture:NativeKeyGesture,epoch:Int) {
        cancelPhysicalHold()
        physicalHoldGesture=gesture;physicalHoldEpoch=epoch
        typingDictationGestures.insert(gesture.id)
        typingSounds.setPaused("dictation:"+gesture.id, active:true)
        setMusicCapture("dictation:"+gesture.id,active:true)
        guard refreshPhysicalHold() else{return}
        let timer=Timer(timeInterval:0.5,repeats:true){[weak self] _ in _ = self?.refreshPhysicalHold()}
        physicalHoldHeartbeat=timer;RunLoop.main.add(timer,forMode:.common)
    }
    @discardableResult private func refreshPhysicalHold()->Bool {
        if physicalHoldGesture != nil && !functionKeyTapIsActive() {
            // Do not renew a gesture whose global release can no longer be
            // observed, even if the disabled-tap notification is still queued.
            interruptFunctionKeyTap();return false
        }
        guard let gesture=physicalHoldGesture,let epoch=physicalHoldEpoch,
              !terminating,keyBindingEpoch==epoch,
              gesture.owner == .eventTap,
              trustedNativeKeyGestures.contains(gesture.id),
              keyGestureGate.heldGesture(keyCode:gesture.keyCode)?.id==gesture.id,
              nativePhysicalHold?.write(gestureID:gesture.id,keyCode:Int(gesture.keyCode),bindingEpoch:epoch,held:true,nowMs:physicalHoldNowMs())==true else {
            cancelPhysicalHold();return false
        }
        return true
    }
    private func cancelPhysicalHold() {
        physicalHoldHeartbeat?.invalidate();physicalHoldHeartbeat=nil
        if let id=physicalHoldGesture?.id,typingDictationGestures.contains(id) {
            // A cancelled/failed delivery keeps sound paused, never assumes the
            // remote microphone stopped. The UI offers deliberate recovery.
            DispatchQueue.main.asyncAfter(deadline:.now()+8) { [weak self] in
                guard let self,self.typingDictationGestures.remove(id) != nil else { return }
                self.typingSounds.setPaused("dictationUnconfirmed",active:true)
                self.setMusicCapture("dictationUnconfirmed",active:true)
                self.setMusicCapture("dictation:"+id,active:false)
                self.typingSounds.setPaused("dictation:"+id,active:false)
            }
        }
        physicalHoldGesture=nil;physicalHoldEpoch=nil
        _ = nativePhysicalHold?.invalidate(nowMs:physicalHoldNowMs())
    }
    private func closePhysicalHoldStore() {
        cancelPhysicalHold();nativePhysicalHold?.close();nativePhysicalHold=nil
    }
    func enqueueKey(_ data:[String:Any]) {
        var packet=data
        packet.removeValue(forKey:"nativeKeySequence");packet.removeValue(forKey:"nativeKeySignature");packet.removeValue(forKey:"nativeKeyBindingEpoch")
        if let gestureID=packet["gestureId"] as? String {
            if let epoch=gestureBindingEpochs[gestureID]{packet["nativeKeyBindingEpoch"]=epoch}
            if let signed=nativeKeySigner.sign(packet,trusted:trustedNativeKeyGestures.contains(gestureID)){packet=signed}
            if packet["phase"] as? String == "up"{trustedNativeKeyGestures.remove(gestureID);gestureBindingEpochs.removeValue(forKey:gestureID)}
        }
        keyEventQueue.append(packet);sendNextKey()
    }
    func sendNextKey() {
        guard !keyEventSending,!keyEventQueue.isEmpty,let base=baseURL else{return}
        keyEventSending=true
        var request=URLRequest(url:base.appendingPathComponent("api/command"),timeoutInterval:5)
        request.httpMethod="POST";request.setValue(apiToken,forHTTPHeaderField:"X-Air-Token")
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        let packet=keyEventQueue.removeFirst()
        request.httpBody=try? JSONSerialization.data(withJSONObject:packet)
        URLSession.shared.dataTask(with:request){[weak self] data,response,error in
            let payload=data.flatMap { try? JSONSerialization.jsonObject(with:$0) } as? [String:Any]
            let result=payload?["result"] as? [String:Any]
            let ok=error == nil && (response as? HTTPURLResponse)?.statusCode==200 && payload?["ok"] as? Bool==true
            DispatchQueue.main.async {
                guard let self else { return }
                if let id=packet["gestureId"] as? String,self.typingDictationGestures.contains(id) {
                    let up=packet["phase"] as? String=="up"
                    let stopped=ok && TypingDictationCompletion.confirmed(result)
                    let neverStarted=ok && !up && result?["performed"] as? Bool==false
                    if up || neverStarted {
                        self.typingDictationGestures.remove(id)
                        if up && !stopped { self.typingSounds.setPaused("dictationUnconfirmed",active:true);self.setMusicCapture("dictationUnconfirmed",active:true) }
                        self.setMusicCapture("dictation:"+id,active:false)
                        self.typingSounds.setPaused("dictation:"+id,active:false)
                    }
                }
                self.keyEventSending=false;self.sendNextKey()
            }
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
    var musicExportActive=false
    func saveMusicFile(_ body:[String:Any],reply:@escaping(Any?,String?)->Void){
        guard !musicExportActive,!musicFlushInProgress,!terminating,let rawName=body["name"] as? String,let encoded=body["base64"] as? String,
              encoded.utf8.count<=112*1024*1024,let data=Data(base64Encoded:encoded),data.count<=80*1024*1024 else {reply(nil,(self.english ? "File is too large or another export is in progress. Try again shortly." : "文件过大或正在保存，请稍后重试"));return}
        let name=String(URL(fileURLWithPath:rawName).lastPathComponent.prefix(120))
        let ext=URL(fileURLWithPath:name).pathExtension.lowercased()
        guard ["wav","nuphy-music"].contains(ext) else {reply(nil,(self.english ? "Unsupported export format." : "不支持的导出格式"));return}
        musicExportActive=true
        let panel=NSSavePanel();panel.title=(self.english ? "Export performance" : "导出演奏");panel.nameFieldStringValue=name;panel.canCreateDirectories=true
        if let type=UTType(filenameExtension:ext){panel.allowedContentTypes=[type]}
        panel.beginSheetModal(for:window){[weak self] response in
            guard let self else{reply(nil,"The window has closed.");return}
            guard response == .OK,let destination=panel.url else{self.musicExportActive=false;reply(["saved":false],nil);return}
            DispatchQueue.global(qos:.userInitiated).async {
                do {try data.write(to:destination,options:.atomic);DispatchQueue.main.async{self.musicExportActive=false;reply(["saved":true],nil)}}
                catch {DispatchQueue.main.async{self.musicExportActive=false;reply(nil,(self.english ? "Could not save the file: " : "未能保存文件：")+error.localizedDescription)}}
            }
        }
    }
    var retiredMusicDocuments=Set<String>()
    var musicDocumentID:String?
    var musicDocumentLost=false
    var musicDocumentOrigin:URL?
    var musicSaveFailed=false
    var musicActive=false
    var musicEverUsed=false
    var musicCaptureReasons=Set<String>()
    var musicFlushInProgress=false
    var musicFlushEpoch=0
    func refreshMusicPause(){
        typingSounds.setPaused("music",active:musicActive && (NSApp?.isActive ?? false) && window?.isKeyWindow == true && window?.isVisible == true && window?.isMiniaturized == false)
    }
    func setMusicCapture(_ reason:String,active:Bool){
        if active {musicCaptureReasons.insert(reason);stopMusic(suspend:true)} else {musicCaptureReasons.remove(reason)}
    }
    func musicPlayAllowed(recoverDictation:Bool=false,requireForeground:Bool=false)->Bool{
        if recoverDictation {musicCaptureReasons.remove("dictationUnconfirmed")}
        let foreground = (NSApp?.isActive ?? false) && window?.isKeyWindow == true && window?.isMiniaturized == false
        return musicCaptureReasons.isEmpty && !terminating && !musicFlushInProgress && !preparingUpdate && !updateInstallCommitted && !updateAbortRecoveryRequested && (!requireForeground || foreground)
    }
    func stopMusic(suspend:Bool=false){
        if suspend {musicActive=false;refreshMusicPause()}
        web?.evaluateJavaScript("window.dispatchEvent(new Event('nuphylab:music-\(suspend ? "suspend":"stop")'))",completionHandler:nil)
    }
    func windowDidBecomeKey(_ notification:Notification){refreshMusicPause()}
    func windowDidResignKey(_ notification:Notification){
        typingSounds.setPaused("music",active:false)
        web?.evaluateJavaScript("window.dispatchEvent(new Event('nuphylab:music-release'))",completionHandler:nil)
    }
    func windowWillClose(_ notification:Notification){if (notification.object as? NSWindow) === window {pocket.cancelShortcutRecording()};stopMusic(suspend:true)}
    func windowDidMiniaturize(_ notification:Notification){if (notification.object as? NSWindow) === window {pocket.cancelShortcutRecording()};stopMusic(suspend:true)}
    func webView(_ webView:WKWebView,didStartProvisionalNavigation navigation:WKNavigation!){
        if webView === web {pocket.invalidatePage()}
    }
    func webViewWebContentProcessDidTerminate(_ webView:WKWebView){
        if webView === web {pocket.invalidatePage()}
        musicActive=false;refreshMusicPause()
        guard musicEverUsed else{return}
        musicDocumentLost=true;musicSaveFailed=true
        // The lost process cannot provide a valid save receipt. Reopening is
        // an explicit user choice, and keeps only already-saved works.
        show()
        let alert=NSAlert();alert.alertStyle = .warning
        alert.messageText=english ? "The performance page closed unexpectedly" : "演奏页面意外关闭"
        alert.informativeText=english ? "Saved works are safe. Changes that had not finished saving may be lost. Reopen the saved works?" : "已保存的作品仍在。未完成保存的改动可能已丢失。是否重新打开已保存的作品？"
        alert.addButton(withTitle:english ? "Reopen saved works" : "重新打开已保存作品")
        alert.addButton(withTitle:english ? "Later" : "稍后")
        alert.beginSheetModal(for:window){[weak self] response in
            guard let self,response == .alertFirstButtonReturn,let url=self.baseURL else{return}
            self.reopenSavedMusicDocument(url)
        }
    }
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage,replyHandler:@escaping(Any?,String?)->Void){
        guard message.frameInfo.isMainFrame,let url=message.frameInfo.request.url,
              ((url.host==baseURL?.host && url.port==baseURL?.port) || (["musicFile","musicControl"].contains(message.name) && url.host==musicDocumentOrigin?.host && url.port==musicDocumentOrigin?.port)),
              let body=message.body as? [String:Any] else{replyHandler(nil,"Invalid origin");return}
        if message.name == "musicFile" {saveMusicFile(body,reply:replyHandler);return}
        if message.name == "musicControl" {
            guard registerMusicDocument(body) else{replyHandler(nil,"The performance document is not current");return}
            if body["saveHealthy"] as? Bool == true {musicSaveFailed=false;replyHandler(true,nil);return}
            guard let present=body["present"] as? Bool,let active=body["active"] as? Bool else{replyHandler(nil,"Invalid music state");return}
            let allowed=musicPlayAllowed(recoverDictation:body["resumeAfterDictation"] as? Bool == true,requireForeground:body["request"] as? Bool == true)
            musicActive=present && active && allowed
            refreshMusicPause();replyHandler(["allowed":allowed,"blocked":!musicCaptureReasons.isEmpty,"unconfirmed":musicCaptureReasons.contains("dictationUnconfirmed")],nil);return
        }
        if message.name == "dragConvert" {
            guard !terminating, !preparingUpdate, !updateInstallCommitted, !updateAbortRecoveryRequested, !musicFlushInProgress else{replyHandler(nil,english ? "Finishing the current operation" : "正在完成当前操作");return}
            dragConvert.handle(body, reply:replyHandler);return
        }
        if message.name == "keyboardPocket" {
            guard !terminating, !updateInstallCommitted else{replyHandler(nil,english ? "Finishing the current operation" : "正在完成当前操作");return}
            let op=body["op"] as? String ?? ""
            let disabling=op == "settings" && (body["values"] as? [String:Any])?["enabled"] as? Bool == false
            let passive=["status","refresh","page","layout","language","cancelShortcutRecording"].contains(op)
            guard disabling || passive || (!applicationQuitPending && !preparingUpdate && !updateAbortRecoveryRequested && !permissionRelaunchPending && !musicFlushInProgress) else{replyHandler(nil,english ? "Finishing the current operation" : "正在完成当前操作");return}
            pocket.handle(body,reply:replyHandler);return
        }
        if message.name == "typingSounds" { typingSounds.handle(body, reply: replyHandler); return }
        if message.name == "selectionLab" {
            selectionLab.handle(body, reply:{ [weak self] value,error in
                self?.pocket.refreshAuthorization();replyHandler(value,error)
            });return
        }
        if message.name == "audioControl" {
            guard let permission=body["permission"] as? String,["microphone","system"].contains(permission) else{replyHandler(nil,"Invalid permission");return}
            let pane=permission == "microphone" ? "Privacy_Microphone" : "Privacy_AudioCapture"
            NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?"+pane)!)
            replyHandler(true,nil);return
        }
        switch body["kind"] as? String {
        case "captureDiagnostics":
            replyHandler(functionKeyCaptureDiagnostics(),nil);return
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
            let permissions=nativePermissionSnapshot()
            refreshCapturePermissions(permissions)
            refreshHotkeys()
            // The caller sends this exact snapshot with its helper refresh.
            // A fire-and-forget POST here races that refresh and can leave the
            // response using the host's previous (denied) permissions.
            replyHandler(permissionStatus(permissions),nil);return
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
        PermissionProbe.snapshot()
    }
    private func freshPermissionSnapshot(now:TimeInterval)->[String:Any]? {
        now-permissionProbeAt<4 ? permissionProbeResult : nil
    }
    private func permissionStatus(_ local:[String:Any])->[String:Any] {
        var status=local
        let system=freshPermissionSnapshot(now:ProcessInfo.processInfo.systemUptime) ?? local
        status["systemPermissions"]=Dictionary(uniqueKeysWithValues:PermissionProbe.keys.map{($0,system[$0] as? Bool == true)})
        status["permissionRecoveryPending"]=permissionRelaunchPending || (permissionRecovery.grantAt != nil && !permissionRecovery.attempted && !CommandLine.arguments.contains(PermissionAppRelaunch.argument))
        permissionRevision+=1
        status["permissionRevision"]=permissionRevision
        return status
    }
    func refreshPermissionProbe(now:TimeInterval,needed:Bool) {
        guard needed,permissionProbeProcess==nil,now>=nextPermissionProbe,
              !terminating,!permissionRelaunchPending,
              let executable=Bundle.main.executableURL else{return}
        nextPermissionProbe=now+2
        let process=Process(),output=Pipe()
        process.executableURL=executable;process.arguments=[PermissionProbe.argument]
        process.standardInput=FileHandle.nullDevice;process.standardOutput=output;process.standardError=FileHandle.nullDevice
        permissionProbeProcess=process
        process.terminationHandler={ [weak self] child in
            let data=output.fileHandleForReading.readDataToEndOfFile()
            let result=child.terminationReason == .exit && child.terminationStatus==0 ? PermissionProbe.decode(data):nil
            DispatchQueue.main.async {
                guard let self=self,self.permissionProbeProcess === child else{return}
                self.permissionProbeProcess=nil
                self.permissionProbeResult=result;self.permissionProbeAt=ProcessInfo.processInfo.systemUptime
                let signature=result.map{value in PermissionProbe.keys.map{value[$0] as? Bool==true ? "1":"0"}.joined()} ?? "unavailable"
                if signature != self.lastPermissionProbeSignature {
                    self.lastPermissionProbeSignature=signature
                    self.appendWorkerLog(Data("Fresh permission probe (input/access/post): \(signature)\n".utf8))
                }
                self.reportNativePermissions()
            }
        }
        do {try process.run()} catch {permissionProbeProcess=nil;permissionProbeResult=nil}
        DispatchQueue.main.asyncAfter(deadline:.now()+2) { [weak self,weak process] in
            guard let process=process,self?.permissionProbeProcess === process,process.isRunning else{return}
            process.terminate()
        }
    }
    func reportNativePermissions(force:Bool=false) {
        guard baseURL != nil,!terminating else{return}
        let permissions=nativePermissionSnapshot()
        refreshCapturePermissions(permissions)
        let now=ProcessInfo.processInfo.systemUptime,localGranted=PermissionProbe.allGranted(permissions)
        // A helper that has not answered yet is not evidence of cached denial.
        let stale = !localGranted || permissionHelperReady == false
        refreshPermissionProbe(now:now,needed:stale)
        let fresh=freshPermissionSnapshot(now:now)
        let granted=fresh.map{PermissionProbe.allGranted($0)} ?? localGranted
        permissionRecovery.observe(granted:granted,
            captureReady:!stale && (!hotkeysEnabled || functionKeyTapIsActive()),now:now,
            freshGrantNeedsRelaunch:fresh != nil && granted && stale)
        let canRecover = NSApp?.isActive == true && worker?.isRunning == true && !IsSecureEventInputEnabled()
            && !applicationQuitPending && !dragConvert.busy && !dragConvert.isFileDragActive
            && !musicSaveFailed && !musicActive && !musicExportActive && !musicFlushInProgress
            && !selectionLab.isBusy && !pocket.isBusy && !pocket.isInteracting && !capturingKey && keyGestureGate.activeCount==0
            && !driverOpenInFlight && !preparingUpdate && !updateInstallCommitted
            && !updateAbortRecoveryRequested && !permissionRelaunchPending
            && !CommandLine.arguments.contains(PermissionAppRelaunch.argument)
        if permissionRecovery.shouldRecover(now:now,idle:canRecover) {
            permissionShutdownCommitted=false
            permissionRelaunchPending=true
            appendWorkerLog(Data("Applying newly granted permissions by a single clean app relaunch.\n".utf8))
            NSApp.terminate(nil);return
        }
        let status=permissionStatus(permissions)
        let system=status["systemPermissions"] as? [String:Bool] ?? [:]
        let signature=PermissionProbe.keys.map { key in
            "\(permissions[key] as? Bool == true)/\(system[key] == true)"
        }.joined() + "/\(status["permissionRecoveryPending"] as? Bool == true)"
        guard force || signature != lastPermissionReportSignature || Date().timeIntervalSince(lastPermissionReport)>5 else{return}
        lastPermissionReportSignature=signature;lastPermissionReport=Date()
        post(["op":"nativePermissions","permissions":status])
    }
    // TCC can change while this process and its old event tap remain alive.
    // Invalidate that tap on an authorization edge, release owned holds, then
    // recreate it immediately. A repeated status poll must not cancel a hold.
    func refreshCapturePermissions(_ permissions:[String:Any]) {
        let signature=["inputMonitoring","accessibility","canPostEvents"].map{permissions[$0] as? Bool == true ? "1":"0"}.joined()
        guard signature != capturePermissionSignature else{return}
        // A probe started before a live grant or revocation cannot describe
        // the new state. Drop its presentation result and check again.
        if capturePermissionSignature != nil {
            permissionProbeResult=nil
            if permissionProbeProcess?.isRunning == true {permissionProbeProcess?.terminate()}
            permissionProbeProcess=nil
            nextPermissionProbe=0
        }
        capturePermissionSignature=signature
        cancelPhysicalHold();interruptFunctionKeyTap();stopReservedKeyCapture()
        nextCaptureRetry = .distantPast
        if hotkeysEnabled {refreshReservedKeyCapture(force:true)}
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
        return ["opened":opened,"permission":permission,"permissions":permissionStatus(nativePermissionSnapshot())]
    }
    func applicationDidBecomeActive(_ notification:Notification){
        refreshMusicPause()
        selectionLab.refreshAuthorization();pocket.refreshAuthorization()
        reportNativePermissions(force:true);refreshHotkeys();resumeAfterOfficialDriverIfNeeded()
    }
    func applicationDidResignActive(_ notification:Notification){
        typingSounds.setPaused("music",active:false)
        web?.evaluateJavaScript("window.dispatchEvent(new Event('nuphylab:music-release'))",completionHandler:nil)
        selectionLab.cancelShortcutRecording()
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
    let officialDriverURL = URL(string:"https://drive.nuphyio.com/#/setting")!
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
            finish(false,T("无法确认键盘已释放，请返回设备页，重新连接键盘后重试。"));return
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
                finish(false,(value?["error"] as? String) ?? error?.localizedDescription ?? self.T("无法确认键盘已释放，请返回设备页，重新连接键盘后重试。"))
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
        let nextEpoch=NativeKeySigner.bindingEpoch(value?["bindingEpoch"])
        if keyBindingEpoch != nextEpoch {setHotkeysEnabled(false);keyBindingEpoch=nextEpoch}
        let dictationCodes=Set((value?["source"] as? String ?? "codex") == "codex" ? (value?["dictationCodes"] as? [String] ?? []) : [])
        physicalCommandCodes=Set(value?["physicalCodes"] as? [String] ?? ["F7","F8","F9","F11","F12"])
        let raw=value?["bindings"] as? [[String:Any]] ?? []
        let next=raw.compactMap { item -> (code:String,keyCode:UInt32)? in
            guard let code=item["code"] as? String,let n=item["keyCode"] as? Int,n>=0,n<=127 else{return nil}
            return (code,UInt32(n))
        }
        dictationKeyCodes=Set(next.filter{dictationCodes.contains($0.code)}.map{$0.keyCode})
        let valid=next.count==12 && Set(next.map{$0.code}).count==12 && Set(next.map{$0.keyCode}).count==12
        configuredKeysEnabled=valid && value?["enabled"] as? Bool==true
        if keyConfiguration.map({$0.code}) != next.map({$0.code}) || keyConfiguration.map({$0.keyCode}) != next.map({$0.keyCode}) {
            setHotkeysEnabled(false);keyConfiguration=valid ? next : []
        }
        refreshHotkeys()
    }
    func refreshHotkeys(){
        if capturingKey || selectionShortcutRecording || keySessionSuspended || terminating || applicationQuitPending || preparingUpdate || updateInstallCommitted || updateAbortRecoveryRequested || permissionRelaunchPending || musicFlushInProgress {pocket.suspend()}
        else {pocket.resume()}
        typingSounds.setPaused("commandShortcut",active:capturingKey)
        setHotkeysEnabled(configuredKeysEnabled && !selectionShortcutRecording && !pocketShortcutRecording && !keySessionSuspended && !capturingKey && !(editingField && NSApp.isActive) && !terminating && hotkeyPollTimer != nil)
        if hotkeysEnabled { refreshReservedKeyCapture() }
        if capturingKey && NSApp.isActive && !terminating { _ = startReservedKeyCapture() }
        else if !hotkeysEnabled { stopReservedKeyCapture() }
        reportHotkeys()
    }
    func reportHotkeys(){
        guard baseURL != nil,!terminating else{return}
        _ = reconcileFunctionKeyTap()
        let suspended=selectionShortcutRecording || pocketShortcutRecording || capturingKey || (editingField && NSApp.isActive)
        let signature="\(registeredCodes)|\(failedCodes)|\(suspended)"
        guard signature != lastKeyReportSignature || Date().timeIntervalSince(lastKeyReport)>5 else{return}
        lastKeyReportSignature=signature;lastKeyReport=Date()
        post(["op":"codexKeyStatus","registered":registeredCodes,"failed":failedCodes,"suspended":suspended])
    }
    func startHotkeyMonitoring(){
        guard !updateInstallCommitted,!updateAbortRecoveryRequested else{return}
        stopHotkeyMonitoring()
        keyRevision = -1
        reportNativePermissions(force:true)
        let timer=Timer(timeInterval:0.5,repeats:true){[weak self] _ in self?.pollHotkeySetting()}
        hotkeyPollTimer=timer;RunLoop.main.add(timer,forMode:.common)
        pollHotkeySetting()
    }
    func stopHotkeyMonitoring(){
        ambientLight.stop(); ambientGeneration += 1
        ambientTask?.cancel(); ambientTask=nil; pendingAmbient=nil
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
                let native=state?["native"] as? [String:Any]
                let helper=native?["helper"] as? [String:Any] ?? native
                let grants=PermissionProbe.keys.compactMap { helper?[$0] as? Bool }
                self.permissionHelperReady=grants.contains(false) ? false : (grants.count==PermissionProbe.keys.count ? true : nil)
                if let value=settings?["language"] as? String, ["en","zh-CN"].contains(value), self.english != (value == "en") {
                    self.english = value == "en"; self.buildMenus(); self.selectionLab.updateLanguage(self.english ? .en:.zh); self.dragConvert.updateLanguage(english:self.english);self.pocket.updateLanguage(english:self.english)
                    #if canImport(Sparkle)
                    self.updateUserDriver?.refreshLanguage()
                    #endif
                }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.ambientLight.sync(enabled:(settings?["ambientLighting"] as? [String:Any])?["enabled"] as? Bool == true)
                }
                self.applyKeyConfiguration(keys)
                let capture=(state?["audio"] as? [String:Any])?["capture"] as? [String:Any]
                self.typingSounds.setPaused("microphone", active:capture?["enabled"] as? Bool == true && capture?["source"] as? String == "microphone")
                self.setMusicCapture("microphone",active:capture?["enabled"] as? Bool == true && capture?["source"] as? String == "microphone")
                self.audioCapture.sync(capture)
            }
        }
        hotkeyStateTask?.resume()
    }
    func setHotkeysEnabled(_ enabled:Bool){
        pocket.refreshAuthorization()
        selectionLab.updateReservedKeys((enabled || (selectionShortcutRecording || pocketShortcutRecording) && configuredKeysEnabled) ? Set(keyConfiguration.map{$0.keyCode}) : (capturingKey ? Set(functionKeyCodes.keys):[]))
        if !enabled {cancelPhysicalHold()}
        if enabled {
            guard !hotkeysEnabled else{return}
            hotkeysEnabled=true;installHotkeys()
        } else {
            if !capturingKey {stopReservedKeyCapture()}
            for gesture in keyGestureGate.releaseAll() {enqueueKey(gesture.packet(phase:"up"))}
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
            return host.handleCarbonHotKey(ident.id,down:GetEventKind(event) != UInt32(kEventHotKeyReleased),eventTime:GetEventTime(event)) ? noErr : OSStatus(eventNotHandledErr)
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
        failedCodes=keyConfiguration.map{$0.code}.filter{!registeredCodes.contains($0) || (!captured && physicalCommandCodes.contains($0))}
        // A key needing the event tap is not ready merely because Carbon
        // accepted a registration that macOS can intercept first.
        registeredCodes.removeAll{failedCodes.contains($0)}
    }
    func stopReservedKeyCapture(){
        if let tap=reservedKeyTap {CGEvent.tapEnable(tap:tap,enable:false);CFMachPortInvalidate(tap)}
        if let source=reservedKeySource {CFRunLoopRemoveSource(CFRunLoopGetMain(),source,.commonModes)}
        reservedKeyTap=nil;reservedKeySource=nil;lastTapCaptureState=nil
    }
    func startReservedKeyCapture()->Bool {
        if let attempt=captureAttemptOverride {return attempt()}
        _ = reconcileFunctionKeyTap()
        if let tap=reservedKeyTap {
            if !CGEvent.tapIsEnabled(tap:tap) {CGEvent.tapEnable(tap:tap,enable:true)}
            _ = reconcileFunctionKeyTap()
            return CGEvent.tapIsEnabled(tap:tap)
        }
        let mask=(CGEventMask(1)<<CGEventType.keyDown.rawValue)|(CGEventMask(1)<<CGEventType.keyUp.rawValue)
        guard let tap=CGEvent.tapCreate(tap:.cghidEventTap,place:.headInsertEventTap,options:.defaultTap,eventsOfInterest:mask,callback:{_,type,event,context in
            guard let context=context else{return Unmanaged.passUnretained(event)}
            let host=Unmanaged<AppDelegate>.fromOpaque(context).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                host.interruptFunctionKeyTap()
                if host.hotkeysEnabled || host.capturingKey,let tap=host.reservedKeyTap {CGEvent.tapEnable(tap:tap,enable:true)}
                return Unmanaged.passUnretained(event)
            }
            return host.handleReservedKey(type,event) ? nil : Unmanaged.passUnretained(event)
        },userInfo:Unmanaged.passUnretained(self).toOpaque()),let source=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,tap,0) else{return false}
        reservedKeyTap=tap;reservedKeySource=source
        CFRunLoopAddSource(CFRunLoopGetMain(),source,.commonModes);CGEvent.tapEnable(tap:tap,enable:true)
        _ = reconcileFunctionKeyTap()
        return CGEvent.tapIsEnabled(tap:tap)
    }
    func handleReservedKey(_ type:CGEventType,_ event:CGEvent)->Bool {
        guard [CGEventType.keyDown,.keyUp].contains(type) else{return false}
        let keyCode=UInt32(event.getIntegerValueField(.keyboardEventKeycode))
        let consumed=handleFunctionKey(keyCode,down:type == .keyDown,
            repeated:event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
            modified:!event.flags.intersection([.maskCommand,.maskControl,.maskAlternate,.maskShift]).isEmpty,
            source:.eventTap,eventTime:Double(event.timestamp)/1_000_000_000,timestampNS:event.timestamp,hardwareVerified:NativeKeyOrigin.isHardware(event))
        observeFunctionKey(source:.eventTap,keyCode:keyCode,phase:type == .keyDown ? "down":"up",
            uptimeSeconds:Double(event.timestamp)/1_000_000_000,timestampNS:event.timestamp,flags:event.flags,
            repeated:event.getIntegerValueField(.keyboardEventAutorepeat) != 0,consumed:consumed)
        return consumed
    }
    func handleLocalKey(_ event:NSEvent)->NSEvent? {
        let rawTimestamp = event.cgEvent?.timestamp
        let eventTime = rawTimestamp.flatMap { $0 > 0 ? Double($0)/1_000_000_000 : nil } ?? event.timestamp
        var consumed=false
        defer {
            if event.type == .keyDown || event.type == .keyUp {
                observeFunctionKey(source:.local,keyCode:UInt32(event.keyCode),phase:event.type == .keyDown ? "down":"up",
                    uptimeSeconds:eventTime,timestampNS:rawTimestamp,flags:CGEventFlags(rawValue:UInt64(event.modifierFlags.rawValue)),
                    repeated:event.isARepeat,consumed:consumed)
            }
        }
        if self.handleFunctionKey(UInt32(event.keyCode),down:event.type == .keyDown,repeated:event.isARepeat,
            modified:!event.modifierFlags.intersection([.command,.control,.option,.shift]).isEmpty,
            source:.local,eventTime:eventTime,timestampNS:rawTimestamp,hardwareVerified:NativeKeyOrigin.isHardware(event.cgEvent)) {consumed=true;return nil}
        guard self.hotkeysEnabled,
              event.modifierFlags.intersection([.command,.control,.option,.shift]).isEmpty,
              let index=self.keyConfiguration.firstIndex(where:{$0.keyCode==UInt32(event.keyCode)}) else{return event}
        self.dispatchBoundKey(index,down:event.type == .keyDown,repeated:event.isARepeat,
            source:.local,eventTime:eventTime,timestampNS:rawTimestamp,hardwareVerified:NativeKeyOrigin.isHardware(event.cgEvent))
        consumed=true
        return nil
    }
    private func observeFunctionKey(source:NativeKeyEventSource,keyCode:UInt32,phase:String,
                                    uptimeSeconds:Double?,timestampNS:UInt64?,flags:CGEventFlags,
                                    repeated:Bool,consumed:Bool) {
        guard !terminating,hotkeysEnabled || capturingKey,
              let row=functionKeyObservations.record(source:source,keyCode:keyCode,phase:phase,
                uptimeSeconds:uptimeSeconds,timestampNS:timestampNS,flags:flags,repeated:repeated,consumed:consumed) else{return}
        // Existing log transport only. Offline host fixtures have no running
        // worker and never write into the user's application data directory.
        if worker?.isRunning == true,let line=NativeFunctionKeyObservations.logLine(row) {appendWorkerLog(line)}
    }
    func handleCarbonHotKey(_ id:UInt32,down:Bool,eventTime:Double)->Bool {
        let index=Int(id)-1
        guard hotkeysEnabled,!terminating,keyConfiguration.indices.contains(index) else{return false}
        if functionKeyCodes[keyConfiguration[index].keyCode] != nil {
            routeFunctionKey(index,down:down,repeated:false,source:.carbon,eventTime:eventTime,tapActive:reconcileFunctionKeyTap())
        } else {dispatchBoundKey(index,down:down,repeated:false,source:.carbon,eventTime:eventTime)}
        return true
    }
    func functionKeyTapIsActive()->Bool {
        eventTapOwnershipOverride?() ?? reservedKeyTap.map { CGEvent.tapIsEnabled(tap:$0) } ?? false
    }
    @discardableResult func reconcileFunctionKeyTap(observedTapEvent:Bool=false)->Bool {
        let available=observedTapEvent || functionKeyTapIsActive()
        if lastTapCaptureState == true && !available {interruptFunctionKeyTap()}
        lastTapCaptureState=available
        return available
    }
    func interruptFunctionKeyTap(){
        for gesture in keyGestureGate.interrupt(owner:.eventTap) {
            if let index=keyConfiguration.firstIndex(where:{$0.keyCode==gesture.keyCode}) {heldHotkeys.remove(UInt32(index+1))}
            enqueueKey(gesture.packet(phase:"up"))
        }
        lastTapCaptureState=false
    }
    func routeFunctionKey(_ index:Int,down:Bool,repeated:Bool,source:NativeKeyEventSource,eventTime:Double?,timestampNS:UInt64?=nil,tapActive:Bool,hardwareVerified:Bool=false){
        let binding=keyConfiguration[index]
        let owner=NativeFunctionKeyOwnership.owner(tapActive:tapActive,carbonRegistered:carbonRegisteredCodes.contains(binding.code))
        let heldOwner=keyGestureGate.heldGesture(keyCode:binding.keyCode)?.owner
        let permitted=NativeFunctionKeyOwnership.accepts(source,owner:owner) ||
            (!down && heldOwner.map{NativeFunctionKeyOwnership.accepts(source,owner:$0)} == true)
        guard permitted else{return}
        dispatchBoundKey(index,down:down,repeated:repeated,source:source,eventTime:eventTime,timestampNS:timestampNS,owner:owner,hardwareVerified:hardwareVerified)
    }
    func functionKeyCaptureDiagnostics()->[String:Any] {
        let active=functionKeyTapIsActive()
        let bindings=keyConfiguration.filter{functionKeyCodes[$0.keyCode] != nil}
        let owners=Dictionary(uniqueKeysWithValues:bindings.map { binding in
            (binding.code,NativeFunctionKeyOwnership.owner(tapActive:active,carbonRegistered:carbonRegisteredCodes.contains(binding.code)).rawValue)
        })
        return ["tapActive":active,"owners":owners,"localOnly":bindings.map{$0.code}.filter{owners[$0]=="local"},
            "awaitingKeyUp":keyGestureGate.awaitingReleaseCodes,"activeGestures":keyGestureGate.activeCount,
            "functionKeyObservations":functionKeyObservations.rows,"observationLimit":NativeFunctionKeyObservations.limit,
            "observationLimitReached":functionKeyObservations.rows.count == NativeFunctionKeyObservations.limit]
    }
    func handleFunctionKey(_ keyCode:UInt32,down:Bool,repeated:Bool,modified:Bool,
                           source:NativeKeyEventSource = .local,eventTime:Double?=nil,timestampNS:UInt64?=nil,hardwareVerified:Bool=false)->Bool {
        guard !terminating,let code=functionKeyCodes[keyCode] else{return false}
        if capturingKey && NSApp.isActive {
            if !down,capturedFunctionKeys.remove(code) != nil {sendCapturedFunctionKey(code,phase:"up");return true}
            guard !modified else{return false}
            if down && !repeated && capturedFunctionKeys.insert(code).inserted {sendCapturedFunctionKey(code,phase:"down")}
            return true
        }
        guard hotkeysEnabled,let index=keyConfiguration.firstIndex(where:{$0.keyCode==keyCode}) else{return false}
        let id=UInt32(index+1)
        let tapActive=reconcileFunctionKeyTap(observedTapEvent:source == .eventTap)
        if !down {
            let wasHeld=heldHotkeys.contains(id)
            routeFunctionKey(index,down:false,repeated:repeated,source:source,eventTime:eventTime,timestampNS:timestampNS,tapActive:tapActive,hardwareVerified:hardwareVerified)
            return !modified || wasHeld
        }
        guard !modified else{return false}
        routeFunctionKey(index,down:true,repeated:repeated,source:source,eventTime:eventTime,timestampNS:timestampNS,tapActive:tapActive,hardwareVerified:hardwareVerified)
        return true
    }
    func sendCapturedFunctionKey(_ code:String,phase:String) {
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('nuphylab:function-key',{detail:{code:'\(code)',phase:'\(phase)'}}));",completionHandler:nil)
    }
    func applicationWillTerminate(_ notification:Notification) { pocket.shutdown();dragConvert.shutdown(); typingSounds.shutdown() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{return false}
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows:Bool)->Bool{show();return true}
    func unlockMusicTransition(){if !terminating && !preparingUpdate && !updateInstallCommitted && !updateAbortRecoveryRequested && !keySessionSuspended {dragConvert.resume();pocket.resume()};web?.evaluateJavaScript("window.dispatchEvent(new Event('nuphylab:music-quit-finished'))",completionHandler:nil)}
    func registerMusicDocument(_ body:[String:Any])->Bool{
        guard let id=body["documentId"] as? String,!id.isEmpty,!retiredMusicDocuments.contains(id),!musicDocumentLost else{return false}
        if musicDocumentID==nil {
            // Only a mounted editor can register. A late save/cleanup callback
            // from the retired document cannot take over the new identity.
            guard body["present"] as? Bool == true else{return false}
            musicDocumentID=id
        }
        guard musicDocumentID==id else{return false}
        if body["present"] as? Bool == true {musicEverUsed=true}
        return true
    }
    func retireMusicDocumentForReload(){
        if let id=musicDocumentID {retiredMusicDocuments.insert(id)}
        musicEverUsed=false;musicDocumentLost=false;musicDocumentID=nil;musicSaveFailed=false
    }
    func reopenSavedMusicDocument(_ url:URL){
        stopMusic(suspend:true)
        retireMusicDocumentForReload();musicDocumentOrigin=url
        web.load(URLRequest(url:url))
    }
    @objc func recoverMusicPage(){
        show()
        guard musicEverUsed,let url=baseURL else{return}
        let alert=NSAlert();alert.alertStyle = .warning
        alert.messageText=english ? "Reopen the saved performance?" : "重新打开已保存的演奏？"
        alert.informativeText=english ? "Unsaved changes in the current page will be discarded. If the editor is still available, export a project backup before continuing. Saved works and other settings will remain." : "当前页面尚未保存的改动将被舍弃。如果编辑器仍可用，请先导出工程备份。已保存的作品和其他设置会保留。"
        alert.addButton(withTitle:english ? "Cancel" : "取消")
        alert.addButton(withTitle:english ? "Reopen saved works" : "重新打开已保存作品")
        alert.beginSheetModal(for:window){[weak self] response in
            if response == .alertSecondButtonReturn {self?.reopenSavedMusicDocument(url)}
        }
    }
    func presentMusicSaveFailure(){
        show()
        let alert=NSAlert();alert.alertStyle = .warning
        alert.messageText=english ? "Your performance has not finished saving" : "演奏尚未保存完成"
        alert.informativeText=english ? "NuPhy Lab will stay open. Try saving again or export a project backup. If the editor cannot reconnect, recover the page from saved works using the button below or Window > Recover Performance Page." : "NuPhy Lab 将保持打开。请重试保存或先导出工程备份。若编辑器无法重连，可用下方按钮或「窗口 → 恢复演奏页面」重新打开已保存作品。"
        alert.addButton(withTitle:english ? "Stay open" : "保持打开")
        if baseURL != nil {alert.addButton(withTitle:english ? "Recover performance page…" : "恢复演奏页面…")}
        alert.beginSheetModal(for:window){[weak self] response in
            if response == .alertSecondButtonReturn {DispatchQueue.main.async{self?.recoverMusicPage()}}
        }
    }
    func musicSaveReceiptIsValid(_ value:Any?)->Bool{
        guard !musicDocumentLost,let expected=musicDocumentID,let receipt=value as? [String:Any] else{return false}
        return receipt["saved"] as? Bool == true && receipt["documentId"] as? String == expected
    }
    func flushMusicForTransition(_ completion:@escaping(Bool)->Void){
        guard musicEverUsed else{completion(true);return}
        guard !musicFlushInProgress else{completion(false);return}
        musicFlushInProgress=true;musicFlushEpoch+=1;let epoch=musicFlushEpoch
        let finish:(Bool)->Void={ [weak self] saved in
            guard let self,self.musicFlushInProgress,self.musicFlushEpoch==epoch else{return}
            self.musicFlushInProgress=false
            self.musicSaveFailed = !saved
            if !saved {
                // A cancelled save has not sent any worker signal, so it must
                // not consume permission recovery's single relaunch attempt.
                if self.permissionRelaunchPending {self.permissionRecovery.attempted=false;self.permissionRecovery.grantAt=ProcessInfo.processInfo.systemUptime}
                self.permissionRelaunchPending=false
                self.unlockMusicTransition()
            }
            completion(saved)
        }
        guard let web else{finish(false);return}
        web.callAsyncJavaScript("window.dispatchEvent(new Event('nuphylab:music-quitting')); if(typeof window.__MUSIC_FLUSH__!=='function') throw new Error('Music save bridge unavailable'); return await window.__MUSIC_FLUSH__();",arguments:[:],in:nil,in:.page){result in
            switch result {case .success(let value):finish(self.musicSaveReceiptIsValid(value));case .failure:finish(false)}
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+20){finish(false)}
    }
    func presentDragBusyNotice(){
        let alert=NSAlert();alert.messageText=english ? "Files are still being converted" : "文件仍在转换中"
        alert.informativeText=english ? "Wait for conversion to finish, or cancel it in Labs > Drag Convert, then try again. Your originals are kept." : "请等待转换完成，或在「实验室 → 拖拽转换」中取消后重试。原文件会保留。"
        alert.addButton(withTitle:english ? "OK" : "好");alert.runModal()
    }
    func replyToTermination(_ allow:Bool){
        guard applicationQuitPending else{return}
        applicationQuitPending=false
        NSApp.reply(toApplicationShouldTerminate:allow)
    }
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply{
        guard !dragConvert.busy else{presentDragBusyNotice();return .terminateCancel}
        if musicExportActive || preparingUpdate {NSSound.beep();return .terminateCancel}
        if terminating {return .terminateLater}
        if musicFlushInProgress {return applicationQuitPending ? .terminateLater : .terminateCancel}
        applicationQuitPending=true
        dragConvert.suspend();pocket.suspend()
        guard musicEverUsed else{
            let result=terminateAfterMusicSave(sender)
            if result != .terminateLater {applicationQuitPending=false}
            return result
        }
        flushMusicForTransition { [weak self] saved in
            guard let self else{return}
            if saved {
                let result=self.terminateAfterMusicSave(sender)
                if result != .terminateLater {if result == .terminateCancel {self.unlockMusicTransition()};self.replyToTermination(result == .terminateNow)}
            } else {self.replyToTermination(false);self.presentMusicSaveFailure()}
        }
        return .terminateLater
    }
    func terminateAfterMusicSave(_ sender:NSApplication)->NSApplication.TerminateReply{
        if terminating{return .terminateLater}
        guard !dragConvert.busy else{presentDragBusyNotice();return .terminateCancel}
        dragConvert.shutdown();pocket.suspend()
        if permissionRelaunchPending { selectionLab.cancel() }
        else { selectionLab.shutdown() }
        typingSounds.setPaused("quitting",active:true)
        resetOfficialDriverReturn()
        stopHotkeyMonitoring()
        guard let worker=worker else{selectionLab.shutdown();return .terminateNow}
        // A stopped process may still have a queued termination callback and log flush.
        // Let that callback surface a nonzero exit instead of bypassing it on a second quit.
        permissionShutdownCommitted=permissionRelaunchPending
        terminating=true
        setExitPresentation(true)
        guard worker.isRunning else{return .terminateLater}
        // Signal only Node. Its shutdown handler must keep HIDBridge alive until
        // restore and helper shutdown finish; Process.terminate() can hit its group.
        let workerPID=worker.processIdentifier
        let signalResult=workerPID>0 ? Darwin.kill(workerPID,SIGTERM) : -1
        let signalError=workerPID>0 ? errno : EINVAL
        if signalResult != 0 && signalError != ESRCH {
            permissionRelaunchPending=false;permissionShutdownCommitted=false
            terminating=false
            typingSounds.setPaused("quitting",active:false)
            setExitPresentation(false)
            appendWorkerLog(Data("Worker shutdown signal failed: pid=\(workerPID), errno=\(signalError)\n".utf8))
            dragConvert.resume();pocket.resume();startHotkeyMonitoring()
            let alert=NSAlert();alert.alertStyle = .warning;alert.messageText=self.T("未能开始恢复键盘灯效");alert.informativeText=self.T("退出请求未能发送给灯光服务。应用仍保持运行，请稍后再试。");alert.runModal()
            return .terminateCancel
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+45){if worker.isRunning{let alert=NSAlert();alert.messageText=self.T("仍在恢复键盘灯效");alert.informativeText=self.T("原始备份已保存。请保持键盘连接，应用将在恢复流程结束后退出。");alert.beginSheetModal(for:self.window){_ in }}}
        return .terminateLater
    }
    func setExitPresentation(_ active: Bool) {
        if !active {unlockMusicTransition()}
        web.evaluateJavaScript("window.__AIR_EXITING__ = \(active ? "true" : "false"); window.dispatchEvent(new Event('nuphylab:shutdown'));", completionHandler:nil)
    }
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){
        guard let url=navigationAction.request.url else{decisionHandler(.cancel);return}
        if navigationAction.shouldPerformDownload {decisionHandler(.download);return}
        if url.scheme=="blob"||url.host=="127.0.0.1"{decisionHandler(.allow);return}
        decisionHandler(.cancel)
        guard ["https","http"].contains(url.scheme ?? "") else{return}
        if url.scheme=="https", ["drive.nuphyio.com","drive.nuphy.io"].contains(url.host ?? "") {
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
    func updater(_ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem, updateCheck: SPUUpdateCheck) throws {
        if let data=UserDefaults.standard.data(forKey:"NuPhyLab.UpdateReminder.v1"),
           let reminder=try? JSONDecoder().decode(AppUpdateReminder.self,from:data),
           !reminder.allows(version:item.versionString,userInitiated:updateCheck == .updates,now:Date().timeIntervalSince1970) {
            throw NSError(domain:NSCocoaErrorDomain,code:NSUserCancelledError,userInfo:[NSLocalizedDescriptionKey:english ? "This version's reminder is postponed." : "此版本的更新提醒已稍后。"])
        }
    }
    func updater(_ updater: SPUUpdater, userDidMake choice: SPUUserUpdateChoice, forUpdate item: SUAppcastItem, state: SPUUserUpdateState) {
        // Sparkle owns Skip This Version. Later alone adds a bounded reminder
        // delay; a manual check and a different version always remain eligible.
        if choice == .dismiss {
            let reminder=AppUpdateReminder(version:item.versionString,remindAfter:Date().timeIntervalSince1970+AppUpdateReminder.delay)
            if let data=try? JSONEncoder().encode(reminder){UserDefaults.standard.set(data,forKey:"NuPhyLab.UpdateReminder.v1")}
        } else {
            UserDefaults.standard.removeObject(forKey:"NuPhyLab.UpdateReminder.v1")
        }
    }
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        pendingUpdateInstall=installHandler
        pendingUpdateVersion=item.versionString
        prepareUpdateInstallation()
        return true
    }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        recoverAfterAbortedUpdate()
    }
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        // A nil error can also mean an installation is scheduled; it is not
        // evidence that the committed installation has been cancelled.
        if error != nil {recoverAfterAbortedUpdate()}
    }
}
#endif
