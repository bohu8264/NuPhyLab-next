use super::*;
use nuphylab_core::recovery::{Baseline, Binding, DeviceIdentity};
use std::process::{Command, Stdio};
#[test]
fn existing_storage_queries_never_create_a_root_or_a_missing_device_slot() {
    let temp = tempfile::tempdir().unwrap();
    assert!(RecoveryRoot::existing_under(temp.path()).unwrap().is_none());
    assert!(temp.path().read_dir().unwrap().next().is_none());
    let root = RecoveryRoot::open_under(temp.path()).unwrap();
    let m = model();
    let c = connection(&m, Some("observed-only-board"));
    assert!(root.existing_device(&m, &c).unwrap().is_none());
    assert!(root.path.read_dir().unwrap().next().is_none());
    let d = root.device(&m, &c).unwrap();
    drop(d.journal_store().unwrap());
    drop(d);
    drop(root);
    let root = RecoveryRoot::existing_under(temp.path()).unwrap().unwrap();
    let d = root.existing_device(&m, &c).unwrap().unwrap();
    assert!(!d
        .existing_journal_store()
        .unwrap()
        .recovery_status()
        .unwrap()
        .has_pending());
}
fn model() -> Model {
    let value: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/windows-lighting-recovery.json"
    )))
    .unwrap();
    serde_json::from_value(value["models"][1].clone()).unwrap()
}
fn connection(model: &Model, serial: Option<&str>) -> Connection {
    Connection {
        vendor_id: model.vendor_id,
        product_id: model.product_ids[0],
        serial: serial.map(str::to_owned),
        token: "storage-fixture-handle".into(),
    }
}
fn baseline(model: &Model, c: &Connection) -> Baseline {
    Baseline {
        binding: Binding {
            model_id: model.id.clone(),
            vendor_id: c.vendor_id,
            product_id: c.product_id,
            firmware_version: model.qualified_firmware.clone(),
            lighting_profile: 1,
            identity: c
                .serial
                .as_ref()
                .map(|s| DeviceIdentity::Serial(s.clone()))
                .unwrap_or_else(|| DeviceIdentity::Connection(c.token.clone())),
        },
        state: vec![2, 60, 2, 0, 1, 3, 31, 47, 63, 2, 45, 1, 0, 0, 12, 34, 56],
        rendered_colors: vec![0; (model.key_count + model.side_count) * 3],
    }
}
fn prepare() -> (tempfile::TempDir, RecoveryRoot) {
    let temp = tempfile::Builder::new()
        .prefix("NuPhy 私有 恢复 0 ")
        .tempdir()
        .unwrap();
    let root = RecoveryRoot::open_under(temp.path()).unwrap();
    (temp, root)
}
fn code<T>(r: Result<T>) -> String {
    match r {
        Err(e) => e.code,
        Ok(_) => panic!("expected rejection"),
    }
}
fn keep_original(root: &RecoveryRoot, model: &Model, c: &Connection) -> (PathBuf, Vec<u8>) {
    let directory = root.device(model, c).unwrap();
    let path = directory.path.clone();
    let mut store = directory.journal_store().unwrap();
    drop(store.begin(baseline(model, c)).unwrap());
    let bytes = fs::read(path.join("profile-1.json")).unwrap();
    (path, bytes)
}
fn string_sid(identity: &Identity) -> String {
    assert_eq!((identity.sid.as_ptr() as usize) % 4, 0);
    let mut text = ptr::null_mut();
    assert_ne!(
        unsafe { ConvertSidToStringSidW(identity.sid.as_ptr().cast_mut().cast(), &mut text) },
        0
    );
    let _allocation = LocalAllocation(text.cast());
    String::from_utf16(&unsafe { wide_string(text) }.unwrap()).unwrap()
}
fn create_with_sddl(path: &Path, sddl: &str) {
    let wide: Vec<_> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut descriptor = ptr::null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        },
        0
    );
    let _allocated = LocalAllocation(descriptor);
    let attrs = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let path: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    assert_ne!(unsafe { CreateDirectoryW(path.as_ptr(), &attrs) }, 0);
}
fn security_text(file: &File) -> String {
    use windows_sys::Win32::Security::Authorization::ConvertSecurityDescriptorToStringSecurityDescriptorW;
    let mut descriptor = ptr::null_mut();
    assert_eq!(
        unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut descriptor,
            )
        },
        0
    );
    let _allocated = LocalAllocation(descriptor);
    let mut text = ptr::null_mut();
    assert_ne!(
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                1,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut text,
                ptr::null_mut(),
            )
        },
        0
    );
    let _text = LocalAllocation(text.cast());
    String::from_utf16(&unsafe { wide_string(text) }.unwrap()).unwrap()
}
fn remove_dacl_protection(path: &Path) {
    use windows_sys::Win32::{
        Security::{Authorization::SetSecurityInfo, UNPROTECTED_DACL_SECURITY_INFORMATION},
        Storage::FileSystem::WRITE_DAC,
    };
    let file = OpenOptions::new()
        .access_mode(READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .unwrap();
    let (mut dacl, mut descriptor) = (ptr::null_mut(), ptr::null_mut());
    assert_eq!(
        unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        },
        0
    );
    let _allocated = LocalAllocation(descriptor);
    assert_eq!(
        unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                dacl,
                ptr::null_mut(),
            )
        },
        0
    );
}
fn junction(link: &Path, target: &Path) {
    let status = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "junction fixture creation failed");
}
#[test]
fn atomically_created_root_and_device_directories_have_private_owned_inheritable_permissions() {
    let (temp, root) = prepare();
    let model = model();
    let c = connection(&model, Some("qualified-private-board"));
    let directory = root.device(&model, &c).unwrap();
    let root_handle = open_directory(&root.path).unwrap();
    check_private(&root_handle, &root.identity).unwrap();
    check_private(&directory.anchor._directory, &root.identity).unwrap();
    assert!(!directory
        .path
        .to_string_lossy()
        .contains("qualified-private-board"));
    assert!(!directory.recovery_status().unwrap().has_pending());
    let lock = OpenOptions::new()
        .access_mode(READ_CONTROL)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(directory.path.join("session.lock"))
        .unwrap();
    let text = security_text(&lock);
    assert!(text.contains("SY"));
    assert!(!text.contains(";;;WD"));
    assert!(!text.contains(";;;BU"));
    drop(lock);
    drop(root_handle);
    drop(directory);
    drop(root);
    assert!(temp.path().exists());
}
#[test]
fn existing_broad_null_or_inherited_permissions_are_rejected_without_repairing_or_deleting_contents(
) {
    for mode in ["broad", "null", "inherited"] {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("NuPhyLab");
        fs::create_dir(&app).unwrap();
        let path = app.join(PRIVATE_ROOT);
        let identity = Identity::current().unwrap();
        let sid = string_sid(&identity);
        let sddl = match mode {
            "broad" => format!("O:{sid}D:P(A;OICI;FA;;;WD)"),
            "null" => format!("O:{sid}D:NO_ACCESS_CONTROL"),
            _ => format!("O:{sid}D:(A;OICI;FA;;;SY)(A;OICI;FA;;;{sid})"),
        };
        create_with_sddl(&path, &sddl);
        if mode == "inherited" {
            // Windows can mark an explicitly created DACL as protected even
            // without SDDL's P flag. Set the actual negative state, then
            // verify the fixture is unsafe before exercising the selector.
            remove_dacl_protection(&path);
        }
        fs::write(
            path.join("original-witness.bin"),
            b"preserve existing contents",
        )
        .unwrap();
        let file = open_directory(&path).unwrap();
        assert!(
            check_private(&file, &identity).is_err(),
            "fixture must be unsafe: {mode}"
        );
        let before = security_text(&file);
        match RecoveryRoot::open_under(temp.path()) {
            Err(error) => assert_eq!(error.code, PERMISSIONS_ERROR, "{mode}"),
            Ok(_) => panic!(
                "accepted {mode} fixture: {}",
                before.replace(&sid, "CURRENT_USER")
            ),
        }
        assert_eq!(security_text(&file), before);
        assert_eq!(
            fs::read(path.join("original-witness.bin")).unwrap(),
            b"preserve existing contents"
        );
    }
}
#[test]
fn directory_guard_and_model_lock_follow_the_journal_after_selectors_are_dropped() {
    let (temp, root) = prepare();
    let model = model();
    let c = connection(&model, None);
    let directory = root.device(&model, &c).unwrap();
    let source = root.path.clone();
    let renamed = source.with_file_name("renamed-private-root");
    let store = directory.journal_store().unwrap();
    drop(directory);
    drop(root);
    assert!(fs::rename(&source, &renamed).is_err());
    let another = RecoveryRoot::open_under(temp.path()).unwrap();
    assert_eq!(code(another.device(&model, &c)), "BACKUP_LOCKED");
    drop(another);
    drop(store);
    fs::rename(&source, &renamed).unwrap();
}
#[test]
fn new_tokens_and_pid_variants_cannot_bypass_an_unverified_original() {
    let (_temp, root) = prepare();
    let model = model();
    let mut c = connection(&model, None);
    let (path, original) = keep_original(&root, &model, &c);
    c.token = "new-native-handle".into();
    c.product_id = model.product_ids[1];
    let reopened = root.device(&model, &c).unwrap();
    assert_eq!(reopened.path, path);
    let mut store = reopened.journal_store().unwrap();
    assert!(store.recovery_status().unwrap().has_pending());
    assert_eq!(
        store.begin(baseline(&model, &c)).err().unwrap().code,
        "RECOVERY_REQUIRED"
    );
    assert_eq!(fs::read(path.join("profile-1.json")).unwrap(), original);
}
#[test]
fn changing_between_unverified_and_qualified_identity_never_hides_pending_originals() {
    for was_qualified in [false, true] {
        let (_temp, root) = prepare();
        let model = model();
        let c = connection(&model, was_qualified.then_some("qualified-board-0"));
        let (path, original) = keep_original(&root, &model, &c);
        let next = connection(&model, (!was_qualified).then_some("qualified-board-0"));
        let (model_key, slot) = policy::keys(&model, &next).unwrap();
        assert_eq!(code(root.device(&model, &next)), "RECOVERY_REQUIRED");
        assert!(!root.path.join(model_key).join(slot).exists());
        assert_eq!(fs::read(path.join("profile-1.json")).unwrap(), original);
    }
}
#[test]
fn different_qualified_devices_keep_separate_originals_and_empty_unverified_slots_do_not_block() {
    let (_temp, root) = prepare();
    let model = model();
    drop(root.device(&model, &connection(&model, None)).unwrap());
    let a = connection(&model, Some("qualified-device-A"));
    let b = connection(&model, Some("qualified-device-B"));
    let (a_path, a_original) = keep_original(&root, &model, &a);
    let (b_path, b_original) = keep_original(&root, &model, &b);
    assert_ne!(a_path, b_path);
    assert_eq!(fs::read(a_path.join("profile-1.json")).unwrap(), a_original);
    assert_eq!(fs::read(b_path.join("profile-1.json")).unwrap(), b_original);
}
#[test]
fn redirected_application_directory_and_redirected_ancestors_are_refused() {
    for ancestor in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = if ancestor {
            temp.path().join("redirected parent")
        } else {
            temp.path().join("NuPhyLab")
        };
        junction(&link, outside.path());
        let parent = if ancestor {
            link.as_path()
        } else {
            temp.path()
        };
        assert_eq!(code(RecoveryRoot::open_under(parent)), PATH_ERROR);
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_dir(link).unwrap();
    }
}
#[test]
fn a_redirected_device_slot_is_refused_without_touching_its_target() {
    let (_temp, root) = prepare();
    let outside = tempfile::tempdir().unwrap();
    let model = model();
    let c = connection(&model, None);
    let directory = root.device(&model, &c).unwrap();
    let path = directory.path.clone();
    drop(directory);
    fs::remove_dir(&path).unwrap();
    junction(&path, outside.path());
    assert_eq!(code(root.device(&model, &c)), PATH_ERROR);
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    fs::remove_dir(path).unwrap();
}
#[test]
fn unknown_entries_or_excessive_slot_counts_stop_selection_without_removing_data() {
    for excessive in [false, true] {
        let (_temp, root) = prepare();
        let model = model();
        let c = connection(&model, None);
        let directory = root.device(&model, &c).unwrap();
        let model_dir = directory.path.parent().unwrap().to_path_buf();
        drop(directory);
        if excessive {
            for index in 0..MAX_SLOTS {
                create_private(
                    &model_dir.join(format!("serial-{index:064x}")),
                    &root.identity,
                )
                .unwrap();
            }
        } else {
            fs::write(
                model_dir.join("unexpected-original.bin"),
                b"leave unchanged",
            )
            .unwrap();
        }
        assert_eq!(code(root.device(&model, &c)), "RECOVERY_STORAGE_LAYOUT");
        if !excessive {
            assert_eq!(
                fs::read(model_dir.join("unexpected-original.bin")).unwrap(),
                b"leave unchanged"
            );
        }
    }
}
#[test]
fn a_full_namespace_can_reopen_an_existing_slot_but_cannot_create_one_more() {
    let (_temp, root) = prepare();
    let model = model();
    let c = connection(&model, None);
    let directory = root.device(&model, &c).unwrap();
    let model_dir = directory.path.parent().unwrap().to_path_buf();
    drop(directory);
    for index in 0..MAX_SLOTS - 1 {
        create_private(
            &model_dir.join(format!("serial-{index:064x}")),
            &root.identity,
        )
        .unwrap();
    }
    let entries = || {
        let mut names: Vec<_> = fs::read_dir(&model_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        names
    };
    let before = entries();
    assert_eq!(before.len(), MAX_SLOTS + 1); // Also includes the model lock.
    drop(root.device(&model, &c).unwrap());
    let next = connection(&model, Some("qualified-capacity-overflow"));
    let (_, slot) = policy::keys(&model, &next).unwrap();
    assert_eq!(code(root.device(&model, &next)), "RECOVERY_STORAGE_LAYOUT");
    assert!(!model_dir.join(slot).exists());
    assert_eq!(entries(), before);
}
fn child(temp: &Path, mode: &str, output: &Path) -> std::process::Child {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "storage::windows::tests::storage_process_entry",
            "--ignored",
            "--nocapture",
        ])
        .env("NUPHYLAB_STORAGE_TEST_PARENT", temp)
        .env("NUPHYLAB_STORAGE_TEST_MODE", mode)
        .env("NUPHYLAB_STORAGE_TEST_OUTPUT", output)
        .env(
            "LOCALAPPDATA",
            temp.join("environment override must not be used"),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}
fn wait_child(mut child: std::process::Child) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("storage child timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
#[test]
fn model_gate_remains_exclusive_across_processes_until_the_last_journal_drops() {
    let (temp, root) = prepare();
    let model = model();
    let c = connection(&model, None);
    let directory = root.device(&model, &c).unwrap();
    let store = directory.journal_store().unwrap();
    drop(directory);
    drop(root);
    let output = temp.path().join("child-lock-status.txt");
    wait_child(child(temp.path(), "locked", &output));
    assert_eq!(fs::read_to_string(&output).unwrap(), "BACKUP_LOCKED");
    drop(store);
    wait_child(child(temp.path(), "open", &output));
    assert_eq!(fs::read_to_string(output).unwrap(), "opened");
}
#[test]
fn known_folder_comes_from_windows_instead_of_a_localappdata_environment_override() {
    let temp = tempfile::tempdir().unwrap();
    let expected = known_folder().unwrap();
    let output = temp.path().join("known-folder.txt");
    wait_child(child(temp.path(), "known-folder", &output));
    assert_eq!(PathBuf::from(fs::read_to_string(output).unwrap()), expected);
    assert!(!temp
        .path()
        .join("environment override must not be used")
        .exists());
}
#[test]
#[ignore = "isolated storage/environment worker invoked by parent Windows storage tests"]
fn storage_process_entry() {
    let Some(parent) = std::env::var_os("NUPHYLAB_STORAGE_TEST_PARENT") else {
        return;
    };
    let parent = PathBuf::from(parent);
    let mode = std::env::var("NUPHYLAB_STORAGE_TEST_MODE").unwrap();
    let output = PathBuf::from(std::env::var_os("NUPHYLAB_STORAGE_TEST_OUTPUT").unwrap());
    if mode == "known-folder" {
        fs::write(output, known_folder().unwrap().to_string_lossy().as_bytes()).unwrap();
        return;
    }
    let root = RecoveryRoot::open_under(&parent).unwrap();
    let model = model();
    let c = connection(&model, None);
    let text = match root.device(&model, &c) {
        Ok(_) => {
            assert_eq!(mode, "open");
            "opened".to_string()
        }
        Err(e) => {
            assert_eq!(mode, "locked");
            e.code
        }
    };
    fs::write(output, text).unwrap();
}

#[test]
fn local_unicode_paths_beyond_max_path_can_create_and_reopen_the_same_private_slot() {
    let temp = tempfile::Builder::new()
        .prefix("长路径 恢复 0 ")
        .tempdir()
        .unwrap();
    let parent = temp
        .path()
        .join("long-parent".repeat(10))
        .join("more-parent".repeat(10));
    fs::create_dir_all(&parent).unwrap();
    let root = RecoveryRoot::open_under(&parent).unwrap();
    let model = model();
    let c = connection(&model, Some("qualified-long-path-board"));
    let (path, original) = keep_original(&root, &model, &c);
    assert!(path.as_os_str().encode_wide().count() > 260);
    let selected = root.device(&model, &c).unwrap();
    assert_eq!(selected.path, path);
    assert!(selected.recovery_status().unwrap().has_pending());
    assert_eq!(fs::read(path.join("profile-1.json")).unwrap(), original);
}
