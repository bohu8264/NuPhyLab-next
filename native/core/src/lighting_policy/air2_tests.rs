use super::*;
use crate::output::tests::{code, directory, model, Board};
use crate::output::{Connection, Lighting, Session, Transport};
use crate::recovery::JournalStore;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Clone)]
struct Observed(Arc<Mutex<Board>>);
impl Transport for Observed {
    fn connection(&self) -> Connection {
        self.0.lock().unwrap().connection()
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        self.0.lock().unwrap().exchange(frame, timeout)
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.0.lock().unwrap().pause(delay)
    }
}

fn oracle() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../tests/fixtures/air75-v3-2.0.0.7-lighting.json"
    ))
    .unwrap()
}
fn air2() -> Board {
    let mut b = Board::new(&model());
    b.firmware = vec![0, 0, 2, 170, 7, 0, 0, 0];
    b
}
#[test]
fn independent_firmware_execution_matches_all_color_and_palette_vectors() {
    let data = oracle();
    let model = model();
    let colors = data["colors"].as_array().unwrap();
    assert_eq!(colors.len(), 8192);
    let boundaries = data["boundaries"].as_array().unwrap();
    assert!(boundaries.len() > 4000);
    for row in colors.iter().chain(boundaries) {
        let rgb: [u8; 3] = serde_json::from_value(row[0].clone()).unwrap();
        let expected: [u8; 3] = serde_json::from_value(row[1].clone()).unwrap();
        assert_eq!(main_color_readback_v2(rgb), expected, "input {rgb:?}");
        assert_eq!(
            main_color_readback_v2(exact_color_input(PolicyKind::Air75V2, expected).unwrap()),
            expected
        );
    }
    let palettes = data["palettes"].as_array().unwrap();
    assert_eq!(palettes.len(), 256);
    for row in palettes {
        let rgb: Vec<u8> = serde_json::from_value(row[0].clone()).unwrap();
        let normal: Vec<u8> = serde_json::from_value(row[1].clone()).unwrap();
        let last: Vec<u8> = serde_json::from_value(row[2].clone()).unwrap();
        let mut expected = normal.repeat(83);
        expected.extend(last);
        assert_eq!(
            rendered_palette(&model, "2.0.0.7", &rgb.repeat(84)).unwrap(),
            expected
        );
    }
    assert_eq!(data["routes"].as_array().unwrap().len(), 18);
    assert_eq!(qualified(&model, "2.0.0.7").unwrap(), PolicyKind::Air75V2);
    assert_eq!(
        code(qualified(&model, "2.0.0.8")),
        "RECOVERY_POLICY_UNVERIFIED"
    );
    assert_eq!(model.qualified_firmware, "1.0.23.6");
    assert!(!supports_board_sleep(&model, "2.0.0.7"));
}
#[test]
fn air2_setting_writes_preserve_preset_fields_and_do_not_accept_cross_firmware_receipts() {
    let model = model();
    let mut target = air2().state;
    target[6..9].copy_from_slice(&main_color_readback_v2([64, 0, 14]));
    let mut live = target.clone();
    live[5] ^= 1;
    live[17] ^= 1;
    let plan = state_write_plan(&model, "2.0.0.7", &target, &live).unwrap();
    assert_eq!(plan.payload.len(), 17);
    assert_eq!(plan.payload[5], live[5]);
    assert_eq!(
        main_color_readback_v2(plan.payload[6..9].try_into().unwrap()),
        target[6..9]
    );
    assert!(owned_state_matches(&model, "2.0.0.7", &target, &live).unwrap());
    assert!(preset_fields_differ(&model, "2.0.0.7", &target, &live).unwrap());
    let mut driver = Lighting::open(air2(), model.clone()).unwrap();
    let baseline = driver.capture_baseline().unwrap();
    let mut changed = baseline.binding.clone();
    changed.firmware_version = "1.0.23.6".into();
    assert_eq!(
        code(plan_restore(&model, &baseline, &changed, &live, None)),
        "BACKUP_DEVICE_MISMATCH"
    );
    assert_eq!(
        crate::bridge::contract().capabilities["lightingWrite"],
        false
    );
    assert_eq!(crate::bridge::contract().capabilities["keymapWrite"], false);
}
#[test]
fn air2_both_profiles_preserve_stock_and_full_custom_originals_through_session_output_and_exit() {
    for profile in [0, 1] {
        for custom in [false, true] {
            let model = model();
            let (_tmp, path) = directory();
            let mut board = air2();
            board.profile = profile;
            if custom {
                board.state[0] = 21;
                board.state[1] = 100;
                board.state[4] = 1;
                board.state[6..9].copy_from_slice(&main_color_readback_v2([87, 255, 191]));
            }
            let original = board.state.clone();
            let original_rgb = board.rgb();
            let original_sleep = board.sleep;
            let mut store = JournalStore::open(&path, &model).unwrap();
            let observed = Observed(Arc::new(Mutex::new(board)));
            let mut session = Session::start(observed.clone(), model.clone(), &mut store).unwrap();
            session.paint(&[31, 47, 63].repeat(84), true).unwrap();
            session.side([71, 19, 37], 25).unwrap();
            assert!(session.close().unwrap().verified);
            drop(session);
            assert!(!path.join(format!("profile-{profile}.json")).exists());
            assert!(!path.join("board-sleep.json").exists());
            let files: Vec<_> = std::fs::read_dir(&path)
                .unwrap()
                .map(|p| p.unwrap().path())
                .collect();
            assert!(files
                .iter()
                .any(|p| p.to_string_lossy().contains(".history-")));
            let board = observed.0.lock().unwrap();
            assert_eq!(board.state, original);
            assert_eq!(board.rgb(), original_rgb);
            assert_eq!(board.sleep, original_sleep);
            assert!(!board.calls.iter().any(|f| matches!(f[1], 0xf3 | 0xf5)));
        }
    }
}
#[test]
fn air2_cold_rgb_recovery_uses_current_firmware_and_keeps_records_on_a_firmware_change() {
    let model = model();
    let (_tmp, path) = directory();
    let observed = Observed(Arc::new(Mutex::new(air2())));
    let original = observed.0.lock().unwrap().state.clone();
    let original_rgb = observed.0.lock().unwrap().rgb();
    {
        let mut lighting = Lighting::open(observed.clone(), model.clone()).unwrap();
        let baseline = lighting.capture_baseline().unwrap();
        let mut store = JournalStore::open(&path, &model).unwrap();
        let mut tx = store.begin(baseline).unwrap();
        lighting.arm(&mut tx).unwrap();
        lighting
            .paint(&mut tx, &[19, 37, 71].repeat(84), true)
            .unwrap();
    }
    let saved = std::fs::read(path.join("profile-1.json")).unwrap();
    let palettes = std::fs::read(path.join("profile-1.palette.json")).unwrap();
    observed.0.lock().unwrap().firmware = vec![23, 0, 1, 170, 6, 0, 0, 0];
    let writes = observed.0.lock().unwrap().writes().len();
    {
        let mut store = JournalStore::open_existing(&path, &model).unwrap();
        let result =
            crate::output::recover_existing(observed.clone(), model.clone(), &mut store, 1)
                .unwrap();
        assert!(!result.complete);
        assert!(matches!(
            result.lighting,
            crate::output::RecoveryPart::Failed { .. }
        ));
    }
    assert_eq!(observed.0.lock().unwrap().writes().len(), writes);
    assert_eq!(std::fs::read(path.join("profile-1.json")).unwrap(), saved);
    assert_eq!(
        std::fs::read(path.join("profile-1.palette.json")).unwrap(),
        palettes
    );
    {
        let mut board = observed.0.lock().unwrap();
        board.firmware = vec![0, 0, 2, 170, 7, 0, 0, 0];
        board.connection.token = "fresh-after-restart".into();
    }
    {
        let mut store = JournalStore::open_existing(&path, &model).unwrap();
        let result =
            crate::output::recover_existing(observed.clone(), model, &mut store, 1).unwrap();
        assert!(result.complete);
    }
    let board = observed.0.lock().unwrap();
    assert_eq!(board.state, original);
    assert_eq!(board.rgb(), original_rgb);
    assert!(!path.join("profile-1.json").exists());
}
#[test]
fn air2_delayed_rgb_observation_does_not_replay_any_palette_packets() {
    let model = model();
    let (_tmp, path) = directory();
    let observed = Observed(Arc::new(Mutex::new(air2())));
    let original = observed.0.lock().unwrap().state.clone();
    let mut store = JournalStore::open(&path, &model).unwrap();
    let mut session = Session::start(observed.clone(), model, &mut store).unwrap();
    let before = observed
        .0
        .lock()
        .unwrap()
        .calls
        .iter()
        .filter(|f| f[1] == 0xd8)
        .count();
    observed.0.lock().unwrap().corrupt_color = true;
    assert!(
        session
            .paint(&[19, 37, 71].repeat(84), true)
            .unwrap()
            .readback
    );
    {
        let board = observed.0.lock().unwrap();
        assert_eq!(
            board.calls.iter().filter(|f| f[1] == 0xd8).count() - before,
            7
        );
        assert!(board.waits.contains(&20));
    }
    assert!(session.close().unwrap().verified);
    assert_eq!(observed.0.lock().unwrap().state, original);
}
