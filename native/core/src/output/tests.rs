use super::*;
use crate::recovery::JournalStore;
use std::fs;
#[path = "../../test-support/lighting_board.rs"]
mod board;
pub(crate) use board::{code, directory, fixture, model, Board};

#[test]
fn setting_and_color_frames_match_the_official_s4_encoder_without_qualifying_new_firmware() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/nuphy-official-s4-frames.json"
    ))
    .unwrap();
    let mut count = 0;
    for row in data["examples"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["command"] == 0xd6 || r["command"] == 0xd8)
    {
        let model = model();
        let mut board = Board::new(&model);
        board.key = row["key"].as_u64().unwrap() as u8;
        board.profile = row["handle"].as_u64().unwrap() as u8;
        let driver = Lighting::open(board, model).unwrap();
        let payload: Vec<u8> = serde_json::from_value(row["payload"].clone()).unwrap();
        let expected: Vec<u8> = serde_json::from_value(row["frame"].clone()).unwrap();
        assert_eq!(
            driver
                .frame(row["command"].as_u64().unwrap() as u8, &payload)
                .unwrap()
                .as_slice(),
            expected
        );
        count += 1;
    }
    assert_eq!(count, 6);
}

#[test]
fn raw_settings_and_rgb_frames_match_the_extracted_swift_encoder() {
    let data = fixture();
    assert!(!data.frames.is_empty());
    for row in data.frames {
        let model = data.models.iter().find(|m| m.id == row.model_id).unwrap();
        let mut board = Board::new(model);
        board.key = row.key;
        board.profile = row.profile;
        let driver = Lighting::open(board, model.clone()).unwrap();
        assert_eq!(
            driver.frame(row.command, &row.payload).unwrap().as_slice(),
            row.frame
        );
        for command in [0xb3, 0xf5, 0xee, 0xd5] {
            assert!(driver.frame(command, &row.payload).is_err());
        }
    }
}

#[test]
fn every_model_and_profile_runs_capture_arm_paint_side_restore_and_cleanup() {
    for model in fixture().models {
        for profile in [0, 1] {
            let (_tmp, directory) = directory();
            let mut board = Board::new(&model);
            board.profile = profile;
            board.plain = profile == 0;
            let original = board.state.clone();
            let original_main = lighting_policy::rendered_palette(
                &model,
                &model.qualified_firmware,
                &board.palette,
            )
            .unwrap();
            let mut driver = Lighting::open(board, model.clone()).unwrap();
            let baseline = driver.capture_baseline().unwrap();
            let mut store = JournalStore::open(&directory, &model).unwrap();
            let mut tx = store.begin(baseline).unwrap();
            driver.arm(&mut tx).unwrap();
            let side = driver.transport.state[9..17].to_vec();
            let colors: Vec<u8> = (0..model.canvas_count * 3)
                .map(|i| ((i * 17 + 7) % 256) as u8)
                .collect();
            assert!(driver.paint(&mut tx, &colors, false).unwrap().readback);
            assert_eq!(&driver.transport.state[9..17], side);
            let count = driver.transport.writes().len();
            assert!(driver.paint(&mut tx, &colors, false).unwrap().skipped);
            assert_eq!(driver.transport.writes().len(), count);
            let mut changed = colors.clone();
            changed[0] ^= 1;
            driver.paint(&mut tx, &changed, false).unwrap();
            assert_eq!(driver.transport.writes().len(), count + 1);
            let last = driver.transport.writes().last().unwrap().to_vec();
            assert_eq!(last[4] ^ driver.key, 4);
            driver.side(&mut tx, [25, 50, 75], 35).unwrap();
            let receipt = driver.restore(&mut tx).unwrap();
            let result = tx.complete(receipt).unwrap();
            assert!(result.verified && !result.no_mutation);
            assert!(lighting_policy::owned_state_matches(
                &model,
                &model.qualified_firmware,
                &original,
                &driver.transport.state
            )
            .unwrap());
            assert_eq!(
                lighting_policy::rendered_palette(
                    &model,
                    &model.qualified_firmware,
                    &driver.transport.palette
                )
                .unwrap(),
                original_main
            );
            assert!(!directory.join(format!("profile-{profile}.json")).exists());
            assert!(directory.read_dir().unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".history-")));
            if model.id == "air75-v3" {
                assert!(driver.transport.waits.contains(&1150));
            }
        }
    }
}

#[test]
fn unsupported_firmware_and_dimmed_custom_originals_never_receive_a_write() {
    let model = model();
    let mut board = Board::new(&model);
    board.firmware = vec![0, 0, 2, 170, 8, 0, 0, 0];
    struct IdentityOnly(Board);
    impl Transport for IdentityOnly {
        fn connection(&self) -> Connection {
            self.0.connection()
        }
        fn pause(&mut self, delay: Duration) -> Result<()> {
            self.0.pause(delay)
        }
        fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
            assert!(matches!(frame[1], 0xa1 | 0xa0 | 0xd1));
            self.0.exchange(frame, timeout)
        }
    }
    assert_eq!(
        code(Lighting::open(IdentityOnly(board), model.clone())),
        "RECOVERY_POLICY_UNVERIFIED"
    );
    for brightness in [0, 40, 99] {
        let mut board = Board::new(&model);
        board.state[0] = 21;
        board.state[1] = brightness;
        let mut driver = Lighting::open(board, model.clone()).unwrap();
        assert_eq!(code(driver.capture_baseline()), "PALETTE_NOT_OBSERVABLE");
        assert!(driver.transport.writes().is_empty());
    }
}

#[test]
fn uncertain_writes_are_not_replayed_and_explicit_recovery_keeps_the_durable_original() {
    for fault in ["timeout", "echo", "route", "readback"] {
        let model = model();
        let (_tmp, directory) = directory();
        let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
        let baseline = driver.capture_baseline().unwrap();
        let mut store = JournalStore::open(&directory, &model).unwrap();
        let mut tx = store.begin(baseline).unwrap();
        driver.arm(&mut tx).unwrap();
        match fault {
            "timeout" => driver.transport.fail_command = Some(0xd8),
            "echo" => driver.transport.bad_echo = Some(0xd8),
            "route" => driver.transport.bad_route = Some(0xd8),
            "readback" => driver.transport.corrupt_color = true,
            _ => unreachable!(),
        }
        let before = driver.transport.writes().len();
        assert!(driver.paint(&mut tx, &vec![200; 252], true).is_err());
        let failed = driver.transport.writes().len();
        assert!(failed > before);
        assert_eq!(
            code(driver.paint(&mut tx, &vec![200; 252], false)),
            "NOT_ARMED"
        );
        assert_eq!(driver.transport.writes().len(), failed);
        assert!(directory.join("profile-1.json").exists());
        let receipt = driver.restore(&mut tx).unwrap();
        assert!(tx.complete(receipt).unwrap().verified);
    }
}

#[test]
fn changed_profile_key_firmware_or_handle_stops_the_remaining_rgb_packets() {
    for change in ["profile", "key", "firmware", "token"] {
        let model = model();
        let (_tmp, directory) = directory();
        let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
        let baseline = driver.capture_baseline().unwrap();
        let mut store = JournalStore::open(&directory, &model).unwrap();
        let mut tx = store.begin(baseline).unwrap();
        driver.arm(&mut tx).unwrap();
        let before = driver.transport.writes().len();
        driver.transport.change_after_write = Some(change);
        assert!(driver.paint(&mut tx, &vec![240; 252], true).is_err());
        assert_eq!(driver.transport.writes().len(), before + 1);
        assert!(driver.restore(&mut tx).is_err());
        assert!(directory.join("profile-1.json").exists());
    }
}

#[test]
fn a_settings_ack_without_applied_state_is_read_back_but_never_resent() {
    let model = model();
    let (_tmp, directory) = directory();
    let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
    let baseline = driver.capture_baseline().unwrap();
    let mut store = JournalStore::open(&directory, &model).unwrap();
    let mut tx = store.begin(baseline).unwrap();
    driver.transport.stuck_state = true;
    assert_eq!(code(driver.arm(&mut tx)), "STATE_VERIFY_FAILED");
    assert_eq!(driver.transport.writes().len(), 1);
    driver.transport.stuck_state = false;
    let receipt = driver.restore(&mut tx).unwrap();
    assert!(tx.complete(receipt).unwrap().verified);
}

#[test]
fn an_unused_original_is_archived_without_overwriting_a_later_user_change() {
    let model = model();
    let (_tmp, directory) = directory();
    let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
    let baseline = driver.capture_baseline().unwrap();
    let mut store = JournalStore::open(&directory, &model).unwrap();
    let mut tx = store.begin(baseline).unwrap();
    driver.transport.state[1] = 25;
    assert_eq!(code(driver.arm(&mut tx)), "SNAPSHOT_SESSION_CHANGED");
    let receipt = driver.restore(&mut tx).unwrap();
    let result = tx.complete(receipt).unwrap();
    assert!(result.no_mutation && !result.verified);
    assert_eq!(driver.transport.state[1], 25);
    assert!(driver.transport.writes().is_empty());
}

#[test]
fn first_capture_crash_after_applied_d6_recovers_stock_settings_without_guessing_a_palette() {
    let model = model();
    let (_tmp, directory) = directory();
    let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
    let original = driver.transport.state.clone();
    let baseline = driver.capture_baseline().unwrap();
    let binding = baseline.binding.clone();
    let mut store = JournalStore::open(&directory, &model).unwrap();
    let mut tx = store.begin(baseline).unwrap();
    driver.transport.fail_command = Some(0xd6);
    assert_eq!(code(driver.arm(&mut tx)), "HID_TIMEOUT");
    drop(tx);
    drop(store);
    let board = driver.into_transport();
    let mut restarted = Lighting::open(board, model.clone()).unwrap();
    let mut store = JournalStore::open(&directory, &model).unwrap();
    let mut tx = store.resume(&binding).unwrap();
    let receipt = restarted.restore(&mut tx).unwrap();
    assert!(tx.complete(receipt).unwrap().verified);
    assert!(lighting_policy::owned_state_matches(
        &model,
        &model.qualified_firmware,
        &original,
        &restarted.transport.state
    )
    .unwrap());
}

#[test]
fn unchanged_frames_still_check_the_device_mode_and_the_original_journal() {
    for fault in ["mode", "journal"] {
        let model = model();
        let (_tmp, directory) = directory();
        let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
        let baseline = driver.capture_baseline().unwrap();
        let mut store = JournalStore::open(&directory, &model).unwrap();
        let mut tx = store.begin(baseline).unwrap();
        driver.arm(&mut tx).unwrap();
        driver.paint(&mut tx, &vec![120; 252], false).unwrap();
        let before = driver.transport.writes().len();
        if fault == "mode" {
            driver.transport.state[0] = 2;
        } else {
            fs::write(directory.join("profile-1.json"), b"changed").unwrap();
        }
        assert!(driver.paint(&mut tx, &vec![120; 252], false).is_err());
        assert_eq!(driver.transport.writes().len(), before);
    }
}

#[test]
fn complete_custom_original_and_preset_drift_are_restored_without_replaying_old_presets() {
    let model = model();
    let (_tmp, directory) = directory();
    let mut board = Board::new(&model);
    board.state[0] = 21;
    board.state[1] = 100;
    board.state[4] = 1;
    board.state[6..9].copy_from_slice(&[255, 255, 255]);
    let original = board.rgb();
    let mut driver = Lighting::open(board, model.clone()).unwrap();
    let baseline = driver.capture_baseline().unwrap();
    let mut store = JournalStore::open(&directory, &model).unwrap();
    let mut tx = store.begin(baseline).unwrap();
    driver.arm(&mut tx).unwrap();
    driver.paint(&mut tx, &vec![12; 252], false).unwrap();
    driver.transport.state[5] = 4;
    driver.transport.state[17] = 4;
    let receipt = driver.restore(&mut tx).unwrap();
    tx.complete(receipt).unwrap();
    assert_eq!(driver.transport.rgb(), original);
    assert_eq!(driver.transport.state[5], 4);
    assert_eq!(driver.transport.state[17], 4);
}

#[test]
fn scoped_errors_and_unwinding_close_once_and_uncertain_restoration_never_retries_on_drop() {
    for failure in ["paint", "unwind", "restore"] {
        let model = model();
        let (_tmp, directory) = directory();
        let mut store = JournalStore::open(&directory, &model).unwrap();
        let mut session = Session::start(Board::new(&model), model.clone(), &mut store).unwrap();
        if failure == "paint" {
            session.lighting.transport.inner.fail_command = Some(0xd8);
            assert_eq!(code(session.paint(&vec![88; 252], true)), "HID_TIMEOUT");
            assert!(session.completion.as_ref().unwrap().verified);
            assert_eq!(code(session.paint(&vec![88; 252], false)), "SESSION_CLOSED");
            drop(session);
            assert!(!directory.join("profile-1.json").exists());
        } else if failure == "unwind" {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let _session = session;
                panic!("simulated actor unwind");
            }));
            assert!(!directory.join("profile-1.json").exists());
        } else {
            session.lighting.transport.inner.fail_command = Some(0xd6);
            assert_eq!(code(session.close()), "HID_TIMEOUT");
            let writes = session.lighting.transport.inner.writes().len();
            drop(session);
            assert!(directory.join("profile-1.json").exists());
            assert!(writes >= 2);
        }
    }
}

#[test]
fn an_unwind_during_initial_takeover_already_has_a_scoped_recovery_owner() {
    let model = model();
    let (_tmp, directory) = directory();
    let mut store = JournalStore::open(&directory, &model).unwrap();
    let mut board = Board::new(&model);
    board.panic_after = Some(0xd6);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _session = Session::start(board, model, &mut store);
    }));
    assert!(outcome.is_err());
    assert!(!directory.join("profile-1.json").exists());
}

#[test]
fn malformed_physical_maps_are_rejected_before_any_transport_operation() {
    for fault in ["duplicate", "missing", "side-index"] {
        let correct = model();
        let mut invalid = correct.clone();
        match fault {
            "duplicate" => invalid.rgb_write_indices[1] = invalid.rgb_write_indices[0],
            "missing" => {
                invalid.rgb_write_indices.pop();
            }
            "side-index" => invalid.rgb_write_indices[0] = invalid.key_count as u8,
            _ => unreachable!(),
        }
        assert_eq!(
            code(Lighting::open(Board::new(&correct), invalid)),
            "INVALID_MODELS"
        );
    }
}
