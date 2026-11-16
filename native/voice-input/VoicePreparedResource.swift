import Foundation

// One stopped resource, one borrower. Preparation never starts capture. All
// ownership transitions run on this queue; waiting/cancelled starts cannot
// create a second input unit while the previous recording is shutting down.
final class VoicePreparedResource<Resource:AnyObject, Route:Equatable>: @unchecked Sendable {
    struct Lease {
        let token:UUID
        let resource:Resource
        fileprivate let route:Route
        fileprivate let revision:Int
    }
    private struct Waiting {
        let cancelled:()->Bool
        let continuation:CheckedContinuation<Lease,Error>
    }
    private let queue=DispatchQueue(label:"local.nuphylab.voiceinput.preparation",qos:.userInitiated)
    private let currentRoute:()->Route
    private let make:(Route)throws->Resource
    private let dispose:(Resource)->Void
    private let mayPrepare:()->Bool
    private var available:Lease?
    private var borrowed:Lease?
    private var waiting:[Waiting]=[]
    private var revision=0
    private var closed=false
    private let statusLock=NSLock()
    private var status:[String:Any]=["prepared":false,"borrowed":false]
    init(currentRoute:@escaping ()->Route,mayPrepare:@escaping ()->Bool,
         make:@escaping (Route)throws->Resource,dispose:@escaping (Resource)->Void) {
        self.currentRoute=currentRoute;self.mayPrepare=mayPrepare;self.make=make;self.dispose=dispose
    }
    var diagnostics:[String:Any] {statusLock.lock();defer{statusLock.unlock()};return status}
    private func publish(_ extra:[String:Any]=[:]) {
        statusLock.lock();defer{statusLock.unlock()}
        status["prepared"]=available != nil;status["borrowed"]=borrowed != nil;status["waiting"]=waiting.count
        for (key,value) in extra {status[key]=value}
    }
    func prewarm() {queue.async {self.prepareIfIdle()}}
    private func prepareIfIdle() {
        guard !closed,borrowed==nil,mayPrepare() else{return}
        do {available=try prepared()} catch {available=nil;publish(["preparationFailed":true])}
        publish()
    }
    private func prepared() throws ->Lease {
        let route=currentRoute()
        if let available {
            self.available=nil
            if available.route==route && available.revision==revision {return available}
            dispose(available.resource)
        }
        let began=ProcessInfo.processInfo.systemUptime
        let resource=try make(route)
        // A Bluetooth device may disconnect while its input node initializes.
        guard route==currentRoute() else {dispose(resource);throw VoiceCaptureError.unavailable}
        publish(["preparationSeconds":ProcessInfo.processInfo.systemUptime-began,"preparationFailed":false])
        return Lease(token:UUID(),resource:resource,route:route,revision:revision)
    }
    func take(cancelled:@escaping ()->Bool) async throws ->Lease {
        try await withCheckedThrowingContinuation {continuation in
            queue.async {
                self.waiting.append(Waiting(cancelled:cancelled,continuation:continuation))
                self.serve()
            }
        }
    }
    private func serve() {
        // Cancelled waiters are released even if an older lease is still active.
        waiting=waiting.filter { request in
            if closed || request.cancelled() {request.continuation.resume(throwing:VoiceCaptureError.cancelled);return false}
            return true
        }
        while borrowed==nil,!waiting.isEmpty {
            let request=waiting.removeFirst(),wasPrepared=available != nil
            do {
                let lease=try prepared()
                guard !request.cancelled() else {
                    available=lease;request.continuation.resume(throwing:VoiceCaptureError.cancelled);continue
                }
                let checkout=Lease(token:UUID(),resource:lease.resource,route:lease.route,revision:lease.revision)
                borrowed=checkout;publish(["lastAcquirePrepared":wasPrepared])
                request.continuation.resume(returning:checkout)
            } catch {request.continuation.resume(throwing:error)}
        }
        publish()
    }
    func cancelWaiting() {queue.async {self.serve()}}
    // The borrower must stop hardware and disconnect its writer before returning it.
    func putBack(_ lease:Lease,reusable:Bool) {
        queue.async {
            guard self.borrowed?.token==lease.token else{return}
            self.borrowed=nil
            if reusable && !self.closed && lease.revision==self.revision && lease.route==self.currentRoute() {
                self.available=lease
            } else {self.dispose(lease.resource)}
            self.serve()
            if !self.closed,self.borrowed==nil,self.available==nil {self.prepareIfIdle()}
        }
    }
    func invalidate(resource:Resource?=nil,onlyIfRouteChanged:Bool=false) {
        queue.async {
            if let resource,self.available?.resource !== resource,self.borrowed?.resource !== resource {return}
            if onlyIfRouteChanged,let current=self.available ?? self.borrowed,current.route==self.currentRoute() {return}
            self.revision += 1
            if let cached=self.available {self.available=nil;self.dispose(cached.resource)}
            self.serve();self.prepareIfIdle()
        }
    }
    func shutdown() {
        queue.sync {
            closed=true;revision += 1
            if let cached=available {available=nil;dispose(cached.resource)}
            serve();publish()
        }
    }
    // Barrier for deterministic ownership tests; never called by the hotkey.
    func drain() {queue.sync {}}
}
