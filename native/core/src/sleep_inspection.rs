//! Board-global observation only. It cannot acquire a lease or issue F5.
use crate::{lighting, BridgeError, Model, Result, REPORT_SIZE};
use serde::{Deserialize, Serialize};

pub fn read_length(model: &Model, version: &str) -> Option<u8> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Schema {
        model_id: String,
        firmware_version: String,
        state_length: u8,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Schemas {
        version: u8,
        schemas: Vec<Schema>,
    }
    static SCHEMAS: std::sync::OnceLock<Schemas> = std::sync::OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../shared/contracts/sleep-read-schemas.json"
        ))
        .expect("invalid sleep read schemas")
    });
    assert_eq!(schemas.version, 1);
    schemas
        .schemas
        .iter()
        .find(|s| s.model_id == model.id && s.firmware_version == version)
        .map(|s| s.state_length)
}

/// No payload, alternate address/profile, or arbitrary command is accepted.
pub fn read_frame(length: u8, address: u16, handle: u8, key: u8) -> Result<[u8; REPORT_SIZE]> {
    if length != 4 || address != 0 || handle != 0 {
        return Err(BridgeError::new(
            "READ_ONLY",
            "休眠检查只允许整键盘四字节读取",
        ));
    }
    let mut frame = [0; REPORT_SIZE];
    frame[0] = 0x55;
    frame[1] = 0xf3;
    frame[4..8].copy_from_slice(&[4 ^ key, key, key, key]);
    frame[3] = crate::checksum(&frame);
    Ok(frame)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepSnapshot {
    pub model_id: String,
    pub firmware_version: String,
    pub lighting_profile: u8,
    pub enabled: bool,
    pub state: [u8; 4],
    pub read_only: bool,
    pub no_mutation: bool,
    pub restoration_ready: bool,
}
pub fn capture(
    transport: &mut impl lighting::ReadTransport,
    model: &Model,
) -> Result<SleepSnapshot> {
    let before = lighting::inspect(transport, model)?;
    let length = read_length(model, &before.version)
        .filter(|&n| n == 4)
        .ok_or_else(|| {
            BridgeError::new(
                "SLEEP_SCHEMA_UNVERIFIED",
                "此型号或固件的休眠结构尚未核对，未读取休眠设置",
            )
        })?;
    let mut sample = || -> Result<[u8; 4]> {
        let bytes = crate::decode_routed(
            &transport.read(0xf3, length, 0, 0, before.key)?,
            0xf3,
            4,
            0,
            0,
            before.key,
        )?;
        if bytes[0] > 1 {
            return Err(BridgeError::new(
                "SLEEP_REPLY_INVALID",
                "休眠启用标记无效，结果已丢弃",
            ));
        }
        Ok(bytes.try_into().expect("validated four-byte reply"))
    };
    let state = sample()?;
    if state != sample()? {
        return Err(BridgeError::new(
            "SLEEP_SNAPSHOT_CHANGED",
            "休眠设置在读取期间变化，请重新检查",
        ));
    }
    let after = lighting::inspect(transport, model)?;
    if before.key != after.key
        || before.firmware[..6] != after.firmware[..6]
        || before.lighting_profile != after.lighting_profile
    {
        return Err(BridgeError::new(
            "SNAPSHOT_SESSION_CHANGED",
            "读取期间键盘档位或会话已改变，休眠结果已丢弃",
        ));
    }
    Ok(SleepSnapshot {
        model_id: model.id.clone(),
        firmware_version: before.version,
        lighting_profile: before.lighting_profile,
        enabled: state[0] == 1,
        state,
        read_only: true,
        no_mutation: true,
        restoration_ready: false,
    })
}

#[cfg(test)]
mod tests;
