use super::*;
fn model() -> Model {
    let v: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/windows-lighting-recovery.json"
    )))
    .unwrap();
    serde_json::from_value(v["models"][0].clone()).unwrap()
}
const SERIAL: &str = "A1B2C3D4E5F6";
#[test]
fn qualification_requires_direct_cached_parent_agreement_and_native_family_policy() {
    let m = model();
    let parent = format!("USB\\VID_19F5&PID_1028\\{SERIAL}");
    let v = evaluate(&m, 0x1028, Some(SERIAL), SERIAL, &parent, true, true);
    assert_eq!(v.serial.as_deref(), Some(SERIAL));
    assert_eq!(v.report["status"], "qualified");
    assert!(!v.report.to_string().contains(SERIAL));
    for (cached, parent, unique, policy) in [
        (None, parent.clone(), true, true),
        (Some("OTHER"), parent.clone(), true, true),
        (
            Some(SERIAL),
            "USB\\VID_19F5&PID_1028\\9&LOCATION&0&1".into(),
            true,
            true,
        ),
        (Some(SERIAL), parent.clone(), false, true),
        (Some(SERIAL), parent.clone(), true, false),
    ] {
        assert!(
            evaluate(&m, 0x1028, cached, SERIAL, &parent, unique, policy)
                .serial
                .is_none()
        );
    }
}
#[test]
fn placeholders_other_models_and_non_hardware_strings_never_qualify() {
    let m = model();
    for serial in [
        "",
        "000000000000",
        "FFFFFFFFFFFF",
        "000000000001",
        "0123456789AB",
        "123456789ABC",
        "123456789012",
        "A1B2C3D4E5F\n",
        "A1B2C3D4E5F6X",
        "A1B2 C3D4E5F",
        "键盘唯一编号000000",
    ] {
        let parent = format!("USB\\VID_19F5&PID_1028\\{serial}");
        assert!(
            evaluate(&m, 0x1028, Some(serial), serial, &parent, true, true)
                .serial
                .is_none(),
            "{serial:?}"
        );
    }
    let mut other = m;
    other.id = "kick75".into();
    assert!(evaluate(
        &other,
        0x1028,
        Some(SERIAL),
        SERIAL,
        &format!("USB\\VID_19F5&PID_1028\\{SERIAL}"),
        true,
        true
    )
    .serial
    .is_none());
}
