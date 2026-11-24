#[cfg(windows)]
fn ensure_clear(name: &str) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND},
        System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE},
    };
    let wide: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, wide.as_ptr()) };
    if !handle.is_null() {
        unsafe { CloseHandle(handle) };
        return Err("安装或卸载正在进行，请完成后再打开 NuPhy Lab".into());
    }
    if unsafe { GetLastError() } != ERROR_FILE_NOT_FOUND {
        return Err("无法确认安装状态，请稍后重试".into());
    }
    Ok(())
}
pub fn ensure_not_installing() -> Result<(), String> {
    #[cfg(windows)]
    {
        let config: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../shared/contracts/windows-installation.json"
        ))
        .map_err(|_| "安装保护配置无效")?;
        if config["version"] != 1 {
            return Err("安装保护版本无效".into());
        }
        ensure_clear(config["mutex"].as_str().ok_or("安装保护名称无效")?)
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::CreateMutexW};
    #[test]
    fn an_installer_barrier_blocks_startup_until_the_kernel_handle_is_closed() {
        let name = format!("Local\\NuPhyLab.Install.Test.{}", std::process::id());
        let wide: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
        ensure_clear(&name).unwrap();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
        assert!(!handle.is_null());
        assert!(ensure_clear(&name).is_err());
        unsafe { CloseHandle(handle) };
        ensure_clear(&name).unwrap();
    }
}
