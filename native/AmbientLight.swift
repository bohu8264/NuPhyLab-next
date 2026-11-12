import Foundation
import AppKit
import IOKit
import Darwin

struct AmbientLightReading {
    let status: String
    let lux: Double?
    static func measured(_ value: Double) -> AmbientLightReading {
        guard value.isFinite, value >= 0, value <= 200_000 else { return .init(status: "unavailable", lux: nil) }
        return .init(status: "ready", lux: value)
    }
}

// Runtime-only, read-only access. This macOS interface is undocumented: absent
// symbols/services/data are unavailable, never zero lux. No camera or TCC API.
// All handles are owned by the serial sampling queue.
final class AmbientLightReader {
    private typealias CopyClient = @convention(c) () -> UnsafeMutableRawPointer?
    private typealias CopyEvent = @convention(c) (UnsafeMutableRawPointer, Int64, Int32, Int64) -> UnsafeMutableRawPointer?
    private typealias FloatValue = @convention(c) (UnsafeMutableRawPointer, Int32) -> Double
    private var bezel: UnsafeMutableRawPointer?
    private var io: UnsafeMutableRawPointer?
    private var client: UnsafeMutableRawPointer?
    private var copyEvent: CopyEvent?
    private var floatValue: FloatValue?
    private var nextOpen: TimeInterval = 0

    private func release(_ object: UnsafeMutableRawPointer) { Unmanaged<AnyObject>.fromOpaque(object).release() }
    func reset() {
        if let client { release(client) }; client=nil
        copyEvent=nil; floatValue=nil
        if let io { dlclose(io) }; io=nil
        if let bezel { dlclose(bezel) }; bezel=nil
        nextOpen=0
    }
    deinit { reset() }
    private func open() -> Bool {
        if client != nil { return true }
        let now=ProcessInfo.processInfo.systemUptime
        guard now >= nextOpen else { return false }
        reset(); nextOpen=now+15
        bezel=dlopen("/System/Library/PrivateFrameworks/BezelServices.framework/BezelServices", RTLD_LAZY|RTLD_LOCAL)
        io=dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY|RTLD_LOCAL)
        guard let bezel, let io,
              let create=dlsym(bezel,"ALCALSCopyALSServiceClient"),
              let event=dlsym(io,"IOHIDServiceClientCopyEvent"),
              let value=dlsym(io,"IOHIDEventGetFloatValue") else { return false }
        copyEvent=unsafeBitCast(event,to:CopyEvent.self)
        floatValue=unsafeBitCast(value,to:FloatValue.self)
        client=unsafeBitCast(create,to:CopyClient.self)()
        return client != nil
    }
    private func lidClosed() -> Bool {
        let service=IOServiceGetMatchingService(kIOMainPortDefault,IOServiceMatching("IOPMrootDomain"))
        guard service != 0 else { return false }
        defer { IOObjectRelease(service) }
        return IORegistryEntryCreateCFProperty(service,"AppleClamshellState" as CFString,kCFAllocatorDefault,0)?.takeRetainedValue() as? Bool == true
    }
    func read() -> AmbientLightReading {
        if lidClosed() { return .init(status:"lidClosed",lux:nil) }
        guard open(), let client, let copyEvent, let floatValue,
              let event=copyEvent(client,12,0,0) else { return .init(status:"unavailable",lux:nil) }
        defer { release(event) }
        return .measured(floatValue(event,12 << 16))
    }
}

final class AmbientLightMonitor {
    var onSample: (([String:Any]) -> Void)?
    private let queue=DispatchQueue(label:"com.nuphylab.ambient-light",qos:.utility)
    private let reader=AmbientLightReader()
    private var timer: Timer?
    private var observers=[NSObjectProtocol]()
    private var epoch=0, sequence=0
    private var busy=false, sleeping=false
    private(set) var enabled=false

    // AppKit state and callbacks live on main. Sampling never blocks input/UI.
    func sync(enabled: Bool) {
        guard self.enabled != enabled else { return }
        if !enabled { stop(); return }
        self.enabled=true; epoch += 1
        let center=NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName:NSWorkspace.willSleepNotification,object:nil,queue:.main) { [weak self] _ in
            guard let self else { return }; self.epoch += 1; self.sleeping=true; self.busy=false
            self.emit(.init(status:"sleeping",lux:nil),sampledAt:Date().timeIntervalSince1970*1000)
        })
        observers.append(center.addObserver(forName:NSWorkspace.didWakeNotification,object:nil,queue:.main) { [weak self] _ in
            guard let self else { return }; self.epoch += 1; self.sleeping=false; self.busy=false
            self.queue.async { [weak self] in self?.reader.reset() }; self.sample()
        })
        let timer=Timer(timeInterval:1,repeats:true) { [weak self] _ in self?.sample() }
        self.timer=timer; RunLoop.main.add(timer,forMode:.common); sample()
    }
    func stop() {
        enabled=false; epoch += 1; busy=false; sleeping=false
        timer?.invalidate(); timer=nil
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }; observers=[]
        queue.async { [weak self] in self?.reader.reset() }
    }
    private func sample() {
        guard enabled,!sleeping,!busy else { return }
        busy=true; let generation=epoch
        queue.async { [weak self] in
            guard let self else { return }
            let reading=self.reader.read(), sampledAt=Date().timeIntervalSince1970*1000
            DispatchQueue.main.async { [weak self] in
                guard let self,self.enabled,self.epoch==generation else { return }
                self.busy=false; self.emit(reading,sampledAt:sampledAt)
            }
        }
    }
    private func emit(_ reading:AmbientLightReading,sampledAt:Double) {
        sequence += 1
        var payload:[String:Any]=["status":reading.status,"sequence":sequence,"sampledAt":sampledAt]
        if let lux=reading.lux { payload["lux"]=lux }
        onSample?(payload)
    }
}
