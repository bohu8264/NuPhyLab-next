//! Explicit recovery of existing originals on a newly opened, qualified
//! device. Explicit native v2 recovery selects it; no new baseline is made.
use super::*;
use crate::function_keys::{FunctionKeyCompletion, FunctionKeyLease};
use crate::recovery::{Completion, JournalStore, RecoveryStatus};
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RecoveryPart<T> {
    NotNeeded,
    Restored { completion: T },
    Failed { error: BridgeError },
}
impl<T> RecoveryPart<T> {
    fn from_result(result: Result<T>) -> Self {
        match result {
            Ok(completion) => Self::Restored { completion },
            Err(error) => Self::Failed { error },
        }
    }
    fn failed(&self) -> bool {
        matches!(self, Self::Failed { .. })
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub model_id: String,
    pub lighting_profile: u8,
    pub lighting: RecoveryPart<Completion>,
    pub board_sleep: RecoveryPart<SleepCompletion>,
    pub function_keys: RecoveryPart<FunctionKeyCompletion>,
    pub deferred_profiles: Vec<u8>,
    pub remaining: RecoveryStatus,
    pub completed_cleanup: RecoveryStatus,
    /// All v1 records in this device directory are retired, including the
    /// other physical profile. No record is distinct from a verified restore.
    pub complete: bool,
}
/// The caller owns the existing trusted device directory and its OS lock,
/// explicitly selects the current physical profile and supplies a qualified
/// stable/unique serial. A connection token cannot authorize cold recovery.
/// Restores only the selected RGB/key profile and device-global sleep flag;
/// it never switches profiles or creates an ordinary output lease.
pub fn recover_existing<T: Transport>(
    transport: T,
    model: Model,
    store: &mut JournalStore,
    selected_profile: u8,
) -> Result<RecoveryReport> {
    store.require_model(&model)?;
    if selected_profile > 1 {
        return Err(error(
            "RECOVERY_SELECTION_INVALID",
            "请选择有效的键盘物理档位",
        ));
    }
    if !matches!(transport.connection().serial, Some(ref serial)
        if !serial.trim().is_empty() && serial.len() <= 256 && !serial.chars().any(char::is_control))
    {
        return Err(error(
            "RECOVERY_IDENTITY_UNVERIFIED",
            "重新连接后的恢复需要已核对为稳定且唯一的序列号",
        ));
    }
    let before = store.recovery_status()?;
    let mut deferred_profiles: Vec<_> = before
        .lighting_profiles
        .iter()
        .chain(&before.keymap_profiles)
        .copied()
        .filter(|profile| *profile != selected_profile)
        .collect();
    deferred_profiles.sort_unstable();
    deferred_profiles.dedup();
    let mut lighting = Lighting::open(transport, model)?;
    if !matches!(&lighting.binding.identity, DeviceIdentity::Serial(serial)
        if !serial.trim().is_empty() && serial.len() <= 256 && !serial.chars().any(char::is_control))
    {
        return Err(error(
            "RECOVERY_IDENTITY_UNVERIFIED",
            "设备身份已变化，不能按旧连接恢复",
        ));
    }
    if lighting.binding.lighting_profile != selected_profile {
        return Err(error(
            "SESSION_CHANGED",
            "键盘物理档位与恢复选择不一致，原记录已保留",
        ));
    }
    let binding = lighting.binding.clone();
    let mut completed_cleanup = RecoveryStatus {
        lighting_profiles: vec![],
        board_sleep: false,
        keymap_profiles: vec![],
    };
    // All three records recover independently. The real Windows transport
    // still denies an unqualified key-write barrier; an ACK is not proof.
    let keys = catch_unwind(AssertUnwindSafe(|| {
        if !before.keymap_profiles.contains(&selected_profile) {
            return RecoveryPart::NotNeeded;
        }
        RecoveryPart::from_result(FunctionKeyLease::recover_existing(
            &mut lighting.transport,
            &lighting.model,
            store,
        ))
    }));
    // These attempts are deliberately independent: a corrupt RGB original,
    // USB failure or unwind must not prevent the global sleep cleanup.
    let rgb = catch_unwind(AssertUnwindSafe(|| {
        if !before.lighting_profiles.contains(&selected_profile) {
            return RecoveryPart::NotNeeded;
        }
        match store.finish_verified_lighting(selected_profile, &binding) {
            Ok(true) => {
                completed_cleanup.lighting_profiles.push(selected_profile);
                return RecoveryPart::NotNeeded;
            }
            Ok(false) => {}
            Err(error) => return RecoveryPart::Failed { error },
        }
        RecoveryPart::from_result((|| {
            let mut transaction = store.resume(&binding)?;
            let receipt = lighting.restore(&mut transaction)?;
            transaction.complete(receipt)
        })())
    }));
    let sleep = catch_unwind(AssertUnwindSafe(|| {
        if !before.board_sleep {
            return RecoveryPart::NotNeeded;
        }
        match store.finish_verified_sleep(&binding) {
            Ok(true) => {
                completed_cleanup.board_sleep = true;
                return RecoveryPart::NotNeeded;
            }
            Ok(false) => {}
            Err(error) => return RecoveryPart::Failed { error },
        }
        RecoveryPart::from_result((|| {
            let mut journal = store.sleep_journal(&binding, true)?;
            lighting.release_sleep(&mut journal)
        })())
    }));
    let lighting_result = rgb.unwrap_or_else(|panic| resume_unwind(panic));
    let sleep_result = sleep.unwrap_or_else(|panic| resume_unwind(panic));
    let key_result = keys.unwrap_or_else(|panic| resume_unwind(panic));
    let remaining = store.recovery_status()?;
    let complete = deferred_profiles.is_empty()
        && !remaining.has_pending()
        && !lighting_result.failed()
        && !sleep_result.failed()
        && !key_result.failed();
    Ok(RecoveryReport {
        model_id: binding.model_id,
        lighting_profile: selected_profile,
        lighting: lighting_result,
        board_sleep: sleep_result,
        function_keys: key_result,
        deferred_profiles,
        remaining,
        completed_cleanup,
        complete,
    })
}

#[cfg(test)]
mod tests;
