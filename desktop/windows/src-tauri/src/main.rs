#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod focus;
mod installation;
mod official_driver;
mod release;
mod resume;
mod routes;
mod service;
mod shutdown;
mod tray;
mod updates;
use serde_json::Value;
use std::sync::{atomic::Ordering, Arc};
use tauri::Manager;

#[tauri::command]
async fn service_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<service::Service>>,
    launcher: tauri::State<'_, resume::Launcher>,
    route: String,
    body: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("不支持的窗口".into());
    }
    if route == "/api/command"
        && body["op"] == "windowsAgentAction"
        && matches!(body["action"].as_str(), Some("focusTerminal" | "focusTask"))
    {
        routes::validate(&route, &body)?;
        let (source, id) = resume::selection(&body)?;
        let _guard = launcher.begin()?;
        if state.closing.load(Ordering::SeqCst) {
            return Err("软件正在退出".into());
        }
        #[cfg(windows)]
        {
            let process = if body["action"] == "focusTask" {
                if source != "codex" {
                    return Err("当前仅能核对原生 Codex 任务窗口".into());
                }
                use rand::RngCore;
                let mut bytes = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut bytes);
                let request = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
                let prepared=state.request(route,serde_json::json!({"op":"windowsPrepareTaskFocus","source":source,"id":id,"requestId":request})).await?;
                if prepared["ok"] != true {
                    return Ok(prepared);
                }
                let plan = focus::TaskPlan::parse(
                    prepared["result"].clone(),
                    &source,
                    &id,
                    &request,
                    resume::now()?,
                )?;
                focus::open_task(&plan)?
            } else {
                launcher.owned_process(&source, &id)?
            };
            let lab = window.hwnd().map_err(|_| "无法核对 Lab 窗口")?.0 as usize as u64;
            let service = Arc::clone(state.inner());
            let result = tauri::async_runtime::spawn_blocking(move || {
                focus::switch(process, lab, &service.closing)
            })
            .await
            .map_err(|_| "终端窗口查询未完成")??;
            return Ok(serde_json::json!({"ok":true,"result":result}));
        }
        #[cfg(not(windows))]
        {
            let _ = (source, id);
            return Err("终端切换仅用于 Windows".into());
        }
    }
    if route == "/api/command"
        && body["op"] == "windowsAgentAction"
        && body["action"] == "resumeTerminal"
    {
        routes::validate(&route, &body)?;
        let (source, id) = resume::selection(&body)?;
        let _guard = launcher.begin()?;
        if state.closing.load(Ordering::SeqCst) {
            return Err("软件正在退出".into());
        }
        if launcher.already_opened(&source, &id)? {
            return Ok(
                serde_json::json!({"ok":true,"result":{"processCreated":false,"alreadyOpened":true}}),
            );
        }
        use rand::RngCore;
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let request_id = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let prepared = state.request(route, serde_json::json!({"op":"windowsPrepareResume","source":source,"id":id,"requestId":request_id})).await?;
        if prepared["ok"] != true {
            return Ok(prepared);
        }
        let plan = resume::Plan::parse(
            prepared["result"].clone(),
            &source,
            &id,
            &request_id,
            resume::now()?,
        )?;
        if state.closing.load(Ordering::SeqCst) {
            return Err("软件正在退出".into());
        }
        return Ok(serde_json::json!({"ok":true,"result":launcher.open(plan)?}));
    }
    state.request(route, body).await
}
#[tauri::command]
fn desktop_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<service::Service>>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("不支持的窗口".into());
    }
    Ok(state.status())
}
#[tauri::command]
fn audio_settings(window: tauri::WebviewWindow, permission: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("不支持的窗口".into());
    }
    let uri = match permission.as_str() {
        "microphone" => "ms-settings:privacy-microphone",
        "system" => "ms-settings:sound",
        _ => return Err("不支持的声音设置".into()),
    };
    if !cfg!(windows) {
        return Err("此设置仅适用于 Windows".into());
    }
    let windows = std::env::var_os("WINDIR").ok_or("无法定位 Windows 系统目录")?;
    std::process::Command::new(std::path::PathBuf::from(windows).join("explorer.exe"))
        .arg(uri)
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法打开 Windows 声音设置".into())
}
#[tauri::command]
fn update_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<updates::Updates>>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("不支持的窗口".into());
    }
    Ok(state.status())
}
#[tauri::command]
async fn open_official_driver(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<service::Service>>,
) -> Result<Value, String> {
    if window.label() != "main" || !cfg!(windows) {
        return Err("不支持的窗口或系统".into());
    }
    let prepared = state
        .request(
            "/api/command".into(),
            serde_json::json!({"op":"prepareFirmwareUpdate"}),
        )
        .await?;
    let url = official_driver::destination(&prepared)?;
    let windows = std::env::var_os("WINDIR").ok_or("无法定位 Windows 系统目录")?;
    std::process::Command::new(std::path::PathBuf::from(windows).join("explorer.exe"))
        .arg(&url)
        .spawn()
        .map_err(|_| "无法打开官方工具，请使用 Chrome 或 Edge 手动访问")?;
    Ok(serde_json::json!({"opened":true,"url":url,"needsSupportedBrowser":true}))
}
#[tauri::command]
async fn update_check(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<updates::Updates>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("不支持的窗口".into());
    }
    state.check(app).await
}
#[tauri::command]
async fn update_install(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<updates::Updates>>,
    service: tauri::State<'_, Arc<service::Service>>,
    app: tauri::AppHandle,
    version: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("不支持的窗口".into());
    }
    state
        .inner()
        .install(app, Arc::clone(service.inner()), version)
        .await
}
fn main() {
    if let Some(code) = focus::probe_main() {
        std::process::exit(code);
    }
    let service = service::Service::new();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app,_,_|{if let Some(window)=app.get_webview_window("main"){let _=window.unminimize();let _=window.show();let _=window.set_focus();}}))
        .manage(service)
        .manage(resume::Launcher::default())
        .manage(updates::Updates::new())
        .invoke_handler(tauri::generate_handler![service_request,desktop_status,audio_settings,update_status,update_check,update_install,open_official_driver])
        .setup(|app|{
            if !cfg!(windows){return Err("此宿主仅用于 Windows 预览版".into());}
            installation::ensure_not_installing().map_err(std::io::Error::other)?;
            if release::config().configured(){app.handle().plugin(tauri_plugin_updater::Builder::new().pubkey(&release::config().pubkey).build())?;}
            let resource=app.path().resource_dir()?.join("runtime");
            let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let target="x86_64-pc-windows-msvc";
            let (resources,node,helper)=if cfg!(debug_assertions){
                (root.join("../resources"),root.join(format!("binaries/nuphylab-node-{target}.exe")),root.join(format!("binaries/nuphylab-hid-{target}.exe")))
            }else{
                let bin=std::env::current_exe()?.parent().ok_or("无效的安装目录")?.to_path_buf();
                (resource,bin.join("nuphylab-node.exe"),bin.join("nuphylab-hid.exe"))
            };
            let local=std::env::var_os("LOCALAPPDATA").ok_or("无法确定本机应用数据目录")?;
            let data=std::path::PathBuf::from(local).join("NuPhyLab");
            app.state::<Arc<service::Service>>().start(&node,&helper,&resources,&data)?;
            tauri::WebviewWindowBuilder::from_config(app,&app.config().app.windows[0])?
                .on_navigation(|url|url.scheme()=="tauri"&&url.host_str()==Some("localhost")||matches!(url.scheme(),"http"|"https")&&url.host_str()==Some("tauri.localhost"))
                .build()?;
            tray::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(|window,event|{
            if let tauri::WindowEvent::CloseRequested{api,..}=event {
                let state=Arc::clone(window.state::<Arc<service::Service>>().inner());
                if state.closed.load(Ordering::SeqCst){return;}
                api.prevent_close();
                if state.closing.swap(true,Ordering::SeqCst){return;}
                if let Some(web)=window.app_handle().get_webview_window("main"){
                    let _=web.eval("window.__AIR_EXITING__=true;window.dispatchEvent(new Event('nuphylab:shutdown'));");
                }
                let app=window.app_handle().clone();
                std::thread::spawn(move||{match state.stop(){
                    Ok(())=>app.exit(0),
                    Err(_)=>{state.closing.store(false,Ordering::SeqCst);if let Some(web)=app.get_webview_window("main"){let _=web.eval("window.__AIR_EXITING__=false;window.dispatchEvent(new Event('nuphylab:shutdown'));");}}
                }});
            }
        })
        .run(tauri::generate_context!()).expect("无法运行 NuPhy Lab Windows 预览版");
}
