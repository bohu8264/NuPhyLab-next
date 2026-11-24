use nuphylab_core::{output::Connection, BridgeError, Model, Result};
use sha2::{Digest, Sha256};

pub(super) const PRIVATE_ROOT: &str = "native-recovery-v1";
pub(super) const UNVERIFIED: &str = "unverified";
pub(super) const MAX_SLOTS: usize = 64;
pub(super) const SYSTEM_SID: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];
pub(super) fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}
fn digest(value: &serde_json::Value) -> Result<String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| error("RECOVERY_STORAGE_IDENTITY", "恢复目录身份无法编码"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
pub(super) fn keys(model: &Model, connection: &Connection) -> Result<(String, String)> {
    nuphylab_core::models(
        &serde_json::to_string(&vec![model])
            .map_err(|_| error("INVALID_MODELS", "型号配置无效"))?,
    )?;
    if connection.vendor_id != model.vendor_id
        || !model.product_ids.contains(&connection.product_id)
        || connection.token.trim().is_empty()
        || connection.token.len() > 256
        || connection.token.chars().any(char::is_control)
    {
        return Err(error(
            "RECOVERY_STORAGE_IDENTITY",
            "恢复目录的原生设备身份无效",
        ));
    }
    let serial = match &connection.serial {
        Some(value)
            if value.trim().is_empty()
                || value.len() > 256
                || value.chars().any(char::is_control) =>
        {
            return Err(error("RECOVERY_STORAGE_IDENTITY", "可靠序列号格式无效"))
        }
        value => value,
    };
    let model_key = format!(
        "model-{}",
        digest(&serde_json::json!([1, model.id, connection.vendor_id]))?
    );
    let slot = match serial {
        None => UNVERIFIED.into(),
        Some(serial) => format!(
            "serial-{}",
            digest(&serde_json::json!([
                1,
                "qualified-serial",
                model.id,
                connection.vendor_id,
                serial
            ]))?
        ),
    };
    Ok((model_key, slot))
}
pub(super) fn valid_slot(name: &str) -> bool {
    name == UNVERIFIED
        || name.strip_prefix("serial-").is_some_and(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn sid_valid(sid: &[u8]) -> bool {
    sid.len() >= 8 && sid[0] == 1 && sid[1] <= 15 && sid.len() == 8 + usize::from(sid[1]) * 4
}
/// Validate the exact supported directory ACL using bounded bytes rather
/// than casting untrusted ACE/SID records to aligned Rust references.
/// Flags 0x1000/0x0004 are protected/present DACL; 0x03 grants inheritance
/// to files and subdirectories. Only current user and SYSTEM may appear.
pub(super) fn private_acl(owner: &[u8], user: &[u8], control: u16, acl: &[u8]) -> bool {
    if !sid_valid(owner)
        || !sid_valid(user)
        || owner != user
        || control & 0x1004 != 0x1004
        || acl.len() < 8
        || acl[0] != 2
        || acl[1] != 0
        || acl[6..8] != [0, 0]
    {
        return false;
    }
    let size = u16::from_le_bytes([acl[2], acl[3]]) as usize;
    let count = u16::from_le_bytes([acl[4], acl[5]]);
    if size != acl.len() || count != 2 {
        return false;
    }
    let (mut at, mut saw_user, mut saw_system) = (8, false, false);
    for _ in 0..count {
        let Some(head) = acl.get(at..at + 8) else {
            return false;
        };
        let len = u16::from_le_bytes([head[2], head[3]]) as usize;
        if head[0] != 0
            || head[1] != 3
            || len < 16
            || !len.is_multiple_of(4)
            || u32::from_le_bytes(head[4..8].try_into().unwrap()) != 0x001f01ff
        {
            return false;
        }
        let Some(sid) = acl.get(at + 8..at + len) else {
            return false;
        };
        if !sid_valid(sid) {
            return false;
        }
        if sid == user && !saw_user {
            saw_user = true;
        } else if sid == SYSTEM_SID && !saw_system {
            saw_system = true;
        } else {
            return false;
        }
        at += len;
    }
    at == acl.len() && saw_user && saw_system
}

#[cfg(test)]
mod tests;
