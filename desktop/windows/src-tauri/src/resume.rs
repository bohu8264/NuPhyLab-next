//! Explicit interactive resume only. Never sends a prompt or a keystroke.
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
pub fn selection(body: &Value) -> Result<(String, String), String> {
    let source = body["source"].as_str().unwrap_or("");
    let id = body["id"].as_str().unwrap_or("");
    if !matches!(source, "codex" | "claude") || !uuid(id) {
        return Err("请选择具有完整会话编号的本机任务".into());
    }
    Ok((source.into(), id.into()))
}
pub(crate) fn local_path(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() > 2
        && b.len() <= 16384
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && matches!(b[2], b'\\' | b'/')
        && !value.chars().any(char::is_control)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    version: u32,
    source: String,
    id: String,
    request_id: String,
    executable: String,
    cwd: String,
    prepared_at: u64,
}
impl Plan {
    pub fn parse(
        value: Value,
        source: &str,
        id: &str,
        request: &str,
        now: u64,
    ) -> Result<Self, String> {
        let p: Self = serde_json::from_value(value).map_err(|_| "会话恢复准备回复无效")?;
        if p.version != 1
            || p.source != source
            || p.id != id
            || !uuid(&p.id)
            || !matches!(p.source.as_str(), "codex" | "claude")
            || p.request_id != request
            || request.len() != 64
            || !request.bytes().all(|b| b.is_ascii_hexdigit())
            || p.prepared_at > now
            || now - p.prepared_at > 5000
            || !local_path(&p.cwd)
            || !local_path(&p.executable)
            || !p.executable.to_ascii_lowercase().ends_with(".exe")
        {
            return Err("会话恢复准备已失效，请重新点击".into());
        }
        Ok(p)
    }
}
pub fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .map_err(|_| "系统时间不可用".into())
}
#[cfg(any(windows, test))]
fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
        } else {
            out.extend(std::iter::repeat_n(
                '\\',
                if c == '"' { 2 * slashes + 1 } else { slashes },
            ));
            slashes = 0;
            out.push(c);
        }
    }
    out.extend(std::iter::repeat_n('\\', 2 * slashes));
    out.push('"');
    out
}
#[derive(Default)]
pub struct Launcher {
    busy: AtomicBool,
    #[cfg(windows)]
    processes: std::sync::Mutex<
        std::collections::BTreeMap<(String, String), std::os::windows::io::OwnedHandle>,
    >,
}
pub struct Guard<'a>(&'a AtomicBool);
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl Launcher {
    #[cfg(windows)]
    pub fn owned_process(
        &self,
        source: &str,
        id: &str,
    ) -> Result<std::os::windows::io::OwnedHandle, String> {
        if !self.already_opened(source, id)? {
            return Err("本次 Lab 没有持有这个会话的终端，请先打开或用任务栏切换".into());
        }
        let processes = self.processes.lock().map_err(|_| "会话启动状态不可用")?;
        processes
            .get(&(source.into(), id.into()))
            .ok_or("会话终端已退出")?
            .try_clone()
            .map_err(|_| "无法核对会话进程".into())
    }
    pub fn begin(&self) -> Result<Guard<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "会话恢复正在准备，请稍候")?;
        Ok(Guard(&self.busy))
    }
    pub fn already_opened(&self, source: &str, id: &str) -> Result<bool, String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{
                Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::WaitForSingleObject,
            };
            let mut processes = self.processes.lock().map_err(|_| "会话启动状态不可用")?;
            let mut finished = vec![];
            for (key, process) in processes.iter() {
                match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
                    WAIT_OBJECT_0 => finished.push(key.clone()),
                    WAIT_TIMEOUT => {}
                    _ => return Err("无法确认已打开会话的进程状态".into()),
                }
            }
            for key in finished {
                processes.remove(&key);
            }
            Ok(processes.contains_key(&(source.into(), id.into())))
        }
        #[cfg(not(windows))]
        {
            let _ = (source, id);
            Err("终端会话恢复仅用于 Windows".into())
        }
    }
    pub fn open(&self, plan: Plan) -> Result<Value, String> {
        #[cfg(windows)]
        {
            let mut processes = self.processes.lock().map_err(|_| "会话启动状态不可用")?;
            if processes.len() >= 32
                || processes.contains_key(&(plan.source.clone(), plan.id.clone()))
            {
                return Err("请先处理已经打开的会话终端".into());
            }
            let process = platform::create(&plan)?;
            processes.insert((plan.source, plan.id), process);
            Ok(serde_json::json!({"processCreated":true,"alreadyOpened":false}))
        }
        #[cfg(not(windows))]
        {
            let _ = plan;
            Err("终端会话恢复仅用于 Windows".into())
        }
    }
}
#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        ffi::OsStr,
        os::windows::{
            ffi::OsStrExt,
            io::{FromRawHandle, OwnedHandle},
        },
    };
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            CreateProcessW, CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
            STARTUPINFOW,
        },
    };
    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain([0]).collect()
    }
    pub fn create(plan: &Plan) -> Result<OwnedHandle, String> {
        if !std::path::Path::new(&plan.executable).is_file()
            || !std::path::Path::new(&plan.cwd).is_dir()
        {
            return Err("命令行程序或项目目录已变化，请重新检查".into());
        }
        let executable = wide(&plan.executable);
        let cwd = wide(&plan.cwd);
        let command = format!(
            "{} {} {}",
            quote(&plan.executable),
            if plan.source == "codex" {
                "resume"
            } else {
                "--resume"
            },
            quote(&plan.id)
        );
        let mut command = wide(&command);
        let mut environment = std::env::vars_os()
            .filter(|(key, _)| {
                let key = key.to_string_lossy().to_ascii_uppercase();
                !key.starts_with("AIR_STUDIO_")
                    && !key.starts_with("NUPHYLAB_")
                    && !matches!(
                        key.as_str(),
                        "NODE_OPTIONS" | "NODE_PATH" | "ELECTRON_RUN_AS_NODE" | "TAURI_CONFIG"
                    )
            })
            .collect::<Vec<_>>();
        environment.sort_by_key(|(key, _)| key.to_string_lossy().to_ascii_uppercase());
        let mut block = Vec::new();
        for (key, value) in environment {
            block.extend(key.encode_wide());
            block.push(b'=' as u16);
            block.extend(value.encode_wide());
            block.push(0);
        }
        block.push(0);
        if block.len() == 1 {
            block.push(0);
        }
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..unsafe { std::mem::zeroed() }
        };
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // No inherited handles or redirected pipes: the new console owns its
        // input. Only fixed resume arguments, never a prompt or shell string.
        if unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
                block.as_ptr().cast(),
                cwd.as_ptr(),
                &startup,
                &mut process,
            )
        } == 0
        {
            return Err("无法打开会话终端，请使用复制恢复命令".into());
        }
        unsafe {
            CloseHandle(process.hThread);
            Ok(OwnedHandle::from_raw_handle(process.hProcess))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const ID: &str = "12345678-1234-1234-1234-123456789abc";
    fn plan() -> Value {
        json!({"version":1,"source":"codex","id":ID,"requestId":"a".repeat(64),
            "executable":"C:\\Program Files\\Codex\\codex.exe","cwd":"D:\\项目 0's $(); `","preparedAt":1000})
    }
    #[test]
    fn launch_plan_requires_this_source_session_request_and_fresh_time() {
        let request = "a".repeat(64);
        assert!(Plan::parse(plan(), "codex", ID, &request, 6000).is_ok());
        for (source, id, token, time) in [
            ("claude", ID, request.clone(), 1000),
            ("codex", "foreign", request.clone(), 1000),
            ("codex", ID, "b".repeat(64), 1000),
            ("codex", ID, request.clone(), 999),
            ("codex", ID, request.clone(), 6001),
        ] {
            assert!(Plan::parse(plan(), source, id, &token, time).is_err());
        }
    }
    #[test]
    fn frontend_cannot_supply_a_program_shell_prompt_or_unsafe_identifier() {
        let request = "a".repeat(64);
        for (field, value) in [
            ("executable", "C:\\codex.cmd"),
            ("executable", "\\\\server\\codex.exe"),
            ("cwd", "D:relative"),
            ("cwd", "D:\\bad\npath"),
            ("id", "--last"),
            ("args", "--yolo"),
            ("prompt", "send this"),
        ] {
            let mut p = plan();
            p[field] = json!(value);
            assert!(
                Plan::parse(p, "codex", ID, &request, 1000).is_err(),
                "{field}"
            );
        }
        assert!(selection(&json!({"source":"codex","id":ID})).is_ok());
        assert!(selection(&json!({"source":"shell","id":ID})).is_err());
    }
    #[test]
    fn windows_quoting_keeps_unicode_spaces_metacharacters_and_backslashes_literal() {
        let text = "D:\\项目 0's $(); `\\codex.exe";
        assert_eq!(quote(text), format!("\"{text}\""));
        assert_eq!(quote("end\\"), "\"end\\\\\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote(""), "\"\"");
    }
    #[test]
    fn concurrent_launches_are_coalesced_and_cancellation_releases_the_guard() {
        let launcher = Launcher::default();
        let guard = launcher.begin().unwrap();
        assert!(launcher.begin().is_err());
        drop(guard);
        assert!(launcher.begin().is_ok());
    }
}
