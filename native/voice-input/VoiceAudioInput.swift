import AVFoundation
import AudioToolbox
import CoreAudio

// An input-only AUHAL, bound before initialization. Unlike rebinding the I/O
// unit owned by AVAudioEngine, this does not rebuild its private input/output
// aggregate or touch the system's default device. Preparation never starts I/O.
final class VoiceAudioInput: @unchecked Sendable {
    let deviceID:AudioDeviceID
    let format:AVAudioFormat
    private let unit:AudioUnit
    private let buffer:AVAudioPCMBuffer
    private let lock=NSLock()
    private var running=false
    private var sink:((AVAudioPCMBuffer)->Void)?
    private var failure:(()->Void)?
    private var failed=false
    private var initialized=false
    private let notifications=DispatchQueue(label:"local.nuphylab.voiceinput.hardware")
    private var listeners:[(AudioObjectPropertyAddress,AudioObjectPropertyListenerBlock)]=[]

    private init(unit:AudioUnit,device:AudioDeviceID,format:AVAudioFormat,buffer:AVAudioPCMBuffer) {
        self.unit=unit;deviceID=device;self.format=format;self.buffer=buffer
    }
    static func prepare(device:AudioDeviceID)throws->VoiceAudioInput {
        guard device != 0 else{throw VoiceMicrophoneError.disconnected}
        var description=AudioComponentDescription(componentType:kAudioUnitType_Output,componentSubType:kAudioUnitSubType_HALOutput,componentManufacturer:kAudioUnitManufacturer_Apple,componentFlags:0,componentFlagsMask:0)
        guard let component=AudioComponentFindNext(nil,&description) else{throw VoiceMicrophoneError.unavailable}
        var created:AudioUnit?
        try require(AudioComponentInstanceNew(component,&created))
        guard let unit=created else{throw VoiceMicrophoneError.unavailable}
        var transferred=false
        defer{if !transferred{AudioComponentInstanceDispose(unit)}}
        var enabled:UInt32=1,disabled:UInt32=0,selected=device
        try require(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_EnableIO,kAudioUnitScope_Input,1,&enabled,4))
        try require(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_EnableIO,kAudioUnitScope_Output,0,&disabled,4))
        try require(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,&selected,4))
        var hardware=AudioStreamBasicDescription(),size=UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try require(AudioUnitGetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Input,1,&hardware,&size))
        guard hardware.mSampleRate.isFinite,hardware.mSampleRate>0,(1...64).contains(hardware.mChannelsPerFrame),
              let format=AVAudioFormat(standardFormatWithSampleRate:hardware.mSampleRate,channels:hardware.mChannelsPerFrame) else{throw VoiceMicrophoneError.unavailable}
        var client=format.streamDescription.pointee
        try require(AudioUnitSetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Output,1,&client,size))
        // Preallocate the render buffer and bound every hardware callback.
        var maximum:UInt32=4096,maximumSize:UInt32=4
        try require(AudioUnitGetProperty(unit,kAudioUnitProperty_MaximumFramesPerSlice,kAudioUnitScope_Global,0,&maximum,&maximumSize))
        maximum=max(4096,maximum)
        guard maximum<=65536 else{throw VoiceMicrophoneError.unavailable}
        try require(AudioUnitSetProperty(unit,kAudioUnitProperty_MaximumFramesPerSlice,kAudioUnitScope_Global,0,&maximum,4))
        guard let buffer=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:maximum) else{throw VoiceMicrophoneError.unavailable}
        let input=VoiceAudioInput(unit:unit,device:device,format:format,buffer:buffer)
        transferred=true
        try input.initialize()
        return input
    }
    private static func require(_ status:OSStatus)throws {guard status==noErr else{throw VoiceMicrophoneError.unavailable}}
    private func initialize()throws {
        var callback=AURenderCallbackStruct(inputProc:{ref,flags,time,_,frames,_ in
            Unmanaged<VoiceAudioInput>.fromOpaque(ref).takeUnretainedValue().render(flags:flags,time:time,frames:frames)
        },inputProcRefCon:Unmanaged.passUnretained(self).toOpaque())
        try Self.require(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_SetInputCallback,kAudioUnitScope_Global,0,&callback,UInt32(MemoryLayout<AURenderCallbackStruct>.size)))
        try Self.require(AudioUnitInitialize(unit));initialized=true
        for selector in [kAudioDevicePropertyDeviceIsAlive,kAudioDevicePropertyNominalSampleRate] {
            var address=AudioObjectPropertyAddress(mSelector:selector,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain)
            let block:AudioObjectPropertyListenerBlock = {[weak self] _,_ in self?.reportFailure()}
            if AudioObjectAddPropertyListenerBlock(deviceID,&address,notifications,block)==noErr {listeners.append((address,block))}
        }
    }
    var isRunning:Bool {lock.lock();defer{lock.unlock()};return running}
    func start(sink:@escaping (AVAudioPCMBuffer)->Void,onError:@escaping ()->Void)throws {
        lock.lock();self.sink=sink;failure=onError;failed=false;running=true;lock.unlock()
        let status=AudioOutputUnitStart(unit)
        if status != noErr {stop();throw VoiceMicrophoneError.unavailable}
    }
    func stop() {
        // Disable delivery first, then wait for hardware callbacks to stop before
        // the caller drains its writer or returns this resource to the pool.
        lock.lock();running=false;sink=nil;failure=nil;lock.unlock()
        AudioOutputUnitStop(unit)
    }
    private func render(flags:UnsafeMutablePointer<AudioUnitRenderActionFlags>,time:UnsafePointer<AudioTimeStamp>,frames:UInt32)->OSStatus {
        guard frames>0,frames<=buffer.frameCapacity else{reportFailure();return kAudioUnitErr_TooManyFramesToProcess}
        buffer.frameLength=frames
        let status=AudioUnitRender(unit,flags,time,1,frames,buffer.mutableAudioBufferList)
        guard status==noErr else{reportFailure();return status}
        lock.lock();let deliver=running ? sink : nil;lock.unlock()
        deliver?(buffer)
        return noErr
    }
    private func reportFailure() {
        lock.lock();let callback=running && !failed ? failure : nil;if running{failed=true};lock.unlock()
        callback?()
    }
    deinit {
        stop()
        for (var address,block) in listeners{AudioObjectRemovePropertyListenerBlock(deviceID,&address,notifications,block)}
        if initialized{AudioUnitUninitialize(unit)}
        AudioComponentInstanceDispose(unit)
    }
}
