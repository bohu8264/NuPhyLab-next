fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "service_request",
            "desktop_status",
            "audio_settings",
            "update_status",
            "update_check",
            "update_install",
            "open_official_driver",
        ]),
    ))
    .expect("Tauri configuration is invalid");
}
