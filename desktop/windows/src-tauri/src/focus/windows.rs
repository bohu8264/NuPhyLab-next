use super::*;
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    os::windows::{
        io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{FILETIME, HANDLE, HWND, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
    System::{Console::*, SystemInformation::GetSystemDirectoryW, Threading::*},
    UI::WindowsAndMessaging::*,
};

fn created(handle: HANDLE) -> Result<u64, String> {
    let (mut birth, mut exit, mut kernel, mut user) =
        unsafe { std::mem::zeroed::<(FILETIME, FILETIME, FILETIME, FILETIME)>() };
    if unsafe { GetProcessTimes(handle, &mut birth, &mut exit, &mut kernel, &mut user) } == 0
        || unsafe { WaitForSingleObject(handle, 0) } != WAIT_TIMEOUT
    {
        return Err("会话进程已退出或无法核对".into());
    }
    Ok((u64::from(birth.dwHighDateTime) << 32) | u64::from(birth.dwLowDateTime))
}
fn process(pid: u32) -> Result<OwnedHandle, String> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZATION_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return Err("无法核对终端进程".into());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}
fn system_console(handle: HANDLE) -> bool {
    let mut system = vec![0u16; 32768];
    let n = unsafe { GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) } as usize;
    if n == 0 || n >= system.len() {
        return false;
    }
    let expected = format!("{}\\conhost.exe", String::from_utf16_lossy(&system[..n]));
    image(handle).is_ok_and(|actual| actual.eq_ignore_ascii_case(&expected))
}
fn image(handle: HANDLE) -> Result<String, String> {
    let mut image = vec![0u16; 32768];
    let mut n = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, image.as_mut_ptr(), &mut n) }
        == 0
        || n == 0
        || n as usize > image.len()
    {
        return Err("无法核对任务程序位置".into());
    }
    Ok(String::from_utf16_lossy(&image[..n as usize]))
}
pub fn open_task(plan: &TaskPlan) -> Result<OwnedHandle, String> {
    let handle = process(plan.pid)?;
    if format!("{:016x}", created(handle.as_raw_handle())?) != plan.created_ticks
        || !image(handle.as_raw_handle())?.eq_ignore_ascii_case(&plan.executable)
    {
        return Err("任务进程身份已变化，请重新点击".into());
    }
    Ok(handle)
}
fn window_matches(target: &Target) -> bool {
    let hwnd = target.hwnd as usize as HWND;
    let mut owner = 0;
    let mut class = [0u16; 64];
    unsafe {
        if IsWindowVisible(hwnd) == 0
            || GetAncestor(hwnd, GA_ROOT) != hwnd
            || GetWindowThreadProcessId(hwnd, &mut owner) == 0
            || owner != target.owner_pid
        {
            return false;
        }
        let n = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        if n <= 0 || String::from_utf16_lossy(&class[..n as usize]) != "ConsoleWindowClass" {
            return false;
        }
    }
    let Ok(handle) = process(owner) else {
        return false;
    };
    created(handle.as_raw_handle()).ok() == Some(target.owner_created)
        && system_console(handle.as_raw_handle())
}

fn inspect(request: &Request) -> Result<Target, String> {
    if !request.valid() {
        return Err("终端查询参数无效".into());
    }
    let target = process(request.pid)?;
    if created(target.as_raw_handle())? != request.created {
        return Err("会话进程已变化".into());
    }
    // This happens only in a disposable child, never in the GUI/HID owner.
    if unsafe { AttachConsole(request.pid) } == 0 {
        return Err("此终端不能自动定位，请用任务栏切换".into());
    }
    struct Attachment;
    impl Drop for Attachment {
        fn drop(&mut self) {
            unsafe {
                FreeConsole();
            }
        }
    }
    let _attachment = Attachment;
    let mut members = [0u32; 256];
    let n = unsafe { GetConsoleProcessList(members.as_mut_ptr(), members.len() as u32) } as usize;
    if n == 0
        || n > members.len()
        || !members[..n].contains(&request.pid)
        || !members[..n].contains(&unsafe { GetCurrentProcessId() })
    {
        return Err("无法核对会话所属的终端".into());
    }
    let hwnd = unsafe { GetConsoleWindow() };
    let mut owner = 0;
    if hwnd.is_null() || unsafe { GetWindowThreadProcessId(hwnd, &mut owner) } == 0 {
        return Err("此终端没有可核对的独立窗口，请用任务栏切换".into());
    }
    let owner_handle = process(owner)?;
    let proof = Target {
        version: 1,
        request_id: request.request_id.clone(),
        pid: request.pid,
        created: request.created,
        hwnd: hwnd as usize as u64,
        owner_pid: owner,
        owner_created: created(owner_handle.as_raw_handle())?,
        observed_at: crate::resume::now()?,
    };
    if !window_matches(&proof) || created(target.as_raw_handle())? != request.created {
        return Err("此终端没有可核对的独立窗口，请用任务栏切换".into());
    }
    Ok(proof)
}

pub(super) fn probe_main() -> i32 {
    // Preserve only the inherited reply pipe before attaching to a console.
    let raw = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return 1;
    }
    let Ok(reply) = (unsafe { BorrowedHandle::borrow_raw(raw) }).try_clone_to_owned() else {
        return 1;
    };
    let mut output = File::from(reply);
    let result = (|| {
        let mut line = String::new();
        BufReader::new(std::io::stdin().take(4097))
            .read_line(&mut line)
            .map_err(|_| "无法读取终端查询")?;
        if line.len() > 4096 || !line.ends_with('\n') {
            return Err("终端查询格式无效".into());
        }
        let request: Request = serde_json::from_str(&line).map_err(|_| "终端查询参数无效")?;
        inspect(&request)
    })();
    let value = match result {
        Ok(target) => serde_json::json!({"ok":true,"result":target}),
        Err(reason) => serde_json::json!({"ok":false,"error":reason}),
    };
    if writeln!(output, "{value}")
        .and_then(|_| output.flush())
        .is_err()
    {
        return 1;
    }
    0
}

struct Probe(Child);
impl Drop for Probe {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn query(request: &Request, cancelled: &AtomicBool) -> Result<Target, String> {
    let executable = std::env::current_exe().map_err(|_| "无法定位应用自身")?;
    let mut command = Command::new(executable);
    command
        .arg(PROBE_ARG)
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = Probe(command.spawn().map_err(|_| "无法启动独立窗口查询")?);
    let mut input = child.0.stdin.take().ok_or("无法发送终端查询")?;
    writeln!(
        input,
        "{}",
        serde_json::to_string(request).map_err(|_| "终端查询参数无效")?
    )
    .map_err(|_| "无法发送终端查询")?;
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("软件正在退出".into());
        }
        if let Some(status) = child.0.try_wait().map_err(|_| "无法确认窗口查询状态")? {
            if !status.success() {
                return Err("无法完成窗口查询，请用任务栏切换".into());
            }
            break;
        }
        if Instant::now() >= deadline {
            return Err("终端窗口查询超时，请用任务栏切换".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut bytes = Vec::new();
    child
        .0
        .stdout
        .take()
        .ok_or("无法读取终端查询")?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取终端查询")?;
    if bytes.len() > 4096 {
        return Err("终端窗口查询回复无效".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "终端窗口查询回复无效")?;
    if value["ok"] != true {
        return Err("此终端不能自动定位，请用任务栏切换".into());
    }
    Target::parse(value["result"].clone(), request, crate::resume::now()?)
}
struct WindowsDesktop<'a> {
    process: OwnedHandle,
    lab: HWND,
    cancelled: &'a AtomicBool,
}
impl Desktop for WindowsDesktop<'_> {
    fn permitted(&self, restored_target: Option<&Target>) -> bool {
        let foreground = unsafe { GetForegroundWindow() };
        !self.cancelled.load(Ordering::SeqCst)
            && (foreground == self.lab
                || restored_target.is_some_and(|target| foreground as usize as u64 == target.hwnd))
    }
    fn matches(&self, target: &Target) -> bool {
        created(self.process.as_raw_handle()).ok() == Some(target.created)
            && unsafe { GetProcessId(self.process.as_raw_handle()) } == target.pid
            && crate::resume::now()
                .is_ok_and(|now| now >= target.observed_at && now - target.observed_at <= 1500)
            && window_matches(target)
    }
    fn restore(&self, target: &Target) -> bool {
        let hwnd = target.hwnd as usize as HWND;
        unsafe { IsIconic(hwnd) == 0 || ShowWindowAsync(hwnd, SW_RESTORE) != 0 }
    }
    fn activate(&self, target: &Target) -> bool {
        unsafe { SetForegroundWindow(target.hwnd as usize as HWND) != 0 }
    }
    fn is_foreground(&self, target: &Target) -> bool {
        unsafe { GetForegroundWindow() as usize as u64 == target.hwnd }
    }
}
pub fn switch(
    process: OwnedHandle,
    lab: u64,
    cancelled: &AtomicBool,
) -> Result<serde_json::Value, String> {
    if lab == 0
        || cancelled.load(Ordering::SeqCst)
        || unsafe { GetForegroundWindow() as usize as u64 } != lab
    {
        return Err("请在 Lab 窗口中重新点击".into());
    }
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let request = Request {
        version: 1,
        request_id: bytes.iter().map(|b| format!("{b:02x}")).collect(),
        pid: unsafe { GetProcessId(process.as_raw_handle()) },
        created: created(process.as_raw_handle())?,
    };
    let target = query(&request, cancelled)?;
    activate(
        &WindowsDesktop {
            process,
            lab: lab as usize as HWND,
            cancelled,
        },
        &target,
    )?;
    Ok(serde_json::json!({"focused":true}))
}
