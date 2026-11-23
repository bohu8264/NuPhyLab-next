use super::*;
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};

pub(super) fn next_transaction_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    baseline_digest: String,
    palette_digest: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    Baseline,
    Palette,
    Intent,
    RgbIntent,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::Palette => "palette",
            Self::Intent => "intent",
            Self::RgbIntent => "rgb-intent",
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    kind: Kind,
    digest: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completed {
    baseline_digest: String,
    artifacts: Vec<Artifact>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub verified: bool,
    pub no_mutation: bool,
    pub archived: bool,
}
pub(super) fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| error("BACKUP_CLEANUP_FAILED", "恢复记录目录同步失败"))?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl JournalStore {
    pub(super) fn marker(&self, profile: u8, kind: &str) -> PathBuf {
        self.directory
            .join(format!("profile-{profile}.{kind}.json"))
    }
    fn active(&self, profile: u8, kind: Kind) -> PathBuf {
        match kind {
            Kind::Baseline => self.path(profile, false),
            Kind::Palette => self.path(profile, true),
            _ => self.marker(profile, kind.name()),
        }
    }
    fn archived(&self, profile: u8, baseline: &str, artifact: &Artifact) -> PathBuf {
        if artifact.kind == Kind::Baseline {
            self.directory
                .join(format!("profile-{profile}.history-{baseline}.json"))
        } else {
            self.directory.join(format!(
                "profile-{profile}.history-{baseline}.{}-{}.json",
                artifact.kind.name(),
                artifact.digest
            ))
        }
    }
    pub(super) fn finish_completed(&mut self) -> Result<()> {
        for profile in 0..=1 {
            self.finish_completed_profile(profile, None)?;
        }
        Ok(())
    }
    pub(crate) fn finish_completed_profile(
        &mut self,
        profile: u8,
        current: Option<&Binding>,
    ) -> Result<bool> {
        let marker = self.marker(profile, "completed");
        if !exists(&marker)? {
            return Ok(false);
        }
        if profile == 0 && function_keys::fence::profile(&self.directory, &self.model)?.is_some() {
            return Ok(false);
        }
        let completed: Completed = decode(&read(&marker)?)?;
        if !digest_valid(&completed.baseline_digest)
            || completed.artifacts.is_empty()
            || completed.artifacts.len() > 4
        {
            return Err(error("INVALID_BACKUP", "完成记录格式无效，原记录已保留"));
        }
        let mut seen = std::collections::HashSet::new();
        let mut baseline = None;
        let mut artifacts = Vec::new();
        for artifact in &completed.artifacts {
            if !digest_valid(&artifact.digest) || !seen.insert(artifact.kind.name()) {
                return Err(error("INVALID_BACKUP", "完成记录摘要或类型无效"));
            }
            let bytes = read(&self.archived(profile, &completed.baseline_digest, artifact))?;
            if digest(&bytes) != artifact.digest {
                return Err(error("BACKUP_CHANGED", "完成记录的历史副本不一致"));
            }
            if artifact.kind == Kind::Baseline {
                if artifact.digest != completed.baseline_digest {
                    return Err(error("INVALID_BACKUP", "完成记录原文摘要不匹配"));
                }
                let saved: Baseline = decode(&bytes)?;
                saved.validate(&self.model)?;
                if current.is_some_and(|binding| binding != &saved.binding) {
                    return Err(error(
                        "BACKUP_DEVICE_MISMATCH",
                        "完成记录不属于当前键盘、固件或档位",
                    ));
                }
                if saved.binding.lighting_profile != profile {
                    return Err(error("INVALID_BACKUP", "完成记录档位不匹配"));
                }
                baseline = Some(saved);
            }
            artifacts.push((artifact, bytes));
        }
        let baseline = baseline.ok_or_else(|| error("INVALID_BACKUP", "完成记录缺少原文"))?;
        if seen.contains(Kind::RgbIntent.name()) && !seen.contains(Kind::Intent.name()) {
            return Err(error("INVALID_BACKUP", "颜色完成记录缺少设置写入意图"));
        }
        // Validate all archives and all remaining active files before
        // deleting anything. A conflicting new record is never removed.
        for (artifact, bytes) in &artifacts {
            match artifact.kind {
                Kind::Palette => {
                    let saved: Palette = decode(bytes)?;
                    if saved.baseline_digest != completed.baseline_digest {
                        return Err(error("INVALID_BACKUP", "原调色板归属不匹配"));
                    }
                    saved.original.validate(&self.model, &baseline.binding)?;
                }
                Kind::Intent | Kind::RgbIntent => {
                    let saved: Intent = decode(bytes)?;
                    if saved.baseline_digest != completed.baseline_digest {
                        return Err(error("INVALID_BACKUP", "写入意图归属不匹配"));
                    }
                    if artifact.kind == Kind::RgbIntent
                        && saved.palette_digest.as_ref()
                            != completed
                                .artifacts
                                .iter()
                                .find(|a| a.kind == Kind::Palette)
                                .map(|a| &a.digest)
                    {
                        return Err(error("INVALID_BACKUP", "颜色写入意图缺少对应原调色板"));
                    }
                    if artifact.kind == Kind::Intent && saved.palette_digest.is_some() {
                        return Err(error("INVALID_BACKUP", "设置写入意图格式无效"));
                    }
                }
                Kind::Baseline => {}
            }
            let active = self.active(profile, artifact.kind);
            if exists(&active)? && read(&active)? != *bytes {
                return Err(error(
                    "BACKUP_CHANGED",
                    "完成清理时发现不同的活动记录，均已保留",
                ));
            }
        }
        // An unlisted artifact cannot be silently orphaned or erased.
        for kind in [Kind::Baseline, Kind::Palette, Kind::Intent, Kind::RgbIntent] {
            if exists(&self.active(profile, kind))? && !seen.contains(kind.name()) {
                return Err(error(
                    "BACKUP_CHANGED",
                    "完成记录之外存在新文件，已停止清理",
                ));
            }
        }
        for kind in [Kind::RgbIntent, Kind::Palette, Kind::Intent, Kind::Baseline] {
            #[cfg(test)]
            if self.cleanup_fail_before == Some(kind.name()) {
                self.cleanup_fail_before = None;
                return Err(error("BACKUP_CLEANUP_FAILED", "模拟清理中断"));
            }
            let path = self.active(profile, kind);
            if exists(&path)? {
                fs::remove_file(path).map_err(|_| {
                    error(
                        "BACKUP_CLEANUP_FAILED",
                        "记录清理未完成，完成标记及历史已保留",
                    )
                })?;
            }
        }
        sync_directory(&self.directory)?;
        fs::remove_file(&marker).map_err(|_| error("BACKUP_CLEANUP_FAILED", "无法清理完成标记"))?;
        sync_directory(&self.directory)?;
        Ok(true)
    }
}
impl Transaction<'_> {
    pub(crate) fn token(&self) -> (u64, u64) {
        (self.id, self.write_sequence)
    }
    pub(crate) fn prepare_recovery(&mut self, current: &Binding) -> Result<()> {
        self.recovery_only = true;
        self.intact(current)
    }
    pub(crate) fn output_guard(&mut self, current: &Binding) -> Result<()> {
        if self.failed || self.recovery_only {
            return Err(error("RECOVERY_REQUIRED", "灯光租约已失效，需要先恢复"));
        }
        if let Err(e) = self.intact(current) {
            self.failed = true;
            return Err(e);
        }
        self.validate_intents()
    }
    pub(super) fn validate_intents(&self) -> Result<()> {
        let profile = self.baseline.binding.lighting_profile;
        let intent = self.store.marker(profile, "intent");
        let rgb = self.store.marker(profile, "rgb-intent");
        if self.write_sequence > 0 && !exists(&intent)? {
            return Err(error("BACKUP_CHANGED", "写入意图记录缺失，已停止事务"));
        }
        for (path, is_rgb) in [(&intent, false), (&rgb, true)] {
            if !exists(path)? {
                continue;
            }
            let saved: Intent = decode(&read(path)?)?;
            if saved.baseline_digest != digest(&self.bytes)
                || (is_rgb
                    && (self.palette.is_none()
                        || saved.palette_digest != self.palette.as_deref().map(digest)
                        || !exists(&intent)?))
                || (!is_rgb && saved.palette_digest.is_some())
            {
                return Err(error("INVALID_BACKUP", "写入意图与原记录或调色板不匹配"));
            }
        }
        Ok(())
    }
    pub fn mutation_started(&mut self) -> Result<bool> {
        self.intact(&self.baseline.binding)?;
        self.validate_intents()?;
        let started = exists(
            &self
                .store
                .marker(self.baseline.binding.lighting_profile, "intent"),
        )?;
        if !started && !self.fresh {
            return Err(error(
                "RECOVERY_CONFIRMATION_REQUIRED",
                "旧记录缺少写入意图，无法自动判断是否改过键盘，原文已保留",
            ));
        }
        Ok(started)
    }
    pub(super) fn record_intent(&mut self, kind: Mutation) -> Result<()> {
        self.validate_intents()?;
        let profile = self.baseline.binding.lighting_profile;
        let path = self.store.marker(profile, "intent");
        let bytes = encode(&Intent {
            baseline_digest: digest(&self.bytes),
            palette_digest: None,
        })?;
        if exists(&path)? {
            if read(&path)? != bytes {
                return Err(error("BACKUP_CHANGED", "写入意图记录已变化"));
            }
        } else {
            self.store.save_new(&path, &bytes)?;
        }
        if matches!(kind, Mutation::Palette) {
            let saved = self
                .palette
                .as_deref()
                .ok_or_else(|| error("BACKUP_INCOMPLETE", "颜色写入前缺少原调色板"))?;
            let path = self.store.marker(profile, "rgb-intent");
            let bytes = encode(&Intent {
                baseline_digest: digest(&self.bytes),
                palette_digest: Some(digest(saved)),
            })?;
            if exists(&path)? {
                if read(&path)? != bytes {
                    return Err(error("BACKUP_CHANGED", "颜色写入意图已变化"));
                }
            } else {
                self.store.save_new(&path, &bytes)?;
            }
        }
        Ok(())
    }
    pub(crate) fn recovery_write<T>(
        &mut self,
        current: &Binding,
        kind: Mutation,
        action: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.recovery_only = true;
        self.intact(current)?;
        if !self.mutation_started()? {
            return Err(error(
                "RECOVERY_REQUIRED",
                "此记录没有设备写入意图，不应重放原设置",
            ));
        }
        self.record_intent(kind)?;
        self.write_sequence += 1;
        let value = action()?;
        self.intact(current)?;
        Ok(value)
    }
    pub fn complete(mut self, receipt: crate::output::VerifiedRestoration) -> Result<Completion> {
        self.recovery_only = true;
        self.intact(&self.baseline.binding)?;
        self.validate_intents()?;
        if !receipt.belongs_to(&self.baseline) || receipt.token() != self.token() {
            return Err(error(
                "RESTORE_RECEIPT_INVALID",
                "恢复凭据不属于当前记录或最后一次写入",
            ));
        }
        let no_mutation = !self.mutation_started()?;
        if receipt.no_mutation() != no_mutation {
            return Err(error("RESTORE_RECEIPT_INVALID", "恢复凭据的写入状态不一致"));
        }
        let profile = self.baseline.binding.lighting_profile;
        let base = digest(&self.bytes);
        let mut artifacts = Vec::new();
        for kind in [Kind::Baseline, Kind::Palette, Kind::Intent, Kind::RgbIntent] {
            let path = self.store.active(profile, kind);
            if !exists(&path)? {
                continue;
            }
            let bytes = read(&path)?;
            let artifact = Artifact {
                kind,
                digest: digest(&bytes),
            };
            let archive = self.store.archived(profile, &base, &artifact);
            if exists(&archive)? {
                if read(&archive)? != bytes {
                    return Err(error("BACKUP_CHANGED", "原记录历史副本冲突，已停止清理"));
                }
            } else {
                self.store.save_new(&archive, &bytes)?;
            }
            artifacts.push(artifact);
        }
        let marker = self.store.marker(profile, "completed");
        self.store.save_new(
            &marker,
            &encode(&Completed {
                baseline_digest: base,
                artifacts,
            })?,
        )?;
        // Unrelated/damaged records in another profile must not prevent
        // this independently verified RGB original from being retired.
        self.store.finish_completed_profile(profile, None)?;
        Ok(Completion {
            verified: !no_mutation,
            no_mutation,
            archived: true,
        })
    }
}

#[cfg(test)]
mod tests;
