#[cfg(test)]
extern crate self as nuphylab_core;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, Read};
pub mod bridge;
pub mod controller;
pub mod function_keys;
pub mod keymap;
pub mod lighting;
pub mod lighting_policy;
pub mod output;
pub mod recovery;
pub mod sleep_inspection;

pub const REPORT_SIZE: usize = 64;
pub const MAX_LINE: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}
impl BridgeError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, BridgeError>;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub vendor_id: u16,
    pub product_ids: Vec<u16>,
    pub key_count: usize,
    pub side_count: usize,
    pub canvas_count: usize,
    pub rows: u8,
    pub columns: u8,
    pub extra_keys: usize,
    pub qualified_firmware: String,
    pub lighting_state_length: u8,
    pub lighting_recovery_policy: lighting_policy::PolicyKind,
    pub rgb_write_indices: Vec<u8>,
}
pub fn models(text: &str) -> Result<Vec<Model>> {
    let values: Vec<Model> = serde_json::from_str(text)
        .map_err(|_| BridgeError::new("INVALID_MODELS", "设备配置无效"))?;
    let mut ids = std::collections::HashSet::new();
    let mut products = std::collections::HashSet::new();
    if values.is_empty() || values.len() > 32 {
        return Err(BridgeError::new("INVALID_MODELS", "设备配置数量无效"));
    }
    for model in &values {
        if model.vendor_id != 0x19f5
            || model.id.is_empty()
            || !ids.insert(&model.id)
            || model.product_ids.is_empty()
            || model.product_ids.iter().any(|pid| !products.insert(*pid))
            || model.key_count == 0
            || model.key_count + model.side_count > 255
            || model.canvas_count < model.key_count
            || model.rows == 0
            || model.columns == 0
            || !matches!(model.lighting_state_length, 17 | 22)
            || !model.lighting_recovery_policy.accepts(model)
            || model.rgb_write_indices.len() != model.key_count
            || model
                .rgb_write_indices
                .iter()
                .any(|&i| usize::from(i) >= model.key_count)
            || model
                .rgb_write_indices
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != model.key_count
        {
            return Err(BridgeError::new("INVALID_MODELS", "设备身份或布局配置无效"));
        }
    }
    Ok(values)
}

pub fn checksum(bytes: &[u8]) -> u8 {
    bytes
        .iter()
        .skip(4)
        .fold(0u8, |sum, byte| sum.wrapping_add(*byte))
}

pub fn verify_control_descriptor(bytes: &[u8]) -> Result<()> {
    let invalid = || {
        BridgeError::new(
            "INVALID_DESCRIPTOR",
            "控制接口必须提供无编号的 64 字节输入和输出报告",
        )
    };
    let (mut at, mut size, mut count, mut input, mut output) = (0usize, 0u32, 0u32, 0u32, 0u32);
    let mut stack = Vec::new();
    while at < bytes.len() {
        let prefix = bytes[at];
        at += 1;
        // No long items are needed by the qualified S4 control collection.
        if prefix == 0xfe {
            return Err(invalid());
        }
        let length = match prefix & 3 {
            3 => 4,
            value => value as usize,
        };
        let data = bytes.get(at..at + length).ok_or_else(invalid)?;
        at += length;
        let value = data
            .iter()
            .enumerate()
            .fold(0u32, |v, (i, b)| v | u32::from(*b) << (i * 8));
        match ((prefix >> 2) & 3, prefix >> 4) {
            (1, 7) => size = value,
            (1, 9) => count = value,
            (1, 8) => return Err(invalid()),
            (1, 10) => {
                if stack.len() >= 16 {
                    return Err(invalid());
                }
                stack.push((size, count));
            }
            (1, 11) => {
                (size, count) = stack.pop().ok_or_else(invalid)?;
            }
            (0, 8) | (0, 9) => {
                let bits = size
                    .checked_mul(count)
                    .filter(|n| *n <= 65536)
                    .ok_or_else(invalid)?;
                if prefix >> 4 == 8 {
                    input = input.checked_add(bits).ok_or_else(invalid)?;
                } else {
                    output = output.checked_add(bits).ok_or_else(invalid)?;
                }
            }
            _ => {}
        }
    }
    if !stack.is_empty() || input != 512 || output != 512 {
        return Err(invalid());
    }
    Ok(())
}

// Reads never carry a payload or construct setting/RGB/keymap writes.
pub fn read_frame(command: u8, length: u8, key: u8) -> Result<[u8; REPORT_SIZE]> {
    if !matches!((command, length), (0xa0, 8) | (0xa1, 8) | (0xd1, 1)) {
        return Err(BridgeError::new(
            "READ_ONLY",
            "此版本只允许设备身份、布局和灯位读取",
        ));
    }
    Ok(read_route_frame(command, length, 0, 0, key))
}
pub fn lighting_read_frame(
    command: u8,
    length: u8,
    address: u16,
    handle: u8,
    key: u8,
) -> Result<[u8; REPORT_SIZE]> {
    let allowed = match command {
        0xd5 => matches!(length, 17 | 22) && address == 0 && handle <= 1,
        0xd2 => {
            length > 0
                && length <= 54
                && length.is_multiple_of(3)
                && address.is_multiple_of(3)
                && u32::from(address) + u32::from(length) <= 255 * 3
                && handle == 0
        }
        _ => false,
    };
    if !allowed {
        return Err(BridgeError::new(
            "READ_ONLY",
            "灯效检查只允许限定范围的 D5 和 D2 读取",
        ));
    }
    Ok(read_route_frame(command, length, address, handle, key))
}
fn read_route_frame(
    command: u8,
    length: u8,
    address: u16,
    handle: u8,
    key: u8,
) -> [u8; REPORT_SIZE] {
    let mut bytes = [0u8; REPORT_SIZE];
    bytes[0] = 0x55;
    bytes[1] = command;
    bytes[4] = length ^ key;
    bytes[5] = address as u8 ^ key;
    bytes[6] = (address >> 8) as u8 ^ key;
    bytes[7] = handle ^ key;
    bytes[3] = checksum(&bytes);
    bytes
}
pub fn validate(bytes: &[u8], command: u8) -> Result<()> {
    if bytes.len() != REPORT_SIZE || bytes[0] != 0xaa || bytes[1] != command || bytes[2] != 0 {
        return Err(BridgeError::new(
            "INVALID_REPLY",
            "设备回复长度或标记不匹配",
        ));
    }
    if bytes[3] != checksum(bytes) {
        return Err(BridgeError::new("INVALID_CHECKSUM", "设备回复校验失败"));
    }
    Ok(())
}
pub fn decode(bytes: &[u8], command: u8, length: usize, key: u8) -> Result<Vec<u8>> {
    decode_routed(bytes, command, length, 0, 0, key)
}
pub fn decode_routed(
    bytes: &[u8],
    command: u8,
    length: usize,
    address: u16,
    handle: u8,
    key: u8,
) -> Result<Vec<u8>> {
    validate(bytes, command)?;
    if length > 56 {
        return Err(BridgeError::new("INVALID_REPLY", "回复数据长度无效"));
    }
    let route = [length as u8, address as u8, (address >> 8) as u8, handle];
    if bytes[4..8] != route && bytes[4..8].iter().map(|v| v ^ key).collect::<Vec<_>>() != route {
        return Err(BridgeError::new(
            "ROUTE_MISMATCH",
            "设备回复路由不匹配，请关闭其他键盘设置程序",
        ));
    }
    Ok(bytes[8..8 + length].iter().map(|v| v ^ key).collect())
}
pub fn identify(bytes: &[u8]) -> Result<(u8, Vec<u8>, String)> {
    validate(bytes, 0xa1)?;
    let key = bytes[11] ^ 0xaa;
    let info = decode(bytes, 0xa1, 8, key)?;
    if info[3] != 0xaa {
        return Err(BridgeError::new("FIRMWARE_REPLY", "固件身份标记无效"));
    }
    let version = format!(
        "{}.{}.{}.{}",
        info[2],
        info[1],
        info[0],
        u16::from_le_bytes([info[4], info[5]])
    );
    Ok((key, info, version))
}

// Take limits allocation even if stdin never sends a newline.
pub fn json_line(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    (&mut *reader)
        .take((MAX_LINE + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| BridgeError::new("PIPE_READ", "无法读取桥接命令"))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_LINE || bytes.last() != Some(&b'\n') {
        return Err(BridgeError::new(
            "INVALID_REQUEST",
            "命令超过长度限制或没有完整换行",
        ));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| BridgeError::new("INVALID_REQUEST", "命令不是有效 JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reply(command: u8, data: &[u8], key: u8) -> Vec<u8> {
        let mut b = vec![0; 64];
        b[0] = 0xaa;
        b[1] = command;
        b[4] = data.len() as u8 ^ key;
        b[5] = key;
        b[6] = key;
        b[7] = key;
        for (i, v) in data.iter().enumerate() {
            b[8 + i] = v ^ key;
        }
        b[3] = checksum(&b);
        b
    }
    #[test]
    fn read_allowlist_rejects_every_mutation() {
        for op in [0xb3, 0xd6, 0xd8, 0xf5, 0xee] {
            assert_eq!(read_frame(op, 1, 0).unwrap_err().code, "READ_ONLY");
        }
        let b = read_frame(0xa1, 8, 0).unwrap();
        assert_eq!(&b[..8], &[0x55, 0xa1, 0, 8, 8, 0, 0, 0]);
    }
    #[test]
    fn identity_routing_and_length_are_checked() {
        let b = reply(0xa1, &[23, 0, 1, 0xaa, 6, 0, 0, 0], 0x80);
        let (k, info, version) = identify(&b).unwrap();
        assert_eq!(k, 0x80);
        assert_eq!(info[3], 0xaa);
        assert_eq!(version, "1.0.23.6");
        assert!(identify(&b[..63]).is_err());
        let mut corrupt = b.clone();
        corrupt[20] ^= 1;
        assert_eq!(identify(&corrupt).unwrap_err().code, "INVALID_CHECKSUM");
        let mut route = b;
        route[7] ^= 1;
        route[3] = checksum(&route);
        assert_eq!(identify(&route).unwrap_err().code, "ROUTE_MISMATCH");
        let leds = reply(0xd1, &[104], 0x80);
        assert_eq!(decode(&leds, 0xd1, 1, 0x80).unwrap(), vec![104]);
    }
    #[test]
    fn lines_are_bounded_and_eof_is_distinct() {
        assert!(json_line(&mut &b""[..]).unwrap().is_none());
        assert_eq!(
            json_line(&mut &b"{\"op\":\"status\"}\n"[..])
                .unwrap()
                .unwrap()["op"],
            "status"
        );
        assert!(json_line(&mut &b"{}"[..]).is_err());
        assert!(json_line(&mut &vec![b'a'; MAX_LINE + 1][..]).is_err());
    }
    #[test]
    fn descriptor_rejects_wrong_lengths_report_ids_and_truncation() {
        let good = [0x75, 8, 0x95, 64, 0x81, 2, 0x91, 2];
        assert!(verify_control_descriptor(&good).is_ok());
        let mut wrong = good;
        wrong[3] = 63;
        assert!(verify_control_descriptor(&wrong).is_err());
        assert!(verify_control_descriptor(&[&[0x85, 1][..], &good].concat()).is_err());
        assert!(verify_control_descriptor(&good[..7]).is_err());
        assert!(verify_control_descriptor(&[]).is_err());
    }
}
