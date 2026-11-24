use super::*;

/// Presence of v1 active files, including incomplete/orphaned records. This
/// is not a restoration receipt and never clears or rewrites any file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub lighting_profiles: Vec<u8>,
    pub board_sleep: bool,
    pub keymap_profiles: Vec<u8>,
}
impl RecoveryStatus {
    pub fn has_pending(&self) -> bool {
        !self.lighting_profiles.is_empty() || self.board_sleep || !self.keymap_profiles.is_empty()
    }
}
impl JournalStore {
    pub fn observe_recovery(&self) -> Result<RecoveryObservation> {
        let status = self.recovery_status()?;
        let mut entries = Vec::new();
        for profile in 0..=1 {
            for path in [
                self.path(profile, false),
                self.path(profile, true),
                self.marker(profile, "intent"),
                self.marker(profile, "rgb-intent"),
                self.marker(profile, "completed"),
            ] {
                entries.push((
                    path.file_name().unwrap().to_string_lossy().into_owned(),
                    if exists(&path)? {
                        Some(digest(&read(&path)?))
                    } else {
                        None
                    },
                ));
            }
        }
        for name in [
            "board-sleep.json",
            "board-sleep.intent.json",
            "board-sleep.completed.json",
        ] {
            let path = self.directory.join(name);
            entries.push((
                name.into(),
                if exists(&path)? {
                    Some(digest(&read(&path)?))
                } else {
                    None
                },
            ));
        }
        for profile in 0..=1 {
            for name in function_keys::active_names(profile) {
                let path = self.directory.join(&name);
                entries.push((
                    name,
                    if exists(&path)? {
                        Some(digest(&read(&path)?))
                    } else {
                        None
                    },
                ));
            }
        }
        let fingerprint = digest(
            &serde_json::to_vec(&entries).map_err(|_| error("BACKUP_INVALID", "无法核对原记录"))?,
        );
        Ok(RecoveryObservation {
            status,
            fingerprint,
        })
    }
    pub fn require_observation(&self, observed: &RecoveryObservation) -> Result<()> {
        let current = self.observe_recovery()?;
        if current.status != observed.status || current.fingerprint != observed.fingerprint {
            return Err(error(
                "RECOVERY_STATUS_CHANGED",
                "检查后原记录发生变化，请重新检查，未执行恢复",
            ));
        }
        Ok(())
    }
    pub fn recovery_status(&self) -> Result<RecoveryStatus> {
        regular(&self.directory, true)?;
        let present = |path: &Path| -> Result<bool> {
            if !exists(path)? {
                return Ok(false);
            }
            regular(path, false)?;
            Ok(true)
        };
        let mut lighting_profiles = Vec::new();
        let key_fence = function_keys::fence::profile(&self.directory, &self.model)?;
        for profile in 0..=1 {
            let paths = [
                self.path(profile, false),
                self.path(profile, true),
                self.marker(profile, "intent"),
                self.marker(profile, "rgb-intent"),
                self.marker(profile, "completed"),
            ];
            let mut pending = false;
            // Check all entries even after one is found, so a later symlink
            // or unreadable path cannot be hidden by an earlier original.
            for path in paths {
                let found = present(&path)?;
                if !(key_fence.is_some() && path == self.directory.join(function_keys::fence::NAME))
                {
                    pending |= found;
                }
            }
            if pending {
                lighting_profiles.push(profile);
            }
        }
        let mut board_sleep = false;
        for name in [
            "board-sleep.json",
            "board-sleep.intent.json",
            "board-sleep.completed.json",
        ] {
            board_sleep |= present(&self.directory.join(name))?;
        }
        Ok(RecoveryStatus {
            lighting_profiles,
            board_sleep,
            keymap_profiles: function_keys::pending(&self.directory, &self.model)?,
        })
    }
}
/// Process-local observation; neither its digest nor a path is serialized.
#[derive(Clone)]
pub struct RecoveryObservation {
    pub status: RecoveryStatus,
    fingerprint: String,
}
