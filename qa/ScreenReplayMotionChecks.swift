import VideoToolbox
import Darwin
// Accelerated 1080p noise alternates across a two-minute synthetic timeline.
// Exercise the encoder with more visual change than typical screen content.
@main enum ScreenReplayMotionChecks {
  static func main() throws {
    let w=1920,h=1080
    let encoder=try ReplayEncoder(width:w,height:h)
    var seed:UInt32=71931
    let cards:[CVPixelBuffer]=try (0..<6).map { _ in
      var pixel:CVPixelBuffer?
      let rc=CVPixelBufferCreate(nil,w,h,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,[kCVPixelBufferIOSurfacePropertiesKey:[:]] as CFDictionary,&pixel)
      guard rc==0,let pixel else{throw ReplayError.unavailable}
      CVPixelBufferLockBaseAddress(pixel,[])
      let address=CVPixelBufferGetBaseAddressOfPlane(pixel,0)!.assumingMemoryBound(to:UInt32.self)
      let count=CVPixelBufferGetBytesPerRowOfPlane(pixel,0)*h/4
      for n in 0..<count {seed ^= seed << 13;seed ^= seed >> 17;seed ^= seed << 5;address[n]=seed}
      memset(CVPixelBufferGetBaseAddressOfPlane(pixel,1)!,128,CVPixelBufferGetBytesPerRowOfPlane(pixel,1)*CVPixelBufferGetHeightOfPlane(pixel,1))
      CVPixelBufferUnlockBaseAddress(pixel,[])
      return pixel
    }
    for i in 0...3600 {
      let time=CMTime(value:Int64(i),timescale:30)
      _ = encoder.encode(cards[i%cards.count],at:time)
      if i%2==0 {encoder.flush(through:time)}
      if i>0 && i%600==0 {
        let ring=try encoder.buffer.snapshot(at:time)
        let bytes=ring.samples.reduce(0){$0+$1.totalSampleSize}
        guard bytes <= ReplayBuffer.byteLimit, abs((ring.end-ring.start).seconds-15)<0.001 else {throw ReplayError.export}
        var used=rusage();getrusage(RUSAGE_SELF,&used)
        print(i/30,"seconds of synthetic content. Snapshot bytes",bytes,"process peak resident bytes",used.ru_maxrss)
      }
    }
    encoder.close()
  }
}
