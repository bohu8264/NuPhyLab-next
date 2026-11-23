//! Windows-only private storage for future lighting/recovery owners. No
//! shipping CLI or frontend selects it, and no HID operation occurs here.
#[cfg(any(windows, test))]
mod policy;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{DeviceDirectory, RecoveryRoot};
