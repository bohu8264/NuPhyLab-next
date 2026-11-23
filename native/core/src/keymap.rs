//! Full base-layer observations, never a lease or a source of write authority.
use crate::{
    lighting::{self, ReadTransport},
    BridgeError, Model, Result,
};
use serde::{Deserialize, Serialize};

fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}
pub fn readable(model: &Model, version: &str) -> bool {
    if version == model.qualified_firmware {
        return true;
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Schema {
        model_id: String,
        firmware_version: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Schemas {
        version: u8,
        word_bytes: u8,
        byte_order: String,
        layer_count: u8,
        mac_base_layer: u8,
        win_base_layer: u8,
        additional_read_schemas: Vec<Schema>,
    }
    static SCHEMAS: std::sync::OnceLock<Schemas> = std::sync::OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../shared/contracts/keymap-read-schemas.json"
        ))
        .expect("invalid keymap read schemas")
    });
    assert_eq!(
        (
            schemas.version,
            schemas.word_bytes,
            schemas.byte_order.as_str(),
            schemas.layer_count,
            schemas.mac_base_layer,
            schemas.win_base_layer
        ),
        (1, 2, "bigEndian", 8, 0, 4)
    );
    schemas
        .additional_read_schemas
        .iter()
        .any(|s| s.model_id == model.id && s.firmware_version == version)
}
pub fn key_count(model: &Model) -> Result<usize> {
    let count = usize::from(model.rows) * usize::from(model.columns) + model.extra_keys;
    if count == 0 || count > 256 || model.extra_keys > 8 {
        return Err(error(
            "KEYMAP_GEOMETRY_INVALID",
            "键位矩阵超出已核对的读取范围",
        ));
    }
    Ok(count)
}
pub fn read_frame(
    model: &Model,
    command: u8,
    length: u8,
    address: u16,
    handle: u8,
    key: u8,
) -> Result<[u8; 64]> {
    let layer_bytes = key_count(model)? * 2;
    let frame = bounded_read_frame(command, length, address, handle, key)?;
    if usize::from(address) + usize::from(length) > layer_bytes * 8
        || usize::from(address) % layer_bytes + usize::from(length) > layer_bytes
    {
        return Err(error(
            "READ_ONLY",
            "键位检查只允许限定层范围内的 B1/B2 读取",
        ));
    }
    Ok(frame)
}
pub fn bounded_read_frame(
    command: u8,
    length: u8,
    address: u16,
    handle: u8,
    key: u8,
) -> Result<[u8; 64]> {
    if !matches!(command, 0xb1 | 0xb2)
        || length == 0
        || length > 56
        || !length.is_multiple_of(2)
        || !address.is_multiple_of(2)
        || handle != 0
        || usize::from(address) + usize::from(length) > 256 * 2 * 8
    {
        return Err(error(
            "READ_ONLY",
            "键位检查只允许有限的 B1/B2 读取，禁止改键与重置",
        ));
    }
    Ok(crate::read_route_frame(
        command, length, address, handle, key,
    ))
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeymapSnapshot {
    pub model_id: String,
    pub firmware_version: String,
    pub lighting_profile: u8,
    pub matrix_key_count: usize,
    pub keymap_key_count: usize,
    pub active: Vec<u16>,
    pub defaults: [Vec<u16>; 2],
    pub read_only: bool,
    pub no_mutation: bool,
    pub restoration_ready: bool,
}
fn layer(
    transport: &mut impl ReadTransport,
    model: &Model,
    identity: &lighting::Identity,
    command: u8,
    layer: usize,
) -> Result<Vec<u16>> {
    let size = key_count(model)? * 2;
    let mut bytes = Vec::with_capacity(size);
    while bytes.len() < size {
        let length = (size - bytes.len()).min(56) as u8;
        let address = (layer * size + bytes.len()) as u16;
        read_frame(model, command, length, address, 0, identity.key)?;
        let raw = transport.read(command, length, address, 0, identity.key)?;
        bytes.extend(crate::decode_routed(
            &raw,
            command,
            usize::from(length),
            address,
            0,
            identity.key,
        )?);
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
        .collect())
}
fn layers(
    transport: &mut impl ReadTransport,
    model: &Model,
    identity: &lighting::Identity,
) -> Result<(Vec<u16>, [Vec<u16>; 2])> {
    Ok((
        layer(
            transport,
            model,
            identity,
            0xb2,
            usize::from(identity.lighting_profile) * 4,
        )?,
        [
            layer(transport, model, identity, 0xb1, 0)?,
            layer(transport, model, identity, 0xb1, 4)?,
        ],
    ))
}
pub fn capture(transport: &mut impl ReadTransport, model: &Model) -> Result<KeymapSnapshot> {
    let identity = lighting::inspect(transport, model)?;
    if !readable(model, &identity.version) {
        return Err(error(
            "KEYMAP_SCHEMA_UNVERIFIED",
            "此固件的键位读取结构尚未核对，未读取或修改键位",
        ));
    }
    let count = key_count(model)?;
    let geometry = crate::decode(
        &transport.read(0xa0, 8, 0, 0, identity.key)?,
        0xa0,
        8,
        identity.key,
    )?;
    let first = layers(transport, model, &identity)?;
    let second = layers(transport, model, &identity)?;
    let after = lighting::inspect(transport, model)?;
    let after_geometry = crate::decode(
        &transport.read(0xa0, 8, 0, 0, after.key)?,
        0xa0,
        8,
        after.key,
    )?;
    if first != second
        || identity.firmware[..6] != after.firmware[..6]
        || identity.key != after.key
        || identity.lighting_profile != after.lighting_profile
        || geometry != after_geometry
    {
        return Err(error(
            "KEYMAP_SESSION_CHANGED",
            "采集期间连接、档位或键位发生变化，结果已丢弃",
        ));
    }
    Ok(KeymapSnapshot {
        model_id: model.id.clone(),
        firmware_version: identity.version,
        lighting_profile: identity.lighting_profile,
        matrix_key_count: usize::from(model.rows) * usize::from(model.columns),
        keymap_key_count: count,
        active: first.0,
        defaults: first.1,
        read_only: true,
        no_mutation: true,
        restoration_ready: false,
    })
}

#[cfg(test)]
mod tests;
