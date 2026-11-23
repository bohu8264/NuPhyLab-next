use super::*;
use crate::output::tests::{code, directory, fixture, Board};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Default, Clone, Copy)]
enum Fault {
    #[default]
    None,
    Rgb,
    Sleep,
    PanicRgb,
    PanicSleep,
}
struct Shared {
    board: Board,
    frames: Vec<[u8; 64]>,
    fault: Fault,
    remove_on_identity: Vec<PathBuf>,
}
#[derive(Clone)]
struct Probe {
    shared: Arc<Mutex<Shared>>,
    token: String,
}
impl Probe {
    fn new(board: Board) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared {
                board,
                frames: vec![],
                fault: Fault::None,
                remove_on_identity: vec![],
            })),
            token: "reconnected-control-handle".into(),
        }
    }
    fn count(&self, command: u8) -> usize {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .frames
            .iter()
            .filter(|f| f[1] == command)
            .count()
    }
    fn clear(&self) {
        self.shared.lock().unwrap().frames.clear();
    }
}
impl Transport for Probe {
    fn connection(&self) -> Connection {
        let mut v = self
            .shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .board
            .connection();
        v.token = self.token.clone();
        v
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .board
            .pause(delay)
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        let mut v = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        v.frames.push(*frame);
        if frame[1] == 0xa1 {
            for path in std::mem::take(&mut v.remove_on_identity) {
                fs::remove_file(path).unwrap();
            }
        }
        match (v.fault, frame[1]) {
            (Fault::Rgb, 0xd6) => {
                return Err(error("COLD_RGB_TEST_FAILURE", "模拟重开后的 RGB 恢复失败"))
            }
            (Fault::Sleep, 0xf5) => {
                return Err(error("COLD_SLEEP_TEST_FAILURE", "模拟重开后的休眠恢复失败"))
            }
            (Fault::PanicRgb, 0xd6) | (Fault::PanicSleep, 0xf5) => {
                v.fault = Fault::None;
                drop(v);
                panic!("simulated cold recovery unwind")
            }
            _ => {}
        }
        v.board.exchange(frame, timeout)
    }
}
struct Seed {
    probe: Probe,
    state: Vec<u8>,
    rgb: Vec<u8>,
    sleep: [u8; 4],
    baseline: Vec<u8>,
    dir: PathBuf,
}
fn seed(model: &Model, dir: &Path, serial: bool) -> Seed {
    let mut board = Board::new(model);
    if !serial {
        board.connection.serial = None;
    }
    let state = board.state.clone();
    let rgb = board.rgb();
    let sleep = board.sleep;
    let mut store = JournalStore::open(dir, model).unwrap();
    // Raw owners intentionally do not have Session's Drop rollback. This
    // leaves exactly the durable artifacts a terminated process retains.
    let mut lighting = Lighting::open(board, model.clone()).unwrap();
    let mut journal = store.sleep_journal(lighting.binding(), false).unwrap();
    let baseline = lighting.capture_baseline().unwrap();
    let mut transaction = store.begin(baseline).unwrap();
    lighting.acquire_sleep(&mut journal).unwrap();
    lighting.arm(&mut transaction).unwrap();
    lighting
        .paint(&mut transaction, &vec![71; model.key_count * 3], true)
        .unwrap();
    let baseline = fs::read(dir.join("profile-1.json")).unwrap();
    let probe = Probe::new(lighting.into_transport());
    Seed {
        probe,
        state,
        rgb,
        sleep,
        baseline,
        dir: dir.into(),
    }
}
fn models() -> Vec<Model> {
    fixture().models
}
fn restored(seed: &Seed) {
    let data = seed.probe.shared.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(data.board.state, seed.state);
    assert_eq!(data.board.rgb(), seed.rgb);
    assert_eq!(data.board.sleep, seed.sleep);
    assert!(!seed.dir.join("profile-1.json").exists());
    assert!(!seed.dir.join("board-sleep.json").exists());
}
#[test]
fn cold_recovery_retires_a_verified_rgb_marker_without_replay_and_restores_sleep() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let seed = seed(&model, &dir, true);
    let mut store = JournalStore::open_existing(&dir, &model).unwrap();
    let mut driver = Lighting::open(seed.probe.clone(), model.clone()).unwrap();
    store.interrupt_cleanup_before("baseline");
    let mut tx = store.resume(driver.binding()).unwrap();
    let receipt = driver.restore(&mut tx).unwrap();
    assert_eq!(code(tx.complete(receipt)), "BACKUP_CLEANUP_FAILED");
    drop(driver);
    seed.probe.clear();
    let report = recover_existing(seed.probe.clone(), model, &mut store, 1).unwrap();
    assert!(report.complete);
    assert_eq!(report.completed_cleanup.lighting_profiles, vec![1]);
    assert!(matches!(report.lighting, RecoveryPart::NotNeeded));
    assert!(matches!(report.board_sleep, RecoveryPart::Restored { .. }));
    assert_eq!(seed.probe.count(0xd6), 0);
    assert_eq!(seed.probe.count(0xd8), 0);
    restored(&seed);
}
#[test]
fn verified_completion_for_another_serial_cannot_clear_records_or_restore_sleep() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let seed = seed(&model, &dir, true);
    let mut store = JournalStore::open_existing(&dir, &model).unwrap();
    let mut driver = Lighting::open(seed.probe.clone(), model.clone()).unwrap();
    store.interrupt_cleanup_before("baseline");
    let mut tx = store.resume(driver.binding()).unwrap();
    let receipt = driver.restore(&mut tx).unwrap();
    assert_eq!(code(tx.complete(receipt)), "BACKUP_CLEANUP_FAILED");
    drop(driver);
    let original = fs::read(dir.join("profile-1.json")).unwrap();
    let marker = fs::read(dir.join("profile-1.completed.json")).unwrap();
    seed.probe.shared.lock().unwrap().board.connection.serial =
        Some("different-recovery-board".into());
    seed.probe.clear();
    let report = recover_existing(seed.probe.clone(), model, &mut store, 1).unwrap();
    assert!(!report.complete);
    failed(&report.lighting, "BACKUP_DEVICE_MISMATCH");
    assert!(matches!(report.board_sleep, RecoveryPart::Failed { .. }));
    assert_eq!(fs::read(dir.join("profile-1.json")).unwrap(), original);
    assert_eq!(
        fs::read(dir.join("profile-1.completed.json")).unwrap(),
        marker
    );
    assert_eq!(seed.probe.count(0xd6), 0);
    assert_eq!(seed.probe.count(0xd8), 0);
    assert_eq!(seed.probe.count(0xf5), 0);
}
fn failed<T>(value: &RecoveryPart<T>, expected: &str) {
    match value {
        RecoveryPart::Failed { error } => assert_eq!(error.code, expected),
        _ => panic!("expected failed recovery"),
    }
}

#[test]
fn new_handle_restores_existing_rgb_and_sleep_for_every_qualified_model() {
    for model in models() {
        let (_tmp, dir) = directory();
        let seed = seed(&model, &dir, true);
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let before = store.recovery_status().unwrap();
        assert_eq!(before.lighting_profiles, [1]);
        assert_eq!(before.board_sleep, model.id == "air75-v3");
        let report = recover_existing(seed.probe.clone(), model.clone(), &mut store, 1).unwrap();
        assert!(report.complete);
        assert!(!report.remaining.has_pending());
        assert!(matches!(report.lighting, RecoveryPart::Restored { .. }));
        if model.id == "air75-v3" {
            assert!(matches!(report.board_sleep, RecoveryPart::Restored { .. }));
            assert_eq!(seed.probe.count(0xf5), 1);
        } else {
            assert!(matches!(report.board_sleep, RecoveryPart::NotNeeded));
            assert_eq!(seed.probe.count(0xf3) + seed.probe.count(0xf5), 0);
        }
        restored(&seed);
        let count = seed.probe.count(0xd6) + seed.probe.count(0xd8) + seed.probe.count(0xf5);
        let second = recover_existing(seed.probe.clone(), model, &mut store, 1).unwrap();
        assert!(second.complete);
        assert!(matches!(second.lighting, RecoveryPart::NotNeeded));
        assert!(matches!(second.board_sleep, RecoveryPart::NotNeeded));
        assert_eq!(
            seed.probe.count(0xd6) + seed.probe.count(0xd8) + seed.probe.count(0xf5),
            count
        );
    }
}
#[test]
fn recovery_uses_the_new_connection_key_and_archives_original_bytes_exactly() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let seed = seed(&model, &dir, true);
    seed.probe.shared.lock().unwrap().board.key = 0xe3;
    let mut store = JournalStore::open(&dir, &model).unwrap();
    assert!(
        recover_existing(seed.probe.clone(), model, &mut store, 1)
            .unwrap()
            .complete
    );
    restored(&seed);
    let originals: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|v| v.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("profile-1.history-")
        })
        .collect();
    assert!(originals
        .iter()
        .any(|p| fs::read(p).unwrap() == seed.baseline));
    assert!(seed
        .probe
        .shared
        .lock()
        .unwrap()
        .frames
        .iter()
        .filter(|f| matches!(f[1], 0xd6 | 0xd8 | 0xf5))
        .all(|f| f[5] == 0xe3));
}
#[test]
fn missing_blank_and_foreign_serials_never_replay_existing_records() {
    let model = models().remove(0);
    for serial in [None, Some(""), Some("  "), Some("foreign-qualified-board")] {
        let (_tmp, dir) = directory();
        let seed = seed(&model, &dir, true);
        seed.probe.shared.lock().unwrap().board.connection.serial = serial.map(str::to_owned);
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let result = recover_existing(seed.probe.clone(), model.clone(), &mut store, 1);
        if serial == Some("foreign-qualified-board") {
            let report = result.unwrap();
            assert!(!report.complete);
            failed(&report.lighting, "BACKUP_DEVICE_MISMATCH");
            failed(&report.board_sleep, "SLEEP_BACKUP_DEVICE_MISMATCH");
        } else {
            assert_eq!(code(result), "RECOVERY_IDENTITY_UNVERIFIED");
        }
        for command in [0xd5, 0xd6, 0xd8, 0xf3, 0xf5] {
            assert_eq!(seed.probe.count(command), 0);
        }
        assert_eq!(fs::read(dir.join("profile-1.json")).unwrap(), seed.baseline);
    }
}
#[test]
fn an_old_connection_token_cannot_authorize_recovery_without_a_serial() {
    let model = models().remove(1);
    let (_tmp, dir) = directory();
    let seed = seed(&model, &dir, false);
    let mut probe = seed.probe.clone();
    probe.token = "control-handle-1".into();
    let mut store = JournalStore::open(&dir, &model).unwrap();
    assert_eq!(
        code(recover_existing(probe, model, &mut store, 1)),
        "RECOVERY_IDENTITY_UNVERIFIED"
    );
    assert_eq!(seed.probe.count(0xd6) + seed.probe.count(0xd8), 0);
}
#[test]
fn firmware_model_configuration_and_profile_changes_fail_before_mutation() {
    for kind in ["firmware", "model-config", "profile", "invalid-profile"] {
        let model = models().remove(0);
        let (_tmp, dir) = directory();
        let seed = seed(&model, &dir, true);
        let mut selected = model.clone();
        let mut profile = 1;
        if kind == "firmware" {
            seed.probe.shared.lock().unwrap().board.firmware[2] = 2;
        }
        if kind == "model-config" {
            selected.rgb_write_indices.swap(0, 1);
        }
        if kind == "profile" {
            seed.probe.shared.lock().unwrap().board.profile = 0;
        }
        if kind == "invalid-profile" {
            profile = 2;
        }
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let expected = match kind {
            "firmware" => "RECOVERY_POLICY_UNVERIFIED",
            "model-config" => "BACKUP_DEVICE_MISMATCH",
            "profile" => "SESSION_CHANGED",
            _ => "RECOVERY_SELECTION_INVALID",
        };
        assert_eq!(
            code(recover_existing(
                seed.probe.clone(),
                selected,
                &mut store,
                profile
            )),
            expected
        );
        for command in [0xd5, 0xd6, 0xd8, 0xf3, 0xf5] {
            assert_eq!(seed.probe.count(command), 0);
        }
        assert_eq!(fs::read(dir.join("profile-1.json")).unwrap(), seed.baseline);
    }
}
#[test]
fn a_failed_rgb_recovery_still_restores_sleep_and_keeps_the_rgb_original() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let seed = seed(&model, &dir, true);
    seed.probe.shared.lock().unwrap().fault = Fault::Rgb;
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let report = recover_existing(seed.probe.clone(), model, &mut store, 1).unwrap();
    assert!(!report.complete);
    failed(&report.lighting, "COLD_RGB_TEST_FAILURE");
    assert!(matches!(report.board_sleep, RecoveryPart::Restored { .. }));
    assert_eq!(report.remaining.lighting_profiles, [1]);
    assert!(!report.remaining.board_sleep);
    assert_eq!(seed.probe.count(0xd6), 1);
    assert_eq!(seed.probe.count(0xf5), 1);
    assert_eq!(fs::read(dir.join("profile-1.json")).unwrap(), seed.baseline);
    assert_eq!(seed.probe.shared.lock().unwrap().board.sleep, seed.sleep);
}
#[test]
fn a_failed_sleep_recovery_does_not_undo_the_verified_rgb_completion() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let seed = seed(&model, &dir, true);
    seed.probe.shared.lock().unwrap().fault = Fault::Sleep;
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let report = recover_existing(seed.probe.clone(), model.clone(), &mut store, 1).unwrap();
    assert!(!report.complete);
    assert!(matches!(report.lighting, RecoveryPart::Restored { .. }));
    failed(&report.board_sleep, "COLD_SLEEP_TEST_FAILURE");
    assert!(report.remaining.lighting_profiles.is_empty());
    assert!(report.remaining.board_sleep);
    assert!(!dir.join("profile-1.json").exists());
    assert_eq!(seed.probe.count(0xf5), 1);
    seed.probe.shared.lock().unwrap().fault = Fault::None;
    seed.probe.clear();
    let second = recover_existing(seed.probe.clone(), model, &mut store, 1).unwrap();
    assert!(second.complete);
    assert!(matches!(second.lighting, RecoveryPart::NotNeeded));
    assert_eq!(seed.probe.count(0xd6) + seed.probe.count(0xd8), 0);
    restored(&seed);
}
#[test]
fn damaged_rgb_and_missing_intents_do_not_skip_independent_sleep_recovery() {
    for kind in ["baseline", "orphan", "intent"] {
        let model = models().remove(0);
        let (_tmp, dir) = directory();
        let seed = seed(&model, &dir, true);
        match kind {
            "baseline" => fs::write(dir.join("profile-1.json"), b"broken").unwrap(),
            "orphan" => fs::remove_file(dir.join("profile-1.json")).unwrap(),
            _ => {
                fs::remove_file(dir.join("profile-1.rgb-intent.json")).unwrap();
                fs::remove_file(dir.join("profile-1.intent.json")).unwrap();
            }
        }
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let report = recover_existing(seed.probe.clone(), model, &mut store, 1).unwrap();
        assert!(!report.complete);
        assert!(matches!(report.lighting, RecoveryPart::Failed { .. }));
        assert!(matches!(report.board_sleep, RecoveryPart::Restored { .. }));
        assert_eq!(seed.probe.count(0xd6) + seed.probe.count(0xd8), 0);
        assert_eq!(seed.probe.shared.lock().unwrap().board.sleep, seed.sleep);
        assert_eq!(report.remaining.lighting_profiles, [1]);
    }
}
#[test]
fn damaged_sleep_records_do_not_skip_independent_rgb_recovery() {
    for kind in ["baseline", "orphan", "intent"] {
        let model = models().remove(0);
        let (_tmp, dir) = directory();
        let seed = seed(&model, &dir, true);
        match kind {
            "baseline" => fs::write(dir.join("board-sleep.json"), b"broken").unwrap(),
            "orphan" => fs::remove_file(dir.join("board-sleep.json")).unwrap(),
            _ => fs::remove_file(dir.join("board-sleep.intent.json")).unwrap(),
        }
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let report = recover_existing(seed.probe.clone(), model, &mut store, 1).unwrap();
        assert!(!report.complete);
        assert!(matches!(report.lighting, RecoveryPart::Restored { .. }));
        assert!(matches!(report.board_sleep, RecoveryPart::Failed { .. }));
        assert_eq!(seed.probe.count(0xf5), 0);
        assert!(report.remaining.board_sleep);
        assert!(report.remaining.lighting_profiles.is_empty());
    }
}
#[test]
fn another_physical_profile_remains_pending_while_global_sleep_can_be_restored() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let seed = seed(&model, &dir, true);
    seed.probe.shared.lock().unwrap().board.profile = 0;
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let report = recover_existing(seed.probe.clone(), model.clone(), &mut store, 0).unwrap();
    assert!(!report.complete);
    assert!(matches!(report.lighting, RecoveryPart::NotNeeded));
    assert!(matches!(report.board_sleep, RecoveryPart::Restored { .. }));
    assert_eq!(report.remaining.lighting_profiles, [1]);
    assert_eq!(
        seed.probe.count(0xd5) + seed.probe.count(0xd6) + seed.probe.count(0xd8),
        0
    );
    assert_eq!(fs::read(dir.join("profile-1.json")).unwrap(), seed.baseline);
    seed.probe.shared.lock().unwrap().board.profile = 1;
    seed.probe.clear();
    assert!(
        recover_existing(seed.probe.clone(), model, &mut store, 1)
            .unwrap()
            .complete
    );
    restored(&seed);
}
#[test]
fn rgb_unwind_attempts_sleep_once_and_sleep_unwind_keeps_verified_rgb_archived() {
    for fault in [Fault::PanicRgb, Fault::PanicSleep] {
        let model = models().remove(0);
        let (_tmp, dir) = directory();
        let seed = seed(&model, &dir, true);
        seed.probe.shared.lock().unwrap().fault = fault;
        let mut store = JournalStore::open(&dir, &model).unwrap();
        assert!(catch_unwind(AssertUnwindSafe(|| recover_existing(
            seed.probe.clone(),
            model,
            &mut store,
            1
        )))
        .is_err());
        match fault {
            Fault::PanicRgb => {
                assert!(dir.join("profile-1.json").exists());
                assert!(!dir.join("board-sleep.json").exists());
                assert_eq!(seed.probe.count(0xd6), 1);
            }
            _ => {
                assert!(!dir.join("profile-1.json").exists());
                assert!(dir.join("board-sleep.json").exists());
            }
        }
        assert_eq!(seed.probe.count(0xf5), 1);
    }
}
#[test]
fn inventory_counts_orphans_and_completed_markers_without_changing_their_bytes() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let store = JournalStore::open(&dir, &model).unwrap();
    assert!(!store.recovery_status().unwrap().has_pending());
    for file in [
        "profile-0.palette.json",
        "profile-1.completed.json",
        "board-sleep.intent.json",
    ] {
        fs::write(dir.join(file), b"incomplete original").unwrap();
    }
    fs::write(dir.join("profile-0.history-test.json"), b"archive only").unwrap();
    let status = store.recovery_status().unwrap();
    assert_eq!(status.lighting_profiles, [0, 1]);
    assert!(status.board_sleep);
    for file in [
        "profile-0.palette.json",
        "profile-1.completed.json",
        "board-sleep.intent.json",
    ] {
        assert_eq!(fs::read(dir.join(file)).unwrap(), b"incomplete original");
    }
}
#[test]
fn a_completion_marker_added_after_open_blocks_rgb_packets_but_not_sleep_cleanup() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let seed = seed(&model, &dir, true);
    let mut store = JournalStore::open(&dir, &model).unwrap();
    fs::write(
        dir.join("profile-1.completed.json"),
        b"unverified completion marker",
    )
    .unwrap();
    let report = recover_existing(seed.probe.clone(), model, &mut store, 1).unwrap();
    failed(&report.lighting, "BACKUP_CLEANUP_REQUIRED");
    assert!(matches!(report.board_sleep, RecoveryPart::Restored { .. }));
    assert!(!report.complete);
    assert_eq!(seed.probe.count(0xd6) + seed.probe.count(0xd8), 0);
}
#[test]
fn inventory_rejects_active_files_that_are_directories() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let store = JournalStore::open(&dir, &model).unwrap();
    fs::create_dir(dir.join("profile-1.intent.json")).unwrap();
    assert!(store.recovery_status().is_err());
}

fn save_hardware(probe: &Probe, path: &Path) {
    let data = probe.shared.lock().unwrap_or_else(|e| e.into_inner());
    let snapshot = serde_json::json!({"state":data.board.state,"palette":data.board.palette,
        "rgb":data.board.rgb(),"sleep":data.board.sleep,"profile":data.board.profile,
        "commands":data.frames.iter().map(|f|f[1]).collect::<Vec<_>>()});
    let mut file = fs::File::create(path).unwrap();
    std::io::Write::write_all(&mut file, serde_json::to_vec(&snapshot).unwrap().as_slice())
        .unwrap();
    file.sync_all().unwrap();
}
struct ChildOwner(std::process::Child);
impl Drop for ChildOwner {
    fn drop(&mut self) {
        if self.0.try_wait().unwrap().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn spawn_process(dir: &Path, mode: &str) -> ChildOwner {
    ChildOwner(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "output::recover::tests::cold_process_entry",
                "--ignored",
                "--nocapture",
            ])
            .env("NUPHYLAB_COLD_TEST_DIRECTORY", dir)
            .env("NUPHYLAB_COLD_TEST_MODE", mode)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    )
}
fn wait_process(mut child: ChildOwner) -> std::process::ExitStatus {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            return status;
        }
        assert!(std::time::Instant::now() < deadline, "cold child timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn a_killed_owner_is_recovered_in_a_new_process_and_partial_success_survives_another_restart() {
    for mode in ["recover", "recover-rgb-failure", "recover-sleep-failure"] {
        let (_tmp, dir) = directory();
        let mut child = spawn_process(&dir, "paint");
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !dir.join("paint.ready").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "paint worker exited before ready"
            );
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let baseline = fs::read(dir.join("profile-1.json")).unwrap();
        child.0.kill().unwrap();
        assert!(!wait_process(child).success());
        assert_eq!(fs::read(dir.join("profile-1.json")).unwrap(), baseline);
        assert!(dir.join("board-sleep.json").exists());
        assert!(wait_process(spawn_process(&dir, mode)).success());
        let report: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("recovery-report.json")).unwrap()).unwrap();
        if mode != "recover" {
            assert_eq!(report["complete"], false);
            if mode == "recover-rgb-failure" {
                assert_eq!(report["lighting"]["status"], "failed");
                assert_eq!(report["boardSleep"]["status"], "restored");
                assert_eq!(fs::read(dir.join("profile-1.json")).unwrap(), baseline);
            } else {
                assert_eq!(report["lighting"]["status"], "restored");
                assert_eq!(report["boardSleep"]["status"], "failed");
                assert!(!dir.join("profile-1.json").exists());
            }
            assert!(wait_process(spawn_process(&dir, "recover")).success());
            let second: serde_json::Value =
                serde_json::from_slice(&fs::read(dir.join("recovery-report.json")).unwrap())
                    .unwrap();
            assert_eq!(second["complete"], true);
            let completed = if mode == "recover-rgb-failure" {
                "boardSleep"
            } else {
                "lighting"
            };
            assert_eq!(second[completed]["status"], "notNeeded");
        } else {
            assert_eq!(report["complete"], true);
        }
        let observed: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("hardware-state.json")).unwrap()).unwrap();
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("hardware-original.json")).unwrap()).unwrap();
        assert_eq!(observed["state"], original["state"]);
        assert_eq!(observed["rgb"], original["rgb"]);
        assert_eq!(observed["sleep"], original["sleep"]);
        assert!(!dir.join("profile-1.json").exists());
        assert!(!dir.join("board-sleep.json").exists());
    }
}
#[test]
#[ignore = "isolated seed/recovery process invoked by the parent cold-recovery test"]
fn cold_process_entry() {
    let Some(dir) = std::env::var_os("NUPHYLAB_COLD_TEST_DIRECTORY") else {
        return;
    };
    let dir = PathBuf::from(dir);
    let mode = std::env::var("NUPHYLAB_COLD_TEST_MODE").unwrap();
    let model = models().remove(0);
    let hardware = dir.join("hardware-state.json");
    let mut board = Board::new(&model);
    if mode != "paint" {
        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(&hardware).unwrap()).unwrap();
        board.state = serde_json::from_value(state["state"].clone()).unwrap();
        board.palette = serde_json::from_value(state["palette"].clone()).unwrap();
        board.sleep = serde_json::from_value(state["sleep"].clone()).unwrap();
        board.profile = serde_json::from_value(state["profile"].clone()).unwrap();
    }
    let mut probe = Probe::new(board);
    probe.token = format!("cold-process-handle-{}", std::process::id());
    let mut store = JournalStore::open(&dir, &model).unwrap();
    if mode == "paint" {
        save_hardware(&probe, &dir.join("hardware-original.json"));
        let mut session = Session::start(probe.clone(), model, &mut store).unwrap();
        session.paint(&vec![71; 252], true).unwrap();
        save_hardware(&probe, &hardware);
        fs::write(dir.join("paint.ready"), b"ready after verified paint").unwrap();
        // Keep the scoped owner and lock alive until the parent kills this
        // process; EOF would otherwise execute the normal Drop restoration.
        let mut input = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut input).unwrap();
        panic!("paint worker was expected to be terminated by parent");
    } else {
        probe.shared.lock().unwrap().fault = match mode.as_str() {
            "recover-rgb-failure" => Fault::Rgb,
            "recover-sleep-failure" => Fault::Sleep,
            _ => Fault::None,
        };
        let report = recover_existing(probe.clone(), model, &mut store, 1).unwrap();
        fs::write(
            dir.join("recovery-report.json"),
            serde_json::to_vec(&report).unwrap(),
        )
        .unwrap();
        save_hardware(&probe, &hardware);
    }
}

#[test]
fn deleting_another_profiles_files_during_recovery_is_not_a_restoration_receipt() {
    let model = models().remove(0);
    let (_tmp, dir) = directory();
    let seed = seed(&model, &dir, true);
    {
        let mut shared = seed.probe.shared.lock().unwrap();
        shared.board.profile = 0;
        shared.remove_on_identity = [
            "profile-1.json",
            "profile-1.palette.json",
            "profile-1.intent.json",
            "profile-1.rgb-intent.json",
        ]
        .map(|name| dir.join(name))
        .to_vec();
    }
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let report = recover_existing(seed.probe.clone(), model, &mut store, 0).unwrap();
    assert!(!report.complete);
    assert_eq!(report.deferred_profiles, [1]);
    assert!(!report.remaining.has_pending());
    assert!(matches!(report.lighting, RecoveryPart::NotNeeded));
    assert!(matches!(report.board_sleep, RecoveryPart::Restored { .. }));
    assert_eq!(seed.probe.count(0xd6) + seed.probe.count(0xd8), 0);
}
