use super::*;
use std::{
    fs,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn model() -> Model {
    Model {
        id: "air75-v3".into(),
        name: "Air75 V3".into(),
        vendor_id: 0x19f5,
        product_ids: vec![0x1028],
        key_count: 84,
        side_count: 20,
        canvas_count: 84,
        rows: 6,
        columns: 16,
        extra_keys: 2,
        qualified_firmware: "1.0.23.6".into(),
        lighting_state_length: 22,
        lighting_recovery_policy: crate::lighting_policy::PolicyKind::Air75,
        rgb_write_indices: (0..84).collect(),
    }
}
fn baseline() -> Baseline {
    Baseline {
        binding: Binding {
            model_id: "air75-v3".into(),
            vendor_id: 0x19f5,
            product_id: 0x1028,
            firmware_version: "1.0.23.6".into(),
            lighting_profile: 1,
            identity: DeviceIdentity::Serial("test-board-0".into()),
        },
        state: vec![
            2, 60, 0, 0, 0, 0, 0, 0, 0, 2, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 94,
        ],
        rendered_colors: vec![42; 104 * 3],
    }
}
fn palette_proof(
    model: &Model,
    binding: &Binding,
    value: u8,
) -> crate::lighting_policy::ReconstructedPalette {
    let mut state = baseline().state;
    state.truncate(usize::from(model.lighting_state_length));
    state[0] = 21;
    state[1] = 100;
    state[4] = 1;
    state[6..9].copy_from_slice(&[255, 255, 255]);
    let mut colors = crate::lighting_policy::rendered_palette(
        model,
        &binding.firmware_version,
        &vec![value; model.key_count * 3],
    )
    .unwrap();
    colors.extend(vec![0; model.side_count * 3]);
    crate::lighting_policy::ReconstructedPalette::capture(model, binding, &state, &colors).unwrap()
}
fn directory() -> (tempfile::TempDir, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("恢复 日志 空格 0");
    fs::create_dir(&directory).unwrap();
    (temporary, directory)
}
fn code<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected failure"),
        Err(e) => e.code,
    }
}

#[test]
fn durable_baseline_precedes_mutation_and_palette_never_replaces_it() {
    let (_temporary, directory) = directory();
    let original = baseline();
    let binding = original.binding.clone();
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    let baseline_path = store.path(1, false);
    let palette_path = store.path(1, true);
    let mut transaction = store.begin(original.clone()).unwrap();
    let original_bytes = fs::read(&baseline_path).unwrap();
    assert_eq!(decode::<Baseline>(&original_bytes).unwrap(), original);
    let mut writes = 0;
    transaction
        .mutate::<()>(&binding, Mutation::Settings, || {
            writes += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        code(transaction.mutate::<()>(&binding, Mutation::Palette, || {
            writes += 1;
            Ok(())
        })),
        "BACKUP_INCOMPLETE"
    );
    assert_eq!(writes, 1);
    transaction
        .preserve_palette(palette_proof(&model(), &binding, 120))
        .unwrap();
    let saved_palette = fs::read(&palette_path).unwrap();
    transaction
        .preserve_palette(palette_proof(&model(), &binding, 120))
        .unwrap();
    assert_eq!(
        code(transaction.preserve_palette(palette_proof(&model(), &binding, 130))),
        "BACKUP_CHANGED"
    );
    transaction
        .mutate::<()>(&binding, Mutation::Palette, || {
            writes += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(writes, 2);
    assert_eq!(fs::read(&baseline_path).unwrap(), original_bytes);
    assert_eq!(fs::read(&palette_path).unwrap(), saved_palette);
    drop(transaction);
    drop(store);
    let mut reopened = JournalStore::open(&directory, &model()).unwrap();
    let mut recovery = reopened.resume(&binding).unwrap();
    assert_eq!(
        code(recovery.mutate::<()>(&binding, Mutation::Settings, || panic!("new playback"))),
        "RECOVERY_REQUIRED"
    );
    recovery
        .recover(&binding, |saved, colors| {
            assert_eq!(saved, &original);
            assert_eq!(colors.unwrap().colors(), &[120; 84 * 3]);
            Ok(())
        })
        .unwrap();
    // A callback's success is not independent hardware evidence.
    assert_eq!(fs::read(&baseline_path).unwrap(), original_bytes);
    assert_eq!(fs::read(&palette_path).unwrap(), saved_palette);
}

#[test]
fn preexisting_partial_or_inactive_records_never_get_overwritten() {
    for (profile, palette, bytes) in [
        (1, false, b"{broken".as_slice()),
        (0, false, b"inactive"),
        (0, true, b"orphan"),
    ] {
        let (_temporary, directory) = directory();
        let mut store = JournalStore::open(&directory, &model()).unwrap();
        let path = store.path(profile, palette);
        fs::write(&path, bytes).unwrap();
        assert_eq!(code(store.begin(baseline())), "RECOVERY_REQUIRED");
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn mismatched_device_firmware_and_profile_never_reach_a_callback() {
    let changes: [fn(&mut Binding); 6] = [
        |b| b.lighting_profile = 0,
        |b| b.model_id = "kick75".into(),
        |b| b.product_id = 0x1027,
        |b| b.firmware_version = "2.0.0.8".into(),
        |b| b.identity = DeviceIdentity::Serial("different-board".into()),
        |b| b.identity = DeviceIdentity::Connection("same-looking-port".into()),
    ];
    for change in changes {
        let (_temporary, directory) = directory();
        let mut store = JournalStore::open(&directory, &model()).unwrap();
        let original = baseline();
        let path = store.path(1, false);
        let mut transaction = store.begin(original.clone()).unwrap();
        let bytes = fs::read(&path).unwrap();
        let mut changed = original.binding.clone();
        change(&mut changed);
        assert_eq!(
            code(
                transaction.mutate::<()>(&changed, Mutation::Settings, || panic!("wrong keyboard"))
            ),
            "BACKUP_DEVICE_MISMATCH"
        );
        // Switching back does not revive an invalidated write lease.
        assert_eq!(
            code(
                transaction.mutate::<()>(&original.binding, Mutation::Settings, || panic!(
                    "stale lease"
                ))
            ),
            "RECOVERY_REQUIRED"
        );
        assert!(transaction
            .recover(&changed, |_, _| -> Result<()> { panic!("wrong recovery") })
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn no_serial_records_cannot_be_automatically_replayed_on_a_new_connection() {
    let (_temporary, directory) = directory();
    let mut original = baseline();
    original.binding.identity = DeviceIdentity::Connection("process-1:connection-1".into());
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    drop(store.begin(original.clone()).unwrap());
    drop(store);
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    let mut new_connection = original.binding.clone();
    new_connection.identity = DeviceIdentity::Connection("process-2:connection-1".into());
    assert_eq!(
        code(store.resume(&new_connection)),
        "BACKUP_DEVICE_MISMATCH"
    );
    assert_eq!(
        store.resume(&original.binding).unwrap().baseline(),
        &original
    );
}

#[test]
fn uncertain_writes_and_panics_stop_output_but_preserve_recovery_retries() {
    for panic in [false, true] {
        let (_temporary, directory) = directory();
        let mut store = JournalStore::open(&directory, &model()).unwrap();
        let original = baseline();
        let binding = original.binding.clone();
        let path = store.path(1, false);
        let mut transaction = store.begin(original).unwrap();
        let bytes = fs::read(&path).unwrap();
        let mut writes = 0;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            transaction.mutate::<()>(&binding, Mutation::Settings, || -> Result<()> {
                writes += 1;
                if panic {
                    panic!("simulated uncertain transport unwind");
                }
                Err(error("HID_TIMEOUT", "write may have reached the device"))
            })
        }));
        if panic {
            assert!(outcome.is_err());
        } else {
            assert_eq!(code(outcome.unwrap()), "HID_TIMEOUT");
        }
        assert_eq!(
            code(transaction.mutate::<()>(&binding, Mutation::Settings, || {
                writes += 1;
                Ok(())
            })),
            "RECOVERY_REQUIRED"
        );
        assert_eq!(writes, 1);
        assert_eq!(
            code(transaction.recover(&binding, |_, _| -> Result<()> {
                Err(error("HID_TIMEOUT", "still unplugged"))
            })),
            "HID_TIMEOUT"
        );
        transaction.recover(&binding, |_, _| Ok(())).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn changed_baselines_or_palettes_invalidate_the_lease_even_if_replaced_back() {
    for (palette, operation) in [false, true]
        .into_iter()
        .flat_map(|palette| ["mutate", "palette", "recover"].map(|operation| (palette, operation)))
    {
        let (_temporary, directory) = directory();
        let mut store = JournalStore::open(&directory, &model()).unwrap();
        let original = baseline();
        let binding = original.binding.clone();
        let path = store.path(1, palette);
        let mut transaction = store.begin(original).unwrap();
        if palette {
            transaction
                .preserve_palette(palette_proof(&model(), &binding, 42))
                .unwrap();
        }
        let bytes = fs::read(&path).unwrap();
        fs::write(&path, b"outside change").unwrap();
        let failure = match operation {
            "mutate" => code(
                transaction
                    .mutate::<()>(&binding, Mutation::Settings, || panic!("modified journal")),
            ),
            "palette" => code(transaction.preserve_palette(palette_proof(&model(), &binding, 42))),
            "recover" => {
                code(transaction.recover::<()>(&binding, |_, _| panic!("modified recovery")))
            }
            _ => unreachable!(),
        };
        assert_eq!(failure, "BACKUP_CHANGED");
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            code(
                transaction.mutate::<()>(&binding, Mutation::Settings, || panic!("revived lease"))
            ),
            "RECOVERY_REQUIRED"
        );
        transaction.recover(&binding, |_, _| Ok(())).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn invalid_schema_digest_geometry_and_oversized_files_are_retained() {
    let original = baseline();
    let mut wrong_geometry = original.clone();
    wrong_geometry.rendered_colors.pop();
    let mut wrong_state = original.clone();
    wrong_state.state[1] = 101;
    let mut unknown_field: serde_json::Value =
        serde_json::from_slice(&encode(&original).unwrap()).unwrap();
    unknown_field["restored"] = serde_json::json!(true);
    let mut wrong_digest = encode(&original).unwrap();
    let at = wrong_digest
        .windows(8)
        .position(|v| v == b"test-boa")
        .unwrap();
    wrong_digest[at] = b'X';
    let mut wrong_schema: serde_json::Value =
        serde_json::from_slice(&encode(&original).unwrap()).unwrap();
    wrong_schema["schema"] = 2.into();
    for bytes in [
        b"{truncated".to_vec(),
        vec![b'x'; MAX_BYTES as usize + 1],
        wrong_digest,
        serde_json::to_vec(&unknown_field).unwrap(),
        serde_json::to_vec(&wrong_schema).unwrap(),
        encode(&wrong_geometry).unwrap(),
        encode(&wrong_state).unwrap(),
    ] {
        let (_temporary, directory) = directory();
        let mut store = JournalStore::open(&directory, &model()).unwrap();
        let path = store.path(1, false);
        fs::write(&path, &bytes).unwrap();
        assert!(store.resume(&original.binding).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn palette_is_bound_to_the_exact_baseline_and_invalid_identity_cannot_create_files() {
    let (_temporary, directory) = directory();
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    let mut invalid = baseline();
    invalid.binding.identity = DeviceIdentity::Serial("".into());
    assert_eq!(code(store.begin(invalid)), "BACKUP_IDENTITY_INVALID");
    assert!(!store.path(1, false).exists());
    let original = baseline();
    let palette_path = store.path(1, true);
    let mut transaction = store.begin(original.clone()).unwrap();
    assert_eq!(
        code(crate::lighting_policy::ReconstructedPalette::capture(
            &model(),
            &original.binding,
            &baseline().state,
            &[0; 3]
        )),
        "INVALID_PALETTE"
    );
    transaction
        .preserve_palette(palette_proof(&model(), &original.binding, 0))
        .unwrap();
    drop(transaction);
    let bytes = encode(&Palette {
        baseline_digest: "different-baseline".into(),
        original: palette_proof(&model(), &original.binding, 0),
    })
    .unwrap();
    fs::write(&palette_path, &bytes).unwrap();
    assert_eq!(code(store.resume(&original.binding)), "INVALID_BACKUP");
    assert_eq!(fs::read(&palette_path).unwrap(), bytes);
}

#[test]
fn links_and_directories_cannot_stand_in_for_recovery_files() {
    let (_temporary, directory) = directory();
    let outside = directory.with_file_name("outside");
    fs::create_dir(&outside).unwrap();
    let linked = directory.with_file_name("linked");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &linked).unwrap();
    #[cfg(windows)]
    assert!(Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&linked)
        .arg(&outside)
        .output()
        .unwrap()
        .status
        .success());
    assert_eq!(
        code(JournalStore::open(&linked, &model())),
        "BACKUP_PATH_INVALID"
    );
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    let path = store.path(1, false);
    fs::create_dir(&path).unwrap();
    assert_eq!(
        code(store.resume(&baseline().binding)),
        "BACKUP_PATH_INVALID"
    );
    fs::remove_dir(&path).unwrap();
    let target = outside.join("original.json");
    fs::write(&target, b"untouched").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &path).unwrap();
    #[cfg(windows)]
    fs::hard_link(&target, &path).unwrap();
    assert_eq!(code(store.begin(baseline())), "RECOVERY_REQUIRED");
    assert_eq!(fs::read(&target).unwrap(), b"untouched");
}

#[test]
fn seventeen_byte_records_use_their_own_geometry_and_model_identity() {
    let (_temporary, directory) = directory();
    let mut kick = model();
    kick.id = "kick75".into();
    kick.product_ids = vec![0x1026, 0x1027];
    kick.key_count = 80;
    kick.side_count = 5;
    kick.columns = 15;
    kick.qualified_firmware = "4.0.18.6".into();
    kick.lighting_state_length = 17;
    kick.lighting_recovery_policy = crate::lighting_policy::PolicyKind::Kick75;
    kick.rgb_write_indices = (0..80).collect();
    let mut original = baseline();
    original.binding.model_id = kick.id.clone();
    original.binding.product_id = 0x1027;
    original.binding.firmware_version = kick.qualified_firmware.clone();
    original.binding.lighting_profile = 0;
    original.state.truncate(17);
    original.rendered_colors = vec![12; 85 * 3];
    let binding = original.binding.clone();
    let mut store = JournalStore::open(&directory, &kick).unwrap();
    let mut transaction = store.begin(original.clone()).unwrap();
    assert_eq!(
        code(transaction.preserve_palette(palette_proof(&model(), &baseline().binding, 12))),
        "INVALID_PALETTE"
    );
    transaction
        .preserve_palette(palette_proof(&kick, &binding, 12))
        .unwrap();
    drop(transaction);
    drop(store);
    let mut wrong_model = JournalStore::open(&directory, &model()).unwrap();
    assert_eq!(
        code(wrong_model.resume(&binding)),
        "BACKUP_IDENTITY_INVALID"
    );
    drop(wrong_model);
    let mut store = JournalStore::open(&directory, &kick).unwrap();
    assert_eq!(store.resume(&binding).unwrap().baseline(), &original);
}

#[test]
fn a_journal_change_during_a_callback_cannot_acknowledge_a_successful_write() {
    let (_temporary, directory) = directory();
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    let binding = baseline().binding;
    let path = store.path(1, false);
    let mut transaction = store.begin(baseline()).unwrap();
    assert_eq!(
        code(transaction.mutate(&binding, Mutation::Settings, || {
            fs::write(&path, b"changed during the hardware operation").unwrap();
            Ok(())
        })),
        "BACKUP_CHANGED"
    );
    assert_eq!(
        code(transaction.mutate::<()>(&binding, Mutation::Settings, || panic!("replayed write"))),
        "RECOVERY_REQUIRED"
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        b"changed during the hardware operation"
    );
}

#[test]
fn preset_history_is_exact_reused_and_mandatory_before_a_recovery_plan() {
    let (_temporary, directory) = directory();
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    let original = baseline();
    let binding = original.binding.clone();
    let path = store.path(1, false);
    let mut transaction = store.begin(original.clone()).unwrap();
    let bytes = fs::read(&path).unwrap();
    let mut live = original.state.clone();
    live[1] = 100;
    live[5] = 4;
    live[17] = 4;
    let history = directory.join(format!("profile-1.history-{}.json", digest(&bytes)));
    fs::write(&history, b"unrelated record").unwrap();
    assert_eq!(
        code(transaction.plan_restoration(&binding, &live)),
        "BACKUP_CHANGED"
    );
    assert_eq!(fs::read(&history).unwrap(), b"unrelated record");
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_file(&history).unwrap();
    let plan = transaction.plan_restoration(&binding, &live).unwrap();
    assert!(plan.archive_required);
    assert_eq!(fs::read(&history).unwrap(), bytes);
    transaction.plan_restoration(&binding, &live).unwrap();
    assert_eq!(
        fs::read_dir(&directory)
            .unwrap()
            .filter(|entry| entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".history-"))
            .count(),
        1
    );
    let mut observed = original.state;
    observed[5] = 4;
    observed[17] = 4;
    assert!(
        transaction
            .assess_restoration(&plan, &binding, &observed, None, None)
            .unwrap()
            .archive_required
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        bytes,
        "assessment must not delete or replace the original"
    );
}

#[test]
fn preset_drift_during_readback_is_archived_and_a_different_baseline_plan_is_rejected() {
    let (_temporary, directory) = directory();
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    let original = baseline();
    let binding = original.binding.clone();
    let path = store.path(1, false);
    let mut transaction = store.begin(original.clone()).unwrap();
    let bytes = fs::read(&path).unwrap();
    let plan = transaction
        .plan_restoration(&binding, &original.state)
        .unwrap();
    assert!(!plan.archive_required);
    let mut changed = original.state.clone();
    changed[21] = 93;
    assert!(
        transaction
            .assess_restoration(&plan, &binding, &changed, None, None)
            .unwrap()
            .archive_required
    );
    let history = directory.join(format!("profile-1.history-{}.json", digest(&bytes)));
    assert_eq!(fs::read(&history).unwrap(), bytes);
    let mut other = original;
    other.state[1] = 59;
    let other_plan =
        crate::lighting_policy::plan_restore(&model(), &other, &binding, &other.state, None)
            .unwrap();
    assert_eq!(
        code(transaction.assess_restoration(&other_plan, &binding, &other.state, None, None)),
        "BACKUP_CHANGED"
    );
}

#[test]
fn a_rehashed_palette_with_an_invalid_observation_still_cannot_authorize_colors() {
    let (_temporary, directory) = directory();
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    let original = baseline();
    let binding = original.binding.clone();
    let path = store.path(1, true);
    let mut transaction = store.begin(original).unwrap();
    transaction
        .preserve_palette(palette_proof(&model(), &binding, 120))
        .unwrap();
    drop(transaction);
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["data"]["original"]["observedState"][1] = 99.into();
    let invalid: Palette = serde_json::from_value(record["data"].clone()).unwrap();
    let bytes = encode(&invalid).unwrap();
    fs::write(&path, &bytes).unwrap();
    assert_eq!(code(store.resume(&binding)), "PALETTE_NOT_OBSERVABLE");
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn process_crash_releases_the_lock_without_losing_the_original() {
    let (_temporary, directory) = directory();
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "recovery::tests::lock_child",
                "--nocapture",
            ])
            .env("NUPHY_JOURNAL_TEST_CHILD", &directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let marker = directory.join("ready");
    let deadline = Instant::now() + Duration::from_secs(8);
    while !marker.exists() {
        assert!(Instant::now() < deadline, "child did not acquire lock");
        assert!(child.0.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        code(JournalStore::open(&directory, &model())),
        "BACKUP_LOCKED"
    );
    let bytes = fs::read(directory.join("profile-1.json")).unwrap();
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    assert_eq!(
        store.resume(&baseline().binding).unwrap().baseline(),
        &baseline()
    );
    assert_eq!(fs::read(directory.join("profile-1.json")).unwrap(), bytes);
}
#[test]
#[ignore = "spawned only by process_crash_releases_the_lock_without_losing_the_original"]
fn lock_child() {
    let directory = PathBuf::from(std::env::var_os("NUPHY_JOURNAL_TEST_CHILD").unwrap());
    let mut store = JournalStore::open(&directory, &model()).unwrap();
    let _transaction = store.begin(baseline()).unwrap();
    fs::write(directory.join("ready"), b"locked").unwrap();
    std::thread::sleep(Duration::from_secs(30));
}

#[test]
fn dropping_the_store_releases_its_lock_even_while_an_inherited_handle_remains_open() {
    let (_temporary, directory) = directory();
    let store = JournalStore::open(&directory, &model()).unwrap();
    // A duplicate models the open file description briefly inherited by a
    // concurrently spawned process before close-on-exec finishes.
    let inherited = store.anchor.lock.try_clone().unwrap();
    // A read-only probe is compatible with the journal's Windows sharing
    // policy. Reopening a writable JournalStore would also test that policy,
    // which intentionally remains exclusive until every duplicate closes.
    let probe = File::open(directory.join("session.lock")).unwrap();
    assert!(probe.try_lock().is_err());
    drop(store);
    probe.try_lock().unwrap();
    drop(inherited);
    let competing = File::open(directory.join("session.lock")).unwrap();
    assert!(competing.try_lock().is_err());
    drop(competing);
    probe.unlock().unwrap();
    drop(probe);
    assert!(JournalStore::open(&directory, &model()).is_ok());
}
