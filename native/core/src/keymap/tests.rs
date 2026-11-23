use super::*;
use crate::{
    output::tests::{code, fixture, model, Board},
    output::Transport,
};
use std::time::Duration;
struct Keyboard {
    board: Board,
    active: Vec<u16>,
    defaults: [Vec<u16>; 2],
    reads: Vec<u8>,
    map_reads: usize,
    geometry_reads: usize,
    fault: &'static str,
}
impl Keyboard {
    fn new(model: &Model) -> Self {
        let count = key_count(model).unwrap();
        let mac = [
            105, 106, 32262, 32263, 32264, 32278, 172, 174, 171, 168, 170, 169,
        ];
        let mut defaults = [vec![4; count], vec![4; count]];
        for i in 0..12 {
            defaults[0][i + 1] = mac[i];
            defaults[1][i + 1] = 58 + i as u16;
        }
        defaults[0][count - 1] = 0xabcd;
        defaults[1][count - 1] = 0x1234;
        Self {
            board: Board::new(model),
            active: defaults[1].clone(),
            defaults,
            reads: vec![],
            map_reads: 0,
            geometry_reads: 0,
            fault: "",
        }
    }
}
impl ReadTransport for Keyboard {
    fn read(
        &mut self,
        command: u8,
        length: u8,
        address: u16,
        handle: u8,
        key: u8,
    ) -> Result<Vec<u8>> {
        self.reads.push(command);
        if !matches!(command, 0xb1 | 0xb2) {
            assert!(matches!(command, 0xa0 | 0xa1 | 0xd1));
            let mut reply = self.board.exchange(
                &crate::read_frame(command, length, key)?,
                Duration::from_millis(1200),
            )?;
            if command == 0xa0 {
                self.geometry_reads += 1;
                if self.fault == "geometry" && self.geometry_reads == 4 {
                    reply[14] ^= 1;
                    reply[3] = crate::checksum(&reply);
                }
            }
            return Ok(reply);
        }
        read_frame(&self.board.model, command, length, address, handle, key)?;
        let size = key_count(&self.board.model)? * 2;
        let layer = usize::from(address) / size;
        let offset = usize::from(address) % size;
        let chunks = size.div_ceil(56);
        if self.map_reads >= 3 * chunks {
            match self.fault {
                "active" => self.active[20] ^= 1,
                "macDefault" => self.defaults[0][20] ^= 1,
                "winDefault" => self.defaults[1][20] ^= 1,
                _ => {}
            }
        }
        self.map_reads += 1;
        let values = if command == 0xb2 {
            assert_eq!(layer, usize::from(self.board.profile) * 4);
            &self.active
        } else {
            &self.defaults[if layer == 0 {
                0
            } else {
                assert_eq!(layer, 4);
                1
            }]
        };
        let bytes: Vec<_> = values.iter().flat_map(|v| v.to_be_bytes()).collect();
        let mut reply = vec![0; 64];
        reply[0] = 0xaa;
        reply[1] = command;
        let route_key = if self.board.plain { 0 } else { key };
        reply[4] = length ^ route_key;
        reply[5] = address as u8 ^ route_key;
        reply[6] = (address >> 8) as u8 ^ route_key;
        reply[7] = handle ^ route_key;
        for (i, &v) in bytes[offset..offset + usize::from(length)]
            .iter()
            .enumerate()
        {
            reply[8 + i] = v ^ key;
        }
        if self.fault == "route" {
            reply[5] ^= 2;
        }
        reply[3] = crate::checksum(&reply);
        if self.map_reads == 6 * chunks {
            match self.fault {
                "key" => self.board.key ^= 1,
                "firmware" => self.board.firmware[0] += 1,
                "profile" => self.board.profile ^= 1,
                _ => {}
            }
        }
        Ok(reply)
    }
}
#[test]
fn official_encoder_and_parser_samples_match_both_keymap_read_commands() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/nuphy-official-keymap-frames.json"
    ))
    .unwrap();
    let models = fixture().models;
    let rows = data["examples"].as_array().unwrap();
    assert_eq!(rows.len(), 96);
    for row in rows {
        let model = models.iter().find(|m| m.id == row["modelId"]).unwrap();
        let expected: Vec<u8> = serde_json::from_value(row["frame"].clone()).unwrap();
        assert_eq!(
            read_frame(
                model,
                row["command"].as_u64().unwrap() as u8,
                row["length"].as_u64().unwrap() as u8,
                row["address"].as_u64().unwrap() as u16,
                0,
                row["key"].as_u64().unwrap() as u8
            )
            .unwrap()
            .as_slice(),
            expected
        );
    }
}
#[test]
fn all_models_profiles_and_route_encodings_read_complete_big_endian_layers_without_writes() {
    for model in fixture().models {
        for profile in [0, 1] {
            for key in [0, 128, 255] {
                for plain in [false, true] {
                    let mut keyboard = Keyboard::new(&model);
                    keyboard.board.profile = profile;
                    keyboard.board.key = key;
                    keyboard.board.plain = plain;
                    keyboard.active = keyboard.defaults[profile as usize].clone();
                    let original = keyboard.active.clone();
                    let snapshot = capture(&mut keyboard, &model).unwrap();
                    assert_eq!(snapshot.active, original);
                    assert_eq!(snapshot.defaults, keyboard.defaults);
                    assert_eq!(snapshot.keymap_key_count, key_count(&model).unwrap());
                    assert_eq!(
                        snapshot.active.last(),
                        Some(if profile == 0 { &0xabcd } else { &0x1234 })
                    );
                    assert!(
                        snapshot.no_mutation && snapshot.read_only && !snapshot.restoration_ready
                    );
                    assert!(keyboard.board.writes().is_empty());
                    assert!(keyboard
                        .reads
                        .iter()
                        .all(|c| matches!(c, 0xa0 | 0xa1 | 0xd1 | 0xb1 | 0xb2)));
                }
            }
        }
    }
}
#[test]
fn registered_air_2_observation_never_mutates_and_unknown_firmware_never_reads_layers() {
    for version in [7, 8] {
        let model = model();
        let mut keyboard = Keyboard::new(&model);
        keyboard.board.firmware = [0, 0, 2, 170, version, 0, 0, 0].to_vec();
        if version == 7 {
            assert!(capture(&mut keyboard, &model).unwrap().no_mutation);
            let lighting = crate::output::Lighting::open(keyboard.board, model).unwrap();
            assert!(lighting.into_transport().writes().is_empty());
            assert_eq!(crate::bridge::contract().capabilities["keymapWrite"], false);
        } else {
            assert_eq!(
                code(capture(&mut keyboard, &model)),
                "KEYMAP_SCHEMA_UNVERIFIED"
            );
            assert_eq!(keyboard.map_reads, 0);
        }
    }
}
#[test]
fn changing_any_layer_identity_geometry_or_route_discards_the_complete_observation() {
    for fault in [
        "active",
        "macDefault",
        "winDefault",
        "key",
        "firmware",
        "profile",
        "geometry",
        "route",
    ] {
        let model = model();
        let mut keyboard = Keyboard::new(&model);
        keyboard.fault = fault;
        assert_eq!(
            code(capture(&mut keyboard, &model)),
            if fault == "route" {
                "ROUTE_MISMATCH"
            } else {
                "KEYMAP_SESSION_CHANGED"
            }
        );
        assert!(keyboard.board.writes().is_empty());
    }
}
#[test]
fn reader_refuses_mutations_odd_or_cross_layer_reads_and_unbounded_geometry() {
    let model = model();
    let size = key_count(&model).unwrap() * 2;
    for (command, length, address, handle) in [
        (0xb3, 2, 0, 0),
        (0xb4, 2, 0, 0),
        (0xd8, 4, 0, 0),
        (0xb1, 0, 0, 0),
        (0xb2, 57, 0, 0),
        (0xb1, 1, 0, 0),
        (0xb2, 2, 1, 0),
        (0xb2, 2, 0, 1),
        (0xb1, 4, (size - 2) as u16, 0),
        (0xb2, 2, (size * 8) as u16, 0),
    ] {
        assert!(read_frame(&model, command, length, address, handle, 0).is_err());
    }
    assert!(bounded_read_frame(0xb2, 2, 4096, 0, 0).is_err());
    let mut invalid = model;
    invalid.rows = 255;
    invalid.columns = 255;
    assert!(key_count(&invalid).is_err());
}
