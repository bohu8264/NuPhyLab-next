//! One-shot process evidence. Never starts, shuts down or injects into agents.
use nuphylab_core::{BridgeError, Result};
use serde_json::{json, Value};
fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}
fn ids(value: &Value) -> Result<Vec<String>> {
    let a: Vec<String> = serde_json::from_value(value.clone())
        .map_err(|_| error("AGENT_REQUEST_INVALID", "任务编号无效"))?;
    if a.len() > 100
        || a.iter().any(|s| {
            s.is_empty()
                || s.len() > 160
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
    {
        return Err(error("AGENT_REQUEST_INVALID", "任务编号无效"));
    }
    Ok(a)
}
fn target_ids(value: &Value) -> Result<Vec<String>> {
    let ids = ids(value)?;
    if ids.len() != 1
        || ids[0].len() != 36
        || !ids[0].bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
    {
        return Err(error(
            "AGENT_REQUEST_INVALID",
            "窗口查询需要一个完整任务编号",
        ));
    }
    Ok(ids)
}
#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        os::windows::ffi::OsStrExt,
        path::PathBuf,
        time::{Duration, Instant},
    };
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::*,
            System::{RestartManager::*, Threading::*},
        },
    };
    fn ticks(t: FILETIME) -> u64 {
        (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
    }
    fn millis(t: FILETIME) -> u64 {
        ticks(t).saturating_sub(116444736000000000) / 10000
    }
    fn name(image: &str) -> String {
        image.rsplit('\\').next().unwrap_or("").to_ascii_lowercase()
    }
    fn process(pid: u32) -> Result<Option<(FILETIME, String)>> {
        unsafe {
            let handle = match OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                pid,
            ) {
                Ok(h) => h,
                Err(e) => {
                    if e.code() == windows::core::HRESULT::from_win32(87) {
                        return Ok(None);
                    }
                    return Err(error("AGENT_PROCESS_UNAVAILABLE", "无法确认进程身份"));
                }
            };
            struct Handle(HANDLE);
            impl Drop for Handle {
                fn drop(&mut self) {
                    unsafe {
                        let _ = CloseHandle(self.0);
                    }
                }
            }
            let _handle = Handle(handle);
            match WaitForSingleObject(handle, 0) {
                WAIT_OBJECT_0 => return Ok(None),
                WAIT_TIMEOUT => {}
                _ => return Err(error("AGENT_PROCESS_UNAVAILABLE", "无法确认进程存活状态")),
            }
            let (mut created, mut exited, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
                .map_err(|_| error("AGENT_PROCESS_UNAVAILABLE", "无法确认进程启动时间"))?;
            let mut path = vec![0u16; 32768];
            let mut size = path.len() as u32;
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(path.as_mut_ptr()),
                &mut size,
            )
            .map_err(|_| error("AGENT_PROCESS_UNAVAILABLE", "无法确认程序身份"))?;
            match WaitForSingleObject(handle, 0) {
                WAIT_OBJECT_0 => Ok(None),
                WAIT_TIMEOUT => Ok(Some((
                    created,
                    String::from_utf16_lossy(&path[..size as usize]),
                ))),
                _ => Err(error("AGENT_PROCESS_UNAVAILABLE", "无法确认进程存活状态")),
            }
        }
    }
    pub fn starts(value: &Value) -> Result<Value> {
        let pids: Vec<u32> = serde_json::from_value(value.clone())
            .map_err(|_| error("AGENT_REQUEST_INVALID", "进程列表无效"))?;
        if pids.len() > 128 || pids.contains(&0) {
            return Err(error("AGENT_REQUEST_INVALID", "进程列表无效"));
        }
        let mut out = vec![];
        for pid in pids {
            if let Some((created, image)) = process(pid)? {
                out.push(json!({"pid":pid,"startedAt":millis(created),"executable":name(&image)}));
            }
        }
        Ok(json!({"processes":out}))
    }
    pub fn writers(value: &Value, targets: bool) -> Result<Value> {
        let ids = if targets {
            target_ids(value)?
        } else {
            ids(value)?
        };
        let root = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join(".codex")))
            .ok_or_else(|| error("AGENT_HOME_UNAVAILABLE", "无法定位 Codex 数据目录"))?;
        if !root.is_absolute() || root.to_string_lossy().starts_with("\\\\") {
            return Err(error(
                "AGENT_HOME_UNAVAILABLE",
                "任务状态仅支持本地 Codex 数据目录",
            ));
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut out = vec![];
        for id in ids {
            if Instant::now() > deadline {
                return Err(error("AGENT_QUERY_TIMEOUT", "进程证据查询超时"));
            }
            let file = root.join("thread-writer-locks").join(format!("{id}.lock"));
            if !file
                .try_exists()
                .map_err(|_| error("AGENT_LOCK_UNAVAILABLE", "无法检查任务锁"))?
            {
                continue;
            }
            unsafe {
                let mut session = 0;
                let mut key = [0u16; 33];
                RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr()))
                    .ok()
                    .map_err(|_| error("AGENT_WRITERS_UNAVAILABLE", "无法检查任务写入者"))?;
                struct Session(u32);
                impl Drop for Session {
                    fn drop(&mut self) {
                        unsafe {
                            let _ = RmEndSession(self.0);
                        }
                    }
                }
                let _session = Session(session);
                let wide: Vec<u16> = file.as_os_str().encode_wide().chain([0]).collect();
                RmRegisterResources(session, Some(&[PCWSTR(wide.as_ptr())]), None, None)
                    .ok()
                    .map_err(|_| error("AGENT_WRITERS_UNAVAILABLE", "无法检查任务写入者"))?;
                let (mut needed, mut count, mut reasons) = (0, 0, 0);
                let first = RmGetList(session, &mut needed, &mut count, None, &mut reasons);
                if first == ERROR_SUCCESS {
                    continue;
                }
                if first != ERROR_MORE_DATA || needed > 256 {
                    return Err(error("AGENT_WRITERS_UNAVAILABLE", "任务写入者结果无效"));
                }
                let mut rows = vec![RM_PROCESS_INFO::default(); needed as usize];
                count = needed;
                RmGetList(
                    session,
                    &mut needed,
                    &mut count,
                    Some(rows.as_mut_ptr()),
                    &mut reasons,
                )
                .ok()
                .map_err(|_| error("AGENT_WRITERS_UNAVAILABLE", "任务写入者在查询期间变化"))?;
                if count as usize > rows.len() {
                    return Err(error("AGENT_WRITERS_UNAVAILABLE", "任务写入者数量已变化"));
                }
                for row in &rows[..count as usize] {
                    if let Some((created, image)) = process(row.Process.dwProcessId)? {
                        if matches!(
                            name(&image).as_str(),
                            "codex.exe" | "codex-x86_64-pc-windows-msvc.exe"
                        ) && (if targets {
                            ticks(created) == ticks(row.Process.ProcessStartTime)
                        } else {
                            millis(created) == millis(row.Process.ProcessStartTime)
                        }) {
                            if targets {
                                out.push(json!({"id":id,"pid":row.Process.dwProcessId,
                                    "createdTicks":format!("{:016x}",ticks(created)),"startedAt":millis(created),"executable":image}));
                            } else {
                                out.push(json!({"id":id,"startedAt":millis(created)}));
                                break;
                            }
                        }
                    }
                }
            }
        }
        Ok(json!({"writers":out}))
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn identity_uses_kernel_liveness_including_exit_code_259() {
            if std::env::var("NUPHYLAB_AGENT_PROBE_LIVENESS_FIXTURE").as_deref() == Ok("exit259") {
                std::process::exit(259);
            }
            let own = process(unsafe { GetCurrentProcessId() }).unwrap().unwrap();
            assert!(ticks(own.0) > 116444736000000000);
            assert!(own.1.ends_with(".exe"));
            use std::os::windows::process::CommandExt;
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "platform::tests::identity_uses_kernel_liveness_including_exit_code_259",
                ])
                .env("NUPHYLAB_AGENT_PROBE_LIVENESS_FIXTURE", "exit259")
                .creation_flags(0x08000000)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            assert_eq!(child.wait().unwrap().code(), Some(259));
            assert!(process(child.id()).unwrap().is_none());
        }
    }
}
fn run() -> Result<Value> {
    if std::env::args().len() != 1 {
        return Err(error("AGENT_REQUEST_INVALID", "进程探针不接受命令行参数"));
    }
    let value = nuphylab_core::json_line(&mut std::io::stdin().lock())?
        .ok_or_else(|| error("AGENT_REQUEST_INVALID", "缺少进程查询"))?;
    let op = value["op"].as_str().unwrap_or("");
    let field = if op == "processStarts" {
        "pids"
    } else if matches!(op, "writers" | "writerTargets") {
        "ids"
    } else {
        return Err(error("AGENT_REQUEST_INVALID", "不支持的进程查询"));
    };
    if value
        .as_object()
        .is_none_or(|o| o.len() != 2 || o.keys().any(|k| k != "op" && k != field))
    {
        return Err(error("AGENT_REQUEST_INVALID", "进程查询不接受其他参数"));
    }
    if op == "writers" {
        let _ = ids(&value[field])?;
    } else if op == "writerTargets" {
        let _ = target_ids(&value[field])?;
    }
    #[cfg(windows)]
    {
        if matches!(op, "writers" | "writerTargets") {
            platform::writers(&value[field], op == "writerTargets")
        } else {
            platform::starts(&value[field])
        }
    }
    #[cfg(not(windows))]
    {
        Err(error("WINDOWS_REQUIRED", "进程探针仅在 Windows 可用"))
    }
}
fn main() {
    let result = run();
    let ok = result.is_ok();
    println!(
        "{}",
        match result {
            Ok(result) => json!({"protocolVersion":1,"ok":true,"result":result}),
            Err(error) => json!({"protocolVersion":1,"ok":false,"error":error}),
        }
    );
    if !ok {
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn writer_ids_are_names_never_paths_or_commands() {
        assert!(ids(&json!(["abc_123-def"])).is_ok());
        for v in [
            json!(["../x"]),
            json!(["C:\\x"]),
            json!(["x.lock"]),
            json!([""]),
            json!(["$(run)"]),
        ] {
            assert!(ids(&v).is_err());
        }
    }
    #[test]
    fn target_lookup_requires_exactly_one_uuid() {
        assert!(target_ids(&json!(["12345678-1234-1234-1234-123456789abc"])).is_ok());
        for v in [
            json!([]),
            json!(["task-0"]),
            json!(["../x"]),
            json!([
                "12345678-1234-1234-1234-123456789abc",
                "12345678-1234-1234-1234-123456789abc"
            ]),
        ] {
            assert!(target_ids(&v).is_err());
        }
    }
}
