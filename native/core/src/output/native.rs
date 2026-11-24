//! Stock modes own settings only. They never enter custom mode, capture a
//! palette preimage, or send a per-key/side/sleep mutation.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeLightingConfig {
    pub mode: u8,
    pub brightness: u8,
    pub speed: u8,
    pub color: Option<[u8; 3]>,
}
impl NativeLightingConfig {
    pub fn validate(&self) -> Result<()> {
        if !(1..=20).contains(&self.mode) || self.brightness > 100 || self.speed > 4 {
            return Err(error(
                "INVALID_NATIVE_LIGHTING",
                "内置灯效模式、亮度或速度超出范围",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Serialize)]
pub struct NativeSnapshot {
    pub verified: bool,
    pub changed: bool,
    pub state: Vec<u8>,
    pub colors: Vec<u8>,
}
impl<T: Transport> Lighting<T> {
    pub(crate) fn capture_native_baseline(&mut self) -> Result<Baseline> {
        self.start();
        if self.model.id != "kick75" {
            return Err(error(
                "NATIVE_LIGHTING_UNSUPPORTED",
                "此型号尚未开放内置灯效事务",
            ));
        }
        let state = self.state()?;
        if !(1..=20).contains(&state[0]) {
            return Err(error(
                "NATIVE_BASELINE_UNSUPPORTED",
                "请先在官方工具中选择一种内置灯效，再使用此功能",
            ));
        }
        let colors = self.colors()?;
        let after = self.state()?;
        self.native_state_matches(&state, &after)?;
        lighting_policy::state_write_plan(
            &self.model,
            &self.binding.firmware_version,
            &state,
            &after,
        )?;
        Ok(Baseline {
            binding: self.binding.clone(),
            state,
            rendered_colors: colors,
        })
    }
    pub(crate) fn arm_native(&mut self, tx: &mut Transaction<'_>) -> Result<()> {
        self.start();
        if self.model.id != "kick75"
            || tx.baseline().binding != self.binding
            || !(1..=20).contains(&tx.baseline().state[0])
        {
            return Err(error(
                "NATIVE_BASELINE_UNSUPPORTED",
                "此原设置不支持内置灯效事务",
            ));
        }
        let live = self.state()?;
        self.native_state_matches(&tx.baseline().state, &live)?;
        tx.output_guard(&self.binding)?;
        self.armed = true;
        self.failed = false;
        self.last = None;
        self.lease = Some(tx.token().0);
        self.native_expected = Some(live);
        Ok(())
    }
    fn native_state_matches(&self, expected: &[u8], live: &[u8]) -> Result<()> {
        if !lighting_policy::owned_state_matches(
            &self.model,
            &self.binding.firmware_version,
            expected,
            live,
        )? || lighting_policy::preset_fields_differ(
            &self.model,
            &self.binding.firmware_version,
            expected,
            live,
        )? {
            return Err(error(
                "OWNERSHIP_CHANGED",
                "键盘内置灯效设置已被改变，已停止输出",
            ));
        }
        Ok(())
    }
    fn native_guard(&mut self, tx: &mut Transaction<'_>) -> Result<Vec<u8>> {
        if !self.armed || self.failed || self.lease != Some(tx.token().0) {
            return Err(error("NOT_ARMED", "内置灯效事务尚未接管或已失效"));
        }
        let expected = self
            .native_expected
            .clone()
            .ok_or_else(|| error("LIGHTING_PURPOSE_MISMATCH", "当前事务用于逐键绘图"))?;
        self.failed = true;
        tx.output_guard(&self.binding)?;
        let live = self.state()?;
        self.native_state_matches(&expected, &live)?;
        Ok(live)
    }
    fn native_snapshot_inner(
        &mut self,
        tx: &mut Transaction<'_>,
        changed: bool,
    ) -> Result<NativeSnapshot> {
        let state = self.native_guard(tx)?;
        let colors = self.colors()?;
        let after = self.state()?;
        self.native_state_matches(&state, &after)?;
        self.failed = false;
        Ok(NativeSnapshot {
            verified: true,
            changed,
            state: after,
            colors,
        })
    }
    fn native_lighting(
        &mut self,
        tx: &mut Transaction<'_>,
        config: &NativeLightingConfig,
    ) -> Result<NativeSnapshot> {
        config.validate()?;
        self.start();
        let live = self.native_guard(tx)?;
        let mut target = live.clone();
        target[0] = config.mode;
        target[1] = config.brightness;
        target[2] = config.speed;
        if let Some(color) = config.color {
            target[4] = 0;
            target[6..9].copy_from_slice(&color);
        }
        let changed = target != live;
        if changed {
            // Recheck immediately before encoding; preserve every field the
            // command did not explicitly request, including side and presets.
            let current = self.state()?;
            self.native_state_matches(&live, &current)?;
            let plan = lighting_policy::state_write_plan(
                &self.model,
                &self.binding.firmware_version,
                &target,
                &current,
            )?;
            self.send(tx, 0xd6, &plan.payload, false)?;
            self.pause(120)?;
            let mut verified = false;
            for attempt in 0..5 {
                let observed = self.state()?;
                if lighting_policy::preset_fields_differ(
                    &self.model,
                    &self.binding.firmware_version,
                    &target,
                    &observed,
                )? {
                    return Err(error(
                        "OWNERSHIP_CHANGED",
                        "内置灯效预设已被改变，已停止输出",
                    ));
                }
                if lighting_policy::owned_state_matches(
                    &self.model,
                    &self.binding.firmware_version,
                    &target,
                    &observed,
                )? {
                    verified = true;
                    break;
                }
                if attempt < 4 {
                    self.pause(120)?;
                }
            }
            if !verified {
                return Err(error(
                    "STATE_VERIFY_FAILED",
                    "内置灯效设置独立读回不一致，不重发写入",
                ));
            }
            self.native_expected = Some(target);
        }
        self.failed = false;
        self.native_snapshot_inner(tx, changed)
    }
}
impl<T: Transport> Session<'_, T> {
    pub fn native_lighting(&mut self, config: &NativeLightingConfig) -> Result<NativeSnapshot> {
        self.native_operation(Some(config))
    }
    pub fn native_snapshot(&mut self) -> Result<NativeSnapshot> {
        self.native_operation(None)
    }
    fn native_operation(
        &mut self,
        config: Option<&NativeLightingConfig>,
    ) -> Result<NativeSnapshot> {
        if self.close_attempted {
            return Err(error("SESSION_CLOSED", "灯光事务已经停止"));
        }
        let tx = self
            .transaction
            .as_mut()
            .ok_or_else(|| error("SESSION_CLOSED", "灯光事务已经关闭"))?;
        self.lighting
            .ensure_sleep(&self.sleep)
            .and_then(|_| match config {
                Some(config) => self.lighting.native_lighting(tx, config),
                None => {
                    self.lighting.start();
                    self.lighting.native_snapshot_inner(tx, false)
                }
            })
            .map_err(|failure| self.rollback_error(failure))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        output::tests::{code, directory, fixture, Board},
        recovery::JournalStore,
    };
    fn model() -> Model {
        fixture()
            .models
            .into_iter()
            .find(|m| m.id == "kick75")
            .unwrap()
    }
    fn config() -> NativeLightingConfig {
        NativeLightingConfig {
            mode: 3,
            brightness: 45,
            speed: 1,
            color: Some([7, 23, 111]),
        }
    }
    #[test]
    fn native_modes_preserve_palette_side_presets_and_sleep_and_restore_original() {
        for profile in [0, 1] {
            let model = model();
            let (_tmp, dir) = directory();
            let mut board = Board::new(&model);
            board.profile = profile;
            let original = board.clone();
            let mut store = JournalStore::open(&dir, &model).unwrap();
            let mut session = Session::start_kind(
                board,
                model,
                &mut store,
                Some(profile),
                ArmKind::Native,
                |_| {},
            )
            .unwrap();
            assert!(session.lighting.transport.inner.writes().is_empty());
            let sample = session.native_lighting(&config()).unwrap();
            assert!(sample.verified && sample.changed);
            assert_eq!(&sample.state[9..], &original.state[9..]);
            assert_eq!(sample.state[5], original.state[5]);
            let count = session.lighting.transport.inner.writes().len();
            assert!(!session.native_lighting(&config()).unwrap().changed);
            assert_eq!(session.lighting.transport.inner.writes().len(), count);
            session.lighting.transport.inner.palette.fill(173); // Dynamic samples aren't palette proof.
            let before = session.native_snapshot().unwrap();
            session.lighting.transport.inner.corrupt_color = true;
            let dynamic = session.native_snapshot().unwrap();
            assert_ne!(before.colors, dynamic.colors);
            assert_eq!(before.state, dynamic.state);
            session.close().unwrap();
            let board = &session.lighting.transport.inner;
            assert_eq!(board.state, original.state);
            assert_eq!(board.sleep, original.sleep);
            assert!(board.palette.iter().all(|&v| v == 173));
            assert!(board
                .writes()
                .iter()
                .all(|f| f[1] == 0xd6 && (f[8] ^ f[5]) != 21));
            assert!(!board
                .calls
                .iter()
                .any(|f| matches!(f[1], 0xf3 | 0xf5 | 0xd8)));
        }
    }
    #[test]
    fn native_rejects_unsupported_model_firmware_baselines_and_fields_without_mutation() {
        for mode in [0, 21] {
            let model = model();
            let mut board = Board::new(&model);
            board.state[0] = mode;
            if mode == 21 {
                board.state[1] = 100;
            }
            let mut driver = Lighting::open(board, model).unwrap();
            assert_eq!(
                code(driver.capture_native_baseline()),
                "NATIVE_BASELINE_UNSUPPORTED"
            );
            assert!(driver.transport.writes().is_empty());
        }
        for other in fixture().models.into_iter().filter(|m| m.id != "kick75") {
            let board = Board::new(&other);
            let mut driver = Lighting::open(board, other).unwrap();
            assert_eq!(
                code(driver.capture_native_baseline()),
                "NATIVE_LIGHTING_UNSUPPORTED"
            );
            assert!(driver.transport.writes().is_empty());
        }
        for invalid in [
            NativeLightingConfig {
                mode: 21,
                ..config()
            },
            NativeLightingConfig {
                brightness: 101,
                ..config()
            },
            NativeLightingConfig {
                speed: 5,
                ..config()
            },
        ] {
            assert!(invalid.validate().is_err());
        }
        let air = fixture()
            .models
            .into_iter()
            .find(|m| m.id == "air75-v3")
            .unwrap();
        let mut board = Board::new(&air);
        board.firmware[..6].copy_from_slice(&[0, 0, 2, 0xaa, 8, 0]);
        assert_eq!(
            code(Lighting::open(board, air)),
            "RECOVERY_POLICY_UNVERIFIED"
        );
    }
    #[test]
    fn every_stock_mode_and_boundary_parameter_uses_settings_only() {
        let model = model();
        let (_tmp, dir) = directory();
        let board = Board::new(&model);
        let original = board.clone();
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let mut session =
            Session::start_kind(board, model, &mut store, Some(1), ArmKind::Native, |_| {})
                .unwrap();
        for mode in 1..=20 {
            for (brightness, speed) in [(0, 0), (100, 4)] {
                let result = session
                    .native_lighting(&NativeLightingConfig {
                        mode,
                        brightness,
                        speed,
                        color: None,
                    })
                    .unwrap();
                assert_eq!(&result.state[..3], &[mode, brightness, speed]);
                assert_eq!(&result.state[3..], &original.state[3..]);
            }
        }
        session.close().unwrap();
        let board = &session.lighting.transport.inner;
        assert_eq!(board.palette, original.palette);
        assert_eq!(board.state, original.state);
        assert!(board.writes().iter().all(|f| f[1] == 0xd6));
    }
    #[test]
    fn native_ownership_changes_stop_polling_and_failures_restore_once() {
        for fail in ["external", "echo", "readback", "purpose"] {
            let model = model();
            let (_tmp, dir) = directory();
            let original = Board::new(&model);
            let mut store = JournalStore::open(&dir, &model).unwrap();
            let mut session = Session::start_kind(
                original.clone(),
                model,
                &mut store,
                Some(1),
                ArmKind::Native,
                |_| {},
            )
            .unwrap();
            session.native_lighting(&config()).unwrap();
            match fail {
                "external" => {
                    session.lighting.transport.inner.state[2] ^= 1;
                    assert!(session.native_snapshot().is_err());
                }
                "echo" => {
                    session.lighting.transport.inner.bad_echo = Some(0xd6);
                    let mut c = config();
                    c.mode = 5;
                    assert!(session.native_lighting(&c).is_err());
                }
                "readback" => {
                    session.lighting.transport.inner.stuck_state = true;
                    let mut c = config();
                    c.mode = 5;
                    assert!(session.native_lighting(&c).is_err());
                }
                _ => assert_eq!(
                    code(session.side([0, 0, 0], 0)),
                    "LIGHTING_PURPOSE_MISMATCH"
                ),
            }
            let writes = session.lighting.transport.inner.writes().len();
            let _ = session.finish_once();
            assert_eq!(session.lighting.transport.inner.writes().len(), writes); // No blind retry.
            assert!(session.native_snapshot().is_err());
        }
    }
    #[test]
    fn native_cold_recovery_needs_no_palette_and_never_sends_custom_or_rgb() {
        let model = model();
        let (_tmp, dir) = directory();
        let board = Board::new(&model);
        let original = board.state.clone();
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let mut driver = Lighting::open(board, model.clone()).unwrap();
        let baseline = driver.capture_native_baseline().unwrap();
        let mut tx = store.begin(baseline).unwrap();
        driver.arm_native(&mut tx).unwrap();
        driver.native_lighting(&mut tx, &config()).unwrap();
        drop(tx);
        drop(store);
        let mut board = driver.into_transport();
        board.connection.token = "fresh-control".into();
        board.key ^= 17;
        use std::sync::{Arc, Mutex};
        #[derive(Clone)]
        struct Shared(Arc<Mutex<Board>>);
        impl Transport for Shared {
            fn connection(&self) -> Connection {
                self.0.lock().unwrap().connection()
            }
            fn exchange(&mut self, f: &[u8; 64], t: Duration) -> Result<Vec<u8>> {
                self.0.lock().unwrap().exchange(f, t)
            }
            fn pause(&mut self, t: Duration) -> Result<()> {
                self.0.lock().unwrap().pause(t)
            }
        }
        let shared = Shared(Arc::new(Mutex::new(board)));
        let mut store = JournalStore::open_existing(&dir, &model).unwrap();
        // Reuse the actual cold recovery implementation and verify its result.
        let report = recover_existing(shared.clone(), model, &mut store, 1).unwrap();
        assert!(report.complete);
        let board = shared.0.lock().unwrap();
        assert_eq!(board.state, original);
        assert!(board
            .writes()
            .iter()
            .all(|f| f[1] == 0xd6 && (f[8] ^ f[5]) != 21));
    }
}
