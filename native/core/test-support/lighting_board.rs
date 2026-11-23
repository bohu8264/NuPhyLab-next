use nuphylab_core::{
    lighting_policy,
    output::{Connection, Transport},
    BridgeError, Model, Result,
};
use serde::Deserialize;
use std::time::Duration;
use std::{fs, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Fixture {
    pub(crate) models: Vec<Model>,
    pub(crate) swift_models: Vec<SwiftModel>,
    pub(crate) frames: Vec<Frame>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwiftModel {
    pub(crate) id: String,
    pub(crate) rgb_write_indices: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Frame {
    pub(crate) model_id: String,
    pub(crate) key: u8,
    pub(crate) profile: u8,
    pub(crate) command: u8,
    pub(crate) payload: Vec<u8>,
    pub(crate) frame: Vec<u8>,
}
pub(crate) fn fixture() -> Fixture {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/windows-lighting-recovery.json"
    )))
    .unwrap()
}
pub(crate) fn model() -> Model {
    fixture().models.remove(0)
}
pub(crate) fn directory() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let directory = tmp.path().join("灯光事务 Windows 空格 0");
    fs::create_dir(&directory).unwrap();
    (tmp, directory)
}
pub(crate) fn code<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected rejection"),
        Err(e) => e.code,
    }
}

#[derive(Clone)]
pub(crate) struct Board {
    pub(crate) model: Model,
    pub(crate) map: Vec<u8>,
    pub(crate) connection: Connection,
    pub(crate) firmware: Vec<u8>,
    pub(crate) key: u8,
    pub(crate) profile: u8,
    pub(crate) state: Vec<u8>,
    pub(crate) sleep: [u8; 4],
    pub(crate) palette: Vec<u8>,
    pub(crate) calls: Vec<[u8; 64]>,
    pub(crate) waits: Vec<u64>,
    pub(crate) fail_command: Option<u8>,
    pub(crate) panic_after: Option<u8>,
    pub(crate) bad_echo: Option<u8>,
    pub(crate) bad_route: Option<u8>,
    pub(crate) change_after_write: Option<&'static str>,
    pub(crate) stuck_state: bool,
    pub(crate) corrupt_color: bool,
    pub(crate) always_corrupt: bool,
    pub(crate) plain: bool,
}
impl Board {
    pub(crate) fn new(model: &Model) -> Self {
        let version: Vec<u16> = model
            .qualified_firmware
            .split('.')
            .map(|v| v.parse().unwrap())
            .collect();
        let mut state = vec![2, 60, 2, 0, 1, 3, 31, 47, 63, 2, 45, 1, 0, 0, 12, 34, 56];
        if model.lighting_state_length == 22 {
            state[6..9].copy_from_slice(
                &lighting_policy::main_color_readback_for(
                    model,
                    &model.qualified_firmware,
                    [31, 47, 63],
                )
                .unwrap(),
            );
            state.extend([3, 24, 48, 96, 94]);
        }
        Self {
            model: model.clone(),
            map: fixture()
                .swift_models
                .into_iter()
                .find(|m| m.id == model.id)
                .unwrap()
                .rgb_write_indices,
            connection: Connection {
                vendor_id: model.vendor_id,
                product_id: model.product_ids[0],
                serial: Some("raw-fixture-board".into()),
                token: "control-handle-1".into(),
            },
            firmware: vec![
                version[2] as u8,
                version[1] as u8,
                version[0] as u8,
                0xaa,
                version[3] as u8,
                (version[3] >> 8) as u8,
                0,
                0,
            ],
            key: 0x80,
            profile: 1,
            state,
            sleep: [1, 6, 30, 0],
            palette: (0..model.key_count * 3)
                .map(|i| ((i * 73 + 31) % 256) as u8)
                .collect(),
            calls: vec![],
            waits: vec![],
            fail_command: None,
            panic_after: None,
            bad_echo: None,
            bad_route: None,
            change_after_write: None,
            stuck_state: false,
            corrupt_color: false,
            always_corrupt: false,
            plain: false,
        }
    }
    pub(crate) fn version(&self) -> String {
        format!(
            "{}.{}.{}.{}",
            self.firmware[2],
            self.firmware[1],
            self.firmware[0],
            u16::from_le_bytes([self.firmware[4], self.firmware[5]])
        )
    }
    pub(crate) fn rgb(&self) -> Vec<u8> {
        let mut main = if self.state[0] == 21 {
            // A fault may change the reported firmware to an unregistered
            // version. The simulated pixels still exist for the audit even
            // when production correctly refuses to open that connection.
            lighting_policy::rendered_palette(&self.model, &self.version(), &self.palette)
                .or_else(|_| {
                    lighting_policy::rendered_palette(
                        &self.model,
                        &self.model.qualified_firmware,
                        &self.palette,
                    )
                })
                .unwrap()
        } else {
            self.state[6..9].repeat(self.model.key_count)
        };
        for value in &mut main {
            *value = (u16::from(*value) * u16::from(self.state[1]) / 100) as u8;
        }
        let side: Vec<u8> = self.state[14..17]
            .iter()
            .map(|&v| (u16::from(v) * u16::from(self.state[10]) / 100) as u8)
            .collect();
        main.extend(side.repeat(self.model.side_count));
        main
    }
    pub(crate) fn writes(&self) -> Vec<&[u8; 64]> {
        self.calls
            .iter()
            .filter(|f| matches!(f[1], 0xd6 | 0xd8))
            .collect()
    }
}
impl Transport for Board {
    fn connection(&self) -> Connection {
        self.connection.clone()
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.waits.push(delay.as_millis() as u64);
        Ok(())
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        assert!(!timeout.is_zero() && timeout <= Duration::from_millis(1200));
        assert_eq!(frame[0], 0x55);
        assert_eq!(frame[3], nuphylab_core::checksum(frame));
        self.calls.push(*frame);
        let command = frame[1];
        let route_key = if command == 0xa1 { 0 } else { self.key };
        let length = usize::from(frame[4] ^ route_key);
        let address = u16::from(frame[5] ^ route_key) | u16::from(frame[6] ^ route_key) << 8;
        let handle = frame[7] ^ route_key;
        let mut payload = match command {
            0xa1 => self.firmware.clone(),
            0xa0 => vec![
                self.profile,
                8,
                4,
                self.model.rows,
                self.model.columns,
                0x80 | self.model.extra_keys as u8,
                0,
                0,
            ],
            0xd1 => vec![(self.model.key_count + self.model.side_count) as u8],
            0xf3 => {
                assert_eq!((length, address, handle), (4, 0, 0));
                self.sleep.to_vec()
            }
            0xf5 => {
                assert_eq!((length, address, handle), (1, 0, 0));
                let enabled = frame[8] ^ self.key;
                assert!(enabled <= 1);
                self.sleep[0] = enabled;
                vec![enabled]
            }
            0xd5 => {
                assert_eq!(handle, self.profile);
                self.state.clone()
            }
            0xd2 => {
                let mut colors = self.rgb();
                if self.corrupt_color || self.always_corrupt {
                    colors[0] ^= 1;
                    self.corrupt_color = false;
                }
                colors[usize::from(address)..usize::from(address) + length].to_vec()
            }
            0xd6 => {
                assert_eq!(length, 17);
                assert_eq!(address, 0);
                assert_eq!(handle, self.profile);
                let values: Vec<u8> = frame[8..8 + length].iter().map(|v| v ^ self.key).collect();
                if !self.stuck_state {
                    for (i, &v) in values.iter().enumerate() {
                        if (self.model.id == "air75-v3" && i == 13)
                            || (self.model.lighting_recovery_policy
                                == lighting_policy::PolicyKind::Additional
                                && matches!(i, 5 | 13))
                        {
                            continue;
                        }
                        self.state[i] = v;
                    }
                    if self.model.id == "air75-v3" {
                        let rendered = lighting_policy::main_color_readback_for(
                            &self.model,
                            &self.version(),
                            values[6..9].try_into().unwrap(),
                        )
                        .unwrap();
                        self.state[6..9].copy_from_slice(&rendered);
                    }
                }
                values
            }
            0xd8 => {
                assert_eq!(address, 0);
                assert_eq!(handle, self.profile);
                assert!(length <= 52 && length.is_multiple_of(4));
                let values: Vec<u8> = frame[8..8 + length].iter().map(|v| v ^ self.key).collect();
                for record in values.as_chunks::<4>().0 {
                    let logical = self.map.iter().position(|&p| p == record[0]).unwrap();
                    self.palette[logical * 3..logical * 3 + 3].copy_from_slice(&record[1..]);
                }
                values
            }
            _ => panic!("unexpected raw command {command:x}"),
        };
        assert_eq!(payload.len(), length);
        if matches!(command, 0xd6 | 0xd8 | 0xf5) {
            if self.panic_after == Some(command) {
                self.panic_after = None;
                panic!("simulated transport unwind after applied write");
            }
            if self.fail_command == Some(command) {
                self.fail_command = None;
                return Err(error(
                    "HID_TIMEOUT",
                    "simulated applied write with missing acknowledgement",
                ));
            }
            if self.bad_echo == Some(command) {
                self.bad_echo = None;
                payload[0] ^= 1;
            }
            if let Some(change) = self.change_after_write.take() {
                match change {
                    "profile" => self.profile ^= 1,
                    "key" => self.key ^= 1,
                    "token" => self.connection.token = "new-handle".into(),
                    "firmware" => self.firmware[0] += 1,
                    _ => unreachable!(),
                }
            }
        }
        let mut raw = vec![0; 64];
        raw[0] = 0xaa;
        raw[1] = command;
        let key = if self.plain { 0 } else { self.key };
        raw[4] = length as u8 ^ key;
        raw[5] = address as u8 ^ key;
        raw[6] = (address >> 8) as u8 ^ key;
        raw[7] = handle ^ key;
        if self.bad_route == Some(command) {
            self.bad_route = None;
            raw[7] ^= 1;
        }
        for (i, v) in payload.into_iter().enumerate() {
            raw[8 + i] = v ^ self.key;
        }
        raw[3] = nuphylab_core::checksum(&raw);
        Ok(raw)
    }
}

fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}
