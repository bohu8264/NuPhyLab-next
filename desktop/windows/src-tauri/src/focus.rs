//! Explicit focus of a console created by this Lab instance. No input injection.
#[cfg(any(windows, test))]
use serde::{Deserialize, Serialize};

pub const PROBE_ARG: &str = "--lab-console-window-probe";
#[cfg(any(windows, test))]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskPlan {
    version: u32,
    source: String,
    id: String,
    request_id: String,
    pid: u32,
    created_ticks: String,
    executable: String,
    prepared_at: u64,
}
#[cfg(any(windows, test))]
impl TaskPlan {
    pub fn parse(
        value: serde_json::Value,
        source: &str,
        id: &str,
        request: &str,
        now: u64,
    ) -> Result<Self, String> {
        let plan: Self = serde_json::from_value(value).map_err(|_| "任务窗口准备回复无效")?;
        if plan.version != 1
            || source != "codex"
            || plan.source != source
            || plan.id != id
            || crate::resume::selection(&serde_json::json!({"source":source,"id":id})).is_err()
            || request.len() != 64
            || !request.bytes().all(|b| b.is_ascii_hexdigit())
            || plan.request_id != request
            || plan.pid == 0
            || plan.pid == u32::MAX
            || plan.created_ticks.len() != 16
            || !plan
                .created_ticks
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !u64::from_str_radix(&plan.created_ticks, 16).is_ok_and(|n| n > 116444736000000000)
            || !crate::resume::local_path(&plan.executable)
            || !matches!(
                plan.executable
                    .rsplit(['\\', '/'])
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str(),
                "codex.exe" | "codex-x86_64-pc-windows-msvc.exe"
            )
            || plan.prepared_at > now
            || now - plan.prepared_at > 1500
        {
            return Err("任务窗口准备已失效，请重新点击".into());
        }
        Ok(plan)
    }
}
pub fn probe_main() -> Option<i32> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.first().is_none_or(|arg| arg != PROBE_ARG) {
        return None;
    }
    if args.len() != 1 {
        return Some(1);
    }
    #[cfg(windows)]
    return Some(windows::probe_main());
    #[cfg(not(windows))]
    Some(1)
}

#[cfg(any(windows, test))]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u32,
    request_id: String,
    pid: u32,
    created: u64,
}
#[cfg(any(windows, test))]
impl Request {
    fn valid(&self) -> bool {
        self.version == 1
            && self.pid > 0
            && self.pid < u32::MAX
            && self.created > 0
            && self.request_id.len() == 64
            && self.request_id.bytes().all(|b| b.is_ascii_hexdigit())
    }
}
#[cfg(any(windows, test))]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    version: u32,
    request_id: String,
    pid: u32,
    created: u64,
    hwnd: u64,
    owner_pid: u32,
    owner_created: u64,
    observed_at: u64,
}
#[cfg(any(windows, test))]
impl Target {
    fn parse(value: serde_json::Value, request: &Request, now: u64) -> Result<Self, String> {
        let target: Self = serde_json::from_value(value).map_err(|_| "终端窗口查询回复无效")?;
        if !request.valid()
            || target.version != 1
            || target.request_id != request.request_id
            || target.pid != request.pid
            || target.created != request.created
            || target.hwnd == 0
            || target.hwnd > isize::MAX as u64
            || target.owner_pid == 0
            || target.owner_created == 0
            || target.observed_at > now
            || now - target.observed_at > 1500
        {
            return Err("终端窗口信息已变化，请重新点击".into());
        }
        Ok(target)
    }
}
#[cfg(any(windows, test))]
trait Desktop {
    fn permitted(&self, restored_target: Option<&Target>) -> bool;
    fn matches(&self, target: &Target) -> bool;
    fn restore(&self, target: &Target) -> bool;
    fn activate(&self, target: &Target) -> bool;
    fn is_foreground(&self, target: &Target) -> bool;
}
#[cfg(any(windows, test))]
fn activate(desktop: &impl Desktop, target: &Target) -> Result<(), String> {
    if !desktop.permitted(None) || !desktop.matches(target) {
        return Err("目标窗口或当前操作已变化，请重新点击".into());
    }
    if !desktop.restore(target) || !desktop.permitted(Some(target)) || !desktop.matches(target) {
        return Err("无法确认终端窗口，请用任务栏切换".into());
    }
    if !desktop.activate(target) || !desktop.is_foreground(target) || !desktop.matches(target) {
        return Err("Windows 未确认窗口已切换，请用任务栏切换".into());
    }
    Ok(())
}

#[cfg(windows)]
#[path = "focus/windows.rs"]
mod windows;
#[cfg(windows)]
pub use windows::{open_task, switch};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;
    fn request() -> Request {
        Request {
            version: 1,
            request_id: "a".repeat(64),
            pid: 42,
            created: 123,
        }
    }
    #[test]
    fn task_focus_plan_binds_codex_identity_and_forbids_window_or_input_arguments() {
        let id = "12345678-1234-1234-1234-123456789abc";
        let request = "a".repeat(64);
        let base = json!({"version":1,"source":"codex","id":id,"requestId":request,"pid":42,
            "createdTicks":"01dc000000000001","executable":"C:\\原生工具\\codex.exe","preparedAt":1000});
        assert!(TaskPlan::parse(base.clone(), "codex", id, &request, 2500).is_ok());
        for (field, value) in [
            ("source", json!("claude")),
            ("id", json!("foreign")),
            ("requestId", json!("b".repeat(64))),
            ("pid", json!(0)),
            ("pid", json!(u32::MAX)),
            ("createdTicks", json!("0000000000000001")),
            ("createdTicks", json!("01DC000000000001")),
            ("executable", json!("C:\\bin\\cmd.exe")),
            ("executable", json!("\\\\server\\share\\codex.exe")),
            ("hwnd", json!(101)),
            ("args", json!(["Enter"])),
            ("prompt", json!("approve")),
        ] {
            let mut v = base.clone();
            v[field] = value;
            assert!(
                TaskPlan::parse(v, "codex", id, &request, 1000).is_err(),
                "{field}"
            );
        }
        assert!(TaskPlan::parse(base.clone(), "claude", id, &request, 1000).is_err());
        assert!(TaskPlan::parse(base.clone(), "codex", id, &request, 999).is_err());
        assert!(TaskPlan::parse(base, "codex", id, &request, 2501).is_err());
    }
    fn target() -> serde_json::Value {
        json!({"version":1,"requestId":"a".repeat(64),"pid":42,"created":123,
            "hwnd":101,"ownerPid":43,"ownerCreated":124,"observedAt":1000})
    }
    #[test]
    fn window_proof_binds_this_owned_process_request_and_fresh_observation() {
        assert!(Target::parse(target(), &request(), 2500).is_ok());
        for (field, value) in [
            ("pid", json!(99)),
            ("created", json!(124)),
            ("requestId", json!("b".repeat(64))),
            ("ownerPid", json!(0)),
            ("ownerCreated", json!(0)),
            ("hwnd", json!(0)),
            ("hwnd", json!(u64::MAX)),
            ("version", json!(2)),
            ("prompt", json!("send this")),
        ] {
            let mut v = target();
            v[field] = value;
            assert!(Target::parse(v, &request(), 1000).is_err(), "{field}");
        }
        assert!(Target::parse(target(), &request(), 999).is_err());
        assert!(Target::parse(target(), &request(), 2501).is_err());
    }
    #[test]
    fn probe_request_never_accepts_window_handles_paths_or_commands() {
        for extra in ["hwnd", "executable", "args", "prompt"] {
            let mut v = serde_json::to_value(request()).unwrap();
            v[extra] = json!("foreign");
            assert!(serde_json::from_value::<Request>(v).is_err());
        }
        let mut r = request();
        r.pid = u32::MAX;
        assert!(!r.valid());
        r = request();
        r.request_id = "z".repeat(64);
        assert!(!r.valid());
    }
    struct Mock {
        permission: Cell<usize>,
        matching: Cell<usize>,
        restore_ok: bool,
        activation_ok: bool,
        foreground: bool,
        restored: Cell<u32>,
        activated: Cell<u32>,
    }
    impl Mock {
        fn new() -> Self {
            Self {
                permission: Cell::new(2),
                matching: Cell::new(3),
                restore_ok: true,
                activation_ok: true,
                foreground: true,
                restored: Cell::new(0),
                activated: Cell::new(0),
            }
        }
        fn next(value: &Cell<usize>) -> bool {
            let n = value.get();
            value.set(n.saturating_sub(1));
            n > 0
        }
    }
    impl Desktop for Mock {
        fn permitted(&self, _: Option<&Target>) -> bool {
            Self::next(&self.permission)
        }
        fn matches(&self, _: &Target) -> bool {
            Self::next(&self.matching)
        }
        fn restore(&self, _: &Target) -> bool {
            self.restored.set(self.restored.get() + 1);
            self.restore_ok
        }
        fn activate(&self, _: &Target) -> bool {
            self.activated.set(self.activated.get() + 1);
            self.activation_ok
        }
        fn is_foreground(&self, _: &Target) -> bool {
            self.foreground
        }
    }
    #[test]
    fn closing_lost_focus_dead_process_or_reused_window_cannot_activate() {
        let t = Target::parse(target(), &request(), 1000).unwrap();
        for remaining in [0, 1] {
            let m = Mock::new();
            m.permission.set(remaining);
            assert!(activate(&m, &t).is_err());
            assert_eq!(m.activated.get(), 0);
            let m = Mock::new();
            m.matching.set(remaining);
            assert!(activate(&m, &t).is_err());
            assert_eq!(m.activated.get(), 0);
        }
    }
    #[test]
    fn activation_requires_both_system_receipt_and_actual_foreground() {
        let t = Target::parse(target(), &request(), 1000).unwrap();
        let m = Mock::new();
        assert!(activate(&m, &t).is_ok());
        assert_eq!(m.activated.get(), 1);
        for (restore_ok, activation_ok, foreground) in [
            (false, true, true),
            (true, false, true),
            (true, true, false),
        ] {
            let m = Mock {
                restore_ok,
                activation_ok,
                foreground,
                ..Mock::new()
            };
            assert!(activate(&m, &t).is_err());
            assert_eq!(m.activated.get(), u32::from(restore_ok));
        }
    }
}
