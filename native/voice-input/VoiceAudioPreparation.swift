import AVFoundation
import CoreAudio
import AudioToolbox

struct VoiceAudioRoute:Equatable {
    let input:AudioDeviceID
    let output:AudioDeviceID
    var selection:String=""
    var inputRate:Double=0
    var outputRate:Double=0
    static func sampleRate(_ device:AudioDeviceID)->Double {
        var property=AudioObjectPropertyAddress(mSelector:kAudioDevicePropertyNominalSampleRate,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
        var value:Double=0,size=UInt32(MemoryLayout<Double>.size)
        guard AudioObjectGetPropertyData(device,&property,0,nil,&size,&value)==noErr,value.isFinite else{return 0}
        return value
    }
    static func current()->VoiceAudioRoute {
        func device(_ selector:AudioObjectPropertySelector)->AudioDeviceID {
            var address=AudioObjectPropertyAddress(mSelector:selector,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
            var value=AudioDeviceID(0),size=UInt32(MemoryLayout<AudioDeviceID>.size)
            guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),&address,0,nil,&size,&value)==noErr else{return 0}
            return value
        }
        return VoiceAudioRoute(input:device(kAudioHardwarePropertyDefaultInputDevice),output:device(kAudioHardwarePropertyDefaultOutputDevice))
    }
}

final class VoiceAudioPreparation: @unchecked Sendable {
    static let shared=VoiceAudioPreparation()
    typealias Pool=VoicePreparedResource<VoiceAudioInput,VoiceAudioRoute>
    let pool:Pool
    let microphones:VoiceMicrophoneSelection
    private let routeQueue=DispatchQueue(label:"local.nuphylab.voiceinput.route",qos:.userInitiated)
    private var listeners:[(AudioObjectPropertyAddress,AudioObjectPropertyListenerBlock)]=[]
    private var formatListeners:[(AudioObjectID,AudioObjectPropertyAddress,AudioObjectPropertyListenerBlock)]=[]
    private init() {
        let selection=VoiceMicrophoneSelection();selection.refresh();microphones=selection
        pool=Pool(currentRoute:{selection.route()},
                  mayPrepare:{AVCaptureDevice.authorizationStatus(for:.audio) == .authorized},
                  make:{route in try VoiceAudioInput.prepare(device:route.input)},dispose:{$0.stop()})
        for selector in [kAudioHardwarePropertyDefaultInputDevice,kAudioHardwarePropertyDevices] {
            var address=AudioObjectPropertyAddress(mSelector:selector,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
            let block:AudioObjectPropertyListenerBlock = {[weak self] _,_ in
                self?.microphones.refresh();self?.refreshFormatListeners();self?.pool.invalidate(onlyIfRouteChanged:true)
            }
            if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject),&address,routeQueue,block)==noErr {listeners.append((address,block))}
        }
        routeQueue.async {[weak self] in self?.refreshFormatListeners()}
    }
    // Input-only capture has no dependency on the default output device.
    private func refreshFormatListeners() {
        for (id,var address,block) in formatListeners {AudioObjectRemovePropertyListenerBlock(id,&address,routeQueue,block)}
        formatListeners.removeAll()
        let route=microphones.route()
        for id in [route.input].filter({$0 != 0}) {
            var address=AudioObjectPropertyAddress(mSelector:kAudioDevicePropertyNominalSampleRate,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
            let block:AudioObjectPropertyListenerBlock = {[weak self] _,_ in self?.pool.invalidate(onlyIfRouteChanged:true)}
            if AudioObjectAddPropertyListenerBlock(id,&address,routeQueue,block)==noErr {formatListeners.append((id,address,block))}
        }
    }
    func select(_ uid:String) {
        microphones.set(uid)
        routeQueue.async {[weak self] in self?.refreshFormatListeners();self?.pool.invalidate(onlyIfRouteChanged:true)}
    }
    func prewarm() {pool.prewarm()}
    func shutdown() {
        routeQueue.sync {
            for (var address,block) in listeners {AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject),&address,routeQueue,block)}
            listeners.removeAll()
            for (id,var address,block) in formatListeners {AudioObjectRemovePropertyListenerBlock(id,&address,routeQueue,block)}
            formatListeners.removeAll()
        }
        pool.shutdown()
    }
}

enum VoiceMicrophoneError:LocalizedError {
    case disconnected,unavailable
    var errorDescription:String? {
        switch self {
        case .disconnected:return "所选麦克风未连接，请连接设备或在语音输入页重新选择。"
        case .unavailable:return "无法使用所选麦克风，请检查设备或选择其他麦克风。"
        }
    }
}
