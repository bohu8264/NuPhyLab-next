//! Non-suppressing Raw Input, bound to the unique selected USB parent.
//! This is not a physical approval or key-injection authorization channel.
use super::*;
mod state;
pub use state::{MonitorSignal, ResetReason};
pub struct MonitorStatus {
    pub reset: Arc<MonitorSignal>,
    pub ready: SyncSender<Result<()>>,
}
pub fn code(scan: u16, flags: u16) -> Option<String> {
    if flags & 4 != 0 {
        return (scan == 0x45).then(|| "Pause".into());
    }
    if flags & 2 != 0 {
        return Some(
            match scan {
                0x1c => "NumpadEnter",
                0x1d => "ControlRight",
                0x35 => "NumpadDivide",
                0x37 => "PrintScreen",
                0x38 => "AltRight",
                0x47 => "Home",
                0x48 => "ArrowUp",
                0x49 => "PageUp",
                0x4b => "ArrowLeft",
                0x4d => "ArrowRight",
                0x4f => "End",
                0x50 => "ArrowDown",
                0x51 => "PageDown",
                0x52 => "Insert",
                0x53 => "Delete",
                0x5b => "MetaLeft",
                0x5c => "MetaRight",
                0x5d => "ContextMenu",
                _ => return None,
            }
            .into(),
        );
    }
    const TABLE:&str="Escape Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal Backspace Tab KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Enter ControlLeft KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote Backquote ShiftLeft Backslash KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash ShiftRight NumpadMultiply AltLeft Space CapsLock F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 NumLock ScrollLock Numpad7 Numpad8 Numpad9 NumpadSubtract Numpad4 Numpad5 Numpad6 NumpadAdd Numpad1 Numpad2 Numpad3 Numpad0 NumpadDecimal";
    match scan {
        0x57 => Some("F11".into()),
        0x58 => Some("F12".into()),
        1..=0x53 => TABLE
            .split_ascii_whitespace()
            .nth(scan as usize - 1)
            .map(String::from),
        _ => None,
    }
}
pub fn valid_code(v: &str) -> bool {
    (0..=0x5d).any(|s| [0, 2, 4].iter().any(|f| code(s, *f).as_deref() == Some(v)))
}
#[cfg(windows)]
mod platform {
    use super::*;
    use nuphylab_hid::input_binding::InputBinding;
    use std::{cell::RefCell, collections::HashMap, mem::size_of};
    use windows::{
        core::w,
        Win32::{
            Foundation::*,
            System::LibraryLoader::GetModuleHandleW,
            UI::{Input::*, WindowsAndMessaging::*},
        },
    };
    struct Context {
        keys: state::KeyState,
        events: SyncSender<Value>,
        binding: InputBinding,
        devices: HashMap<usize, bool>,
    }
    thread_local! {static CONTEXT:RefCell<Option<Context>>=const{RefCell::new(None)};}
    unsafe fn selected(device: HANDLE, binding: &InputBinding) -> bool {
        if device.is_invalid() {
            return false;
        }
        let mut size = 0;
        if GetRawInputDeviceInfoW(Some(device), RIDI_DEVICENAME, None, &mut size) == u32::MAX
            || size == 0
            || size > 4096
        {
            return false;
        }
        let mut name = vec![0u16; size as usize + 1];
        if GetRawInputDeviceInfoW(
            Some(device),
            RIDI_DEVICENAME,
            Some(name.as_mut_ptr().cast()),
            &mut size,
        ) == u32::MAX
        {
            return false;
        }
        let path = String::from_utf16_lossy(&name[..size as usize]);
        binding.accepts_interface(path.trim_end_matches('\0'))
    }
    unsafe extern "system" fn procedure(
        window: HWND,
        message: u32,
        w: WPARAM,
        l: LPARAM,
    ) -> LRESULT {
        if message == WM_INPUT {
            let mut raw = [0u64; 128];
            let mut bytes = std::mem::size_of_val(&raw) as u32;
            let n = GetRawInputData(
                HRAWINPUT(l.0 as *mut _),
                RID_INPUT,
                Some(raw.as_mut_ptr().cast()),
                &mut bytes,
                size_of::<RAWINPUTHEADER>() as u32,
            );
            if n != u32::MAX
                && n as usize >= size_of::<RAWINPUT>()
                && bytes as usize <= std::mem::size_of_val(&raw)
            {
                let event = &*(raw.as_ptr().cast::<RAWINPUT>());
                if event.header.dwType == RIM_TYPEKEYBOARD.0 {
                    let k = event.data.keyboard;
                    if k.VKey != 255 {
                        if let Some(key) = code(k.MakeCode, k.Flags) {
                            CONTEXT.with(|slot| {
                                if let Some(ctx) = slot.borrow_mut().as_mut() {
                                    if ctx.keys.signal.reason().is_some() {
                                        return;
                                    }
                                    let device = event.header.hDevice.0 as usize;
                                    if !ctx.devices.contains_key(&device) && ctx.devices.len() >= 64
                                    {
                                        ctx.keys.invalidate(ResetReason::SourceLimit);
                                        return;
                                    }
                                    let selected =
                                        *ctx.devices.entry(device).or_insert_with(|| {
                                            selected(event.header.hDevice, &ctx.binding)
                                        });
                                    if !selected {
                                        return;
                                    }
                                    ctx.keys.observe(device, key, k.Flags & 1 == 0, &ctx.events);
                                }
                            });
                        }
                    }
                }
            }
        } else if message == WM_INPUT_DEVICE_CHANGE {
            CONTEXT.with(|slot| {
                if let Some(ctx) = slot.borrow_mut().as_mut() {
                    ctx.keys.invalidate(ResetReason::DeviceChanged);
                    ctx.devices.clear();
                }
            });
        }
        DefWindowProcW(window, message, w, l)
    }
    pub fn monitor(
        models: Vec<nuphylab_core::Model>,
        model: nuphylab_core::Model,
        codes: Vec<String>,
        monitor_id: String,
        stop: Arc<AtomicBool>,
        events: SyncSender<Value>,
        status: MonitorStatus,
    ) -> Result<()> {
        let MonitorStatus {
            reset: signal,
            ready,
        } = status;
        let binding = InputBinding::qualify(&models, &model.id)?;
        unsafe {
            let module =
                GetModuleHandleW(None).map_err(|_| failure("INPUT_INIT", "无法初始化按键观察"))?;
            let instance = HINSTANCE(module.0);
            let class = w!("NuPhyLabRawInputObserver");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: instance,
                lpszClassName: class,
                ..Default::default()
            };
            RegisterClassW(&wc);
            let window = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                w!("NuPhyLab Input"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance),
                None,
            )
            .map_err(|_| failure("INPUT_INIT", "无法创建按键观察窗口"))?;
            struct Window(HWND);
            impl Drop for Window {
                fn drop(&mut self) {
                    unsafe {
                        let _ = RegisterRawInputDevices(
                            &[RAWINPUTDEVICE {
                                usUsagePage: 1,
                                usUsage: 6,
                                dwFlags: RIDEV_REMOVE,
                                hwndTarget: HWND::default(),
                            }],
                            size_of::<RAWINPUTDEVICE>() as u32,
                        );
                        let _ = DestroyWindow(self.0);
                    }
                }
            }
            let _window = Window(window);
            RegisterRawInputDevices(
                &[RAWINPUTDEVICE {
                    usUsagePage: 1,
                    usUsage: 6,
                    dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
                    hwndTarget: window,
                }],
                size_of::<RAWINPUTDEVICE>() as u32,
            )
            .map_err(|_| failure("INPUT_INIT", "无法开始按键观察"))?;
            CONTEXT.with(|s| {
                *s.borrow_mut() = Some(Context {
                    keys: state::KeyState::new(model.id, monitor_id, codes, signal.clone()),
                    events,
                    binding,
                    devices: HashMap::new(),
                })
            });
            let _ = ready.send(Ok(()));
            while !stop.load(Ordering::Acquire) && signal.reason().is_none() {
                let mut m = MSG::default();
                while PeekMessageW(&mut m, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&m);
                    DispatchMessageW(&m);
                }
                thread::sleep(Duration::from_millis(5));
            }
            CONTEXT.with(|s| *s.borrow_mut() = None);
        }
        Ok(())
    }
}
#[cfg(windows)]
pub use platform::monitor;
#[cfg(not(windows))]
pub fn monitor(
    _: Vec<nuphylab_core::Model>,
    _: nuphylab_core::Model,
    _: Vec<String>,
    _: String,
    _: Arc<AtomicBool>,
    _: SyncSender<Value>,
    status: MonitorStatus,
) -> Result<()> {
    let error = failure("WINDOWS_REQUIRED", "按键观察仅在 Windows 可用");
    status.reset.invalidate(ResetReason::WorkerFailed);
    let _ = status.ready.try_send(Err(error.clone()));
    Err(error)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scan_codes_preserve_zero_function_keys_and_left_right_modifiers() {
        for (s, f, expected) in [
            (11, 0, "Digit0"),
            (30, 0, "KeyA"),
            (0x48, 0, "Numpad8"),
            (0x48, 2, "ArrowUp"),
            (0x1d, 0, "ControlLeft"),
            (0x1d, 2, "ControlRight"),
            (0x45, 4, "Pause"),
            (0x58, 0, "F12"),
        ] {
            assert_eq!(code(s, f).as_deref(), Some(expected));
        }
        assert!(code(255, 0).is_none());
        assert!(valid_code("KeyA"));
        assert!(!valid_code("Command"));
    }
}
