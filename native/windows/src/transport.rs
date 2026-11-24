//! Owned control-handle I/O. Device selection and write authorization belong
//! to the caller; this layer normalizes reports and bounds each exchange.
use nuphylab_core::{
    output::{Connection, Transport},
    BridgeError, Result,
};
use std::time::{Duration, Instant};

pub trait Io {
    fn write(&self, report: &[u8]) -> Result<usize>;
    fn read_timeout(&self, report: &mut [u8], timeout_ms: i32) -> Result<usize>;
}
pub struct ControlTransport<B> {
    device: B,
    connection: Connection,
    deadline: Option<Instant>,
}
impl<B: Io> ControlTransport<B> {
    /// None means a persistent handle with per-exchange limits; the core
    /// controller supplies its own operation/recovery budgets.
    pub fn new(device: B, connection: Connection, deadline: Option<Instant>) -> Self {
        Self {
            device,
            connection,
            deadline,
        }
    }
}
impl<B: Io> Transport for ControlTransport<B> {
    fn connection(&self) -> Connection {
        self.connection.clone()
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        let started = Instant::now();
        let deadline = (started + timeout.min(Duration::from_millis(1200))).min(
            self.deadline
                .unwrap_or(started + Duration::from_millis(1200)),
        );
        if timeout.is_zero() || started >= deadline {
            return Err(BridgeError::new(
                "HID_TIMEOUT",
                "设备操作已超时，未发送报文",
            ));
        }
        let mut report = [0u8; 65];
        report[1..].copy_from_slice(frame);
        if self.device.write(&report)? != report.len() {
            return Err(BridgeError::new("HID_WRITE_FAILED", "设备请求未完整发送"));
        }
        let mut bytes = [0u8; 65];
        while Instant::now() < deadline {
            let wait = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .clamp(1, 100) as i32;
            let count = self.device.read_timeout(&mut bytes, wait)?;
            let raw = match count {
                64 => &bytes[..64],
                65 if bytes[0] == 0 => &bytes[1..],
                _ => continue,
            };
            if raw[0] != 0xaa || raw[1] != frame[1] {
                continue;
            }
            nuphylab_core::validate(raw, frame[1])?;
            return Ok(raw.to_vec());
        }
        Err(BridgeError::new(
            "HID_TIMEOUT",
            "键盘通信超时，请关闭其他键盘设置程序",
        ))
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        if self
            .deadline
            .is_some_and(|end| end.saturating_duration_since(Instant::now()) < delay)
        {
            return Err(BridgeError::new("HID_TIMEOUT", "设备等待超出操作期限"));
        }
        std::thread::sleep(delay);
        Ok(())
    }
}
impl<B: Io> nuphylab_core::lighting::ReadTransport for ControlTransport<B> {
    fn read(
        &mut self,
        command: u8,
        length: u8,
        address: u16,
        handle: u8,
        key: u8,
    ) -> Result<Vec<u8>> {
        let frame = if command == 0xf3 {
            nuphylab_core::sleep_inspection::read_frame(length, address, handle, key)?
        } else if matches!(command, 0xb1 | 0xb2) {
            nuphylab_core::keymap::bounded_read_frame(command, length, address, handle, key)?
        } else if matches!(command, 0xd2 | 0xd5) {
            nuphylab_core::lighting_read_frame(command, length, address, handle, key)?
        } else {
            if address != 0 || handle != 0 {
                return Err(BridgeError::new("READ_ONLY", "读取路由无效"));
            }
            nuphylab_core::read_frame(command, length, key)?
        };
        self.exchange(&frame, Duration::from_millis(1200))
    }
}
#[cfg(windows)]
impl Io for hidapi::HidDevice {
    fn write(&self, report: &[u8]) -> Result<usize> {
        hidapi::HidDevice::write(self, report)
            .map_err(|e| BridgeError::new("HID_IO", format!("设备通信失败：{e}")))
    }
    fn read_timeout(&self, report: &mut [u8], timeout_ms: i32) -> Result<usize> {
        hidapi::HidDevice::read_timeout(self, report, timeout_ms)
            .map_err(|e| BridgeError::new("HID_IO", format!("设备通信失败：{e}")))
    }
}
#[cfg(windows)]
pub(crate) fn connection(vendor_id: u16, product_id: u16) -> Connection {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Connection {
        vendor_id,
        product_id,
        serial: None,
        token: format!(
            "hid-{}-{stamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
    }
}

#[cfg(test)]
mod tests;
