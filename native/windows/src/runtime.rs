//! Explicit native lighting composition. The desktop application continues
//! to select the separate read-only protocol. No path/serial override exists.
use nuphylab_core::{
    controller::{self, Backend, DeviceFactory},
    output::{Connection, Lighting, Transport},
    recovery::{DeviceIdentity, JournalStore},
    BridgeError, Model, Result,
};
use std::io::{Read, Write};

struct Factory<O, J> {
    open: O,
    journal: J,
}
impl<T, O, J> DeviceFactory for Factory<O, J>
where
    T: Transport,
    O: FnMut() -> Result<(Model, T)>,
    J: FnMut(&Model, &Connection) -> Result<JournalStore>,
{
    type Transport = T;
    fn open_selected(&mut self, model_id: &str, profile: u8) -> Result<(Model, T)> {
        let (model, transport) = (self.open)()?;
        qualify(model, transport, model_id, profile).map(|(model, transport, _)| (model, transport))
    }
    fn journal(&mut self, model: &Model, connection: &Connection) -> Result<JournalStore> {
        let store = (self.journal)(model, connection)?;
        if store.recovery_status()?.has_pending() {
            return Err(BridgeError::new(
                "RECOVERY_REQUIRED",
                "此键盘仍有待处理的原设置，不能重新采集或播放",
            ));
        }
        Ok(store)
    }
    fn existing_journal(
        &mut self,
        model: &Model,
        connection: &Connection,
    ) -> Result<Option<JournalStore>> {
        existing_journal(model, connection)
    }
    fn open_for_recovery(
        &mut self,
        selected: &str,
        profile: u8,
        restoring: bool,
    ) -> Result<(Model, T, String)> {
        let (model, mut transport) = (self.open)()?;
        if restoring {
            return qualify(model, transport, selected, profile);
        }
        if model.id != selected
            || profile > 1
            || !matches!(transport.connection().serial, Some(ref s) if !s.trim().is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        {
            return Err(BridgeError::new(
                "RECOVERY_IDENTITY_UNVERIFIED",
                "尚未核对当前键盘唯一身份，未检查恢复目录",
            ));
        }
        let identity =
            nuphylab_core::lighting::inspect(&mut IdentityReader(&mut transport), &model)?;
        if identity.lighting_profile != profile {
            return Err(BridgeError::new(
                "SESSION_CHANGED",
                "物理档位已改变，请重新检查",
            ));
        }
        Ok((model, transport, identity.version))
    }
}
struct IdentityReader<'a, T>(&'a mut T);
impl<T: Transport> nuphylab_core::lighting::ReadTransport for IdentityReader<'_, T> {
    fn read(
        &mut self,
        command: u8,
        length: u8,
        address: u16,
        handle: u8,
        key: u8,
    ) -> Result<Vec<u8>> {
        if address != 0 || handle != 0 {
            return Err(BridgeError::new("READ_ONLY", "身份检查不允许其他读取"));
        }
        self.0.exchange(
            &nuphylab_core::read_frame(command, length, key)?,
            std::time::Duration::from_millis(1200),
        )
    }
}
fn qualify<T: Transport>(
    model: Model,
    transport: T,
    selected: &str,
    profile: u8,
) -> Result<(Model, T, String)> {
    if model.id != selected || profile > 1 {
        return Err(BridgeError::new(
            "CONTROLLER_DEVICE_MISMATCH",
            "实际控制接口或档位选择无效，未接管",
        ));
    }
    let identity_error = || {
        BridgeError::new(
            "RECOVERY_IDENTITY_UNVERIFIED",
            "Windows 尚未核对键盘的稳定唯一身份，未开启灯光事务",
        )
    };
    if !matches!(&transport.connection().serial, Some(serial)
        if !serial.trim().is_empty() && serial.len() <= 256 && !serial.chars().any(char::is_control))
    {
        return Err(identity_error());
    }
    // This open only reads A1/A0/D1; no lighting/sleep reads, baseline or
    // directory creation may happen before all qualification checks pass.
    let lighting = Lighting::open(transport, model.clone())?;
    if lighting.binding().lighting_profile != profile {
        return Err(BridgeError::new(
            "SESSION_CHANGED",
            "键盘物理档位与所选设备不一致，未接管",
        ));
    }
    if !matches!(&lighting.binding().identity, DeviceIdentity::Serial(serial)
        if !serial.trim().is_empty() && serial.len() <= 256 && !serial.chars().any(char::is_control))
    {
        return Err(identity_error());
    }
    let firmware = lighting.binding().firmware_version.clone();
    Ok((model, lighting.into_transport(), firmware))
}
#[cfg(windows)]
fn journal(model: &Model, connection: &Connection) -> Result<JournalStore> {
    let root = crate::storage::RecoveryRoot::open()?;
    root.device(model, connection)?.journal_store()
}
#[cfg(not(windows))]
fn journal(_: &Model, _: &Connection) -> Result<JournalStore> {
    Err(BridgeError::new(
        "WINDOWS_REQUIRED",
        "此恢复目录仅在 Windows 使用",
    ))
}
#[cfg(windows)]
fn existing_journal(model: &Model, connection: &Connection) -> Result<Option<JournalStore>> {
    let Some(root) = crate::storage::RecoveryRoot::open_existing()? else {
        return Ok(None);
    };
    root.existing_device(model, connection)?
        .map(|d| d.existing_journal_store())
        .transpose()
}
#[cfg(not(windows))]
fn existing_journal(_: &Model, _: &Connection) -> Result<Option<JournalStore>> {
    Err(BridgeError::new(
        "WINDOWS_REQUIRED",
        "此恢复目录仅在 Windows 使用",
    ))
}
/// Handshake and quit are device-free. Only an explicit arm opens the one
/// USB candidate and qualifies it before obtaining its fixed private store.
pub fn run<R, W>(models: &[Model], reader: R, writer: W) -> Result<()>
where
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    controller::run_with_factory(
        Factory {
            open: || crate::probe::open_lighting_transport(models),
            journal,
        },
        reader,
        writer,
        Backend::WindowsHid,
    )
}

#[cfg(test)]
mod tests;
