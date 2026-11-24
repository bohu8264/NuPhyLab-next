//! User-mode suspend/resume notification. No device handle or global hook.
use super::*;
#[cfg(windows)]
pub fn watch(
    stop: Arc<AtomicBool>,
    reset: Arc<AtomicBool>,
    ready: SyncSender<Result<()>>,
) -> Result<()> {
    use std::cell::RefCell;
    use windows::{
        core::w,
        Win32::{
            Foundation::*,
            System::{LibraryLoader::GetModuleHandleW, Power::*},
            UI::WindowsAndMessaging::*,
        },
    };
    thread_local! {static RESET:RefCell<Option<Arc<AtomicBool>>>=const{RefCell::new(None)};}
    unsafe extern "system" fn procedure(
        window: HWND,
        message: u32,
        w: WPARAM,
        l: LPARAM,
    ) -> LRESULT {
        if message == WM_POWERBROADCAST
            && [
                PBT_APMSUSPEND,
                PBT_APMRESUMEAUTOMATIC,
                PBT_APMRESUMESUSPEND,
                PBT_APMRESUMECRITICAL,
            ]
            .contains(&(w.0 as u32))
        {
            RESET.with(|slot| {
                if let Some(flag) = slot.borrow().as_ref() {
                    flag.store(true, Ordering::Release);
                }
            });
        }
        DefWindowProcW(window, message, w, l)
    }
    unsafe {
        let instance = HINSTANCE(
            GetModuleHandleW(None)
                .map_err(|_| failure("POWER_INIT", "无法订阅系统休眠状态"))?
                .0,
        );
        let class = w!("NuPhyLabPowerObserver");
        RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            lpszClassName: class,
            ..Default::default()
        });
        let window = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("NuPhyLab Power"),
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
        .map_err(|_| failure("POWER_INIT", "无法订阅系统休眠状态"))?;
        struct Window(HWND);
        impl Drop for Window {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }
        let _window = Window(window);
        let registration =
            RegisterSuspendResumeNotification(HANDLE(window.0), DEVICE_NOTIFY_WINDOW_HANDLE)
                .map_err(|_| failure("POWER_INIT", "无法订阅系统休眠状态"))?;
        struct Registration(HPOWERNOTIFY);
        impl Drop for Registration {
            fn drop(&mut self) {
                unsafe {
                    let _ = UnregisterSuspendResumeNotification(self.0);
                }
            }
        }
        let _registration = Registration(registration);
        RESET.with(|slot| *slot.borrow_mut() = Some(reset));
        let _ = ready.send(Ok(()));
        while !stop.load(Ordering::Acquire) {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            thread::sleep(Duration::from_millis(5));
        }
        RESET.with(|slot| *slot.borrow_mut() = None);
    }
    Ok(())
}
