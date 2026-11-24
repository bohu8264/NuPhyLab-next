//! Durable originals for native transaction owners. The default Windows
//! read-only probe does not construct or invoke this module.
//! Active records clear only after a sealed raw-transport restoration receipt;
//! a durable completion marker makes an interrupted cleanup resumable.
use crate::{
    lighting::validate_state,
    lighting_policy::{
        self, PaletteReadback, ReconstructedPalette, RestoreAssessment, RestorePlan,
    },
    BridgeError, Model, Result,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
};
mod completion;
pub(crate) mod function_keys;
pub(crate) mod sleep;
mod status;
use completion::next_transaction_id;
pub use completion::Completion;
pub use status::{RecoveryObservation, RecoveryStatus};

const MAX_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum DeviceIdentity {
    Serial(String),
    // Without a reliable serial, a new connection cannot automatically take
    // ownership of an older device's recovery record, even at the same port.
    Connection(String),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub model_id: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub firmware_version: String,
    pub lighting_profile: u8,
    pub identity: DeviceIdentity,
}
impl Binding {
    pub(crate) fn validate(&self, model: &Model) -> Result<()> {
        let (DeviceIdentity::Serial(identity) | DeviceIdentity::Connection(identity)) =
            &self.identity;
        if self.model_id != model.id
            || self.vendor_id != model.vendor_id
            || !model.product_ids.contains(&self.product_id)
            || lighting_policy::qualified(model, &self.firmware_version).is_err()
            || self.lighting_profile > 1
            || identity.is_empty()
            || identity.len() > 256
            || identity.chars().any(char::is_control)
        {
            return Err(error(
                "BACKUP_IDENTITY_INVALID",
                "恢复记录的设备身份或固件无效",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Baseline {
    pub binding: Binding,
    pub state: Vec<u8>,
    pub rendered_colors: Vec<u8>,
}
impl Baseline {
    pub(crate) fn validate(&self, model: &Model) -> Result<()> {
        self.binding.validate(model)?;
        validate_state(&self.state, model)?;
        if self.rendered_colors.len() != (model.key_count + model.side_count) * 3 {
            return Err(error("INVALID_BACKUP", "恢复记录的颜色数量无效"));
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope<T> {
    schema: u8,
    digest: String,
    data: T,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Palette {
    baseline_digest: String,
    original: ReconstructedPalette,
}

/// One already-established, private device directory. Callers must select it
/// from trusted application storage, never artwork or a frontend path.
pub struct JournalStore {
    directory: PathBuf,
    model: Model,
    // Transactions retain the OS lock, validated native directory handles
    // and outer namespace gate after the selector itself is dropped.
    anchor: std::sync::Arc<DirectoryLease>,
    #[cfg(test)]
    cleanup_fail_before: Option<&'static str>,
}
struct DirectoryLease {
    lock: File,
    _directory_guard: Option<std::sync::Arc<dyn Send + Sync>>,
}
impl Drop for DirectoryLease {
    fn drop(&mut self) {
        // Closing just this descriptor is insufficient if a concurrent
        // spawn/duplicate still owns the same open file description.
        // Release our lease before directory guards and handles are dropped.
        let _ = self.lock.unlock();
    }
}
impl JournalStore {
    #[cfg(test)]
    pub(crate) fn interrupt_cleanup_before(&mut self, step: &'static str) {
        self.cleanup_fail_before = Some(step);
    }
    pub fn open_with_directory_guard<G: Send + Sync + 'static>(
        directory: &Path,
        model: &Model,
        guard: std::sync::Arc<G>,
    ) -> Result<Self> {
        let mut store = Self::open(directory, model)?;
        std::sync::Arc::get_mut(&mut store.anchor)
            .unwrap()
            ._directory_guard = Some(guard);
        Ok(store)
    }
    pub fn open_existing_with_directory_guard<G: Send + Sync + 'static>(
        directory: &Path,
        model: &Model,
        guard: std::sync::Arc<G>,
    ) -> Result<Self> {
        let mut store = Self::open_existing(directory, model)?;
        std::sync::Arc::get_mut(&mut store.anchor)
            .unwrap()
            ._directory_guard = Some(guard);
        Ok(store)
    }
    pub(crate) fn require_model(&self, model: &Model) -> Result<()> {
        if &self.model != model {
            return Err(error(
                "BACKUP_DEVICE_MISMATCH",
                "恢复目录的型号配置与设备不一致",
            ));
        }
        Ok(())
    }
    pub fn open(directory: &Path, model: &Model) -> Result<Self> {
        Self::open_mode(directory, model, true)
    }
    /// Inspect an existing store without creating a lock or retiring records.
    pub fn open_existing(directory: &Path, model: &Model) -> Result<Self> {
        Self::open_mode(directory, model, false)
    }
    fn open_mode(directory: &Path, model: &Model, initialize: bool) -> Result<Self> {
        regular(directory, true)?;
        let directory = directory
            .canonicalize()
            .map_err(|_| error("BACKUP_PATH_INVALID", "无法定位恢复记录目录"))?;
        let lock_path = directory.join("session.lock");
        if exists(&lock_path)? {
            regular(&lock_path, false)?;
        }
        let mut options = safe_options();
        options
            .read(true)
            .write(true)
            .create(initialize)
            .truncate(false);
        let lock = options
            .open(&lock_path)
            .map_err(|_| error("BACKUP_LOCKED", "恢复记录被占用或无法锁定"))?;
        regular(&lock_path, false)?;
        lock.try_lock()
            .map_err(|_| error("BACKUP_LOCKED", "另一后台程序正在使用恢复记录"))?;
        let mut store = Self {
            directory,
            model: model.clone(),
            anchor: std::sync::Arc::new(DirectoryLease {
                lock,
                _directory_guard: None,
            }),
            #[cfg(test)]
            cleanup_fail_before: None,
        };
        if initialize {
            store.finish_completed()?;
            sleep::finish_completed(&store.directory, &store.model)?;
        }
        Ok(store)
    }
    pub(crate) fn finish_verified_lighting(
        &mut self,
        profile: u8,
        current: &Binding,
    ) -> Result<bool> {
        self.finish_completed_profile(profile, Some(current))
            .map_err(|e| {
                if e.code == "BACKUP_DEVICE_MISMATCH" {
                    e
                } else {
                    BridgeError::new(
                        "BACKUP_CLEANUP_REQUIRED",
                        format!("完成记录尚未通过核对，原文已保留：{}", e.message),
                    )
                }
            })
    }
    pub(crate) fn finish_verified_sleep(&mut self, current: &Binding) -> Result<bool> {
        let present = exists(&self.directory.join("board-sleep.completed.json"))?;
        sleep::finish_completed_bound(&self.directory, &self.model, Some(current))?;
        Ok(present)
    }
    fn path(&self, profile: u8, palette: bool) -> PathBuf {
        let suffix = if palette { ".palette" } else { "" };
        self.directory
            .join(format!("profile-{profile}{suffix}.json"))
    }
    pub fn begin(&mut self, baseline: Baseline) -> Result<Transaction<'_>> {
        baseline.validate(&self.model)?;
        sleep::require_empty(&self.directory)?;
        function_keys::require_empty(&self.directory, &self.model)?;
        // Until the writable transport supports deferred-profile ownership,
        // retain and block on *any* record, including an orphaned palette.
        for profile in 0..=1 {
            for palette in [false, true] {
                if exists(&self.path(profile, palette))? {
                    return Err(error("RECOVERY_REQUIRED", "已有恢复记录，不能覆盖原始设置"));
                }
            }
            for kind in ["intent", "rgb-intent", "completed"] {
                if exists(&self.marker(profile, kind))? {
                    return Err(error("RECOVERY_REQUIRED", "已有灯光事务记录，不能覆盖"));
                }
            }
        }
        let bytes = encode(&baseline)?;
        self.save_new(&self.path(baseline.binding.lighting_profile, false), &bytes)?;
        Ok(Transaction {
            store: self,
            baseline,
            bytes,
            palette: None,
            failed: false,
            recovery_only: false,
            id: next_transaction_id(),
            write_sequence: 0,
            fresh: true,
        })
    }
    pub fn resume(&mut self, binding: &Binding) -> Result<Transaction<'_>> {
        binding.validate(&self.model)?;
        let bytes = read(&self.path(binding.lighting_profile, false))?;
        let baseline: Baseline = decode(&bytes)?;
        baseline.validate(&self.model)?;
        if &baseline.binding != binding {
            return Err(error(
                "BACKUP_DEVICE_MISMATCH",
                "恢复记录与当前键盘、固件或档位不一致",
            ));
        }
        let palette_path = self.path(binding.lighting_profile, true);
        let palette = match palette_path.symlink_metadata() {
            Ok(_) => {
                let palette_bytes = read(&palette_path)?;
                let saved: Palette = decode(&palette_bytes)?;
                if saved.baseline_digest != digest(&bytes) {
                    return Err(error("INVALID_BACKUP", "原调色板与恢复记录不匹配"));
                }
                saved.original.validate(&self.model, binding)?;
                Some(palette_bytes)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(error("BACKUP_READ_FAILED", "无法检查原调色板记录")),
        };
        let transaction = Transaction {
            store: self,
            baseline,
            bytes,
            palette,
            failed: false,
            recovery_only: true,
            id: next_transaction_id(),
            write_sequence: 0,
            fresh: false,
        };
        transaction.validate_intents()?;
        Ok(transaction)
    }
    fn save_new(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        save_new_at(&self.directory, path, bytes)
    }
}
fn save_new_at(directory: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    regular(directory, true)?;
    let mut file = safe_options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| error("BACKUP_CREATE_FAILED", "不能独占创建恢复记录，原文件已保留"))?;
    // On every failure the partial record stays in place and no caller's
    // device callback runs. Retrying cannot replace it with a new baseline.
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .and_then(|_| file.rewind())
        .map_err(|_| error("BACKUP_SAVE_FAILED", "恢复记录未完成刷盘，已停止操作"))?;
    let mut observed = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut observed)
        .map_err(|_| error("BACKUP_SAVE_FAILED", "无法回读恢复记录"))?;
    // Close the writer before opening a separate read handle: Windows
    // sharing checks apply to both handles' desired access/share flags.
    drop(file);
    if observed != bytes || read(path)? != bytes {
        return Err(error("BACKUP_CHANGED", "恢复记录回读不一致，已停止操作"));
    }
    #[cfg(unix)]
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| error("BACKUP_SAVE_FAILED", "恢复记录目录未完成刷盘"))?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub enum Mutation {
    Settings,
    Palette,
}
pub struct Transaction<'a> {
    store: &'a mut JournalStore,
    baseline: Baseline,
    bytes: Vec<u8>,
    palette: Option<Vec<u8>>,
    failed: bool,
    recovery_only: bool,
    id: u64,
    write_sequence: u64,
    fresh: bool,
}
impl Transaction<'_> {
    pub(crate) fn function_key_records_pending(&self) -> Result<bool> {
        Ok(!function_keys::pending(&self.store.directory, &self.store.model)?.is_empty())
    }
    pub fn baseline(&self) -> &Baseline {
        &self.baseline
    }
    /// Preserve the exact original before retaining a keyboard-owned preset
    /// change. A failed archive blocks the recovery plan; retries reuse it.
    fn preserve_history(&mut self, current: &Binding) -> Result<()> {
        self.intact(current)?;
        let path = self.store.directory.join(format!(
            "profile-{}.history-{}.json",
            current.lighting_profile,
            digest(&self.bytes)
        ));
        if exists(&path)? {
            if read(&path)? != self.bytes {
                return Err(error(
                    "BACKUP_CHANGED",
                    "原设置历史记录不一致，活动记录已保留",
                ));
            }
        } else {
            self.store.save_new(&path, &self.bytes)?;
        }
        self.intact(current)
    }
    /// Construct a plan bound to the durable original and archive retained
    /// preset changes before any future adapter can use it.
    pub fn plan_restoration(
        &mut self,
        current: &Binding,
        live_state: &[u8],
    ) -> Result<RestorePlan> {
        self.recovery_only = true;
        self.intact(current)?;
        let palette: Option<Palette> = self.palette.as_deref().map(decode).transpose()?;
        let plan = lighting_policy::plan_restore(
            &self.store.model,
            &self.baseline,
            current,
            live_state,
            palette.as_ref().map(|p| &p.original),
        )?;
        if plan.archive_required {
            self.preserve_history(current)?;
        }
        Ok(plan)
    }
    /// Offline comparison plus durable history, without active-journal cleanup.
    /// A future HID adapter must supply independent fresh readback.
    pub fn assess_restoration(
        &mut self,
        plan: &RestorePlan,
        current: &Binding,
        observed_state: &[u8],
        rendered: Option<&[u8]>,
        palette_readback: Option<&PaletteReadback>,
    ) -> Result<RestoreAssessment> {
        self.recovery_only = true;
        self.intact(current)?;
        if !plan.belongs_to(&self.baseline) {
            return Err(error("BACKUP_CHANGED", "恢复计划不属于当前原始记录"));
        }
        let result = lighting_policy::assess_restore(
            &self.store.model,
            plan,
            current,
            observed_state,
            rendered,
            palette_readback,
        )?;
        if result.archive_required {
            self.preserve_history(current)?;
        }
        self.intact(current)?;
        Ok(result)
    }
    fn intact(&self, current: &Binding) -> Result<()> {
        if current != &self.baseline.binding {
            return Err(error(
                "BACKUP_DEVICE_MISMATCH",
                "设备、固件或档位已变化，原记录已保留",
            ));
        }
        if exists(&self.store.marker(current.lighting_profile, "completed"))? {
            return Err(error(
                "BACKUP_CLEANUP_REQUIRED",
                "已有灯光完成标记，需要先核对文件清理，不重复操作键盘",
            ));
        }
        if read(&self.store.path(current.lighting_profile, false))? != self.bytes {
            return Err(error("BACKUP_CHANGED", "原恢复记录已变化，已停止设备操作"));
        }
        let path = self.store.path(current.lighting_profile, true);
        match &self.palette {
            Some(bytes) if read(&path)? == *bytes => self.validate_intents(),
            None if matches!(path.symlink_metadata(), Err(e) if e.kind() == std::io::ErrorKind::NotFound) => {
                self.validate_intents()
            }
            _ => Err(error(
                "BACKUP_CHANGED",
                "原调色板记录已变化，已停止设备操作",
            )),
        }
    }
    /// Only the future qualified transport may provide an independently
    /// reconstructed original palette. Rendered inspection samples are not it.
    pub fn preserve_palette(&mut self, original: ReconstructedPalette) -> Result<()> {
        if self.failed || self.recovery_only {
            return Err(error(
                "RECOVERY_REQUIRED",
                "该记录只能用于恢复，不能补写新基线",
            ));
        }
        if let Err(error) = self.intact(&self.baseline.binding) {
            self.failed = true;
            return Err(error);
        }
        original.validate(&self.store.model, &self.baseline.binding)?;
        let bytes = encode(&Palette {
            baseline_digest: digest(&self.bytes),
            original,
        })?;
        if let Some(saved) = &self.palette {
            return if saved == &bytes {
                Ok(())
            } else {
                Err(error("BACKUP_CHANGED", "不能替换已保存的原调色板"))
            };
        }
        self.failed = true;
        self.store.save_new(
            &self
                .store
                .path(self.baseline.binding.lighting_profile, true),
            &bytes,
        )?;
        self.palette = Some(bytes);
        self.failed = false;
        Ok(())
    }
    /// The callback is the boundary for a future HID adapter, not a public
    /// protocol operation. A failed/uncertain write cannot be blindly retried.
    pub fn mutate<T>(
        &mut self,
        current: &Binding,
        kind: Mutation,
        action: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        if self.failed || self.recovery_only {
            return Err(error("RECOVERY_REQUIRED", "需要先恢复原设置，不能继续输出"));
        }
        if let Err(error) = self.intact(current) {
            self.failed = true;
            return Err(error);
        }
        if matches!(kind, Mutation::Palette) && self.palette.is_none() {
            return Err(error(
                "BACKUP_INCOMPLETE",
                "原调色板尚未可靠保存，不能写入颜色",
            ));
        }
        self.record_intent(kind)?;
        // Poison first, so unwinding after an uncertain callback also blocks
        // further animation frames. A successful callback restores the lease.
        self.failed = true;
        self.write_sequence += 1;
        let value = action()?;
        self.intact(current)?;
        self.failed = false;
        Ok(value)
    }
    /// A future adapter can retry restoration with the original data. Success
    /// here is NOT restoration evidence and never removes any journal.
    pub fn recover<T>(
        &mut self,
        current: &Binding,
        action: impl FnOnce(&Baseline, Option<&ReconstructedPalette>) -> Result<T>,
    ) -> Result<T> {
        self.recovery_only = true;
        self.intact(current)?;
        let palette: Option<Palette> = self.palette.as_deref().map(decode).transpose()?;
        let value = action(&self.baseline, palette.as_ref().map(|p| &p.original))?;
        self.intact(current)?;
        Ok(value)
    }
}

fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}
fn exists(path: &Path) -> Result<bool> {
    match path.symlink_metadata() {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(error(
            "BACKUP_READ_FAILED",
            "无法确认是否已有恢复记录，已停止操作",
        )),
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn encode<T: Serialize>(data: &T) -> Result<Vec<u8>> {
    let payload =
        serde_json::to_vec(data).map_err(|_| error("INVALID_BACKUP", "恢复记录无法编码"))?;
    let bytes = serde_json::to_vec(&Envelope {
        schema: 1,
        digest: digest(&payload),
        data,
    })
    .map_err(|_| error("INVALID_BACKUP", "恢复记录无法编码"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(error("INVALID_BACKUP", "恢复记录过大"));
    }
    Ok(bytes)
}
fn decode<T: Serialize + DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    let saved: Envelope<T> = serde_json::from_slice(bytes)
        .map_err(|_| error("INVALID_BACKUP", "恢复记录损坏或格式不支持，原文件已保留"))?;
    let payload =
        serde_json::to_vec(&saved.data).map_err(|_| error("INVALID_BACKUP", "恢复记录无法校验"))?;
    if saved.schema != 1 || saved.digest != digest(&payload) {
        return Err(error("INVALID_BACKUP", "恢复记录校验失败，原文件已保留"));
    }
    Ok(saved.data)
}
fn regular(path: &Path, directory: bool) -> Result<()> {
    let metadata = path
        .symlink_metadata()
        .map_err(|_| error("BACKUP_READ_FAILED", "无法检查恢复记录路径"))?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.file_type().is_symlink()
        || reparse
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
    {
        return Err(error(
            "BACKUP_PATH_INVALID",
            "恢复记录必须使用普通文件和目录",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !directory && metadata.nlink() != 1 {
            return Err(error("BACKUP_PATH_INVALID", "恢复记录不能使用硬链接"));
        }
    }
    Ok(())
}
fn safe_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    options
}
fn read(path: &Path) -> Result<Vec<u8>> {
    regular(path, false)?;
    let file = safe_options()
        .read(true)
        .open(path)
        .map_err(|_| error("BACKUP_READ_FAILED", "无法读取恢复记录，原文件已保留"))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("BACKUP_READ_FAILED", "恢复记录读取失败"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(error("INVALID_BACKUP", "恢复记录超过读取上限"));
    }
    regular(path, false)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests;
