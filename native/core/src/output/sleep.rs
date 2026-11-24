//! Only the inspected AIR board-global enable flag is writable here.
use super::*;
use crate::recovery::sleep::{Journal, Watch};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepCompletion {
    pub supported: bool,
    pub restored: bool,
    pub no_mutation: bool,
    pub archived: bool,
    pub preserved_external_change: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepStatus {
    pub supported: bool,
    pub active: bool,
    pub pending: bool,
}

pub(crate) struct Verified {
    token: (u64, u64),
    original_digest: String,
    no_mutation: bool,
    preserved_external_change: bool,
}
impl Verified {
    pub(crate) fn token(&self) -> (u64, u64) {
        self.token
    }
    pub(crate) fn original_digest(&self) -> &str {
        &self.original_digest
    }
    pub(crate) fn no_mutation(&self) -> bool {
        self.no_mutation
    }
    pub(crate) fn preserved_external_change(&self) -> bool {
        self.preserved_external_change
    }
}
pub(super) struct Guard<T> {
    pub(super) inner: T,
    watch: Watch,
    recovering: bool,
}
impl<T: Transport> Transport for Guard<T> {
    fn connection(&self) -> Connection {
        self.inner.connection()
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        let guarded = !self.recovering && matches!(frame[1], 0xd6 | 0xd8);
        if guarded {
            self.watch.intact()?;
        }
        let result = self.inner.exchange(frame, timeout)?;
        if guarded {
            self.watch.intact()?;
        }
        Ok(result)
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.inner.pause(delay)
    }
    fn settle_function_key_writes(&mut self, timeout: Duration) -> Result<()> {
        if !self.recovering {
            self.watch.intact()?;
        }
        self.inner.settle_function_key_writes(timeout)?;
        if !self.recovering {
            self.watch.intact()?;
        }
        Ok(())
    }
    fn begin_recovery(&mut self) {
        self.recovering = true;
        self.inner.begin_recovery();
    }
}
impl<T: Transport> Lighting<T> {
    pub(super) fn guard_sleep(self, watch: Watch) -> Lighting<Guard<T>> {
        Lighting {
            transport: Guard {
                inner: self.transport,
                watch,
                recovering: false,
            },
            model: self.model,
            connection: self.connection,
            binding: self.binding,
            key: self.key,
            firmware: self.firmware,
            deadline: self.deadline,
            armed: self.armed,
            failed: self.failed,
            last: self.last,
            lease: self.lease,
            native_expected: self.native_expected,
        }
    }
    fn check_sleep(&mut self) -> Result<()> {
        if !lighting_policy::supports_board_sleep(&self.model, &self.binding.firmware_version)
            || self.binding.product_id != 0x1028
            || !matches!(&self.binding.identity,DeviceIdentity::Serial(s) if !s.trim().is_empty())
        {
            return Err(error(
                "SLEEP_UNSUPPORTED",
                "休眠控制需要已核对的 AIR 固件和可靠序列号",
            ));
        }
        if self.transport.connection() != self.connection {
            return Err(error("SESSION_CHANGED", "休眠控制句柄已变化，原记录已保留"));
        }
        let identity = lighting::inspect(
            &mut ReadAdapter {
                transport: &mut self.transport,
                deadline: self.deadline,
            },
            &self.model,
        )?;
        // Sleep is global: a physical Mac/Win switch must not prevent this
        // independent cleanup. Firmware, key and the same control handle stay bound.
        if identity.key != self.key || identity.firmware[..6] != self.firmware[..6] {
            return Err(error("SESSION_CHANGED", "休眠控制的固件或密钥已变化"));
        }
        Ok(())
    }
    fn sleep_info(&mut self) -> Result<[u8; 4]> {
        self.check_sleep()?;
        let raw = self.raw(&frame(0xf3, None, self.key)?)?;
        let info: [u8; 4] = crate::decode_routed(&raw, 0xf3, 4, 0, 0, self.key)?
            .try_into()
            .map_err(|_| error("SLEEP_REPLY_INVALID", "休眠回复长度无效"))?;
        if info[0] > 1 {
            return Err(error("SLEEP_REPLY_INVALID", "休眠启用标记无效"));
        }
        self.check_sleep()?;
        Ok(info)
    }
    fn sleep_enable(
        &mut self,
        journal: &mut Journal,
        enabled: u8,
        before: [u8; 4],
    ) -> Result<[u8; 4]> {
        journal.intact()?;
        if enabled > 1 || self.sleep_info()? != before {
            return Err(error(
                "SLEEP_SETTING_CHANGED",
                "休眠设置在写入前变化，未重放旧时间参数",
            ));
        }
        journal.prepare_write()?;
        let raw = self.raw(&frame(0xf5, Some(enabled), self.key)?)?;
        if crate::decode_routed(&raw, 0xf5, 1, 0, 0, self.key)? != [enabled] {
            return Err(error("SLEEP_ACK_MISMATCH", "休眠写入确认不一致"));
        }
        self.check_sleep()?;
        journal.intact()?;
        let observed = self.sleep_info()?;
        let mut expected = before;
        expected[0] = enabled;
        if observed != expected {
            return Err(error(
                "SLEEP_VERIFY_FAILED",
                "休眠启用或非拥有字段独立读回不一致，不重发设置",
            ));
        }
        Ok(observed)
    }
    pub(super) fn acquire_sleep(&mut self, journal: &mut Journal) -> Result<()> {
        self.start();
        journal.intact()?;
        if !journal.supported() {
            return Ok(());
        }
        let before = self.sleep_info()?;
        if before[0] == 0 {
            journal.already_disabled = true;
            return Ok(());
        }
        journal.capture(before)?;
        self.sleep_enable(journal, 0, before)?;
        journal.acquired = true;
        Ok(())
    }
    pub(super) fn ensure_sleep(&mut self, journal: &Journal) -> Result<()> {
        self.start();
        journal.intact()?;
        if journal.supported()
            && (journal.acquired || journal.already_disabled)
            && self.sleep_info()?[0] != 0
        {
            return Err(error(
                "SLEEP_SETTING_CHANGED",
                "休眠标记被外部修改，已停止灯光，不再次禁用",
            ));
        }
        Ok(())
    }
    pub(super) fn release_sleep(&mut self, journal: &mut Journal) -> Result<SleepCompletion> {
        if let Some(report) = &journal.completion {
            return Ok(report.clone());
        }
        self.start();
        self.transport.begin_recovery();
        journal.acquired = false;
        let Some(original) = journal.original()? else {
            return journal.finish_unused();
        };
        let no_mutation = !journal.mutation_started()?;
        let before = self.sleep_info()?;
        let preserved_external_change = before[1..] != original.original[1..]
            || (no_mutation && before[0] != original.original[0]);
        let observed = if !no_mutation && before[0] != original.original[0] {
            self.sleep_enable(journal, original.original[0], before)?
        } else {
            before
        };
        if self.sleep_info()? != observed {
            return Err(error(
                "SLEEP_SETTING_CHANGED",
                "休眠恢复核对期间设置改变，原记录已保留",
            ));
        }
        self.check_sleep()?;
        journal.intact()?;
        journal.finish(Verified {
            token: journal.token(),
            original_digest: journal.original_digest()?,
            no_mutation,
            preserved_external_change,
        })
    }
}
fn frame(command: u8, enabled: Option<u8>, key: u8) -> Result<[u8; 64]> {
    let length = match (command, enabled) {
        (0xf3, None) => 4,
        (0xf5, Some(0 | 1)) => 1,
        _ => {
            return Err(error(
                "SLEEP_WRITE_SCOPE_INVALID",
                "只允许整键盘四字节读取或一字节启用设置",
            ))
        }
    };
    let mut bytes = [0; 64];
    bytes[0] = 0x55;
    bytes[1] = command;
    bytes[4] = length ^ key;
    bytes[5] = key;
    bytes[6] = key;
    bytes[7] = key;
    if let Some(enabled) = enabled {
        bytes[8] = enabled ^ key;
    }
    bytes[3] = crate::checksum(&bytes);
    Ok(bytes)
}
/// Explicit native recovery on a qualified stable serial, independent of RGB
/// profile records. The current Windows entry point does not expose this API.
pub fn recover_board_sleep<T: Transport>(
    transport: T,
    model: Model,
    store: &mut crate::recovery::JournalStore,
) -> Result<SleepCompletion> {
    let mut lighting = Lighting::open(transport, model)?;
    let mut journal = store.sleep_journal(lighting.binding(), true)?;
    lighting.release_sleep(&mut journal)
}

#[cfg(test)]
mod tests;
