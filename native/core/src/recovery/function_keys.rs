//! Private originals for candidate function-key leases. The shared anchor
//! retains both the OS lock and the validated native directory handles.
use super::*;
use crate::function_keys::{Original, VerifiedKeyRestoration};
use std::sync::Arc;
pub(crate) mod fence;
fn name(profile: u8, part: &str) -> String {
    format!("keymap-{profile}{part}.json")
}
pub(crate) fn active_names(profile: u8) -> [String; 3] {
    [
        name(profile, ""),
        name(profile, ".intent"),
        name(profile, ".completed"),
    ]
}
pub(crate) fn pending(directory: &Path, model: &Model) -> Result<Vec<u8>> {
    let mut profiles = Vec::new();
    for profile in 0..=1 {
        let mut found = false;
        for name in active_names(profile) {
            let path = directory.join(name);
            if exists(&path)? {
                regular(&path, false)?;
                found = true;
            }
        }
        if found {
            profiles.push(profile);
        }
    }
    if let Some(profile) = fence::profile(directory, model)? {
        if !profiles.contains(&profile) {
            profiles.push(profile);
            profiles.sort_unstable();
        }
    }
    Ok(profiles)
}
pub(crate) fn require_empty(directory: &Path, model: &Model) -> Result<()> {
    if !pending(directory, model)?.is_empty() {
        return Err(error(
            "FUNCTION_KEYS_RECOVERY_REQUIRED",
            "已有原功能键记录，不能建立新的输出基线",
        ));
    }
    Ok(())
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
pub(crate) struct Journal {
    directory: PathBuf,
    model: Model,
    binding: Binding,
    _anchor: Arc<DirectoryLease>,
    original: Vec<u8>,
    intent: Option<Vec<u8>>,
    files: [Option<Vec<u8>>; 3],
    fence: Vec<u8>,
    fence_present: bool,
    #[cfg(test)]
    pub(crate) cleanup_fail_before: Option<usize>,
}
impl Journal {
    pub(crate) fn create(store: &JournalStore, original: &Original) -> Result<Self> {
        original.validate(&store.model)?;
        if store.recovery_status()?.has_pending() {
            return Err(error(
                "RECOVERY_REQUIRED",
                "已有待处理的原设置，不能覆盖或创建临时功能键",
            ));
        }
        Self::save_original(store, original)
    }
    pub(crate) fn create_for_lighting(
        transaction: &mut Transaction<'_>,
        original: &Original,
    ) -> Result<Self> {
        transaction.output_guard(&original.binding)?;
        original.validate(&transaction.store.model)?;
        let pending = transaction.store.recovery_status()?;
        if pending.lighting_profiles != [original.binding.lighting_profile]
            || pending.board_sleep
            || !pending.keymap_profiles.is_empty()
        {
            return Err(error(
                "RECOVERY_REQUIRED",
                "存在不属于当前所有者的原记录，未接管功能键",
            ));
        }
        Self::save_original(transaction.store, original)
    }
    fn save_original(store: &JournalStore, original: &Original) -> Result<Self> {
        let bytes = encode(original)?;
        let mut journal = Self {
            directory: store.directory.clone(),
            model: store.model.clone(),
            binding: original.binding.clone(),
            _anchor: Arc::clone(&store.anchor),
            original: bytes.clone(),
            intent: None,
            files: [None, None, None],
            fence: fence::bytes(original, &bytes)?,
            fence_present: false,
            #[cfg(test)]
            cleanup_fail_before: None,
        };
        let path = journal.path(0);
        save_new_at(&journal.directory, &path, &bytes)?;
        journal.files[0] = Some(bytes);
        // Both records must be durable before an intent or B3 can exist.
        // The reserved Mac completion cannot collide with the active Win
        // RGB original. create_new never replaces a prior user's record.
        save_new_at(
            &journal.directory,
            &journal.directory.join(fence::NAME),
            &journal.fence,
        )?;
        journal.fence_present = true;
        journal.intact()?;
        Ok(journal)
    }
    pub(crate) fn resume(store: &JournalStore, binding: &Binding) -> Result<Self> {
        crate::function_keys::qualify(&store.model, binding)?;
        let paths = active_names(binding.lighting_profile).map(|n| store.directory.join(n));
        let mut files: [Option<Vec<u8>>; 3] = [None, None, None];
        for (i, path) in paths.iter().enumerate() {
            if exists(path)? {
                files[i] = Some(read(path)?);
            }
        }
        let (original, intent) = if let Some(marker) = &files[2] {
            let completed: Completed = decode(marker)?;
            if !valid_digest(&completed.original_digest)
                || completed
                    .intent_digest
                    .as_ref()
                    .is_some_and(|d| !valid_digest(d))
            {
                return Err(error(
                    "FUNCTION_KEYS_BACKUP_INVALID",
                    "功能键完成记录的摘要无效",
                ));
            }
            let original = read(&history(
                &store.directory,
                binding.lighting_profile,
                &completed.original_digest,
                None,
            ))?;
            if digest(&original) != completed.original_digest {
                return Err(error(
                    "FUNCTION_KEYS_BACKUP_CHANGED",
                    "功能键原历史记录不一致",
                ));
            }
            let intent = completed
                .intent_digest
                .as_ref()
                .map(|d| {
                    read(&history(
                        &store.directory,
                        binding.lighting_profile,
                        &completed.original_digest,
                        Some(d),
                    ))
                })
                .transpose()?;
            if intent.as_ref().map(|b| digest(b)) != completed.intent_digest
                || files[0].as_ref().is_some_and(|b| b != &original)
                || files[1]
                    .as_ref()
                    .is_some_and(|b| Some(b) != intent.as_ref())
            {
                return Err(error(
                    "FUNCTION_KEYS_BACKUP_CHANGED",
                    "功能键完成记录、活动文件与历史不一致",
                ));
            }
            (original, intent)
        } else {
            (
                files[0].clone().ok_or_else(|| {
                    error(
                        "FUNCTION_KEYS_BACKUP_MISSING",
                        "原功能键记录缺失，未处理孤立文件",
                    )
                })?,
                files[1].clone(),
            )
        };
        let record: Original = decode(&original)?;
        record.validate(&store.model)?;
        if &record.binding != binding {
            return Err(error(
                "FUNCTION_KEYS_DEVICE_CHANGED",
                "旧功能键记录与当前设备、固件或档位不一致",
            ));
        }
        validate_intent(&original, intent.as_deref())?;
        let fence = fence::bytes(&record, &original)?;
        let fence_path = store.directory.join(fence::NAME);
        let fence_present = exists(&fence_path)?;
        if fence_present {
            if read(&fence_path)? != fence {
                return Err(error(
                    "FUNCTION_KEYS_LEGACY_GUARD_CHANGED",
                    "旧版兼容保护记录已变化，未继续改键",
                ));
            }
        } else if files[2].is_none() || files[0].is_some() || files[1].is_some() {
            return Err(error(
                "FUNCTION_KEYS_LEGACY_GUARD_MISSING",
                "缺少旧版兼容保护，原功能键记录已保留，未继续写入",
            ));
        }
        Ok(Self {
            directory: store.directory.clone(),
            model: store.model.clone(),
            binding: binding.clone(),
            _anchor: Arc::clone(&store.anchor),
            original,
            intent,
            files,
            fence,
            fence_present,
            #[cfg(test)]
            cleanup_fail_before: None,
        })
    }
    fn path(&self, index: usize) -> PathBuf {
        self.directory
            .join(&active_names(self.binding.lighting_profile)[index])
    }
    pub(crate) fn original(&self) -> Result<Original> {
        let r: Original = decode(&self.original)?;
        r.validate(&self.model)?;
        Ok(r)
    }
    pub(crate) fn has_intent(&self) -> bool {
        self.intent.is_some()
    }
    pub(crate) fn completed(&self) -> bool {
        self.files[2].is_some()
    }
    pub(crate) fn intact(&self) -> Result<()> {
        regular(&self.directory, true)?;
        let path = self.directory.join(fence::NAME);
        if self.fence_present && !exists(&path)? {
            return Err(error(
                "FUNCTION_KEYS_LEGACY_GUARD_MISSING",
                "旧版兼容保护缺失，已停止改键并保留原记录",
            ));
        }
        if if self.fence_present {
            read(&path)? != self.fence
        } else {
            exists(&path)?
        } {
            return Err(error(
                "FUNCTION_KEYS_LEGACY_GUARD_CHANGED",
                "旧版兼容保护发生变化，已停止改键并保留原记录",
            ));
        }
        if !self.fence_present && (self.files[0].is_some() || self.files[1].is_some()) {
            return Err(error(
                "FUNCTION_KEYS_LEGACY_GUARD_MISSING",
                "原功能键仍待处理，不能缺少旧版兼容保护",
            ));
        }
        for (i, expected) in self.files.iter().enumerate() {
            let path = self.path(i);
            match expected {
                Some(bytes) if read(&path)? == *bytes => {}
                None if !exists(&path)? => {}
                _ => {
                    return Err(error(
                        "FUNCTION_KEYS_BACKUP_CHANGED",
                        "原功能键记录、意图或完成文件发生变化",
                    ))
                }
            }
        }
        if self.completed() {
            let archived = history(
                &self.directory,
                self.binding.lighting_profile,
                &digest(&self.original),
                None,
            );
            if read(&archived)? != self.original {
                return Err(error(
                    "FUNCTION_KEYS_BACKUP_CHANGED",
                    "原功能键历史记录已变化",
                ));
            }
            if let Some(intent) = &self.intent {
                if read(&history(
                    &self.directory,
                    self.binding.lighting_profile,
                    &digest(&self.original),
                    Some(&digest(intent)),
                ))? != *intent
                {
                    return Err(error(
                        "FUNCTION_KEYS_BACKUP_CHANGED",
                        "原功能键写入历史已变化",
                    ));
                }
            }
        }
        Ok(())
    }
    pub(crate) fn authorize(&mut self) -> Result<()> {
        self.intact()?;
        if self.intent.is_some() || self.completed() {
            return Err(error(
                "FUNCTION_KEYS_RECOVERY_REQUIRED",
                "功能键事务已经开始，不能重置原记录或重新写入",
            ));
        }
        let bytes = encode(&Intent {
            original_digest: digest(&self.original),
        })?;
        save_new_at(&self.directory, &self.path(1), &bytes)?;
        self.intent = Some(bytes.clone());
        self.files[1] = Some(bytes);
        self.intact()
    }
    pub(crate) fn complete(&mut self, proof: &VerifiedKeyRestoration) -> Result<()> {
        self.intact()?;
        if !proof.matches(&self.original()?) {
            return Err(error(
                "FUNCTION_KEYS_RESTORE_UNVERIFIED",
                "没有与原记录绑定的独立键位读回证明",
            ));
        }
        if !self.completed() {
            archive(
                &self.directory,
                &history(
                    &self.directory,
                    self.binding.lighting_profile,
                    &digest(&self.original),
                    None,
                ),
                &self.original,
            )?;
            if let Some(intent) = &self.intent {
                archive(
                    &self.directory,
                    &history(
                        &self.directory,
                        self.binding.lighting_profile,
                        &digest(&self.original),
                        Some(&digest(intent)),
                    ),
                    intent,
                )?;
            }
            self.intact()?;
            let bytes = encode(&Completed {
                original_digest: digest(&self.original),
                intent_digest: self.intent.as_ref().map(|b| digest(b)),
            })?;
            save_new_at(&self.directory, &self.path(2), &bytes)?;
            self.files[2] = Some(bytes);
        }
        for i in [1, 0, 3, 2] {
            self.intact()?;
            #[cfg(test)]
            if self.cleanup_fail_before == Some(i) {
                self.cleanup_fail_before = None;
                return Err(error(
                    "FUNCTION_KEYS_CLEANUP_REQUIRED",
                    "模拟功能键记录清理中断",
                ));
            }
            if i == 3 {
                // No outstanding key mutation remains: the opaque receipt
                // and durable completion/history already prove restoration.
                // Keep the key completion until the compatibility fence is
                // retired, so an interrupted cleanup remains resumable.
                if self.fence_present {
                    std::fs::remove_file(self.directory.join(fence::NAME)).map_err(|_| {
                        error(
                            "FUNCTION_KEYS_CLEANUP_REQUIRED",
                            "旧版兼容保护尚未清理，完成记录和历史已保留",
                        )
                    })?;
                    self.fence_present = false;
                    completion::sync_directory(&self.directory)?;
                }
            } else if self.files[i].is_some() {
                std::fs::remove_file(self.path(i)).map_err(|_| {
                    error(
                        "FUNCTION_KEYS_CLEANUP_REQUIRED",
                        "功能键恢复已读回，记录清理未完成，历史已保留",
                    )
                })?;
                self.files[i] = None;
                completion::sync_directory(&self.directory)?;
            }
        }
        Ok(())
    }
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn history(directory: &Path, profile: u8, original: &str, intent: Option<&str>) -> PathBuf {
    let suffix = intent.map(|d| format!(".intent-{d}")).unwrap_or_default();
    directory.join(format!("keymap-{profile}.history-{original}{suffix}.json"))
}
fn validate_intent(original: &[u8], intent: Option<&[u8]>) -> Result<()> {
    if let Some(bytes) = intent {
        let value: Intent = decode(bytes)?;
        if value.original_digest != digest(original) {
            return Err(error(
                "FUNCTION_KEYS_BACKUP_CHANGED",
                "功能键写入意图与原记录不匹配",
            ));
        }
    }
    Ok(())
}
fn archive(directory: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    if exists(path)? {
        if read(path)? != bytes {
            return Err(error(
                "FUNCTION_KEYS_BACKUP_CHANGED",
                "已有功能键历史内容不一致，原记录已保留",
            ));
        }
    } else {
        save_new_at(directory, path, bytes)?;
    }
    Ok(())
}
