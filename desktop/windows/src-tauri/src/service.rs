use rand::RngCore;
use serde_json::{json, Value};
use std::{
    io::{BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub struct Service {
    shutdown: Mutex<super::shutdown::Monitor>,
    shutdown_id: String,
    started: AtomicBool,
    child: Mutex<Option<Child>>,
    input: Mutex<Option<ChildStdin>>,
    port: Mutex<Option<u16>>,
    error: Mutex<Option<String>>,
    secret: String,
    token: String,
    pub closing: AtomicBool,
    pub closed: AtomicBool,
    client: reqwest::Client,
}

fn secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}
impl Service {
    pub fn new() -> Arc<Self> {
        let shutdown_id = secret();
        Arc::new(Self {
            shutdown: Mutex::new(super::shutdown::Monitor::new(shutdown_id.clone())),
            shutdown_id,
            started: AtomicBool::new(false),
            child: Mutex::new(None),
            input: Mutex::new(None),
            port: Mutex::new(None),
            error: Mutex::new(None),
            secret: secret(),
            token: secret(),
            closing: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(12))
                .build()
                .expect("local HTTP client"),
        })
    }
    pub fn status(&self) -> Value {
        let ready = self.port.lock().unwrap().is_some();
        let error = self.error.lock().unwrap().clone();
        json!({"host":"tauri","stage":"probe","ready":ready,"error":error})
    }
    fn control(&self, op: &str) -> Result<(), String> {
        let mut input = self.input.lock().unwrap();
        let pipe = input.as_mut().ok_or("后台控制通道已关闭")?;
        writeln!(
            pipe,
            "{}",
            if op == "shutdown" {
                json!({"op":op,"secret":self.secret,"shutdownId":self.shutdown_id})
            } else {
                json!({"op":op,"secret":self.secret})
            }
        )
        .and_then(|_| pipe.flush())
        .map_err(|_| "后台控制通道不可写".into())
    }
    fn failed(&self, message: &str) {
        *self.error.lock().unwrap() = Some(message.into());
        *self.port.lock().unwrap() = None;
    }
    pub fn start(
        self: &Arc<Self>,
        node: &Path,
        helper: &Path,
        resources: &Path,
        data: &Path,
    ) -> Result<(), String> {
        for file in [
            node.to_path_buf(),
            helper.to_path_buf(),
            resources.join("server/main.mjs"),
            resources.join("models.json"),
        ] {
            if !file.is_file() {
                return Err(format!(
                    "缺少应用文件：{}。请先准备 Windows 资源。",
                    file.display()
                ));
            }
        }
        let mut command = Command::new(node);
        command
            .arg(resources.join("server/main.mjs"))
            .current_dir(resources)
            .env("AIR_STUDIO_DATA", data)
            .env("AIR_STUDIO_PORT", "0")
            .env("AIR_STUDIO_TOKEN", &self.token)
            .env("AIR_STUDIO_HOST_SECRET", &self.secret)
            .env("AIR_STUDIO_DESKTOP_HOST", "tauri")
            .env("AIR_STUDIO_AGENT_RESUME", "1")
            .env("AIR_STUDIO_AGENT_TERMINAL_FOCUS", "1")
            .env("AIR_STUDIO_CODEX_TASK_FOCUS", "1")
            .env(
                "AIR_STUDIO_UPDATES_CONFIGURED",
                if super::release::config().configured() {
                    "1"
                } else {
                    "0"
                },
            )
            .env("AIR_STUDIO_PARENT_PID", std::process::id().to_string())
            .env("AIR_STUDIO_HID", helper)
            .env(
                "AIR_STUDIO_IO",
                helper.with_file_name(
                    helper
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .replace("nuphylab-hid", "nuphylab-desktop-io"),
                ),
            )
            .env(
                "AIR_STUDIO_SQLITE",
                helper.with_file_name(
                    helper
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .replace("nuphylab-hid", "nuphylab-sqlite"),
                ),
            )
            .env(
                "AIR_STUDIO_AGENT_PROBE",
                helper.with_file_name(
                    helper
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .replace("nuphylab-hid", "nuphylab-agent-probe"),
                ),
            )
            .env("AIR_STUDIO_HID_MODELS", resources.join("models.json"))
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("AIR_STUDIO_HID_ARGS")
            .env_remove("AIR_STUDIO_IO_ARGS")
            .env_remove("TAURI_SIGNING_PRIVATE_KEY")
            .env_remove("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| "无法启动应用后台服务")?;
        *self.input.lock().unwrap() = child.stdin.take();
        let stdout = child.stdout.take().ok_or("无法读取应用后台服务")?;
        let stderr = child.stderr.take().ok_or("无法读取应用后台诊断")?;
        *self.child.lock().unwrap() = Some(child);
        self.started.store(true, Ordering::SeqCst);
        let state = Arc::clone(self);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut announced_port = None;
            let mut hello = false;
            loop {
                match nuphylab_core::json_line(&mut reader) {
                    Ok(Some(value)) => {
                        state.shutdown.lock().unwrap().observe_output(&value);
                        if value["event"] == "hostShutdownComplete" {
                            continue;
                        }
                        if value["event"] == "hostHello" {
                            if value["protocolVersion"]
                                != super::shutdown::contract().protocol_version
                            {
                                state.shutdown.lock().unwrap().invalid_output();
                                state.failed("应用后台协议版本不匹配");
                                let _ = state.control("shutdown");
                                break;
                            }
                            hello = true;
                            if let Some(port) = announced_port {
                                *state.port.lock().unwrap() = Some(port);
                            }
                            continue;
                        }
                        if value["event"] == "ready" {
                            let port = value["port"].as_u64().filter(|n| *n > 0 && *n <= 65535);
                            if let Some(port) = port {
                                if value["url"] == format!("http://127.0.0.1:{port}") {
                                    announced_port = Some(port as u16);
                                    if hello {
                                        *state.port.lock().unwrap() = announced_port;
                                    }
                                    continue;
                                }
                            }
                            state.failed("应用后台返回了无效的本机地址");
                            break;
                        }
                    }
                    Ok(None) => {
                        state.shutdown.lock().unwrap().output_closed();
                        if !state.closing.load(Ordering::SeqCst) {
                            state.failed("应用后台已退出，请重新打开应用");
                        }
                        break;
                    }
                    Err(_) => {
                        state.shutdown.lock().unwrap().invalid_output();
                        state.failed("应用后台的启动消息无效");
                        break;
                    }
                }
            }
        });
        // Drain diagnostics without exposing account/session data to the page.
        thread::spawn(move || {
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
        });
        self.control("hello")?;
        let state = Arc::clone(self);
        thread::spawn(move || {
            let started = Instant::now();
            while !state.closing.load(Ordering::SeqCst) {
                if state.control("ping").is_err() {
                    state.failed("应用后台连接已中断");
                    break;
                }
                let ready = state.port.lock().unwrap().is_some();
                if started.elapsed() > Duration::from_secs(30) && !ready {
                    state.failed("应用后台启动超时，请重新打开应用");
                    let _ = state.control("shutdown");
                    break;
                }
                thread::sleep(Duration::from_millis(
                    super::shutdown::contract().heartbeat_timeout_ms / 8,
                ));
            }
        });
        Ok(())
    }
    pub async fn request(&self, route: String, body: Value) -> Result<Value, String> {
        super::routes::validate(&route, &body)?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("软件正在恢复键盘并退出".into());
        }
        let port = *self.port.lock().unwrap();
        let port = port.ok_or_else(|| {
            self.error
                .lock()
                .unwrap()
                .clone()
                .unwrap_or("应用后台尚未就绪，请稍候重试".into())
        })?;
        let url = format!("http://127.0.0.1:{port}{route}");
        let request = if body.is_null() {
            self.client.get(url)
        } else {
            self.client.post(url).json(&body)
        };
        let mut response = request
            .header("X-Air-Token", &self.token)
            .send()
            .await
            .map_err(|_| "无法连接应用后台，请重新打开应用")?;
        if response.status().is_redirection() {
            return Err("应用后台返回了意外跳转".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "无法读取应用后台回复")?
        {
            if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
                return Err("应用后台回复超过大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "应用后台回复格式无效".into())
    }
    pub fn stop(&self) -> Result<(), String> {
        self.closing.store(true, Ordering::SeqCst);
        self.shutdown.lock().unwrap().start();
        // Closing stdin is a second, independent lost-host signal to Node.
        let _ = self.control("shutdown");
        self.input.lock().unwrap().take();
        let deadline =
            Instant::now() + Duration::from_millis(super::shutdown::contract().shutdown_timeout_ms);
        loop {
            let mut child = self.child.lock().unwrap();
            if let Some(process) = child.as_mut() {
                if let Some(status) = process.try_wait().map_err(|_| "无法确认后台退出状态")?
                {
                    self.shutdown.lock().unwrap().exited(status.success());
                    child.take();
                    *self.port.lock().unwrap() = None;
                }
            } else if !self.started.load(Ordering::SeqCst) {
                self.closed.store(true, Ordering::SeqCst);
                return Ok(());
            }
            match self.shutdown.lock().unwrap().result() {
                Ok(true) => {
                    self.closed.store(true, Ordering::SeqCst);
                    return Ok(());
                }
                Err(error) => {
                    self.failed(&error);
                    return Err(error);
                }
                Ok(false) => {}
            }
            if Instant::now() > deadline {
                self.failed("后台退出超时，请检查键盘恢复状态");
                return Err("后台退出超时，请检查键盘恢复状态".into());
            }
            drop(child);
            thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    fn node() -> std::path::PathBuf {
        let result = Command::new("node")
            .args(["--eval", "process.stdout.write(process.execPath)"])
            .output()
            .unwrap();
        assert!(result.status.success());
        std::path::PathBuf::from(String::from_utf8(result.stdout).unwrap())
    }
    pub(crate) fn fixture(mode: &str) -> (tempfile::TempDir, Arc<Service>) {
        let directory = tempfile::Builder::new()
            .prefix("NuPhy 宿主退出 0 ")
            .tempdir()
            .unwrap();
        std::fs::create_dir(directory.path().join("server")).unwrap();
        let script=r#"
const {createInterface}=require('node:readline');
const input=createInterface({input:process.stdin});let ended=false;
const mode=MODE;
const timer=setTimeout(()=>process.exit(2),5000);
function done(r){if(ended)return;ended=true;clearTimeout(timer);
 if(mode==='missing'){process.exit(0);return;}
 const receipt={event:'hostShutdownComplete',protocolVersion:2,shutdownId:mode==='stale'?'foreign':r.shutdownId,
   success:mode!=='pending',keyboardVerified:mode!=='pending',recoveryPending:mode==='pending',noMutation:true};
 process.stdout.write(JSON.stringify(receipt)+'\n',()=>{
   if(mode==='trailing')process.stdout.write('not-json\n',()=>process.exit(0));
   else process.exit(mode==='nonzero'?1:0);
 });
}
input.on('line',line=>{const r=JSON.parse(line);if(r.secret!==process.env.AIR_STUDIO_HOST_SECRET)process.exit(3);
 if(r.op==='hello'){console.log(JSON.stringify({event:'hostHello',protocolVersion:2}));console.log(JSON.stringify({event:'ready',port:12345,url:'http://127.0.0.1:12345'}));}
 if(r.op==='shutdown')done(r);
});
"#.replace("MODE",&serde_json::to_string(mode).unwrap());
        std::fs::write(
            directory.path().join("server/main.mjs"),
            script.replace("require('node:readline')", "await import('node:readline')"),
        )
        .unwrap();
        let helper = directory.path().join("unused-helper");
        std::fs::write(&helper, []).unwrap();
        std::fs::write(directory.path().join("models.json"), b"[]").unwrap();
        let service = Service::new();
        service
            .start(&node(), &helper, directory.path(), directory.path())
            .unwrap();
        (directory, service)
    }
    #[test]
    fn real_host_waits_for_bound_node_receipt_and_drains_output_before_closing() {
        let (_directory, service) = fixture("valid");
        service.stop().unwrap();
        assert!(service.closed.load(Ordering::SeqCst));
        service.stop().unwrap();
    }
    #[test]
    fn real_host_refuses_zero_exit_without_receipt_foreign_receipts_and_failed_or_damaged_cleanup()
    {
        for mode in ["missing", "stale", "pending", "nonzero", "trailing"] {
            let (_directory, service) = fixture(mode);
            assert!(service.stop().is_err(), "{mode}");
            assert!(!service.closed.load(Ordering::SeqCst));
            assert!(service.stop().is_err(), "retry: {mode}");
            let remaining = service.child.lock().unwrap().take();
            if let Some(mut child) = remaining {
                let _ = child.wait();
            }
        }
    }
}
