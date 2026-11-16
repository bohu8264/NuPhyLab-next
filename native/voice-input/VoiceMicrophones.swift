import Foundation
import CoreAudio

struct VoiceMicrophone: Equatable {
    let id: AudioDeviceID
    let uid: String
    let name: String
}

enum VoiceMicrophones {
    static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID {
        var address = AudioObjectPropertyAddress(mSelector:selector,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
        var value = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),&address,0,nil,&size,&value)==noErr else { return 0 }
        return value
    }
    static func inputs() -> [VoiceMicrophone] {
        var address = AudioObjectPropertyAddress(mSelector:kAudioHardwarePropertyDevices,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),&address,0,nil,&size)==noErr else { return [] }
        var ids = [AudioDeviceID](repeating:0,count:Int(size)/MemoryLayout<AudioDeviceID>.size)
        guard !ids.isEmpty,AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),&address,0,nil,&size,&ids)==noErr else { return [] }
        func string(_ id:AudioDeviceID,_ selector:AudioObjectPropertySelector) -> String? {
            var property = AudioObjectPropertyAddress(mSelector:selector,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
            var value: Unmanaged<CFString>?; var bytes = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(id,&property,0,nil,&bytes,&value)==noErr else { return nil }
            return value?.takeRetainedValue() as String?
        }
        return ids.compactMap { id in
            // AVAudioEngine creates process-private aggregate devices. They are
            // implementation details, not user-selectable input hardware.
            var compositionAddress=AudioObjectPropertyAddress(mSelector:kAudioAggregateDevicePropertyComposition,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
            if AudioObjectHasProperty(id,&compositionAddress) {
                var composition:Unmanaged<CFDictionary>?,compositionSize=UInt32(MemoryLayout<Unmanaged<CFDictionary>?>.size)
                if AudioObjectGetPropertyData(id,&compositionAddress,0,nil,&compositionSize,&composition)==noErr,
                   let dictionary=composition?.takeRetainedValue() as? [String:Any],
                   (dictionary[kAudioAggregateDeviceIsPrivateKey] as? NSNumber)?.boolValue == true {return nil}
            }
            var streams = AudioObjectPropertyAddress(mSelector:kAudioDevicePropertyStreams,mScope:kAudioDevicePropertyScopeInput,mElement:kAudioObjectPropertyElementMain)
            var bytes: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id,&streams,0,nil,&bytes)==noErr,bytes>0,
                  let uid=string(id,kAudioDevicePropertyDeviceUID),!uid.isEmpty,
                  let name=string(id,kAudioObjectPropertyName) else { return nil }
            return VoiceMicrophone(id:id,uid:uid,name:name)
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    // A disconnected fixed selection never silently resolves to another microphone.
    static func resolve(uid:String,inputs:[VoiceMicrophone],systemDefault:AudioDeviceID) -> AudioDeviceID {
        uid.isEmpty ? systemDefault : inputs.first(where:{$0.uid==uid})?.id ?? 0
    }
}

final class VoiceMicrophoneSelection: @unchecked Sendable {
    private let lock=NSLock()
    private var uid=""
    private var devices:[VoiceMicrophone]=[]
    func set(_ value:String) {lock.lock();uid=value;lock.unlock()}
    func refresh() {let found=VoiceMicrophones.inputs();lock.lock();devices=found;lock.unlock()}
    func route() -> VoiceAudioRoute {
        lock.lock();let selected=uid,inputs=devices;lock.unlock()
        let input=VoiceMicrophones.resolve(uid:selected,inputs:inputs,systemDefault:VoiceMicrophones.defaultDevice(kAudioHardwarePropertyDefaultInputDevice))
        return VoiceAudioRoute(input:input,output:0,selection:selected,inputRate:VoiceAudioRoute.sampleRate(input))
    }
    func contains(_ value:String) -> Bool {lock.lock();defer{lock.unlock()};return value.isEmpty || devices.contains(where:{$0.uid==value})}
    var state:[String:Any] {
        lock.lock();let inputs=devices,selected=uid;lock.unlock()
        let defaultID=VoiceMicrophones.defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
        return ["devices":inputs.map{["uid":$0.uid,"name":$0.name]},"defaultName":inputs.first(where:{$0.id==defaultID})?.name ?? "未检测到输入设备","selectedAvailable":selected.isEmpty ? defaultID != 0 : inputs.contains(where:{$0.uid==selected})]
    }
}
