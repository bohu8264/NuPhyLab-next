use super::*;
#[cfg(windows)]
mod platform {
    use super::*;
    use windows::{
        core::PCWSTR,
        Win32::{
            Media::{
                Audio::*, KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM,
                Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
            },
            System::Com::*,
        },
    };
    struct Apartment;
    impl Apartment {
        fn new() -> Result<Self> {
            unsafe {
                CoInitializeEx(None, COINIT_MULTITHREADED)
                    .ok()
                    .map_err(|_| failure("AUDIO_INIT", "声音服务初始化失败"))?;
            }
            Ok(Self)
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    fn check<T>(v: windows::core::Result<T>) -> Result<T> {
        v.map_err(|_| {
            failure(
                "AUDIO_DEVICE_UNAVAILABLE",
                "声音设备不可用，请检查设备或录音权限",
            )
        })
    }
    fn enumerator() -> Result<IMMDeviceEnumerator> {
        unsafe { check(CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)) }
    }
    fn id(device: &IMMDevice) -> Result<String> {
        unsafe {
            let p = check(device.GetId())?;
            let s = p
                .to_string()
                .map_err(|_| failure("AUDIO_DEVICE_INVALID", "声音设备标识无效"));
            CoTaskMemFree(Some(p.0.cast()));
            s
        }
    }
    pub fn inventory() -> Result<Value> {
        let _apartment = Apartment::new()?;
        let e = enumerator()?;
        let mut devices = vec![];
        unsafe {
            let list = check(e.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE))?;
            for n in 0..check(list.GetCount())?.min(100) {
                let d = check(list.Item(n))?;
                let identifier = id(&d)?;
                if identifier.len() > 256 {
                    continue;
                }
                let name = d
                    .OpenPropertyStore(STGM_READ)
                    .ok()
                    .and_then(|s| {
                        s.GetValue(
                            &windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
                        )
                        .ok()
                    })
                    .map(|v| v.to_string())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| format!("麦克风 {}", n + 1));
                devices.push(
                    json!({"id":identifier,"name":name.chars().take(256).collect::<String>()}),
                );
            }
        }
        Ok(
            json!({"systemSupported":unsafe{e.GetDefaultAudioEndpoint(eRender,eConsole).is_ok()},"devices":devices,"microphonePermission":false,"platform":"win32"}),
        )
    }
    pub fn capture(
        config: Value,
        stop: Arc<AtomicBool>,
        events: SyncSender<Value>,
        ready: SyncSender<Result<()>>,
    ) -> Result<()> {
        let _apartment = Apartment::new()?;
        let e = enumerator()?;
        let system = config["source"] == "system";
        let selected = config["deviceId"].as_str().unwrap_or("");
        let device = unsafe {
            if system || selected.is_empty() {
                check(e.GetDefaultAudioEndpoint(if system { eRender } else { eCapture }, eConsole))?
            } else {
                let wide: Vec<u16> = selected.encode_utf16().chain([0]).collect();
                check(e.GetDevice(PCWSTR(wide.as_ptr())))?
            }
        };
        let original_id = id(&device)?;
        let client: IAudioClient = unsafe { check(device.Activate(CLSCTX_ALL, None))? };
        let format = unsafe { check(client.GetMixFormat())? };
        struct Format(*mut WAVEFORMATEX);
        impl Drop for Format {
            fn drop(&mut self) {
                unsafe {
                    CoTaskMemFree(Some(self.0.cast()));
                }
            }
        }
        let _format = Format(format);
        let (rate, channels, bits, align, floating) = unsafe {
            let f = &*format;
            let rate = f.nSamplesPerSec;
            let channel_count = f.nChannels;
            let kind = if f.wFormatTag == 0xfffe && f.cbSize >= 22 {
                (*(format.cast::<WAVEFORMATEXTENSIBLE>())).SubFormat
            } else if f.wFormatTag == 3 {
                KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
            } else if f.wFormatTag == 1 {
                KSDATAFORMAT_SUBTYPE_PCM
            } else {
                return Err(failure("AUDIO_FORMAT_UNSUPPORTED", "当前声音格式暂不支持"));
            };
            let floating = kind == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
            if kind != KSDATAFORMAT_SUBTYPE_PCM && !floating
                || !(8000..=192000).contains(&rate)
                || !(1..=8).contains(&channel_count)
                || !matches!(
                    (f.wBitsPerSample, floating),
                    (16 | 24 | 32, false) | (32 | 64, true)
                )
                || f.nBlockAlign != f.nChannels * (f.wBitsPerSample / 8)
            {
                return Err(failure("AUDIO_FORMAT_UNSUPPORTED", "当前声音格式暂不支持"));
            }
            (
                f.nSamplesPerSec,
                f.nChannels as usize,
                f.wBitsPerSample,
                f.nBlockAlign as usize,
                floating,
            )
        };
        unsafe {
            check(client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                if system {
                    AUDCLNT_STREAMFLAGS_LOOPBACK
                } else {
                    0
                },
                1000000,
                0,
                format,
                None,
            ))?;
        }
        let capture: IAudioCaptureClient = unsafe { check(client.GetService())? };
        unsafe {
            check(client.Start())?;
        }
        struct Running(IAudioClient);
        impl Drop for Running {
            fn drop(&mut self) {
                unsafe {
                    let _ = self.0.Stop();
                }
            }
        }
        let _running = Running(client);
        let _ = ready.send(Ok(()));
        let session = config["session"].clone();
        let mut analyzer = dsp::Analyzer::default();
        let mut emitted = Instant::now() - Duration::from_secs(1);
        let mut checked = Instant::now();
        let mut last_data = Instant::now();
        while !stop.load(Ordering::Acquire) {
            unsafe {
                while !stop.load(Ordering::Acquire) && check(capture.GetNextPacketSize())? > 0 {
                    let (mut pointer, mut frames, mut flags) = (std::ptr::null_mut(), 0, 0);
                    check(capture.GetBuffer(&mut pointer, &mut frames, &mut flags, None, None))?;
                    if frames > 0 {
                        last_data = Instant::now();
                    }
                    struct Buffer<'a>(&'a IAudioCaptureClient, u32);
                    impl Drop for Buffer<'_> {
                        fn drop(&mut self) {
                            unsafe {
                                let _ = self.0.ReleaseBuffer(self.1);
                            }
                        }
                    }
                    let _buffer = Buffer(&capture, frames);
                    if frames > rate * 2 {
                        return Err(failure("AUDIO_FORMAT_UNSUPPORTED", "声音缓冲区长度异常"));
                    }
                    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                    if pointer.is_null() && !silent {
                        return Err(failure("AUDIO_BUFFER_INVALID", "声音缓冲区无效"));
                    }
                    for frame in 0..frames as usize {
                        let mut sample = 0.0;
                        if !silent {
                            let bytes =
                                std::slice::from_raw_parts(pointer.add(frame * align), align);
                            for ch in 0..channels {
                                sample +=
                                    dsp::pcm(&bytes[ch * (bits as usize / 8)..], bits, floating)
                                        .unwrap_or(0.0);
                            }
                        }
                        analyzer.push(sample / channels as f64);
                    }
                }
            }
            if emitted.elapsed() >= Duration::from_millis(45) {
                let (rms, bands) = if last_data.elapsed() > Duration::from_millis(200) {
                    (0.0, [0.0; 8])
                } else {
                    analyzer.features(rate).unwrap_or((0.0, [0.0; 8]))
                };
                let _=events.try_send(json!({"event":"audioFeature","session":session,"status":"listening","rms":rms,"bands":bands}));
                emitted = Instant::now();
            }
            if checked.elapsed() >= Duration::from_secs(1) {
                if system || selected.is_empty() {
                    let current = unsafe {
                        check(e.GetDefaultAudioEndpoint(
                            if system { eRender } else { eCapture },
                            eConsole,
                        ))?
                    };
                    if id(&current)? != original_id {
                        return Err(failure(
                            "AUDIO_DEVICE_CHANGED",
                            "默认声音设备已改变，请重新开始",
                        ));
                    }
                }
                checked = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
}
#[cfg(windows)]
pub use platform::{capture, inventory};
#[cfg(not(windows))]
pub fn inventory() -> Result<Value> {
    Err(failure("WINDOWS_REQUIRED", "声音采集仅在 Windows 可用"))
}
#[cfg(not(windows))]
pub fn capture(
    _: Value,
    _: Arc<AtomicBool>,
    _: SyncSender<Value>,
    _: SyncSender<Result<()>>,
) -> Result<()> {
    Err(failure("WINDOWS_REQUIRED", "声音采集仅在 Windows 可用"))
}
