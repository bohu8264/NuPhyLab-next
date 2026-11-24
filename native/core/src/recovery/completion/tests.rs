use super::*;
use crate::output::{
    tests::{code, directory, model, Board},
    Lighting,
};

#[test]
fn observing_an_interrupted_completion_does_not_retire_any_file() {
    let model = model();
    let (_tmp, directory) = directory();
    let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
    let baseline = driver.capture_baseline().unwrap();
    let mut store = JournalStore::open(&directory, &model).unwrap();
    store.cleanup_fail_before = Some("baseline");
    let mut tx = store.begin(baseline).unwrap();
    driver.arm(&mut tx).unwrap();
    let receipt = driver.restore(&mut tx).unwrap();
    assert_eq!(code(tx.complete(receipt)), "BACKUP_CLEANUP_FAILED");
    drop(store);
    let files = || {
        let mut rows: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap() != "session.lock")
            .map(|p| (p.file_name().unwrap().to_owned(), fs::read(p).unwrap()))
            .collect();
        rows.sort();
        rows
    };
    let before = files();
    let mut store = JournalStore::open_existing(&directory, &model).unwrap();
    let observed = store.observe_recovery().unwrap();
    assert_eq!(observed.status.lighting_profiles, vec![1]);
    store.require_observation(&observed).unwrap();
    assert_eq!(files(), before);
    assert!(store.finish_verified_lighting(1, driver.binding()).unwrap());
    assert!(!store.recovery_status().unwrap().has_pending());
}
#[test]
fn interrupted_cleanup_resumes_from_verified_archives_without_another_device_write() {
    let model = model();
    let (_tmp, directory) = directory();
    let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
    let baseline = driver.capture_baseline().unwrap();
    let mut store = JournalStore::open(&directory, &model).unwrap();
    store.cleanup_fail_before = Some("baseline");
    let mut tx = store.begin(baseline).unwrap();
    driver.arm(&mut tx).unwrap();
    driver.paint(&mut tx, &vec![88; 252], false).unwrap();
    let receipt = driver.restore(&mut tx).unwrap();
    assert_eq!(code(tx.complete(receipt)), "BACKUP_CLEANUP_FAILED");
    assert!(directory.join("profile-1.completed.json").exists());
    assert!(directory.join("profile-1.json").exists());
    assert!(!directory.join("profile-1.palette.json").exists());
    drop(store);
    let _reopened = JournalStore::open(&directory, &model).unwrap();
    assert!(!directory.join("profile-1.json").exists());
    assert!(!directory.join("profile-1.completed.json").exists());
    assert!(directory.read_dir().unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".history-")));
}

#[test]
fn a_different_active_record_blocks_rollforward_and_keeps_every_remaining_file() {
    let model = model();
    let (_tmp, directory) = directory();
    let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
    let baseline = driver.capture_baseline().unwrap();
    let mut store = JournalStore::open(&directory, &model).unwrap();
    store.cleanup_fail_before = Some("rgb-intent");
    let mut tx = store.begin(baseline).unwrap();
    driver.arm(&mut tx).unwrap();
    driver.paint(&mut tx, &vec![88; 252], false).unwrap();
    let receipt = driver.restore(&mut tx).unwrap();
    assert_eq!(code(tx.complete(receipt)), "BACKUP_CLEANUP_FAILED");
    drop(store);
    let palette = fs::read(directory.join("profile-1.palette.json")).unwrap();
    fs::write(
        directory.join("profile-1.json"),
        b"different active original",
    )
    .unwrap();
    assert_eq!(
        code(JournalStore::open(&directory, &model)),
        "BACKUP_CHANGED"
    );
    assert_eq!(
        fs::read(directory.join("profile-1.json")).unwrap(),
        b"different active original"
    );
    assert_eq!(
        fs::read(directory.join("profile-1.palette.json")).unwrap(),
        palette
    );
    assert!(directory.join("profile-1.completed.json").exists());
}

#[test]
fn damaged_completion_or_archive_never_clears_an_active_original() {
    for fault in ["marker", "archive"] {
        let model = model();
        let (_tmp, directory) = directory();
        let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
        let baseline = driver.capture_baseline().unwrap();
        let mut store = JournalStore::open(&directory, &model).unwrap();
        store.cleanup_fail_before = Some("rgb-intent");
        let mut tx = store.begin(baseline).unwrap();
        driver.arm(&mut tx).unwrap();
        driver.paint(&mut tx, &vec![88; 252], false).unwrap();
        let receipt = driver.restore(&mut tx).unwrap();
        assert_eq!(code(tx.complete(receipt)), "BACKUP_CLEANUP_FAILED");
        let original = fs::read(directory.join("profile-1.json")).unwrap();
        drop(store);
        let marker = directory.join("profile-1.completed.json");
        let path = if fault == "marker" {
            marker.clone()
        } else {
            let completed: Completed = decode(&read(&marker).unwrap()).unwrap();
            directory.join(format!(
                "profile-1.history-{}.json",
                completed.baseline_digest
            ))
        };
        fs::write(path, b"damaged").unwrap();
        assert!(JournalStore::open(&directory, &model).is_err());
        assert_eq!(
            fs::read(directory.join("profile-1.json")).unwrap(),
            original
        );
        assert!(marker.exists());
    }
}

#[test]
fn sealed_receipts_are_bound_to_the_transaction_instance_and_last_write_attempt() {
    for changed in ["write", "instance"] {
        let model = model();
        let (_tmp, directory) = directory();
        let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
        let baseline = driver.capture_baseline().unwrap();
        let binding = baseline.binding.clone();
        let mut store = JournalStore::open(&directory, &model).unwrap();
        let mut tx = store.begin(baseline).unwrap();
        driver.arm(&mut tx).unwrap();
        let receipt = driver.restore(&mut tx).unwrap();
        if changed == "write" {
            tx.recovery_write(&binding, Mutation::Settings, || Ok(()))
                .unwrap();
            assert_eq!(code(tx.complete(receipt)), "RESTORE_RECEIPT_INVALID");
        } else {
            drop(tx);
            drop(store);
            let mut reopened = JournalStore::open(&directory, &model).unwrap();
            let tx = reopened.resume(&binding).unwrap();
            assert_eq!(code(tx.complete(receipt)), "RESTORE_RECEIPT_INVALID");
        }
        assert!(directory.join("profile-1.json").exists());
        assert!(!directory.join("profile-1.completed.json").exists());
    }
}

#[test]
fn a_missing_palette_after_rgb_intent_and_ambiguous_old_no_intent_record_are_retained() {
    for attempted in [false, true] {
        let model = model();
        let (_tmp, directory) = directory();
        let mut driver = Lighting::open(Board::new(&model), model.clone()).unwrap();
        let baseline = driver.capture_baseline().unwrap();
        let binding = baseline.binding.clone();
        let mut store = JournalStore::open(&directory, &model).unwrap();
        let mut tx = store.begin(baseline).unwrap();
        if attempted {
            driver.arm(&mut tx).unwrap();
            driver.paint(&mut tx, &vec![88; 252], false).unwrap();
        }
        drop(tx);
        drop(store);
        if attempted {
            fs::remove_file(directory.join("profile-1.palette.json")).unwrap();
        }
        let mut store = JournalStore::open(&directory, &model).unwrap();
        if attempted {
            assert_eq!(code(store.resume(&binding)), "INVALID_BACKUP");
        } else {
            let mut tx = store.resume(&binding).unwrap();
            assert_eq!(
                code(driver.restore(&mut tx)),
                "RECOVERY_CONFIRMATION_REQUIRED"
            );
        }
        assert!(directory.join("profile-1.json").exists());
    }
}
