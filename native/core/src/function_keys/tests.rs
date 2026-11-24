use super::*;
use crate::output::tests::{code, directory, fixture, Board};
use std::{fs, path::PathBuf};
fn model() -> Model {
    fixture()
        .models
        .into_iter()
        .find(|m| m.id == "air75-v3")
        .unwrap()
}
#[derive(Clone)]
struct Keyboard {
    board: Board,
    layers: Vec<Vec<u16>>,
    defaults: [Vec<u16>; 2],
    writes: Vec<[u8; 64]>,
    fault: &'static str,
    directory: Option<PathBuf>,
    deadline_seen: Vec<Duration>,
    pending_write: Option<(usize, usize, u16)>,
}
impl Keyboard {
    fn new() -> Self {
        let model = model();
        let count = keymap::key_count(&model).unwrap();
        let mut board = Board::new(&model);
        board.firmware = vec![0, 0, 2, 0xaa, 7, 0, 0, 0];
        let mut layers = vec![vec![4; count]; 8];
        for (layer, values) in layers.iter_mut().enumerate() {
            values[count - 1] = 0x8100 + layer as u16;
        }
        let mut defaults = [layers[0].clone(), layers[4].clone()];
        for (values, base) in defaults.iter_mut().zip([0x8000u16, 57]) {
            for (k, value) in values.iter_mut().enumerate().take(13).skip(1) {
                *value = base + k as u16;
            }
        }
        layers[0] = defaults[0].clone();
        layers[4] = defaults[1].clone();
        Self {
            board,
            layers,
            defaults,
            writes: vec![],
            fault: "",
            directory: None,
            deadline_seen: vec![],
            pending_write: None,
        }
    }
    fn store(&mut self) -> (tempfile::TempDir, JournalStore) {
        let (tmp, path) = directory();
        self.directory = Some(path.clone());
        let store = JournalStore::open(&path, &model()).unwrap();
        (tmp, store)
    }
    fn values(&self) -> Vec<u16> {
        self.layers[4].clone()
    }
}
impl Transport for Keyboard {
    fn connection(&self) -> Connection {
        self.board.connection()
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        self.deadline_seen.push(timeout);
        assert!(!timeout.is_zero() && timeout <= Duration::from_millis(1200));
        if !matches!(frame[1], 0xb1..=0xb3) {
            return self.board.exchange(frame, timeout);
        }
        assert_eq!(frame[3], crate::checksum(frame));
        let key = self.board.key;
        let length = usize::from(frame[4] ^ key);
        let address = u16::from_le_bytes([frame[5] ^ key, frame[6] ^ key]) as usize;
        assert_eq!(frame[7] ^ key, 0);
        assert!(length <= 56 && length.is_multiple_of(2));
        let size = keymap::key_count(&model()).unwrap() * 2;
        let layer = address / size;
        let offset = address % size;
        assert!(offset + length <= size && layer < 8);
        let bytes = if frame[1] == 0xb3 {
            assert_eq!(
                layer, 4,
                "production transaction must write only the Win base layer"
            );
            assert_eq!(length, 2);
            assert!(offset / 2 < usize::from(model().rows) * usize::from(model().columns));
            if let Some(path) = &self.directory {
                assert!(path.join("keymap-1.json").is_file());
                assert!(path.join("keymap-1.intent.json").is_file());
                assert!(path.join("profile-0.json").is_file());
                let original: serde_json::Value =
                    serde_json::from_slice(&fs::read(path.join("keymap-1.json")).unwrap()).unwrap();
                assert_eq!(original["data"]["active"].as_array().unwrap().len(), 98);
            }
            self.writes.push(*frame);
            let payload = [frame[8] ^ key, frame[9] ^ key];
            if matches!(self.fault, "deferred" | "unsettled") {
                self.pending_write = Some((layer, offset / 2, u16::from_be_bytes(payload)));
            } else if self.fault != "noCommit" {
                self.layers[layer][offset / 2] = u16::from_be_bytes(payload);
            }
            match self.fault {
                "timeout" => {
                    self.fault = "";
                    return Err(error("HID_TIMEOUT", "模拟 ACK 丢失"));
                }
                "external" => {
                    self.layers[layer][offset / 2] = 0xffff;
                    self.fault = "";
                }
                "journal" => {
                    let path = self.directory.as_ref().unwrap().join("keymap-1.json");
                    let mut bytes = fs::read(&path).unwrap();
                    bytes.push(b'\n');
                    fs::write(path, bytes).unwrap();
                    self.fault = "";
                }
                "connection" => {
                    self.board.connection.token = "new-handle".into();
                    self.fault = "";
                }
                "defaults" => {
                    self.defaults[0][97] ^= 1;
                    self.fault = "";
                }
                _ => {}
            }
            payload.to_vec()
        } else {
            let values = if frame[1] == 0xb1 {
                match layer {
                    0 => &self.defaults[0],
                    4 => &self.defaults[1],
                    _ => panic!("unexpected default layer"),
                }
            } else {
                &self.layers[layer]
            };
            let data: Vec<_> = values.iter().flat_map(|v| v.to_be_bytes()).collect();
            data[offset..offset + length].to_vec()
        };
        let mut reply = vec![0; 64];
        reply[0] = 0xaa;
        reply[1] = frame[1];
        let route_key = if self.board.plain { 0 } else { key };
        for (i, v) in [length as u8, address as u8, (address >> 8) as u8, 0]
            .iter()
            .enumerate()
        {
            reply[4 + i] = v ^ route_key;
        }
        for (i, v) in bytes.iter().enumerate() {
            reply[8 + i] = v ^ key;
        }
        if frame[1] == 0xb3 && self.fault == "ack" {
            reply[5] ^= 2;
            self.fault = "";
        }
        reply[3] = crate::checksum(&reply);
        Ok(reply)
    }
    fn settle_function_key_writes(&mut self, timeout: Duration) -> Result<()> {
        assert!(!timeout.is_zero());
        if self.pending_write.is_some() && self.fault == "unsettled" {
            return Err(error(
                "FUNCTION_KEYS_WRITE_UNSETTLED",
                "模拟固件提交尚未结束",
            ));
        }
        if let Some((layer, position, value)) = self.pending_write.take() {
            self.layers[layer][position] = value;
        }
        Ok(())
    }
    fn pause(&mut self, _: Duration) -> Result<()> {
        Ok(())
    }
}
#[test]
fn private_write_encoder_and_ack_decoder_match_120_official_virtual_cases() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/nuphy-official-function-key-frames.json"
    ))
    .unwrap();
    let model = model();
    let mut checked = 0;
    let mut rejected = 0;
    for row in fixture["examples"].as_array().unwrap() {
        let position = row["position"].as_u64().unwrap() as usize;
        let value = row["value"].as_u64().unwrap() as u16;
        let profile = if row["layer"] == 4 { 1 } else { 0 };
        let key = row["key"].as_u64().unwrap() as u8;
        if position >= usize::from(model.rows) * usize::from(model.columns) {
            assert!(write_frame(&model, profile, position, value, key).is_err());
            rejected += 1;
            continue;
        }
        let frame = write_frame(&model, profile, position, value, key).unwrap();
        let expected: Vec<u8> = serde_json::from_value(row["frame"].clone()).unwrap();
        assert_eq!(frame.as_slice(), expected);
        let reply: Vec<u8> = serde_json::from_value(row["reply"].clone()).unwrap();
        assert_eq!(
            crate::decode_routed(
                &reply,
                0xb3,
                2,
                row["address"].as_u64().unwrap() as u16,
                0,
                key
            )
            .unwrap(),
            value.to_be_bytes()
        );
        checked += 1;
    }
    assert_eq!((checked, rejected), (90, 30));
}
#[test]
fn a_lease_preserves_every_other_layer_extra_key_light_and_sleep_value() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let original = keyboard.layers.clone();
    let state = keyboard.board.state.clone();
    let sleep = keyboard.board.sleep;
    let palette = keyboard.board.palette.clone();
    let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[12, 1, 4])
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            keyboard.values()[1],
            keyboard.values()[4],
            keyboard.values()[12]
        ),
        (104, 107, 115)
    );
    assert_eq!(store.recovery_status().unwrap().keymap_profiles, vec![1]);
    let done = lease.restore(&mut keyboard).unwrap();
    assert!(done.verified && done.archived);
    assert!(!done.no_mutation);
    assert_eq!(done.restored_keys, 3);
    assert_eq!(keyboard.layers, original);
    assert_eq!(keyboard.board.state, state);
    assert_eq!(keyboard.board.sleep, sleep);
    assert_eq!(keyboard.board.palette, palette);
    assert!(!store.recovery_status().unwrap().has_pending());
    assert_eq!(keyboard.writes.len(), 6);
    assert!(keyboard
        .board
        .calls
        .iter()
        .all(|f| matches!(f[1], 0xa0 | 0xa1 | 0xd1)));
}
#[test]
fn existing_extended_mappings_are_unowned_and_create_no_journal_or_write() {
    let mut keyboard = Keyboard::new();
    for (k, value) in keyboard.layers[4].iter_mut().enumerate().take(13).skip(1) {
        *value = 103 + k as u16;
    }
    let original = keyboard.layers.clone();
    let (_tmp, store) = keyboard.store();
    assert!(FunctionKeyLease::prepare(
        &mut keyboard,
        &model(),
        &store,
        &(1..=12).collect::<Vec<_>>()
    )
    .unwrap()
    .is_none());
    assert!(keyboard.writes.is_empty());
    assert_eq!(keyboard.layers, original);
    assert!(!store.recovery_status().unwrap().has_pending());
}
#[test]
fn custom_positions_shared_targets_extra_keys_and_invalid_lists_do_not_write() {
    for fault in [
        "custom",
        "target",
        "duplicateDefault",
        "extraDefault",
        "empty",
        "duplicate",
        "outOfRange",
    ] {
        let mut keyboard = Keyboard::new();
        let requested = match fault {
            "custom" => {
                keyboard.layers[4][1] = 0x8001;
                vec![1]
            }
            "target" => {
                keyboard.layers[4][22] = 104;
                vec![1]
            }
            "duplicateDefault" => {
                keyboard.defaults[1][23] = 58;
                vec![1]
            }
            "extraDefault" => {
                keyboard.defaults[1][1] = 4;
                keyboard.defaults[1][97] = 58;
                vec![1]
            }
            "empty" => vec![],
            "duplicate" => vec![1, 1],
            _ => vec![13],
        };
        let (_tmp, store) = keyboard.store();
        let before = keyboard.layers.clone();
        assert!(
            FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &requested).is_err(),
            "{fault}"
        );
        assert!(keyboard.writes.is_empty());
        assert_eq!(keyboard.layers, before);
        assert!(!store.recovery_status().unwrap().has_pending());
    }
}
#[test]
fn unsupported_firmware_profile_and_unverified_serial_never_create_originals() {
    for fault in ["version", "profile", "serial", "product"] {
        let mut keyboard = Keyboard::new();
        match fault {
            "version" => keyboard.board.firmware[4] = 8,
            "profile" => keyboard.board.profile = 0,
            "serial" => keyboard.board.connection.serial = None,
            _ => keyboard.board.connection.product_id = 0x1111,
        };
        let (_tmp, store) = keyboard.store();
        assert!(
            FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1]).is_err(),
            "{fault}"
        );
        assert!(keyboard.writes.is_empty());
        assert!(!store.recovery_status().unwrap().has_pending());
    }
}
#[test]
fn a_lost_ack_or_wrong_echo_is_not_retried_and_independent_rollback_is_verified() {
    for fault in ["timeout", "ack", "noCommit"] {
        let mut keyboard = Keyboard::new();
        let before = keyboard.values();
        keyboard.fault = fault;
        let (_tmp, store) = keyboard.store();
        assert!(FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1, 4]).is_err());
        assert_eq!(keyboard.values(), before);
        assert!(!store.recovery_status().unwrap().has_pending());
        let installed = keyboard
            .writes
            .iter()
            .filter(|f| {
                u16::from_be_bytes([f[8] ^ keyboard.board.key, f[9] ^ keyboard.board.key]) == 104
            })
            .count();
        assert_eq!(installed, 1);
        assert_eq!(
            keyboard.writes.len(),
            if fault == "noCommit" { 1 } else { 2 }
        );
    }
}
#[test]
fn an_external_owned_key_change_is_retained_instead_of_reset_to_factory() {
    let mut keyboard = Keyboard::new();
    keyboard.fault = "external";
    let (_tmp, store) = keyboard.store();
    assert_eq!(
        code(FunctionKeyLease::prepare(
            &mut keyboard,
            &model(),
            &store,
            &[1, 4]
        )),
        "FUNCTION_KEYS_RESTORE_REQUIRED"
    );
    assert_eq!(keyboard.values()[1], 0xffff);
    assert_eq!(keyboard.values()[4], 61);
    assert_eq!(keyboard.writes.len(), 1);
    assert!(store.recovery_status().unwrap().has_pending());
    let count = keyboard.writes.len();
    assert_eq!(
        code(FunctionKeyLease::recover_existing(
            &mut keyboard,
            &model(),
            &store
        )),
        "FUNCTION_KEYS_EXTERNAL_CHANGE"
    );
    assert_eq!(keyboard.writes.len(), count);
}
#[test]
fn external_unowned_key_edits_survive_normal_restoration() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1, 4])
        .unwrap()
        .unwrap();
    keyboard.layers[4][45] = 0xffee;
    keyboard.layers[2][46] = 0xabcd;
    let done = lease.restore(&mut keyboard).unwrap();
    assert!(done.external_changes_preserved);
    assert_eq!(keyboard.values()[45], 0xffee);
    assert_eq!(keyboard.layers[2][46], 0xabcd);
    assert_eq!((keyboard.values()[1], keyboard.values()[4]), (58, 61));
    assert!(!store.recovery_status().unwrap().has_pending());
}
#[test]
fn record_mutation_handle_replacement_or_default_change_stops_and_retains_evidence() {
    for fault in ["journal", "connection", "defaults"] {
        let mut keyboard = Keyboard::new();
        keyboard.fault = fault;
        let (_tmp, store) = keyboard.store();
        assert_eq!(
            code(FunctionKeyLease::prepare(
                &mut keyboard,
                &model(),
                &store,
                &[1, 4]
            )),
            "FUNCTION_KEYS_RESTORE_REQUIRED"
        );
        assert_eq!(keyboard.writes.len(), 1);
        assert!(store.recovery_status().unwrap().has_pending());
        assert!(keyboard
            .directory
            .as_ref()
            .unwrap()
            .join("keymap-1.json")
            .is_file());
    }
}
#[test]
fn partial_owned_maps_restore_after_reopen_but_new_normal_handles_do_not_reuse_a_lease() {
    for installed in 0..=3 {
        let mut keyboard = Keyboard::new();
        let (_tmp, store) = keyboard.store();
        let before = keyboard.values();
        let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1, 4, 12])
            .unwrap()
            .unwrap();
        for &key in &[1usize, 4, 12][installed..] {
            keyboard.layers[4][key] = before[key];
        }
        keyboard.board.connection.token = "reopened-control".into();
        let writes = keyboard.writes.len();
        assert_eq!(
            code(lease.restore(&mut keyboard)),
            "FUNCTION_KEYS_CONNECTION_CHANGED"
        );
        assert_eq!(keyboard.writes.len(), writes);
        drop(lease);
        drop(store);
        let store = JournalStore::open(keyboard.directory.as_ref().unwrap(), &model()).unwrap();
        let done = FunctionKeyLease::recover_existing(&mut keyboard, &model(), &store).unwrap();
        assert!(done.verified);
        assert_eq!(done.restored_keys, installed);
        assert_eq!(keyboard.values(), before);
        assert!(!store.recovery_status().unwrap().has_pending());
    }
}
#[test]
fn cleanup_interruptions_resume_from_bound_history_without_replaying_key_writes() {
    for step in [1, 0, 3, 2] {
        let mut keyboard = Keyboard::new();
        let (_tmp, store) = keyboard.store();
        let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1, 4])
            .unwrap()
            .unwrap();
        lease.journal.cleanup_fail_before = Some(step);
        assert_eq!(
            code(lease.restore(&mut keyboard)),
            "FUNCTION_KEYS_CLEANUP_REQUIRED"
        );
        let writes = keyboard.writes.len();
        assert_eq!(keyboard.values()[1], 58);
        assert_eq!(
            keyboard
                .directory
                .as_ref()
                .unwrap()
                .join("profile-0.json")
                .exists(),
            step != 2
        );
        assert!(store.recovery_status().unwrap().has_pending());
        drop(lease);
        drop(store);
        let store = JournalStore::open(keyboard.directory.as_ref().unwrap(), &model()).unwrap();
        assert!(
            FunctionKeyLease::recover_existing(&mut keyboard, &model(), &store)
                .unwrap()
                .verified
        );
        assert_eq!(keyboard.writes.len(), writes);
        assert!(!store.recovery_status().unwrap().has_pending());
    }
}
#[test]
fn the_key_journal_retains_the_os_and_directory_lease_when_the_selector_is_dropped() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1])
        .unwrap()
        .unwrap();
    drop(store);
    assert_eq!(
        code(JournalStore::open(
            keyboard.directory.as_ref().unwrap(),
            &model()
        )),
        "BACKUP_LOCKED"
    );
    lease.restore(&mut keyboard).unwrap();
    drop(lease);
    assert!(JournalStore::open(keyboard.directory.as_ref().unwrap(), &model()).is_ok());
}

#[test]
fn legacy_guard_is_a_durable_incompatible_v1_baseline_and_not_an_rgb_original() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct LegacyBaseline {
        #[allow(dead_code)]
        binding: Binding,
        #[allow(dead_code)]
        state: Vec<u8>,
        #[allow(dead_code)]
        rendered_colors: Vec<u8>,
    }
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1])
        .unwrap()
        .unwrap();
    let path = keyboard.directory.as_ref().unwrap().join("profile-0.json");
    let bytes = fs::read(&path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["schema"], 1);
    assert_eq!(value["data"]["feature"], "function-key-legacy-fence-v1");
    // This is the legacy v1 baseline payload schema. An old reader cannot
    // mistake the fence for an RGB original and write or remove it.
    assert!(serde_json::from_value::<LegacyBaseline>(value["data"].clone()).is_err());
    let status = store.recovery_status().unwrap();
    assert!(status.lighting_profiles.is_empty());
    assert_eq!(status.keymap_profiles, vec![1]);
    lease.restore(&mut keyboard).unwrap();
    assert!(!path.exists());
}

#[test]
fn losing_or_changing_the_legacy_guard_prevents_further_b3_and_preserves_originals() {
    for remove in [false, true] {
        let mut keyboard = Keyboard::new();
        let (_tmp, store) = keyboard.store();
        let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1])
            .unwrap()
            .unwrap();
        let dir = keyboard.directory.as_ref().unwrap();
        let original = fs::read(dir.join("keymap-1.json")).unwrap();
        let path = dir.join("profile-0.json");
        if remove {
            fs::remove_file(&path).unwrap();
        } else {
            let mut bytes = fs::read(&path).unwrap();
            bytes.push(b'\n');
            fs::write(&path, bytes).unwrap();
        }
        let count = keyboard.writes.len();
        assert!(lease.restore(&mut keyboard).is_err());
        assert_eq!(keyboard.writes.len(), count);
        assert_eq!(
            fs::read(keyboard.directory.as_ref().unwrap().join("keymap-1.json")).unwrap(),
            original
        );
    }
}

#[test]
fn an_orphaned_guard_remains_pending_and_is_never_silently_retired_on_open() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1])
        .unwrap()
        .unwrap();
    drop(lease);
    drop(store);
    let dir = keyboard.directory.as_ref().unwrap().clone();
    let path = dir.join("profile-0.json");
    let before = fs::read(&path).unwrap();
    for n in ["keymap-1.json", "keymap-1.intent.json"] {
        fs::remove_file(dir.join(n)).unwrap();
    }
    let mut store = JournalStore::open(&dir, &model()).unwrap();
    let pending = store.recovery_status().unwrap();
    assert_eq!(pending.keymap_profiles, vec![1]);
    assert!(pending.lighting_profiles.is_empty());
    let count = keyboard.writes.len();
    assert!(FunctionKeyLease::recover_existing(&mut keyboard, &model(), &store).is_err());
    assert_eq!(keyboard.writes.len(), count);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        code(crate::output::Session::start(
            keyboard.clone(),
            model(),
            &mut store
        )),
        "FUNCTION_KEYS_RECOVERY_REQUIRED"
    );
}

#[test]
fn a_preexisting_legacy_original_is_never_replaced_to_make_room_for_keys() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let dir = keyboard.directory.as_ref().unwrap();
    let path = dir.join("profile-0.json");
    fs::write(&path, b"unrelated previous RGB original").unwrap();
    assert_eq!(
        code(FunctionKeyLease::prepare(
            &mut keyboard,
            &model(),
            &store,
            &[1]
        )),
        "RECOVERY_REQUIRED"
    );
    assert!(keyboard.writes.is_empty());
    assert_eq!(fs::read(path).unwrap(), b"unrelated previous RGB original");
    assert!(!keyboard
        .directory
        .as_ref()
        .unwrap()
        .join("keymap-1.json")
        .exists());
}

#[test]
fn a_damaged_guard_keeps_keys_pending_without_blocking_independent_rgb_cleanup() {
    for corrupt_digest in [false, true] {
        let (_tmp, mut store, shared) = combined();
        seed_interrupted_combined(&mut store, &shared);
        let dir = shared.0.borrow().directory.clone().unwrap();
        let path = dir.join("profile-0.json");
        let mut bytes = fs::read(&path).unwrap();
        if corrupt_digest {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            value["digest"] = "0".repeat(64).into();
            bytes = serde_json::to_vec(&value).unwrap();
        } else {
            bytes.push(b'X');
        }
        fs::write(&path, &bytes).unwrap();
        let count = shared.0.borrow().writes.len();
        let report =
            crate::output::recover_existing(shared.clone(), model(), &mut store, 1).unwrap();
        assert!(!report.complete);
        assert!(matches!(
            report.function_keys,
            crate::output::RecoveryPart::Failed { .. }
        ));
        assert!(matches!(
            report.lighting,
            crate::output::RecoveryPart::Restored { .. }
        ));
        assert_eq!(shared.0.borrow().writes.len(), count);
        assert_eq!(fs::read(path).unwrap(), bytes);
        assert_eq!(report.remaining.lighting_profiles, vec![0]);
        assert_eq!(report.remaining.keymap_profiles, vec![1]);
    }
}
#[test]
fn an_expired_operation_never_sends_a_packet() {
    let mut keyboard = Keyboard::new();
    let frame = write_frame(&model(), 1, 1, 104, keyboard.board.key).unwrap();
    assert_eq!(
        code(exchange(
            &mut keyboard,
            &frame,
            Instant::now() - Duration::from_millis(1)
        )),
        "FUNCTION_KEYS_TIMEOUT"
    );
    assert!(keyboard.writes.is_empty());
}

#[derive(Clone)]
struct Shared(std::rc::Rc<std::cell::RefCell<Keyboard>>);
impl Transport for Shared {
    fn connection(&self) -> Connection {
        self.0.borrow().connection()
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        self.0.borrow_mut().exchange(frame, timeout)
    }
    fn settle_function_key_writes(&mut self, timeout: Duration) -> Result<()> {
        self.0.borrow_mut().settle_function_key_writes(timeout)
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.0.borrow_mut().pause(delay)
    }
}
fn combined() -> (tempfile::TempDir, JournalStore, Shared) {
    let mut keyboard = Keyboard::new();
    keyboard.board.state[0] = 21;
    keyboard.board.state[1] = 100;
    keyboard.board.state[4] = 1;
    keyboard.board.state[6..9].copy_from_slice(&[255; 3]);
    keyboard.board.palette.fill(255);
    let (tmp, store) = keyboard.store();
    (
        tmp,
        store,
        Shared(std::rc::Rc::new(std::cell::RefCell::new(keyboard))),
    )
}
#[test]
fn one_native_lighting_owner_restores_keys_and_colors_on_normal_scope_exit() {
    let (_tmp, mut store, shared) = combined();
    let before = shared.0.borrow().clone();
    {
        let mut session =
            crate::output::Session::start(shared.clone(), model(), &mut store).unwrap();
        assert!(session.prepare_function_keys(&[1, 4]).unwrap());
        session
            .paint(&vec![255; model().key_count * 3], true)
            .unwrap();
        assert_eq!(shared.0.borrow().values()[1], 104);
    }
    assert_eq!(shared.0.borrow().layers, before.layers);
    assert_eq!(shared.0.borrow().board.state, before.board.state);
    assert_eq!(shared.0.borrow().board.rgb(), before.board.rgb());
    assert!(!store.recovery_status().unwrap().has_pending());
}
#[test]
fn a_keyboard_restore_failure_cannot_skip_lighting_cleanup_or_report_a_clean_exit() {
    let (_tmp, mut store, shared) = combined();
    let original = shared.0.borrow().board.state.clone();
    {
        let mut session =
            crate::output::Session::start(shared.clone(), model(), &mut store).unwrap();
        assert!(session.prepare_function_keys(&[1]).unwrap());
        shared.0.borrow_mut().layers[4][1] = 0xffff;
        assert_eq!(code(session.close()), "FUNCTION_KEYS_EXTERNAL_CHANGE");
    }
    assert_eq!(shared.0.borrow().board.state, original);
    let status = store.recovery_status().unwrap();
    assert_eq!(status.keymap_profiles, vec![1]);
    assert!(status.lighting_profiles.is_empty());
    assert_eq!(shared.0.borrow().values()[1], 0xffff);
}
#[test]
fn a_failed_prepare_without_a_returned_key_lease_stays_unconfirmed_after_rgb_cleanup() {
    let (_tmp, mut store, shared) = combined();
    let original = shared.0.borrow().board.state.clone();
    {
        let mut session =
            crate::output::Session::start(shared.clone(), model(), &mut store).unwrap();
        shared.0.borrow_mut().fault = "journal";
        assert_eq!(
            code(session.prepare_function_keys(&[1, 4])),
            "RESTORE_REQUIRED"
        );
        assert_eq!(code(session.close()), "FUNCTION_KEYS_RESTORE_REQUIRED");
    }
    assert_eq!(shared.0.borrow().board.state, original);
    assert!(store.recovery_status().unwrap().has_pending());
}
#[test]
fn changed_key_originals_stop_color_output_but_rgb_gets_its_own_cleanup_attempt() {
    let (_tmp, mut store, shared) = combined();
    let original = shared.0.borrow().board.state.clone();
    {
        let mut session =
            crate::output::Session::start(shared.clone(), model(), &mut store).unwrap();
        session.prepare_function_keys(&[1]).unwrap();
        let path = shared
            .0
            .borrow()
            .directory
            .as_ref()
            .unwrap()
            .join("keymap-1.intent.json");
        let mut bytes = fs::read(&path).unwrap();
        bytes.push(b'\n');
        fs::write(path, bytes).unwrap();
        let count = shared.0.borrow().board.calls.len();
        assert!(session
            .paint(&vec![12; model().key_count * 3], true)
            .is_err());
        // All later D8 payloads belong to rollback of the saved original;
        // a requested [12; ..] frame never reaches the transport.
        assert!(shared.0.borrow().board.calls[count..]
            .iter()
            .filter(|f| f[1] == 0xd8)
            .all(|f| f[9] ^ 0x80 != 12));
    }
    assert_eq!(shared.0.borrow().board.state, original);
    assert_eq!(store.recovery_status().unwrap().keymap_profiles, vec![1]);
}

#[test]
fn cold_recovery_refuses_another_serial_firmware_profile_or_factory_layer_without_writes() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1, 4])
        .unwrap()
        .unwrap();
    drop(lease);
    let original_bytes =
        fs::read(keyboard.directory.as_ref().unwrap().join("keymap-1.json")).unwrap();
    for fault in ["serial", "version", "profile", "defaults"] {
        let mut other = keyboard.clone();
        match fault {
            "serial" => other.board.connection.serial = Some("another-synthetic-board".into()),
            "version" => other.board.firmware[4] = 8,
            "profile" => other.board.profile = 0,
            _ => other.defaults[0][97] ^= 1,
        };
        let before = other.layers.clone();
        let count = other.writes.len();
        assert!(FunctionKeyLease::recover_existing(&mut other, &model(), &store).is_err());
        assert_eq!(other.layers, before);
        assert_eq!(other.writes.len(), count);
        assert_eq!(
            fs::read(keyboard.directory.as_ref().unwrap().join("keymap-1.json")).unwrap(),
            original_bytes
        );
    }
    assert!(
        FunctionKeyLease::recover_existing(&mut keyboard, &model(), &store)
            .unwrap()
            .verified
    );
}
#[test]
fn orphaned_key_intents_block_new_lighting_and_are_part_of_recovery_observations() {
    let mut keyboard = Keyboard::new();
    let (_tmp, mut store) = keyboard.store();
    let path = keyboard
        .directory
        .as_ref()
        .unwrap()
        .join("keymap-0.intent.json");
    fs::write(&path, b"orphaned intent").unwrap();
    let observed = store.observe_recovery().unwrap();
    assert_eq!(observed.status.keymap_profiles, vec![0]);
    assert!(observed.status.has_pending());
    assert_eq!(
        code(FunctionKeyLease::prepare(
            &mut keyboard,
            &model(),
            &store,
            &[1]
        )),
        "RECOVERY_REQUIRED"
    );
    assert!(keyboard.writes.is_empty());
    let mut lighting = crate::output::Lighting::open(keyboard.board.clone(), model()).unwrap();
    let baseline = lighting.capture_baseline().unwrap();
    assert_eq!(
        code(store.begin(baseline)),
        "FUNCTION_KEYS_RECOVERY_REQUIRED"
    );
    fs::write(path, b"another orphaned intent").unwrap();
    assert_eq!(
        code(store.require_observation(&observed)),
        "RECOVERY_STATUS_CHANGED"
    );
}

#[test]
fn combined_cold_recovery_reports_key_restoration_without_a_new_lighting_lease() {
    let (_tmp, mut store, shared) = combined();
    let original = shared.0.borrow().layers.clone();
    let lease = FunctionKeyLease::prepare(&mut shared.clone(), &model(), &store, &[1, 4])
        .unwrap()
        .unwrap();
    drop(lease);
    shared.0.borrow_mut().board.connection.token = "reopened-for-explicit-recovery".into();
    let report = crate::output::recover_existing(shared.clone(), model(), &mut store, 1).unwrap();
    assert!(report.complete);
    assert!(matches!(
        report.lighting,
        crate::output::RecoveryPart::NotNeeded
    ));
    assert!(matches!(
        report.board_sleep,
        crate::output::RecoveryPart::NotNeeded
    ));
    match report.function_keys {
        crate::output::RecoveryPart::Restored { completion } => {
            assert!(completion.verified && completion.archived);
            assert_eq!(completion.restored_keys, 2);
        }
        _ => panic!("missing independent key restoration receipt"),
    }
    assert_eq!(shared.0.borrow().layers, original);
    assert!(!store.recovery_status().unwrap().has_pending());
    assert!(!shared
        .0
        .borrow()
        .board
        .calls
        .iter()
        .any(|f| matches!(f[1], 0xd6 | 0xd8 | 0xf5)));
}

fn seed_interrupted_combined(store: &mut JournalStore, shared: &Shared) {
    let mut lighting = crate::output::Lighting::open(shared.clone(), model()).unwrap();
    let baseline = lighting.capture_baseline().unwrap();
    let mut tx = store.begin(baseline).unwrap();
    lighting.arm(&mut tx).unwrap();
    let connection = shared.connection();
    let key = shared.0.borrow().board.key;
    let lease = FunctionKeyLease::prepare_for_lighting(
        &mut shared.clone(),
        &model(),
        &mut tx,
        &[1, 4],
        &connection,
        key,
    )
    .unwrap()
    .unwrap();
    // Raw owners have no Session rollback. Only a simulated keyboard is used.
    drop(lease);
}

#[test]
fn cold_key_failure_preserves_records_but_still_restores_lighting() {
    for unsettled in [false, true] {
        let (_tmp, mut store, shared) = combined();
        let original = shared.0.borrow().board.state.clone();
        seed_interrupted_combined(&mut store, &shared);
        let before = shared.0.borrow().writes.len();
        if unsettled {
            let mut keyboard = shared.0.borrow_mut();
            keyboard.fault = "unsettled";
            keyboard.pending_write = Some((4, 1, 104));
        } else {
            shared.0.borrow_mut().layers[4][1] = 0xffff;
        }
        let report =
            crate::output::recover_existing(shared.clone(), model(), &mut store, 1).unwrap();
        assert!(!report.complete);
        assert!(matches!(
            report.function_keys,
            crate::output::RecoveryPart::Failed { .. }
        ));
        assert!(matches!(
            report.lighting,
            crate::output::RecoveryPart::Restored { .. }
        ));
        assert_eq!(report.remaining.keymap_profiles, vec![1]);
        assert!(report.remaining.lighting_profiles.is_empty());
        assert_eq!(shared.0.borrow().writes.len(), before);
        assert_eq!(shared.0.borrow().board.state, original);
    }
}

#[test]
fn damaged_rgb_and_sleep_records_cannot_skip_independent_key_recovery() {
    let (_tmp, mut store, shared) = combined();
    let original = shared.0.borrow().layers.clone();
    seed_interrupted_combined(&mut store, &shared);
    let dir = shared.0.borrow().directory.clone().unwrap();
    fs::write(dir.join("profile-1.json"), b"damaged RGB original").unwrap();
    fs::write(dir.join("board-sleep.json"), b"damaged sleep original").unwrap();
    let report = crate::output::recover_existing(shared.clone(), model(), &mut store, 1).unwrap();
    assert!(!report.complete);
    assert!(matches!(
        report.function_keys,
        crate::output::RecoveryPart::Restored { .. }
    ));
    assert!(matches!(
        report.lighting,
        crate::output::RecoveryPart::Failed { .. }
    ));
    assert!(matches!(
        report.board_sleep,
        crate::output::RecoveryPart::Failed { .. }
    ));
    assert!(report.remaining.keymap_profiles.is_empty());
    assert_eq!(shared.0.borrow().layers, original);
    assert_eq!(
        fs::read(dir.join("profile-1.json")).unwrap(),
        b"damaged RGB original"
    );
    assert_eq!(
        fs::read(dir.join("board-sleep.json")).unwrap(),
        b"damaged sleep original"
    );
}

#[test]
fn keys_in_another_physical_profile_remain_deferred_without_any_setter() {
    let (_tmp, mut store, shared) = combined();
    let dir = shared.0.borrow().directory.clone().unwrap();
    fs::write(
        dir.join("keymap-0.intent.json"),
        b"orphaned other-profile intent",
    )
    .unwrap();
    let report = crate::output::recover_existing(shared.clone(), model(), &mut store, 1).unwrap();
    assert!(!report.complete);
    assert_eq!(report.deferred_profiles, vec![0]);
    assert_eq!(report.remaining.keymap_profiles, vec![0]);
    assert!(matches!(
        report.function_keys,
        crate::output::RecoveryPart::NotNeeded
    ));
    assert!(shared.0.borrow().writes.is_empty());
    assert!(!shared
        .0
        .borrow()
        .board
        .calls
        .iter()
        .any(|f| matches!(f[1], 0xd6 | 0xd8 | 0xf5)));
}
#[test]
fn conflicting_history_cannot_retire_the_only_active_original_after_verified_device_rollback() {
    use sha2::{Digest, Sha256};
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1])
        .unwrap()
        .unwrap();
    let path = keyboard.directory.as_ref().unwrap().clone();
    let original = fs::read(path.join("keymap-1.json")).unwrap();
    let digest = format!("{:x}", Sha256::digest(&original));
    let history = path.join(format!("keymap-1.history-{digest}.json"));
    fs::write(&history, b"conflicting archive").unwrap();
    assert_eq!(
        code(lease.restore(&mut keyboard)),
        "FUNCTION_KEYS_BACKUP_CHANGED"
    );
    assert_eq!(keyboard.values()[1], 58);
    assert_eq!(fs::read(path.join("keymap-1.json")).unwrap(), original);
    assert_eq!(fs::read(history).unwrap(), b"conflicting archive");
    assert!(store.recovery_status().unwrap().has_pending());
}
#[test]
fn terminated_mock_owner_keeps_the_original_and_a_new_process_can_restore_it() {
    use std::{
        process::{Command, Stdio},
        thread,
    };
    let (_tmp, path) = directory();
    let parent = path.parent().unwrap();
    let ready = parent.join("synthetic-keyboard-state.json");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "function_keys::tests::function_keys_crash_child",
            "--ignored",
        ])
        .env("NUPHY_FUNCTION_KEYS_CRASH_DIR", &path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("isolated mock owner exited before readiness: {status}");
        }
        thread::sleep(Duration::from_millis(10));
    }
    if !ready.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("isolated mock owner did not become ready");
    }
    // This process uses only the in-memory Keyboard transport above. It has
    // no HID handle, app data path, or real keyboard restoration obligation.
    child.kill().unwrap();
    child.wait().unwrap();
    let mut keyboard = Keyboard::new();
    keyboard.directory = Some(path.clone());
    keyboard.layers = serde_json::from_slice(&fs::read(ready).unwrap()).unwrap();
    keyboard.board.connection.token = "fresh-native-handle".into();
    let store = JournalStore::open(&path, &model()).unwrap();
    assert!(store.recovery_status().unwrap().has_pending());
    let done = FunctionKeyLease::recover_existing(&mut keyboard, &model(), &store).unwrap();
    assert!(done.verified);
    assert_eq!(done.restored_keys, 3);
    assert_eq!(
        (
            keyboard.values()[1],
            keyboard.values()[4],
            keyboard.values()[12]
        ),
        (58, 61, 69)
    );
    assert!(!store.recovery_status().unwrap().has_pending());
}
#[test]
#[ignore = "spawned only by terminated_mock_owner_keeps_the_original_and_a_new_process_can_restore_it"]
fn function_keys_crash_child() {
    let path = PathBuf::from(
        std::env::var_os("NUPHY_FUNCTION_KEYS_CRASH_DIR").expect("isolated test directory"),
    );
    let mut keyboard = Keyboard::new();
    keyboard.directory = Some(path.clone());
    let store = JournalStore::open(&path, &model()).unwrap();
    let _lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1, 4, 12])
        .unwrap()
        .unwrap();
    let ready = path.parent().unwrap().join("synthetic-keyboard-state.json");
    let temporary = path.parent().unwrap().join("synthetic-keyboard-state.tmp");
    fs::write(&temporary, serde_json::to_vec(&keyboard.layers).unwrap()).unwrap();
    fs::rename(temporary, ready).unwrap();
    std::thread::park_timeout(Duration::from_secs(30));
    panic!("isolated crash fixture was not terminated by parent");
}

#[test]
fn key_rotation_invalidates_a_live_lease_but_explicit_cold_recovery_can_use_the_new_key() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1, 4])
        .unwrap()
        .unwrap();
    keyboard.board.key ^= 0x40;
    let count = keyboard.writes.len();
    assert_eq!(
        code(lease.restore(&mut keyboard)),
        "FUNCTION_KEYS_CONNECTION_CHANGED"
    );
    assert_eq!(keyboard.writes.len(), count);
    drop(lease);
    assert!(
        FunctionKeyLease::recover_existing(&mut keyboard, &model(), &store)
            .unwrap()
            .verified
    );
    assert_eq!((keyboard.values()[1], keyboard.values()[4]), (58, 61));
}
#[test]
fn a_live_lighting_owner_cannot_silently_adopt_a_reopened_keyboard_for_key_writes() {
    let (_tmp, mut store, shared) = combined();
    {
        let mut session =
            crate::output::Session::start(shared.clone(), model(), &mut store).unwrap();
        shared.0.borrow_mut().board.connection.token = "reopened".into();
        assert!(session.prepare_function_keys(&[1]).is_err());
        assert!(shared.0.borrow().writes.is_empty());
    }
    assert!(store.recovery_status().unwrap().keymap_profiles.is_empty());
}

struct Unqualified(Keyboard);
impl Transport for Unqualified {
    fn connection(&self) -> Connection {
        self.0.connection()
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        self.0.exchange(frame, timeout)
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.0.pause(delay)
    }
}
#[test]
fn the_default_platform_transport_cannot_write_keys_without_a_firmware_commit_barrier() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    let mut transport = Unqualified(keyboard);
    assert_eq!(
        code(FunctionKeyLease::prepare(
            &mut transport,
            &model(),
            &store,
            &[1]
        )),
        "FUNCTION_KEYS_BARRIER_UNQUALIFIED"
    );
    assert!(transport.0.writes.is_empty());
    assert!(!store.recovery_status().unwrap().has_pending());
}
#[test]
fn acknowledgement_before_commit_requires_the_barrier_and_independent_full_matrix_readback() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    keyboard.fault = "deferred";
    let original = keyboard.layers.clone();
    let mut lease = FunctionKeyLease::prepare(&mut keyboard, &model(), &store, &[1, 4])
        .unwrap()
        .unwrap();
    assert_eq!((keyboard.values()[1], keyboard.values()[4]), (104, 107));
    assert!(keyboard.pending_write.is_none());
    assert!(lease.restore(&mut keyboard).unwrap().verified);
    assert_eq!(keyboard.layers, original);
    assert!(keyboard.pending_write.is_none());
}
#[test]
fn reading_an_original_value_cannot_clear_a_write_that_may_still_commit_later() {
    let mut keyboard = Keyboard::new();
    let (_tmp, store) = keyboard.store();
    keyboard.fault = "unsettled";
    let original = keyboard.layers.clone();
    assert_eq!(
        code(FunctionKeyLease::prepare(
            &mut keyboard,
            &model(),
            &store,
            &[1, 4]
        )),
        "FUNCTION_KEYS_RESTORE_REQUIRED"
    );
    assert_eq!(
        keyboard.layers, original,
        "old values remain visible before deferred commit"
    );
    assert!(keyboard.pending_write.is_some());
    assert!(store.recovery_status().unwrap().has_pending());
    let count = keyboard.writes.len();
    assert_eq!(
        code(FunctionKeyLease::recover_existing(
            &mut keyboard,
            &model(),
            &store
        )),
        "FUNCTION_KEYS_WRITE_UNSETTLED"
    );
    assert_eq!(keyboard.writes.len(), count);
    assert!(store.recovery_status().unwrap().has_pending());
    keyboard.fault = "";
    assert!(
        FunctionKeyLease::recover_existing(&mut keyboard, &model(), &store)
            .unwrap()
            .verified
    );
    assert_eq!(keyboard.layers, original);
    assert!(keyboard.pending_write.is_none());
    assert!(!store.recovery_status().unwrap().has_pending());
}

#[test]
fn a_damaged_sleep_original_cannot_prevent_independent_key_restoration() {
    let (_tmp, mut store, shared) = combined();
    {
        let mut session =
            crate::output::Session::start(shared.clone(), model(), &mut store).unwrap();
        session.prepare_function_keys(&[1, 4]).unwrap();
        let path = shared
            .0
            .borrow()
            .directory
            .as_ref()
            .unwrap()
            .join("board-sleep.json");
        fs::write(path, b"unverified sleep original").unwrap();
        assert!(session.close().is_err());
    }
    assert_eq!(
        (shared.0.borrow().values()[1], shared.0.borrow().values()[4]),
        (58, 61)
    );
    let status = store.recovery_status().unwrap();
    assert!(status.keymap_profiles.is_empty());
    assert!(status.board_sleep);
}
