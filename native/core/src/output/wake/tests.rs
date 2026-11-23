use super::*;
use crate::{
    output::tests::{code, directory, fixture, model, Board},
    recovery::JournalStore,
};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

struct Write {
    command: u8,
    recovering: bool,
    state: Vec<u8>,
    colors: Vec<u8>,
}
struct Probe {
    board: Board,
    directory: PathBuf,
    writes: Vec<Write>,
    recovering: bool,
    dirty_reads: usize,
    dirty_sample: bool,
    dirty_index: usize,
    black_reads: usize,
    side_indicator: bool,
    drift: bool,
    palette_saved: bool,
}
#[derive(Clone)]
struct Observed(Arc<Mutex<Probe>>);
impl Observed {
    fn new(board: Board, directory: PathBuf) -> Self {
        Self(Arc::new(Mutex::new(Probe {
            board,
            directory,
            writes: vec![],
            recovering: false,
            dirty_reads: 0,
            dirty_sample: false,
            dirty_index: 0,
            black_reads: 0,
            side_indicator: false,
            drift: false,
            palette_saved: false,
        })))
    }
}
impl Transport for Observed {
    fn connection(&self) -> Connection {
        self.0.lock().unwrap().board.connection()
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.0.lock().unwrap().board.pause(delay)
    }
    fn begin_recovery(&mut self) {
        self.0.lock().unwrap().recovering = true;
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        let mut probe = self.0.lock().unwrap();
        if frame[1] == 0xd8 && !probe.recovering && !probe.palette_saved {
            let original: serde_json::Value = serde_json::from_slice(
                &fs::read(
                    probe
                        .directory
                        .join(format!("profile-{}.json", probe.board.profile)),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(original["data"]["state"][10], 45);
            let palette: serde_json::Value = serde_json::from_slice(
                &fs::read(
                    probe
                        .directory
                        .join(format!("profile-{}.palette.json", probe.board.profile)),
                )
                .unwrap(),
            )
            .unwrap();
            let colors: Vec<u8> =
                serde_json::from_value(palette["data"]["original"]["colors"].clone()).unwrap();
            assert_eq!(
                lighting_policy::rendered_palette(
                    &probe.board.model,
                    &probe.board.model.qualified_firmware,
                    &colors
                )
                .unwrap(),
                lighting_policy::rendered_palette(
                    &probe.board.model,
                    &probe.board.model.qualified_firmware,
                    &probe.board.palette
                )
                .unwrap()
            );
            probe.palette_saved = true;
        }
        let result = probe.board.exchange(frame, timeout);
        if matches!(frame[1], 0xd6 | 0xd8 | 0xf5) {
            let value = Write {
                command: frame[1],
                recovering: probe.recovering,
                state: probe.board.state.clone(),
                colors: probe.board.rgb(),
            };
            probe.writes.push(value);
        }
        let mut reply = result?;
        if frame[1] == 0xd2
            && !probe.recovering
            && probe.board.state[0] == 21
            && probe.board.palette.iter().all(|&v| v == 0)
        {
            let key = probe.board.key;
            let address = usize::from(frame[5] ^ key) | (usize::from(frame[6] ^ key) << 8);
            let length = usize::from(frame[4] ^ key);
            if address == 0 {
                probe.black_reads += 1;
                probe.dirty_sample = probe.dirty_reads > 0;
                probe.dirty_reads = probe.dirty_reads.saturating_sub(1);
                if probe.drift {
                    probe.board.state[2] ^= 1;
                    probe.drift = false;
                }
            }
            for index in [
                if probe.dirty_sample {
                    Some(probe.dirty_index * 3)
                } else {
                    None
                },
                if probe.side_indicator {
                    Some(probe.board.model.key_count * 3)
                } else {
                    None
                },
            ]
            .into_iter()
            .flatten()
            {
                if (address..address + length).contains(&index) {
                    reply[8 + index - address] = 17 ^ key;
                }
            }
            reply[3] = crate::checksum(&reply);
        }
        Ok(reply)
    }
}
fn assert_restored(observed: &Observed, original: &Board) {
    let probe = observed.0.lock().unwrap();
    assert_eq!(probe.board.state, original.state);
    assert_eq!(probe.board.rgb(), original.rgb());
    assert_eq!(probe.board.sleep, original.sleep);
}
#[test]
fn every_qualified_model_and_profile_saves_palette_before_blackout_and_restores() {
    for model in fixture().models {
        for profile in [0, 1] {
            let (_tmp, dir) = directory();
            let mut original = Board::new(&model);
            original.profile = profile;
            let observed = Observed::new(original.clone(), dir.clone());
            let mut store = JournalStore::open(&dir, &model).unwrap();
            let mut session = Session::start_kind(
                observed.clone(),
                model.clone(),
                &mut store,
                Some(profile),
                ArmKind::ConnectionWake,
                |_| {},
            )
            .unwrap();
            let preparation = session.connection_wake_preparation().unwrap();
            assert!(
                preparation.main_black_verified
                    && preparation.side_muted
                    && preparation.all_lights_black
                    && preparation.palette_exposure_required
            );
            {
                let p = observed.0.lock().unwrap();
                assert!(p.palette_saved);
                let writes: Vec<_> = p
                    .writes
                    .iter()
                    .filter(|w| matches!(w.command, 0xd6 | 0xd8))
                    .collect();
                assert_eq!(writes[0].command, 0xd6);
                assert_eq!(writes[0].state[10], 0);
                assert!(writes
                    .iter()
                    .all(|w| w.colors[model.key_count * 3..].iter().all(|&v| v == 0)));
                assert_eq!(&writes[0].state[14..17], &[0, 0, 0]);
                assert_eq!(
                    p.board.rgb(),
                    vec![0; (model.key_count + model.side_count) * 3]
                );
            }
            let before = observed.0.lock().unwrap().writes.len();
            let cached = session
                .paint(&vec![0; model.canvas_count * 3], false)
                .unwrap();
            assert!(cached.skipped && !cached.readback);
            assert_eq!(observed.0.lock().unwrap().writes.len(), before);
            session
                .paint(&vec![51; model.canvas_count * 3], true)
                .unwrap();
            session.finish_once().unwrap();
            assert_restored(&observed, &original);
        }
    }
}
#[test]
fn custom_original_uses_its_existing_observation_and_retains_the_original() {
    let model = model();
    let (_tmp, dir) = directory();
    let mut original = Board::new(&model);
    original.state[0] = 21;
    original.state[1] = 100;
    original.state[4] = 1;
    original.state[6..9].fill(255);
    let observed = Observed::new(original.clone(), dir.clone());
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut session = Session::start_kind(
        observed.clone(),
        model,
        &mut store,
        Some(1),
        ArmKind::ConnectionWake,
        |_| {},
    )
    .unwrap();
    assert!(
        !session
            .connection_wake_preparation()
            .unwrap()
            .palette_exposure_required
    );
    session.finish_once().unwrap();
    assert_restored(&observed, &original);
}
#[test]
fn delayed_black_buffer_only_retries_reads_and_checks_the_unmapped_last_slot() {
    let model = model();
    let (_tmp, dir) = directory();
    let original = Board::new(&model);
    let observed = Observed::new(original.clone(), dir.clone());
    {
        let mut p = observed.0.lock().unwrap();
        p.dirty_reads = 2;
        p.dirty_index = model.key_count - 1;
    }
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut session = Session::start_kind(
        observed.clone(),
        model.clone(),
        &mut store,
        Some(1),
        ArmKind::ConnectionWake,
        |_| {},
    )
    .unwrap();
    {
        let p = observed.0.lock().unwrap();
        assert_eq!(p.black_reads, 3);
        assert_eq!(
            p.writes.iter().filter(|w| w.command == 0xd8).count(),
            model.key_count.div_ceil(13)
        );
    }
    session.finish_once().unwrap();
    assert_restored(&observed, &original);
}
#[test]
fn firmware_owned_side_indication_does_not_hide_unverified_side_settings() {
    let model = model();
    let (_tmp, dir) = directory();
    let original = Board::new(&model);
    let observed = Observed::new(original.clone(), dir.clone());
    observed.0.lock().unwrap().side_indicator = true;
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut session = Session::start_kind(
        observed.clone(),
        model.clone(),
        &mut store,
        Some(1),
        ArmKind::ConnectionWake,
        |_| {},
    )
    .unwrap();
    let p = session.connection_wake_preparation().unwrap();
    assert!(
        p.main_black_verified && p.side_muted && p.side_indicator_observed && !p.all_lights_black
    );
    assert_eq!(observed.0.lock().unwrap().black_reads, 1);
    session
        .paint(&vec![255; model.canvas_count * 3], true)
        .unwrap();
    session.finish_once().unwrap();
    assert_restored(&observed, &original);
}
#[test]
fn bad_blackout_or_changed_settings_stop_and_roll_back_without_replaying_failed_output() {
    for fault in ["main0", "unmapped", "drift", "settingsAck", "paletteAck"] {
        let model = model();
        let (_tmp, dir) = directory();
        let original = Board::new(&model);
        let observed = Observed::new(original.clone(), dir.clone());
        {
            let mut p = observed.0.lock().unwrap();
            match fault {
                "main0" | "unmapped" => {
                    p.dirty_reads = 100;
                    p.dirty_index = if fault == "unmapped" {
                        model.key_count - 1
                    } else {
                        0
                    };
                }
                "drift" => p.drift = true,
                "settingsAck" => p.board.bad_echo = Some(0xd6),
                _ => p.board.bad_echo = Some(0xd8),
            }
        }
        let mut store = JournalStore::open(&dir, &model).unwrap();
        let mut recovered = false;
        let failure = code(Session::start_kind(
            observed.clone(),
            model.clone(),
            &mut store,
            Some(1),
            ArmKind::ConnectionWake,
            |c| recovered = c.is_ok(),
        ));
        assert!(recovered);
        assert!(matches!(
            failure.as_str(),
            "COLOR_VERIFY_FAILED" | "OWNERSHIP_CHANGED" | "WRITE_ACK_MISMATCH"
        ));
        assert_restored(&observed, &original);
        let p = observed.0.lock().unwrap();
        let ordinary: Vec<_> = p
            .writes
            .iter()
            .filter(|w| !w.recovering && w.command == 0xd8)
            .collect();
        assert_eq!(
            ordinary.len(),
            match fault {
                "settingsAck" => 0,
                "paletteAck" => 1,
                _ => model.key_count.div_ceil(13),
            }
        );
    }
}
#[test]
fn old_recovery_records_block_wake_before_new_palette_or_settings_writes() {
    let model = model();
    let (_tmp, dir) = directory();
    let original = Board::new(&model);
    let mut store = JournalStore::open(&dir, &model).unwrap();
    let mut driver = Lighting::open(original.clone(), model.clone()).unwrap();
    let old = driver.capture_baseline().unwrap();
    drop(store.begin(old).unwrap());
    let before = fs::read(dir.join("profile-1.json")).unwrap();
    let observed = Observed::new(original, dir.clone());
    assert_eq!(
        code(Session::start_kind(
            observed.clone(),
            model,
            &mut store,
            Some(1),
            ArmKind::ConnectionWake,
            |_| {}
        )),
        "RECOVERY_REQUIRED"
    );
    assert!(observed.0.lock().unwrap().writes.is_empty());
    assert_eq!(fs::read(dir.join("profile-1.json")).unwrap(), before);
}
