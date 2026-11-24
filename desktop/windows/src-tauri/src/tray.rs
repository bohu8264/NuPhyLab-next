#[cfg(windows)]
pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        Manager,
    };
    let open = MenuItem::with_id(app, "open", "打开 NuPhy Lab", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出并恢复键盘", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("nuphylab")
        .tooltip("NuPhy Lab")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if let Some(window) = app.get_webview_window("main") {
                match event.id.as_ref() {
                    "open" => {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    "quit" => {
                        let _ = window.close();
                    }
                    _ => {}
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
#[cfg(not(windows))]
pub fn setup(_: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}
