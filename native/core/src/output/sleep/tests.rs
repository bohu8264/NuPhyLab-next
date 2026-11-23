use super::*;
use crate::{
    output::tests::{code, directory, model, Board},
    recovery::JournalStore,
};
use serde::Deserialize;
use std::{
    fs,
    sync::{Arc, Mutex},
};

#[test]
fn enable_frames_match_the_official_encoder_with_no_replayed_time_parameters() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/nuphy-official-s4-frames.json"
    ))
    .unwrap();
    let mut count = 0;
    for row in data["examples"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["command"] == 0xf5)
    {
        let enabled = row["payload"][0].as_u64().unwrap() as u8;
        let key = row["key"].as_u64().unwrap() as u8;
        let expected: Vec<u8> = serde_json::from_value(row["frame"].clone()).unwrap();
        assert_eq!(
            frame(0xf5, Some(enabled), key).unwrap().as_slice(),
            expected
        );
        count += 1;
    }
    assert_eq!(count, 6);
}

#[derive(Default)]
struct Control {
    serial: Option<Option<String>>,
    profile_changed: bool,
    firmware_changed: bool,
    connection_changed: bool,
    lose_disable_ack: bool,
    ignore_disable: bool,
    fail_restore: bool,
    change_before_write: bool,
    journal_directory: Option<std::path::PathBuf>,
    damage_after_rgb: Option<std::path::PathBuf>,
    panic_rgb_restore: bool,
    reads: usize,
}
struct Shared {
    board: Board,
    frames: Vec<[u8; 64]>,
    control: Control,
}
#[derive(Clone)]
struct Probe {
    shared: Arc<Mutex<Shared>>,
    token: String,
}
impl Probe {
    fn new(model: &Model) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared {
                board: Board::new(model),
                frames: vec![],
                control: Control::default(),
            })),
            token: "sleep-handle-1".into(),
        }
    }
    fn reconnect(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
            token: "sleep-handle-2".into(),
        }
    }
    fn enables(&self) -> Vec<u8> {
        self.shared
            .lock()
            .unwrap()
            .frames
            .iter()
            .filter(|f| f[1] == 0xf5)
            .map(|f| f[8] ^ 0x80)
            .collect()
    }
    fn count(&self, command: u8) -> usize {
        self.shared
            .lock()
            .unwrap()
            .frames
            .iter()
            .filter(|f| f[1] == command)
            .count()
    }
    fn sleep(&self) -> [u8; 4] {
        self.shared.lock().unwrap().board.sleep
    }
}
impl Transport for Probe {
    fn connection(&self) -> Connection {
        let data = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        let mut connection = data.board.connection();
        connection.token = self.token.clone();
        if let Some(serial) = &data.control.serial {
            connection.serial = serial.clone();
        }
        if data.control.connection_changed {
            connection.token = "replacement-handle".into();
        }
        connection
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .board
            .pause(delay)
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        let mut data = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        data.frames.push(*frame);
        if frame[1] == 0xf3 {
            data.control.reads += 1;
            if data.control.change_before_write && data.control.reads == 2 {
                data.board.sleep = [1, 9, 44, 173];
            }
        }
        let enabled = frame[8] ^ 0x80;
        if frame[1] == 0xf5 {
            if let Some(directory) = &data.control.journal_directory {
                assert!(!fs::read(directory.join("board-sleep.json"))
                    .unwrap()
                    .is_empty());
                assert!(!fs::read(directory.join("board-sleep.intent.json"))
                    .unwrap()
                    .is_empty());
            }
        }
        if frame[1] == 0xf5 && enabled == 1 && data.control.fail_restore {
            return Err(error("SLEEP_TEST_RESTORE_FAILED", "模拟休眠恢复失败"));
        }
        if frame[1] == 0xd6 && data.control.panic_rgb_restore {
            data.control.panic_rgb_restore = false;
            drop(data);
            panic!("simulated RGB restoration unwind");
        }
        let mut reply = data.board.exchange(frame, timeout)?;
        if frame[1] == 0xd8 {
            if let Some(path) = data.control.damage_after_rgb.take() {
                fs::write(path, b"changed during a colour packet").unwrap();
            }
        }
        if frame[1] == 0xf5 && enabled == 0 {
            if data.control.ignore_disable {
                data.board.sleep[0] = 1;
            }
            if data.control.lose_disable_ack {
                data.control.lose_disable_ack = false;
                return Err(error("HID_TIMEOUT", "模拟启用标记已写入但确认丢失"));
            }
        }
        if frame[1] == 0xa0 && data.control.profile_changed {
            reply[8] ^= 1;
            reply[3] = crate::checksum(&reply);
        }
        if frame[1] == 0xa1 && data.control.firmware_changed {
            reply[10] ^= 3;
            reply[3] = crate::checksum(&reply);
        }
        Ok(reply)
    }
}
fn no_sleep_files(directory: &std::path::Path) {
    for name in [
        "board-sleep.json",
        "board-sleep.intent.json",
        "board-sleep.completed.json",
    ] {
        assert!(!directory.join(name).exists(), "{name} remained");
    }
}

#[test]
fn global_sleep_frames_match_swift_and_never_expose_time_or_profile_writes() {
    #[derive(Deserialize)]
    struct Row {
        key: u8,
        command: u8,
        enabled: Option<u8>,
        frame: Vec<u8>,
    }
    let data: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/windows-lighting-recovery.json"
    )))
    .unwrap();
    let rows: Vec<Row> = serde_json::from_value(data["sleepFrames"].clone()).unwrap();
    assert_eq!(rows.len(), 9);
    for row in rows {
        assert_eq!(
            frame(row.command, row.enabled, row.key).unwrap().as_slice(),
            row.frame
        );
    }
    for (command, enabled) in [
        (0xf3, Some(0)),
        (0xf5, None),
        (0xf5, Some(2)),
        (0xd6, Some(1)),
    ] {
        assert!(frame(command, enabled, 0x80).is_err());
    }
}

#[test]
fn owned_sleep_is_durable_before_one_byte_writes_and_fully_restored_on_close() {
    let model = model();
    let (_tmp, dir) = directory();
    let probe = Probe::new(&model);
    probe.shared.lock().unwrap().control.journal_directory = Some(dir.clone());
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut session = Session::start(probe.clone(), model, &mut store).unwrap();
    assert!(dir.join("board-sleep.json").exists());
    assert!(dir.join("board-sleep.intent.json").exists());
    assert_eq!(probe.sleep(), [0, 6, 30, 0]);
    assert_eq!(probe.enables(), [0]);
    assert!(session.board_sleep_status().active);
    session.paint(&vec![88; 252], true).unwrap();
    session.close().unwrap();
    assert_eq!(probe.sleep(), [1, 6, 30, 0]);
    assert_eq!(probe.enables(), [0, 1]);
    no_sleep_files(&dir);
    assert!(!dir.join("profile-1.json").exists());
    let count = probe.count(0xf5);
    session.close().unwrap();
    assert_eq!(probe.count(0xf5), count);
}

#[test]
fn unqualified_serial_firmware_and_other_models_never_reach_sleep_commands() {
    for kind in ["missing", "blank", "firmware"] {
        let model = model();
        let (_tmp, dir) = directory();
        let probe = Probe::new(&model);
        if kind == "firmware" {
            probe.shared.lock().unwrap().control.firmware_changed = true;
        } else {
            probe.shared.lock().unwrap().control.serial = Some(if kind == "missing" {
                None
            } else {
                Some(" ".into())
            });
        }
        let mut store = JournalStore::open(&dir, &model).unwrap();
        assert!(Session::start(probe.clone(), model, &mut store).is_err());
        assert_eq!(
            probe.count(0xf3) + probe.count(0xf5) + probe.count(0xd6) + probe.count(0xd8),
            0
        );
    }
    let data: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/windows-lighting-recovery.json"
    )))
    .unwrap();
    let models: Vec<Model> = serde_json::from_value(data["models"].clone()).unwrap();
    for model in models.into_iter().filter(|m| m.id != "air75-v3") {
        let (_tmp, dir) = directory();
        let probe = Probe::new(&model);
        probe.shared.lock().unwrap().control.serial = Some(None);
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let mut session = Session::start(probe.clone(), model, &mut store).unwrap();
        assert!(!session.board_sleep_status().supported);
        session.close().unwrap();
        assert_eq!(probe.count(0xf3) + probe.count(0xf5), 0);
    }
}

#[test]
fn already_disabled_sleep_is_not_recaptured_or_reenabled_after_an_external_edit() {
    let model = model();
    let (_tmp, dir) = directory();
    let probe = Probe::new(&model);
    probe.shared.lock().unwrap().board.sleep = [0, 9, 44, 173];
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut session = Session::start(probe.clone(), model, &mut store).unwrap();
    assert!(!session.board_sleep_status().pending);
    assert!(!dir.join("board-sleep.json").exists());
    probe.shared.lock().unwrap().board.sleep[0] = 1;
    assert_eq!(
        code(session.paint(&vec![88; 252], false)),
        "SLEEP_SETTING_CHANGED"
    );
    assert_eq!(probe.sleep(), [1, 9, 44, 173]);
    assert!(probe.enables().is_empty());
    no_sleep_files(&dir);
}

#[test]
fn lost_ack_or_ignored_setter_is_never_replayed_and_acquisition_rolls_back() {
    for lost in [false, true] {
        let model = model();
        let (_tmp, dir) = directory();
        let probe = Probe::new(&model);
        {
            let mut data = probe.shared.lock().unwrap();
            data.control.lose_disable_ack = lost;
            data.control.ignore_disable = !lost;
        }
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let e = code(Session::start(probe.clone(), model, &mut store));
        assert_eq!(
            e,
            if lost {
                "HID_TIMEOUT"
            } else {
                "SLEEP_VERIFY_FAILED"
            }
        );
        assert_eq!(probe.sleep(), [1, 6, 30, 0]);
        assert_eq!(probe.enables(), if lost { vec![0, 1] } else { vec![0] });
        assert_eq!(probe.count(0xd6), 0);
        no_sleep_files(&dir);
        assert!(!dir.join("profile-1.json").exists());
    }
}

#[test]
fn timing_race_before_f5_preserves_live_bytes_without_any_write() {
    let model = model();
    let (_tmp, dir) = directory();
    let probe = Probe::new(&model);
    probe.shared.lock().unwrap().control.change_before_write = true;
    let mut store = JournalStore::open(&dir, &model).unwrap();
    assert_eq!(
        code(Session::start(probe.clone(), model, &mut store)),
        "SLEEP_SETTING_CHANGED"
    );
    assert_eq!(probe.sleep(), [1, 9, 44, 173]);
    assert!(probe.enables().is_empty());
    no_sleep_files(&dir);
}

#[test]
fn a_fresh_unused_sleep_original_never_overwrites_a_later_manual_disable() {
    let model = model();
    let (_tmp, dir) = directory();
    let probe = Probe::new(&model);
    let store = JournalStore::open(&dir, &model).unwrap();
    let mut lighting = Lighting::open(probe.clone(), model).unwrap();
    let mut journal = store.sleep_journal(lighting.binding(), false).unwrap();
    journal.capture([1, 6, 30, 0]).unwrap();
    probe.shared.lock().unwrap().board.sleep[0] = 0;
    let completed = lighting.release_sleep(&mut journal).unwrap();
    assert!(completed.no_mutation && completed.preserved_external_change);
    assert_eq!(probe.sleep(), [0, 6, 30, 0]);
    assert!(probe.enables().is_empty());
    no_sleep_files(&dir);
}

#[test]
fn restoration_preserves_external_time_bytes_and_does_not_fight_external_enable() {
    for external_enable in [false, true] {
        let model = model();
        let (_tmp, dir) = directory();
        let probe = Probe::new(&model);
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let mut session = Session::start(probe.clone(), model, &mut store).unwrap();
        probe.shared.lock().unwrap().board.sleep = [u8::from(external_enable), 9, 44, 173];
        if external_enable {
            assert_eq!(
                code(session.paint(&vec![88; 252], false)),
                "SLEEP_SETTING_CHANGED"
            );
        } else {
            session.close().unwrap();
        }
        assert_eq!(probe.sleep(), [1, 9, 44, 173]);
        assert_eq!(
            probe.enables(),
            if external_enable { vec![0] } else { vec![0, 1] }
        );
        assert!(
            session
                .sleep
                .completion
                .as_ref()
                .unwrap()
                .preserved_external_change
        );
        no_sleep_files(&dir);
    }
}

#[test]
fn profile_switch_does_not_skip_global_sleep_cleanup_while_rgb_original_stays_pending() {
    let model = model();
    let (_tmp, dir) = directory();
    let probe = Probe::new(&model);
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut session = Session::start(probe.clone(), model, &mut store).unwrap();
    probe.shared.lock().unwrap().control.profile_changed = true;
    assert!(session.close().is_err());
    assert_eq!(probe.sleep(), [1, 6, 30, 0]);
    assert!(dir.join("profile-1.json").exists());
    no_sleep_files(&dir);
    assert_eq!(probe.enables(), [0, 1]);
    for frame in probe
        .shared
        .lock()
        .unwrap()
        .frames
        .iter()
        .filter(|f| f[1] == 0xf5)
    {
        assert_eq!(
            [frame[5] ^ 0x80, frame[6] ^ 0x80, frame[7] ^ 0x80],
            [0, 0, 0]
        );
    }
}

#[test]
fn failed_sleep_restore_does_not_block_rgb_retirement_and_drop_does_not_retry() {
    let model = model();
    let (_tmp, dir) = directory();
    let probe = Probe::new(&model);
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut session = Session::start(probe.clone(), model.clone(), &mut store).unwrap();
    let original = fs::read(dir.join("board-sleep.json")).unwrap();
    probe.shared.lock().unwrap().control.fail_restore = true;
    assert_eq!(code(session.close()), "SLEEP_TEST_RESTORE_FAILED");
    assert!(!dir.join("profile-1.json").exists());
    assert_eq!(fs::read(dir.join("board-sleep.json")).unwrap(), original);
    let count = probe.count(0xf5);
    assert!(session.finish_once().is_err());
    drop(session);
    assert_eq!(probe.count(0xf5), count);
    drop(store);
    let mut store = JournalStore::open(&dir, &model).unwrap();
    probe.shared.lock().unwrap().control.fail_restore = false;
    assert_eq!(
        code(Session::start(probe.reconnect(), model.clone(), &mut store)),
        "SLEEP_RECOVERY_REQUIRED"
    );
    assert_eq!(probe.count(0xf5), count);
    recover_board_sleep(probe.reconnect(), model, &mut store).unwrap();
    assert_eq!(probe.sleep(), [1, 6, 30, 0]);
    no_sleep_files(&dir);
}

#[test]
fn damaged_original_or_intent_stops_new_rgb_but_keeps_independent_rgb_cleanup() {
    for artifact in ["board-sleep.json", "board-sleep.intent.json"] {
        let model = model();
        let (_tmp, dir) = directory();
        let probe = Probe::new(&model);
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let mut session = Session::start(probe.clone(), model, &mut store).unwrap();
        fs::write(dir.join(artifact), b"damaged original").unwrap();
        assert!(session.paint(&vec![88; 252], false).is_err());
        let data = probe.shared.lock().unwrap();
        assert!(!data.frames.iter().any(|f| f[1] == 0xd8
            && f[8..8 + usize::from(f[4] ^ 0x80)]
                .as_chunks::<4>()
                .0
                .iter()
                .all(|v| v[1..].iter().all(|&c| c ^ 0x80 == 88))));
        drop(data);
        assert_eq!(probe.sleep()[0], 0);
        assert_eq!(probe.enables(), [0]);
        assert!(!dir.join("profile-1.json").exists());
        assert_eq!(fs::read(dir.join(artifact)).unwrap(), b"damaged original");
    }
}

#[test]
fn verified_cleanup_interruptions_resume_from_files_and_foreign_records_are_retained() {
    for fault in ["none", "active", "marker", "history"] {
        let model = model();
        let (_tmp, dir) = directory();
        let probe = Probe::new(&model);
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let mut session = Session::start(probe.clone(), model.clone(), &mut store).unwrap();
        session.sleep.cleanup_fail = true;
        assert_eq!(code(session.close()), "SLEEP_CLEANUP_REQUIRED");
        assert_eq!(probe.sleep()[0], 1);
        drop(session);
        drop(store);
        let count = probe.count(0xf5);
        match fault {
            "active" => {
                fs::write(dir.join("board-sleep.json"), b"different active original").unwrap()
            }
            "marker" => fs::write(
                dir.join("board-sleep.completed.json"),
                b"damaged completion marker",
            )
            .unwrap(),
            "history" => {
                let file = fs::read_dir(&dir)
                    .unwrap()
                    .map(|v| v.unwrap().path())
                    .find(|p| {
                        p.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with("board-sleep.history-")
                    })
                    .unwrap();
                fs::write(file, b"damaged history").unwrap();
            }
            _ => {}
        }
        let original = fs::read(dir.join("board-sleep.json")).unwrap();
        let opened = JournalStore::open(&dir, &model);
        if fault == "none" {
            opened.unwrap();
            no_sleep_files(&dir);
        } else {
            assert!(opened.is_err());
            assert_eq!(fs::read(dir.join("board-sleep.json")).unwrap(), original);
            assert!(dir.join("board-sleep.completed.json").exists());
        }
        assert_eq!(probe.count(0xf5), count);
    }
}

#[test]
fn cold_recovery_requires_qualified_matching_serial_and_durable_write_intent() {
    for kind in ["foreign", "missing", "no-intent"] {
        let model = model();
        let (_tmp, dir) = directory();
        let probe = Probe::new(&model);
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let mut session = Session::start(probe.clone(), model.clone(), &mut store).unwrap();
        session.close_attempted = true;
        drop(session);
        drop(store);
        let original = fs::read(dir.join("board-sleep.json")).unwrap();
        let count = probe.count(0xf5);
        if kind == "no-intent" {
            fs::remove_file(dir.join("board-sleep.intent.json")).unwrap();
        } else {
            probe.shared.lock().unwrap().control.serial = Some(if kind == "missing" {
                None
            } else {
                Some("different-keyboard".into())
            });
        }
        let mut store = JournalStore::open(&dir, &model).unwrap();
        assert!(recover_board_sleep(probe.reconnect(), model, &mut store).is_err());
        assert_eq!(probe.count(0xf5), count);
        assert_eq!(fs::read(dir.join("board-sleep.json")).unwrap(), original);
    }
}

#[test]
fn an_rgb_restoration_unwind_still_releases_sleep_without_a_drop_replay() {
    let model = model();
    let (_tmp, dir) = directory();
    let probe = Probe::new(&model);
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut session = Session::start(probe.clone(), model, &mut store).unwrap();
    probe.shared.lock().unwrap().control.panic_rgb_restore = true;
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| session.close())).is_err());
    assert_eq!(probe.sleep(), [1, 6, 30, 0]);
    no_sleep_files(&dir);
    assert!(dir.join("profile-1.json").exists());
    let count = probe.count(0xf5);
    drop(session);
    assert_eq!(probe.count(0xf5), count);
}

#[test]
fn sleep_journal_changes_inside_a_packet_stop_the_remaining_requested_colours() {
    let model = model();
    let (_tmp, dir) = directory();
    let probe = Probe::new(&model);
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut session = Session::start(probe.clone(), model, &mut store).unwrap();
    probe.shared.lock().unwrap().control.damage_after_rgb = Some(dir.join("board-sleep.json"));
    assert!(session.paint(&vec![88; 252], false).is_err());
    let data = probe.shared.lock().unwrap();
    assert_eq!(
        data.frames
            .iter()
            .filter(|f| f[1] == 0xd8
                && f[8..8 + usize::from(f[4] ^ 0x80)]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .all(|v| v[1..].iter().all(|&c| c ^ 0x80 == 88)))
            .count(),
        1
    );
    assert_eq!(data.board.sleep[0], 0);
    drop(data);
    assert_eq!(probe.enables(), [0]);
    assert!(!dir.join("profile-1.json").exists());
}

#[test]
fn sleep_completion_receipts_are_bound_to_the_instance_original_and_last_attempt() {
    for mismatch in ["instance", "write", "original", "mutation"] {
        let model = model();
        let (_tmp, dir) = directory();
        let probe = Probe::new(&model);
        let store = JournalStore::open(&dir, &model).unwrap();
        let lighting = Lighting::open(probe, model).unwrap();
        let mut journal = store.sleep_journal(lighting.binding(), false).unwrap();
        journal.capture([1, 6, 30, 0]).unwrap();
        journal.prepare_write().unwrap();
        let original = fs::read(dir.join("board-sleep.json")).unwrap();
        let mut proof = Verified {
            token: journal.token(),
            original_digest: journal.original_digest().unwrap(),
            no_mutation: false,
            preserved_external_change: false,
        };
        match mismatch {
            "instance" => proof.token.0 += 1,
            "write" => proof.token.1 += 1,
            "original" => proof.original_digest = "0".repeat(64),
            "mutation" => proof.no_mutation = true,
            _ => unreachable!(),
        }
        assert_eq!(code(journal.finish(proof)), "SLEEP_RECEIPT_INVALID");
        assert_eq!(fs::read(dir.join("board-sleep.json")).unwrap(), original);
        assert!(!dir.join("board-sleep.completed.json").exists());
    }
}
