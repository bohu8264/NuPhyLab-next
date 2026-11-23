use super::*;
fn models() -> Vec<Model> {
    let value: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/windows-lighting-recovery.json"
    )))
    .unwrap();
    serde_json::from_value(value["models"].clone()).unwrap()
}
fn connection(model: &Model) -> Connection {
    Connection {
        vendor_id: model.vendor_id,
        product_id: model.product_ids[0],
        serial: None,
        token: "first-handle".into(),
    }
}
fn user() -> Vec<u8> {
    vec![1, 2, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 123, 0, 0, 0]
}
fn acl(sids: &[&[u8]]) -> Vec<u8> {
    let mut value = vec![2, 0, 0, 0, sids.len() as u8, 0, 0, 0];
    for sid in sids {
        let len = (8 + sid.len()) as u16;
        value.extend([0, 3]);
        value.extend(len.to_le_bytes());
        value.extend(0x001f01ffu32.to_le_bytes());
        value.extend(*sid);
    }
    let len = value.len() as u16;
    value[2..4].copy_from_slice(&len.to_le_bytes());
    value
}
#[test]
fn private_acl_accepts_only_current_owner_and_two_exact_full_control_entries() {
    let user = user();
    for sids in [[user.as_slice(), SYSTEM_SID], [SYSTEM_SID, user.as_slice()]] {
        assert!(private_acl(&user, &user, 0x9004, &acl(&sids)));
    }
    assert!(!private_acl(
        SYSTEM_SID,
        &user,
        0x9004,
        &acl(&[&user, SYSTEM_SID])
    ));
    for control in [0, 4, 0x1000] {
        assert!(!private_acl(
            &user,
            &user,
            control,
            &acl(&[&user, SYSTEM_SID])
        ));
    }
    for sids in [
        vec![user.as_slice()],
        vec![user.as_slice(), user.as_slice()],
        vec![SYSTEM_SID, SYSTEM_SID],
        vec![user.as_slice(), SYSTEM_SID, user.as_slice()],
    ] {
        assert!(!private_acl(&user, &user, 0x9004, &acl(&sids)));
    }
}
#[test]
fn malformed_inherited_denied_extra_or_partial_acls_are_rejected_without_panics() {
    let user = user();
    let valid = acl(&[&user, SYSTEM_SID]);
    for index in [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] {
        let mut bytes = valid.clone();
        bytes[index] ^= 0x40;
        assert!(
            !private_acl(&user, &user, 0x9004, &bytes),
            "accepted change at {index}"
        );
    }
    for flag in [0, 1, 2, 8, 0x10, 0x13] {
        let mut bytes = valid.clone();
        bytes[9] = flag;
        assert!(!private_acl(&user, &user, 0x9004, &bytes));
    }
    for end in 0..valid.len() {
        assert!(!private_acl(&user, &user, 0x9004, &valid[..end]));
    }
    let mut extra = valid.clone();
    extra.extend([0, 0, 0, 0]);
    assert!(!private_acl(&user, &user, 0x9004, &extra));
    for length in 0..256 {
        let value: Vec<_> = (0..length)
            .map(|i| ((i * 31 + length * 7) % 256) as u8)
            .collect();
        assert!(!private_acl(&user, &user, 0x9004, &value));
    }
}
#[test]
fn token_pid_variant_and_profile_changes_cannot_open_a_fresh_unverified_slot() {
    let model = models().remove(1);
    let mut first = connection(&model);
    let before = keys(&model, &first).unwrap();
    assert_eq!(before.1, UNVERIFIED);
    assert!(before.0.starts_with("model-"));
    first.token = "another-control-handle".into();
    first.product_id = model.product_ids[1];
    assert_eq!(keys(&model, &first).unwrap(), before);
    first.serial = Some("已核对的同一键盘 / serial 0".into());
    let trusted = keys(&model, &first).unwrap();
    assert_eq!(trusted.0, before.0);
    assert_ne!(trusted.1, before.1);
    first.token = "third-handle".into();
    first.product_id = model.product_ids[0];
    assert_eq!(keys(&model, &first).unwrap(), trusted);
    assert!(!trusted.1.contains("serial 0"));
    first.serial = Some("another verified board".into());
    assert_ne!(keys(&model, &first).unwrap().1, trusted.1);
}
#[test]
fn native_identity_validation_and_slot_names_never_accept_paths_or_unsupported_devices() {
    let model = models().remove(0);
    let good = connection(&model);
    for kind in ["vendor", "product", "token", "serial"] {
        let mut value = good.clone();
        match kind {
            "vendor" => value.vendor_id = 1,
            "product" => value.product_id = 1,
            "token" => value.token = "\n".into(),
            _ => value.serial = Some("  ".into()),
        };
        assert!(keys(&model, &value).is_err());
    }
    for name in [
        "..",
        ".",
        "serial-../x",
        "unverified/x",
        "SERIAL-",
        "serial-ABC",
        "",
    ] {
        assert!(!valid_slot(name));
    }
    assert!(valid_slot(UNVERIFIED));
    assert!(valid_slot(&format!("serial-{}", "a".repeat(64))));
    assert_eq!(PRIVATE_ROOT, "native-recovery-v1");
    assert_eq!(MAX_SLOTS, 64);
}
