use crate::{decode, decode_routed, identify, BridgeError, Model, Result};
use serde::{Deserialize, Serialize};

/// Read-only schema qualification is independent of every write/recovery policy.
pub fn read_state_length(model: &Model, version: &str) -> Option<u8> {
    if version == model.qualified_firmware {
        return Some(model.lighting_state_length);
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Schema {
        model_id: String,
        firmware_version: String,
        state_length: u8,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Schemas {
        version: u8,
        additional_read_schemas: Vec<Schema>,
    }
    static SCHEMAS: std::sync::OnceLock<Schemas> = std::sync::OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../shared/contracts/lighting-read-schemas.json"
        ))
        .expect("invalid lighting read schemas")
    });
    assert_eq!(schemas.version, 1);
    schemas
        .additional_read_schemas
        .iter()
        .find(|s| s.model_id == model.id && s.firmware_version == version)
        .map(|s| s.state_length)
}

// Transport returns raw reports. Protocol validation always stays in core.
pub trait ReadTransport {
    fn read(
        &mut self,
        command: u8,
        length: u8,
        address: u16,
        handle: u8,
        key: u8,
    ) -> Result<Vec<u8>>;
}
#[derive(Debug, Clone)]
pub struct Identity {
    pub firmware: Vec<u8>,
    pub version: String,
    pub lighting_profile: u8,
    pub led_count: usize,
    pub(crate) key: u8,
}
pub fn inspect(transport: &mut impl ReadTransport, model: &Model) -> Result<Identity> {
    let (key, firmware, version) = identify(&transport.read(0xa1, 8, 0, 0, 0)?)?;
    let geometry = decode(&transport.read(0xa0, 8, 0, 0, key)?, 0xa0, 8, key)?;
    if geometry[0] > 1
        || geometry[1..5] != [8, 4, model.rows, model.columns]
        || (if geometry[5] & 0x80 != 0 {
            usize::from(geometry[5] & 0x7f) != model.extra_keys
        } else {
            model.extra_keys != 2
        })
    {
        return Err(BridgeError::new(
            "WRONG_GEOMETRY",
            "键盘布局与设备配置不一致，已停止读取",
        ));
    }
    let led_count = usize::from(decode(&transport.read(0xd1, 1, 0, 0, key)?, 0xd1, 1, key)?[0]);
    if led_count != model.key_count + model.side_count {
        return Err(BridgeError::new(
            "WRONG_LED_COUNT",
            "键盘灯位与设备配置不一致",
        ));
    }
    Ok(Identity {
        firmware,
        version,
        lighting_profile: geometry[0],
        led_count,
        key,
    })
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingSnapshot {
    pub model_id: String,
    pub firmware_version: String,
    pub lighting_profile: u8,
    pub led_count: usize,
    pub state: Vec<u8>,
    pub rendered_colors: Vec<String>,
    pub read_only: bool,
    pub no_mutation: bool,
    pub restoration_ready: bool,
}
pub fn capture(transport: &mut impl ReadTransport, model: &Model) -> Result<LightingSnapshot> {
    let before = inspect(transport, model)?;
    // Never guess a read length for an unidentified firmware family. The
    // exact read version and schema derive from shared, independent read rules.
    let length = read_state_length(model, &before.version).ok_or_else(|| {
        BridgeError::new(
            "LIGHTING_SCHEMA_UNVERIFIED",
            "此固件的灯光结构尚未核对，未读取灯效，也未修改键盘",
        )
    })?;
    let state = decode_routed(
        &transport.read(0xd5, length, 0, before.lighting_profile, before.key)?,
        0xd5,
        usize::from(length),
        0,
        before.lighting_profile,
        before.key,
    )?;
    validate_state(&state, model)?;
    let mut rgb = Vec::with_capacity(before.led_count * 3);
    while rgb.len() < before.led_count * 3 {
        let count = (before.led_count * 3 - rgb.len()).min(54) as u8;
        let address = rgb.len() as u16;
        rgb.extend(decode_routed(
            &transport.read(0xd2, count, address, 0, before.key)?,
            0xd2,
            usize::from(count),
            address,
            0,
            before.key,
        )?);
    }
    let after = inspect(transport, model)?;
    if before.key != after.key
        || before.firmware[..6] != after.firmware[..6]
        || before.lighting_profile != after.lighting_profile
    {
        return Err(BridgeError::new(
            "SNAPSHOT_SESSION_CHANGED",
            "读取期间键盘档位或会话已改变，本次结果已丢弃，请重新检查",
        ));
    }
    Ok(LightingSnapshot {
        model_id: model.id.clone(),
        firmware_version: before.version,
        lighting_profile: before.lighting_profile,
        led_count: before.led_count,
        state,
        rendered_colors: rgb
            .as_chunks::<3>()
            .0
            .iter()
            .map(|color| format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2]))
            .collect(),
        read_only: true,
        no_mutation: true,
        restoration_ready: false,
    })
}
pub(crate) fn validate_state(state: &[u8], model: &Model) -> Result<()> {
    let length = usize::from(model.lighting_state_length);
    if state.len() != length
        || !matches!(length, 17 | 22)
        || state[0] > (if length == 22 { 22 } else { 21 })
        || state[1] > 100
        || state[2] > 4
        || state[3] > 3
        || state[4] > 1
        || state[9] > (if model.side_count == 5 { 3 } else { 4 })
        || state[10] > 100
        || state[11] > 4
        || state[12] > 1
        || (length == 22 && state[17] > 7)
    {
        return Err(BridgeError::new(
            "INVALID_LIGHTING_STATE",
            "灯效设置未通过结构检查，未修改键盘",
        ));
    }
    // AIR 1.0.23.6's shape-speed read may exceed the setter range. Preserve
    // every byte as observed; this module has no setter or restoration path.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{checksum, lighting_read_frame, read_frame};
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
    struct Fake {
        model: Model,
        profile: u8,
        firmware: Vec<u8>,
        calls: Vec<(u8, u8, u16, u8)>,
        rgb_done: bool,
        change: &'static str,
        bad: &'static str,
        plain_route: bool,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                model: model(),
                profile: 1,
                firmware: vec![23, 0, 1, 0xaa, 6, 0, 0, 0],
                calls: vec![],
                rgb_done: false,
                change: "",
                bad: "",
                plain_route: false,
            }
        }
    }
    impl ReadTransport for Fake {
        fn read(
            &mut self,
            command: u8,
            length: u8,
            address: u16,
            handle: u8,
            key: u8,
        ) -> Result<Vec<u8>> {
            if matches!(command, 0xd5 | 0xd2) {
                lighting_read_frame(command, length, address, handle, key)?;
            } else {
                read_frame(command, length, key)?;
            }
            self.calls.push((command, length, address, handle));
            let current_key = if self.rgb_done && self.change == "key" {
                0x81
            } else {
                0x80
            };
            let payload = match command {
                0xa1 => {
                    let mut value = self.firmware.clone();
                    if self.rgb_done && self.change == "firmware" {
                        value[0] += 1;
                    }
                    value
                }
                0xa0 => vec![
                    if self.rgb_done && self.change == "profile" {
                        1 - self.profile
                    } else {
                        self.profile
                    },
                    8,
                    4,
                    self.model.rows,
                    self.model.columns,
                    0x80 | self.model.extra_keys as u8,
                    0,
                    0,
                ],
                0xd1 => vec![(self.model.key_count + self.model.side_count) as u8],
                0xd5 => {
                    let mut value = vec![0; usize::from(length)];
                    value[0] = 2;
                    value[1] = if self.bad == "state" { 101 } else { 60 };
                    value[9] = 2;
                    value[10] = 50;
                    if length == 22 {
                        value[21] = 94;
                    }
                    value
                }
                0xd2 => {
                    self.rgb_done = usize::from(address) + usize::from(length)
                        == (self.model.key_count + self.model.side_count) * 3;
                    (address..address + u16::from(length))
                        .map(|byte| byte as u8)
                        .collect()
                }
                _ => return Err(BridgeError::new("TEST_WRITE", "unexpected operation")),
            };
            let route = [length, address as u8, (address >> 8) as u8, handle];
            let mut raw = vec![0; 64];
            raw[0] = 0xaa;
            raw[1] = command;
            for (i, byte) in route.iter().enumerate() {
                raw[4 + i] = if self.plain_route {
                    *byte
                } else {
                    *byte ^ current_key
                };
            }
            for (i, byte) in payload.iter().enumerate() {
                raw[8 + i] = *byte ^ current_key;
            }
            if self.bad == "route" && command == 0xd2 {
                raw[5] ^= 3;
            }
            raw[3] = checksum(&raw);
            if self.bad == "checksum" && command == 0xd2 {
                raw[3] ^= 1;
            }
            Ok(raw)
        }
    }
    #[test]
    fn snapshot_reads_routed_state_and_all_rgb_without_a_setter() {
        for plain_route in [false, true] {
            let mut fake = Fake::new();
            fake.plain_route = plain_route;
            let model = fake.model.clone();
            let value = capture(&mut fake, &model).unwrap();
            assert_eq!(value.lighting_profile, 1);
            assert_eq!(value.rendered_colors.len(), 104);
            assert_eq!(value.rendered_colors[0], "#000102");
            assert_eq!(value.state[21], 94);
            assert!(!value.restoration_ready);
            assert!(value.no_mutation);
            assert!(fake.calls.contains(&(0xd5, 22, 0, 1)));
            assert!(fake.calls.contains(&(0xd2, 42, 270, 0)));
            assert!(fake
                .calls
                .iter()
                .all(|call| matches!(call.0, 0xa1 | 0xa0 | 0xd1 | 0xd5 | 0xd2)));
        }
    }
    #[test]
    fn seventeen_byte_schema_and_mac_profile_are_independent_of_host_os() {
        let mut fake = Fake::new();
        fake.profile = 0;
        fake.firmware = vec![18, 0, 4, 0xaa, 6, 0, 0, 0];
        fake.model.id = "kick75".into();
        fake.model.qualified_firmware = "4.0.18.6".into();
        fake.model.lighting_state_length = 17;
        fake.model.lighting_recovery_policy = crate::lighting_policy::PolicyKind::Kick75;
        fake.model.rgb_write_indices = (0..80).collect();
        fake.model.key_count = 80;
        fake.model.side_count = 5;
        fake.model.columns = 15;
        let model = fake.model.clone();
        let value = capture(&mut fake, &model).unwrap();
        assert_eq!(value.state.len(), 17);
        assert_eq!(value.rendered_colors.len(), 85);
        assert!(fake.calls.contains(&(0xd5, 17, 0, 0)));
    }
    #[test]
    fn unverified_firmware_never_receives_a_lighting_read() {
        let mut fake = Fake::new();
        fake.firmware = vec![0, 0, 2, 0xaa, 8, 0, 0, 0];
        let model = fake.model.clone();
        assert_eq!(
            capture(&mut fake, &model).unwrap_err().code,
            "LIGHTING_SCHEMA_UNVERIFIED"
        );
        assert_eq!(
            fake.calls.iter().map(|call| call.0).collect::<Vec<_>>(),
            vec![0xa1, 0xa0, 0xd1]
        );
    }
    #[test]
    fn air_2_read_schema_preserves_all_22_bytes_without_granting_recovery() {
        let mut fake = Fake::new();
        fake.firmware = vec![0, 0, 2, 0xaa, 7, 0, 0, 0];
        let model = fake.model.clone();
        let value = capture(&mut fake, &model).unwrap();
        assert_eq!(value.firmware_version, "2.0.0.7");
        assert_eq!(value.state.len(), 22);
        assert_eq!(value.state[21], 94);
        assert!(value.no_mutation && !value.restoration_ready);
        assert!(fake
            .calls
            .iter()
            .all(|c| matches!(c.0, 0xa1 | 0xa0 | 0xd1 | 0xd5 | 0xd2)));
        assert_eq!(
            crate::bridge::contract().capabilities["lightingWrite"],
            false
        );
        assert_eq!(read_state_length(&model, "2.0.0.8"), None);
        let mut other = model.clone();
        other.id = "another-air".into();
        assert_eq!(read_state_length(&other, "2.0.0.7"), None);
    }
    #[test]
    fn malformed_state_and_rgb_routing_fail_without_issuing_writes() {
        for (bad, code) in [
            ("state", "INVALID_LIGHTING_STATE"),
            ("route", "ROUTE_MISMATCH"),
            ("checksum", "INVALID_CHECKSUM"),
        ] {
            let mut fake = Fake::new();
            fake.bad = bad;
            let model = fake.model.clone();
            assert_eq!(capture(&mut fake, &model).unwrap_err().code, code);
        }
    }
    #[test]
    fn changed_profile_firmware_or_key_discards_the_complete_sample() {
        for change in ["profile", "firmware", "key"] {
            let mut fake = Fake::new();
            fake.change = change;
            let model = fake.model.clone();
            assert_eq!(
                capture(&mut fake, &model).unwrap_err().code,
                "SNAPSHOT_SESSION_CHANGED"
            );
        }
    }
    #[test]
    fn lighting_read_builder_rejects_mutations_and_out_of_bounds_routes() {
        for (op, length, address, handle) in [
            (0xd6, 17, 0, 0),
            (0xd8, 54, 0, 0),
            (0xb3, 2, 0, 0),
            (0xf5, 1, 0, 0),
            (0xd5, 56, 0, 0),
            (0xd5, 17, 0, 2),
            (0xd5, 17, 1, 0),
            (0xd2, 55, 0, 0),
            (0xd2, 54, 720, 0),
            (0xd2, 3, 1, 0),
            (0xd2, 54, 0, 1),
        ] {
            assert!(lighting_read_frame(op, length, address, handle, 0x80).is_err());
        }
        let frame = lighting_read_frame(0xd5, 22, 0, 1, 0x80).unwrap();
        assert_eq!(frame[7], 0x81);
        assert!(frame[8..].iter().all(|byte| *byte == 0));
    }
}
