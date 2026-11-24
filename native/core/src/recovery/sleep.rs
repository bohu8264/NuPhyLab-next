//! Board-global sleep original, independent from both RGB profile journals.
//! The enclosing JournalStore owns the device-directory OS lock throughout.
use super::*;
use std::sync::{Arc, Mutex};

const ORIGINAL: &str = "board-sleep.json";
const INTENT: &str = "board-sleep.intent.json";
const COMPLETED: &str = "board-sleep.completed.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SleepBinding {
    model_id: String,
    vendor_id: u16,
    product_id: u16,
    firmware_version: String,
    serial: String,
}
impl SleepBinding {
    fn from_current(model: &Model, current: &Binding) -> Result<Self> {
        current.validate(model)?;
        let DeviceIdentity::Serial(serial) = &current.identity else {
            return Err(error(
                "SLEEP_IDENTITY_UNVERIFIED",
                "休眠控制需要已核对为稳定且唯一的序列号",
            ));
        };
        if model.id != "air75-v3"
            || !lighting_policy::supports_board_sleep(model, &current.firmware_version)
            || current.vendor_id != 0x19f5
            || current.product_id != 0x1028
            || serial.trim().is_empty()
        {
            return Err(error("SLEEP_UNSUPPORTED", "此设备或固件尚未核对休眠控制"));
        }
        Ok(Self {
            model_id: current.model_id.clone(),
            vendor_id: current.vendor_id,
            product_id: current.product_id,
            firmware_version: current.firmware_version.clone(),
            serial: serial.clone(),
        })
    }
    fn validate(&self, model: &Model) -> Result<()> {
        let current = Binding {
            model_id: self.model_id.clone(),
            vendor_id: self.vendor_id,
            product_id: self.product_id,
            firmware_version: self.firmware_version.clone(),
            lighting_profile: 0,
            identity: DeviceIdentity::Serial(self.serial.clone()),
        };
        if Self::from_current(model, &current)? != *self {
            return Err(error("SLEEP_BACKUP_INVALID", "休眠记录身份无效"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Original {
    binding: SleepBinding,
    pub(crate) original: [u8; 4],
    installed_enable: u8,
}
impl Original {
    fn validate(&self, model: &Model) -> Result<()> {
        self.binding.validate(model)?;
        if self.original[0] != 1 || self.installed_enable != 0 {
            return Err(error(
                "SLEEP_BACKUP_INVALID",
                "休眠记录的原始或接管标记无效",
            ));
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    original_digest: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completed {
    original_digest: String,
    intent_digest: Option<String>,
}
#[derive(Default)]
struct Files {
    original: Option<Vec<u8>>,
    intent: Option<Vec<u8>>,
}
#[derive(Clone)]
pub(crate) struct Watch {
    directory: PathBuf,
    files: Arc<Mutex<Files>>,
}
impl Watch {
    pub(crate) fn intact(&self) -> Result<()> {
        let files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        for (name, expected) in [(ORIGINAL, &files.original), (INTENT, &files.intent)] {
            let path = self.directory.join(name);
            match expected {
                Some(bytes) if read(&path)? == *bytes => {}
                None if !exists(&path)? => {}
                _ => {
                    return Err(error(
                        "SLEEP_BACKUP_CHANGED",
                        "休眠原记录或写入意图已变化，已停止输出",
                    ))
                }
            }
        }
        if exists(&self.directory.join(COMPLETED))? {
            return Err(error(
                "SLEEP_CLEANUP_REQUIRED",
                "休眠完成记录待核对，不重复写入",
            ));
        }
        Ok(())
    }
}
pub(crate) fn require_empty(directory: &Path) -> Result<()> {
    for name in [ORIGINAL, INTENT, COMPLETED] {
        if exists(&directory.join(name))? {
            return Err(error(
                "SLEEP_RECOVERY_REQUIRED",
                "已有整键盘休眠记录，不能建立新灯光基线",
            ));
        }
    }
    Ok(())
}
pub(crate) struct Journal {
    directory: PathBuf,
    model: Model,
    expected: Option<SleepBinding>,
    watch: Watch,
    original: Option<Original>,
    fresh: bool,
    id: u64,
    sequence: u64,
    pub(crate) acquired: bool,
    pub(crate) already_disabled: bool,
    pub(crate) completion: Option<crate::output::SleepCompletion>,
    #[cfg(test)]
    pub(crate) cleanup_fail: bool,
}
impl JournalStore {
    pub(crate) fn sleep_journal(&self, current: &Binding, resume: bool) -> Result<Journal> {
        current.validate(&self.model)?;
        let expected =
            if lighting_policy::supports_board_sleep(&self.model, &current.firmware_version) {
                Some(SleepBinding::from_current(&self.model, current)?)
            } else if resume {
                return Err(error("SLEEP_UNSUPPORTED", "此型号尚未核对休眠控制"));
            } else {
                None
            };
        let mut files = Files::default();
        let original = if resume {
            let bytes = read(&self.directory.join(ORIGINAL))?;
            let saved: Original = decode(&bytes)?;
            saved.validate(&self.model)?;
            if Some(&saved.binding) != expected.as_ref() {
                return Err(error(
                    "SLEEP_BACKUP_DEVICE_MISMATCH",
                    "休眠原记录不属于当前键盘或固件",
                ));
            }
            files.original = Some(bytes);
            if exists(&self.directory.join(INTENT))? {
                files.intent = Some(read(&self.directory.join(INTENT))?);
            }
            Some(saved)
        } else {
            require_empty(&self.directory)?;
            None
        };
        let journal = Journal {
            directory: self.directory.clone(),
            model: self.model.clone(),
            expected,
            watch: Watch {
                directory: self.directory.clone(),
                files: Arc::new(Mutex::new(files)),
            },
            original,
            fresh: !resume,
            id: next_transaction_id(),
            sequence: 0,
            acquired: false,
            already_disabled: false,
            completion: None,
            #[cfg(test)]
            cleanup_fail: false,
        };
        journal.intact()?;
        Ok(journal)
    }
}
impl Journal {
    pub(crate) fn watch(&self) -> Watch {
        self.watch.clone()
    }
    pub(crate) fn supported(&self) -> bool {
        self.expected.is_some()
    }
    pub(crate) fn pending(&self) -> bool {
        self.original.is_some() && self.completion.is_none()
    }
    pub(crate) fn intact(&self) -> Result<()> {
        self.watch.intact()?;
        let files = self.watch.files.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(intent) = &files.intent {
            let saved: Intent = decode(intent)?;
            if files.original.as_deref().map(digest).as_ref() != Some(&saved.original_digest) {
                return Err(error("SLEEP_BACKUP_INVALID", "休眠写入意图与原记录不匹配"));
            }
        }
        if self.sequence > 0 && files.intent.is_none() {
            return Err(error(
                "SLEEP_BACKUP_CHANGED",
                "休眠写入意图丢失，原记录已保留",
            ));
        }
        Ok(())
    }
    pub(crate) fn capture(&mut self, info: [u8; 4]) -> Result<()> {
        self.intact()?;
        if self.original.is_some() || info[0] != 1 {
            return Err(error(
                "SLEEP_BACKUP_INVALID",
                "不能替换休眠基线或保存未开启状态",
            ));
        }
        let saved = Original {
            binding: self
                .expected
                .clone()
                .ok_or_else(|| error("SLEEP_UNSUPPORTED", "休眠控制未核对"))?,
            original: info,
            installed_enable: 0,
        };
        let bytes = encode(&saved)?;
        save_new_at(&self.directory, &self.directory.join(ORIGINAL), &bytes)?;
        self.watch
            .files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .original = Some(bytes);
        self.original = Some(saved);
        self.intact()
    }
    pub(crate) fn original(&self) -> Result<Option<Original>> {
        self.intact()?;
        Ok(self.original.clone())
    }
    pub(crate) fn mutation_started(&self) -> Result<bool> {
        self.intact()?;
        let started = self
            .watch
            .files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .intent
            .is_some();
        if !started && !self.fresh {
            return Err(error(
                "SLEEP_CONFIRMATION_REQUIRED",
                "旧休眠记录缺少写入意图，不能自动判断并重放",
            ));
        }
        Ok(started)
    }
    pub(crate) fn prepare_write(&mut self) -> Result<()> {
        self.intact()?;
        let (original, intent) = {
            let files = self.watch.files.lock().unwrap_or_else(|e| e.into_inner());
            (
                files
                    .original
                    .clone()
                    .ok_or_else(|| error("SLEEP_BACKUP_MISSING", "写入前缺少休眠原记录"))?,
                files.intent.clone(),
            )
        };
        let bytes = encode(&Intent {
            original_digest: digest(&original),
        })?;
        if let Some(saved) = intent {
            if saved != bytes {
                return Err(error("SLEEP_BACKUP_CHANGED", "休眠写入意图已变化"));
            }
        } else {
            save_new_at(&self.directory, &self.directory.join(INTENT), &bytes)?;
            self.watch
                .files
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .intent = Some(bytes);
        }
        self.sequence += 1;
        self.intact()
    }
    pub(crate) fn token(&self) -> (u64, u64) {
        (self.id, self.sequence)
    }
    pub(crate) fn original_digest(&self) -> Result<String> {
        self.intact()?;
        self.watch
            .files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .original
            .as_deref()
            .map(digest)
            .ok_or_else(|| error("SLEEP_BACKUP_MISSING", "休眠原记录缺失"))
    }
    pub(crate) fn finish(
        &mut self,
        proof: crate::output::sleep::Verified,
    ) -> Result<crate::output::SleepCompletion> {
        self.intact()?;
        if proof.token() != self.token()
            || proof.original_digest() != self.original_digest()?
            || proof.no_mutation() == self.mutation_started()?
        {
            return Err(error(
                "SLEEP_RECEIPT_INVALID",
                "休眠恢复凭据不属于本次原记录或最后写入",
            ));
        }
        let files = self.watch.files.lock().unwrap_or_else(|e| e.into_inner());
        let original = files.original.as_deref().unwrap();
        let original_digest = digest(original);
        archive(
            &self.directory,
            &history(&self.directory, &original_digest, None),
            original,
        )?;
        let intent_digest = files.intent.as_deref().map(digest);
        if let (Some(intent), Some(digest)) = (&files.intent, &intent_digest) {
            archive(
                &self.directory,
                &history(&self.directory, &original_digest, Some(digest)),
                intent,
            )?;
        }
        save_new_at(
            &self.directory,
            &self.directory.join(COMPLETED),
            &encode(&Completed {
                original_digest,
                intent_digest,
            })?,
        )?;
        drop(files);
        #[cfg(test)]
        if self.cleanup_fail {
            self.cleanup_fail = false;
            return Err(error("SLEEP_CLEANUP_REQUIRED", "模拟休眠记录清理中断"));
        }
        finish_completed(&self.directory, &self.model)?;
        *self.watch.files.lock().unwrap_or_else(|e| e.into_inner()) = Files::default();
        let report = crate::output::SleepCompletion {
            supported: true,
            restored: true,
            no_mutation: proof.no_mutation(),
            archived: true,
            preserved_external_change: proof.preserved_external_change(),
        };
        self.original = None;
        self.acquired = false;
        self.completion = Some(report.clone());
        Ok(report)
    }
    pub(crate) fn finish_unused(&mut self) -> Result<crate::output::SleepCompletion> {
        self.intact()?;
        if self.original.is_some() {
            return Err(error("SLEEP_VERIFY_REQUIRED", "休眠原记录需要独立恢复验证"));
        }
        let report = crate::output::SleepCompletion {
            supported: self.supported(),
            restored: true,
            no_mutation: true,
            archived: true,
            preserved_external_change: false,
        };
        self.completion = Some(report.clone());
        Ok(report)
    }
}
fn history(directory: &Path, original: &str, intent: Option<&str>) -> PathBuf {
    let suffix = intent.map_or(String::new(), |value| format!(".intent-{value}"));
    directory.join(format!("board-sleep.history-{original}{suffix}.json"))
}
fn archive(directory: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    if exists(path)? {
        if read(path)? != bytes {
            return Err(error(
                "SLEEP_BACKUP_CHANGED",
                "休眠历史副本冲突，原记录已保留",
            ));
        }
        Ok(())
    } else {
        save_new_at(directory, path, bytes)
    }
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn sync_directory(directory: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(directory)
        .and_then(|f| f.sync_all())
        .map_err(|_| error("SLEEP_CLEANUP_REQUIRED", "休眠目录同步未完成"))?;
    #[cfg(windows)]
    let _ = directory;
    Ok(())
}
pub(crate) fn finish_completed(directory: &Path, model: &Model) -> Result<()> {
    finish_completed_bound(directory, model, None)
}
pub(crate) fn finish_completed_bound(
    directory: &Path,
    model: &Model,
    current: Option<&Binding>,
) -> Result<()> {
    let marker = directory.join(COMPLETED);
    if !exists(&marker)? {
        return Ok(());
    }
    let completed: Completed = decode(&read(&marker)?)?;
    if !valid_digest(&completed.original_digest)
        || completed
            .intent_digest
            .as_ref()
            .is_some_and(|d| !valid_digest(d))
    {
        return Err(error("SLEEP_BACKUP_INVALID", "休眠完成记录摘要无效"));
    }
    let original = read(&history(directory, &completed.original_digest, None))?;
    if digest(&original) != completed.original_digest {
        return Err(error("SLEEP_BACKUP_CHANGED", "休眠历史原文不一致"));
    }
    let saved: Original = decode(&original)?;
    saved.validate(model)?;
    if let Some(current) = current {
        if saved.binding != SleepBinding::from_current(model, current)? {
            return Err(error(
                "SLEEP_BACKUP_MISMATCH",
                "休眠完成记录不属于当前键盘或固件",
            ));
        }
    }
    let intent = if let Some(expected) = &completed.intent_digest {
        let bytes = read(&history(
            directory,
            &completed.original_digest,
            Some(expected),
        ))?;
        let saved: Intent = decode(&bytes)?;
        if digest(&bytes) != *expected || saved.original_digest != completed.original_digest {
            return Err(error("SLEEP_BACKUP_CHANGED", "休眠历史意图不一致"));
        }
        Some(bytes)
    } else {
        None
    };
    for (name, bytes) in [(ORIGINAL, Some(&original)), (INTENT, intent.as_ref())] {
        let active = directory.join(name);
        if exists(&active)?
            && bytes.is_none_or(|expected| read(&active).map_or(true, |actual| actual != *expected))
        {
            return Err(error(
                "SLEEP_BACKUP_CHANGED",
                "不同的活动休眠记录已保留，停止清理",
            ));
        }
    }
    for name in [INTENT, ORIGINAL, COMPLETED] {
        let path = directory.join(name);
        if exists(&path)? {
            std::fs::remove_file(path)
                .map_err(|_| error("SLEEP_CLEANUP_REQUIRED", "休眠记录清理未完成，历史已保留"))?;
        }
        sync_directory(directory)?;
    }
    Ok(())
}
