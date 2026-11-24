use super::*;
use crate::{
    lighting::ReadTransport,
    output::{
        tests::{model, Board},
        Transport,
    },
};
use std::time::Duration;

struct Reader {
    board: Board,
    reads: usize,
    change: &'static str,
}
impl Reader {
    fn new() -> Self {
        let mut board = Board::new(&model());
        board.firmware = vec![0, 0, 2, 0xaa, 7, 0, 0, 0];
        board.sleep = [1, 10, 30, 213];
        Self {
            board,
            reads: 0,
            change: "",
        }
    }
}
impl ReadTransport for Reader {
    fn read(
        &mut self,
        command: u8,
        length: u8,
        address: u16,
        handle: u8,
        key: u8,
    ) -> Result<Vec<u8>> {
        let frame = if command == 0xf3 {
            read_frame(length, address, handle, key)?
        } else {
            crate::read_frame(command, length, key)?
        };
        if command == 0xf3 {
            self.reads += 1;
            if self.reads == 2 && self.change == "time" {
                self.board.sleep[1] += 1;
            }
        }
        let result = self.board.exchange(&frame, Duration::from_millis(1200));
        if command == 0xf3 && self.reads == 2 {
            match self.change {
                "profile" => self.board.profile = 1 - self.board.profile,
                "key" => self.board.key ^= 1,
                "firmware" => self.board.firmware[4] += 1,
                _ => {}
            }
        }
        result
    }
}

#[test]
fn sleep_observation_is_global_preserves_unknown_bytes_and_has_no_writer() {
    for profile in [0, 1] {
        for plain in [false, true] {
            let mut reader = Reader::new();
            reader.board.profile = profile;
            reader.board.plain = plain;
            let original = reader.board.sleep;
            let snapshot = capture(&mut reader, &model()).unwrap();
            assert_eq!(snapshot.state, original);
            assert_eq!(snapshot.lighting_profile, profile);
            assert!(
                snapshot.enabled
                    && snapshot.no_mutation
                    && snapshot.read_only
                    && !snapshot.restoration_ready
            );
            assert_eq!(reader.board.sleep, original);
            assert_eq!(reader.reads, 2);
            assert!(reader
                .board
                .calls
                .iter()
                .all(|f| matches!(f[1], 0xa1 | 0xa0 | 0xd1 | 0xf3)));
            assert_eq!(
                crate::bridge::contract().capabilities["lightingWrite"],
                false
            );
        }
    }
}
#[test]
fn unsupported_models_and_versions_are_rejected_before_f3() {
    for (id, version) in [("air75-v3", 8), ("kick75", 7)] {
        let mut reader = Reader::new();
        reader.board.firmware[4] = version;
        let mut m = model();
        m.id = id.into();
        assert_eq!(
            capture(&mut reader, &m).unwrap_err().code,
            "SLEEP_SCHEMA_UNVERIFIED"
        );
        assert_eq!(reader.reads, 0);
    }
    assert_eq!(read_length(&model(), "1.0.23.6"), Some(4));
}
#[test]
fn inconsistent_sleep_and_identity_changes_discard_observations_without_mutation() {
    for (change, code) in [
        ("time", "SLEEP_SNAPSHOT_CHANGED"),
        ("profile", "SNAPSHOT_SESSION_CHANGED"),
        ("key", "SNAPSHOT_SESSION_CHANGED"),
        ("firmware", "SNAPSHOT_SESSION_CHANGED"),
    ] {
        let mut reader = Reader::new();
        reader.change = change;
        assert_eq!(capture(&mut reader, &model()).unwrap_err().code, code);
        assert!(reader
            .board
            .calls
            .iter()
            .all(|f| matches!(f[1], 0xa1 | 0xa0 | 0xd1 | 0xf3)));
    }
}
#[test]
fn malformed_replies_and_read_routes_do_not_succeed() {
    let mut reader = Reader::new();
    reader.board.sleep[0] = 2;
    assert_eq!(
        capture(&mut reader, &model()).unwrap_err().code,
        "SLEEP_REPLY_INVALID"
    );
    let mut reader = Reader::new();
    reader.board.bad_route = Some(0xf3);
    assert_eq!(
        capture(&mut reader, &model()).unwrap_err().code,
        "ROUTE_MISMATCH"
    );
    for (length, address, handle) in [(1, 0, 0), (4, 1, 0), (4, 0, 1), (0, 0, 0)] {
        assert_eq!(
            read_frame(length, address, handle, 0x80).unwrap_err().code,
            "READ_ONLY"
        );
    }
}
#[test]
fn sleep_reads_match_independent_official_encoder_samples() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/nuphy-official-s4-frames.json"
    ))
    .unwrap();
    let mut count = 0;
    for row in data["examples"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["command"] == 0xf3)
    {
        let key = row["key"].as_u64().unwrap() as u8;
        let expected: Vec<u8> = serde_json::from_value(row["frame"].clone()).unwrap();
        assert_eq!(read_frame(4, 0, 0, key).unwrap().as_slice(), expected);
        count += 1;
    }
    assert_eq!(count, 3);
}
