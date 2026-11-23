use base64::Engine;
use futures_util::future::{AbortHandle, Abortable};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
pub struct Updates {
    busy: AtomicBool,
    state: Mutex<Value>,
    pending: Mutex<Option<Update>>,
}
impl Updates {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            busy: AtomicBool::new(false),
            state: Mutex::new(
                json!({"available":super::release::config().configured(),"phase":"idle","latest":null,"error":null}),
            ),
            pending: Mutex::new(None),
        })
    }
    pub fn status(&self) -> Value {
        self.state.lock().unwrap().clone()
    }
    fn phase(&self, phase: &str) {
        self.state.lock().unwrap()["phase"] = phase.into();
    }
    fn failure(&self, message: &str) {
        let mut state = self.state.lock().unwrap();
        state["phase"] = "error".into();
        state["error"] = message.into();
        state["latest"] = Value::Null;
    }
    fn enter(&self) -> Result<Busy<'_>, String> {
        if !super::release::config().configured() {
            return Err("此构建尚未配置自动更新服务，请使用本地安装包".into());
        }
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("更新操作正在进行".into());
        }
        Ok(Busy(&self.busy))
    }
    pub async fn check(&self, app: tauri::AppHandle) -> Result<Value, String> {
        let result = self.check_inner(app).await;
        if let Err(error) = &result {
            if !self.busy.load(Ordering::SeqCst) {
                self.failure(error);
            }
        }
        result
    }
    async fn check_inner(&self, app: tauri::AppHandle) -> Result<Value, String> {
        let _busy = self.enter()?;
        self.phase("checking");
        self.pending.lock().unwrap().take();
        let config = super::release::config();
        let endpoints = config
            .endpoints
            .iter()
            .map(|s| update_http::Url::parse(s).map_err(|_| "更新地址无效".to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let hosts = config.allowed_download_hosts.clone();
        let updater = app
            .updater_builder()
            .pubkey(&config.pubkey)
            .endpoints(endpoints)
            .map_err(|_| "更新地址无效")?
            .timeout(Duration::from_secs(20))
            .configure_client(move |client| {
                let hosts = hosts.clone();
                client
                    .https_only(true)
                    .min_tls_version(update_http::tls::Version::TLS_1_2)
                    .timeout(Duration::from_secs(180))
                    .redirect(update_http::redirect::Policy::custom(move |attempt| {
                        let u = attempt.url();
                        if attempt.previous().len() < 5
                            && super::release::secure(u.as_str()).is_some()
                            && u.host_str()
                                .is_some_and(|h| hosts.iter().any(|allowed| allowed == h))
                        {
                            attempt.follow()
                        } else {
                            attempt.error("untrusted update redirect")
                        }
                    }))
            })
            .build()
            .map_err(|_| "无法初始化自动更新")?;
        match updater.check().await {
            Ok(update) => {
                if update
                    .as_ref()
                    .is_some_and(|u| !config.download_allowed(u.download_url.as_str()))
                {
                    self.failure("更新文件地址不在已配置的发布范围内");
                    return Err("更新文件地址不可信".into());
                }
                let mut state = self.state.lock().unwrap();
                state["phase"] = if update.is_some() {
                    "available"
                } else {
                    "upToDate"
                }
                .into();
                state["error"] = Value::Null;
                state["latest"]=update.as_ref().map(|u|json!({"version":u.version,"notes":u.body.as_deref().unwrap_or("").chars().take(12000).collect::<String>()})).unwrap_or(Value::Null);
                *self.pending.lock().unwrap() = update;
                Ok(state.clone())
            }
            Err(_) => {
                self.failure("暂时无法检查软件更新，请稍后重试");
                Err("暂时无法检查软件更新，请稍后重试".into())
            }
        }
    }
    pub async fn install(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        service: Arc<super::service::Service>,
        expected: String,
    ) -> Result<(), String> {
        let result = self
            .install_inner(app, Arc::clone(&service), expected)
            .await;
        if let Err(error) = &result {
            if !self.busy.load(Ordering::SeqCst) {
                self.failure(error);
                self.state.lock().unwrap()["restartRequired"] =
                    service.closed.load(Ordering::SeqCst).into();
            }
        }
        result
    }
    async fn install_inner(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        service: Arc<super::service::Service>,
        expected: String,
    ) -> Result<(), String> {
        let _busy = self.enter()?;
        if expected.len() > 100 {
            return Err("更新版本无效".into());
        }
        let update = self
            .pending
            .lock()
            .unwrap()
            .take()
            .filter(|u| u.version == expected)
            .ok_or("版本已变化，请重新检查更新")?;
        self.phase("downloading");
        let (abort, registration) = AbortHandle::new_pair();
        let progress = Arc::clone(self);
        let mut received = 0u64;
        let bytes = match Abortable::new(
            update.download(
                move |count, total| {
                    received = received.saturating_add(count as u64);
                    if received > MAX_DOWNLOAD || total.is_some_and(|t| t > MAX_DOWNLOAD) {
                        abort.abort();
                    }
                    progress.state.lock().unwrap()["progress"] =
                        json!({"received":received,"total":total});
                },
                || {},
            ),
            registration,
        )
        .await
        {
            Ok(Ok(bytes)) => bytes,
            _ => {
                self.failure("下载或更新签名核对失败，未开始安装");
                return Err("下载或更新签名核对失败，未开始安装".into());
            }
        };
        if bytes.len() as u64 > MAX_DOWNLOAD || !bytes.starts_with(b"MZ") {
            self.failure("更新文件格式无效");
            return Err("更新文件格式无效".into());
        }
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|_| "无法定位更新暂存目录")?;
        std::fs::create_dir_all(&cache).map_err(|_| "无法创建更新暂存目录")?;
        let directory = tempfile::Builder::new()
            .prefix("verified-update-")
            .tempdir_in(cache)
            .map_err(|_| "无法暂存更新文件")?;
        let file = directory.path().join("NuPhyLab-update.exe");
        {
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&file)
                .map_err(|_| "无法写入更新文件")?;
            out.write_all(&bytes)
                .and_then(|_| out.sync_all())
                .map_err(|_| "更新文件写入未完成")?;
        }
        self.phase("verifying");
        let artifact = file.clone();
        let signature = tauri::async_runtime::spawn_blocking(move || verify_publisher(&artifact))
            .await
            .map_err(|_| "更新发布者检查中断")?;
        if let Err(error) = signature {
            self.failure(&error);
            return Err(error);
        }
        // Bind the staged file back to the bytes verified by the updater.
        if !std::fs::read(&file)
            .map(|staged| Sha256::digest(staged) == Sha256::digest(&bytes))
            .unwrap_or(false)
        {
            self.failure("暂存的更新文件已变化，未开始安装");
            return Err("暂存的更新文件已变化，未开始安装".into());
        }
        if service.closing.swap(true, Ordering::SeqCst) {
            self.failure("应用正在退出，请重新打开后更新");
            return Err("应用正在退出，请重新打开后更新".into());
        }
        let _closing = Closing(&service.closing);
        self.phase("restoring");
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(
                "window.__AIR_EXITING__=true;window.dispatchEvent(new Event('nuphylab:shutdown'));",
            );
        }
        let path = file.clone();
        let closing_service = Arc::clone(&service);
        let installed = tauri::async_runtime::spawn_blocking(move || {
            with_stopped_service(&closing_service, || {
                if !cfg!(windows) {
                    return Err("此安装方式仅支持 Windows".into());
                }
                Command::new(path)
                    .args(["/UPDATE", "/P"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map(|_| ())
                    .map_err(|_| "安装程序未能启动，已保留作品和更新文件".into())
            })
        })
        .await
        .map_err(|_| "更新安装准备中断")?;
        match installed {
            Ok(()) => {
                let _kept = directory.keep();
                self.phase("installing");
                app.exit(0);
                Ok(())
            }
            Err(error) => {
                self.failure(&error);
                self.state.lock().unwrap()["restartRequired"] =
                    service.closed.load(Ordering::SeqCst).into();
                service.closing.store(false, Ordering::SeqCst);
                if let Some(window) = app.get_webview_window("main") {
                    let _=window.eval("window.__AIR_EXITING__=false;window.dispatchEvent(new Event('nuphylab:shutdown'));");
                }
                Err(error)
            }
        }
    }
}
struct Busy<'a>(&'a AtomicBool);
struct Closing<'a>(&'a AtomicBool);
impl Drop for Closing<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn with_stopped_service(
    service: &super::service::Service,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    service.stop()?;
    install()
}
fn verify_publisher(path: &std::path::Path) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("发布者检查仅支持 Windows".into());
    }
    let root = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录")?;
    let exe = std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let script="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath $env:NUPHYLAB_UPDATE_ARTIFACT;[ordered]@{valid=($s.Status -eq 'Valid');thumbprint=$s.SignerCertificate.Thumbprint;timestamped=($null -ne $s.TimeStamperCertificate)}|ConvertTo-Json -Compress";
    // UTF-16LE base64 without adding another general-purpose shell endpoint.
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut cmd = Command::new(exe);
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .env("NUPHYLAB_UPDATE_ARTIFACT", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().map_err(|_| "无法启动发布者检查")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("发布者检查中断".into());
            }
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("发布者检查超时，未开始安装".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    let mut bytes = vec![];
    child
        .stdout
        .take()
        .ok_or("发布者检查没有结果")?
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取发布者检查")?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "发布者检查结果无效")?;
    if !status.success()
        || value["valid"] != true
        || value["timestamped"] != true
        || !value["thumbprint"].as_str().is_some_and(|t| {
            super::release::config()
                .trusted_signer_thumbprints
                .iter()
                .any(|known| known.eq_ignore_ascii_case(t))
        })
    {
        return Err("更新文件未通过发布者与时间戳核对，未开始安装".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installing_never_runs_before_verified_service_cleanup() {
        for mode in [
            "valid", "missing", "stale", "pending", "nonzero", "trailing",
        ] {
            let (_directory, service) = super::super::service::tests::fixture(mode);
            let mut invoked = false;
            let result = with_stopped_service(&service, || {
                invoked = true;
                Ok(())
            });
            assert_eq!(invoked, mode == "valid", "{mode}");
            assert_eq!(result.is_ok(), mode == "valid", "{mode}");
        }
    }
}
