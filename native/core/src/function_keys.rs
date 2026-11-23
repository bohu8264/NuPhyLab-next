//! Native-only function-key transactions. No shipping RPC or default probe
//! exposes this candidate writer; firmware/input qualification stays separate.
use crate::{
    keymap::{self, KeymapSnapshot},
    lighting::{self, ReadTransport},
    output::{Connection, Transport},
    recovery::{function_keys::Journal, Binding, DeviceIdentity, JournalStore},
    BridgeError, Model, Result,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
mod transaction;
pub use transaction::{FunctionKeyCompletion, FunctionKeyLease};

fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}
pub(crate) fn qualify(model: &Model, binding: &Binding) -> Result<()> {
    binding.validate(model)?;
    if model.id != "air75-v3"
        || binding.firmware_version != "2.0.0.7"
        || binding.vendor_id != 0x19f5
        || binding.product_id != 0x1028
        || binding.lighting_profile != 1
        || !matches!(&binding.identity, DeviceIdentity::Serial(s) if !s.trim().is_empty())
    {
        return Err(error(
            "FUNCTION_KEYS_UNQUALIFIED",
            "临时功能键尚未核对此设备、固件、唯一身份或 Windows 档位",
        ));
    }
    Ok(())
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Assignment {
    pub function_key: u8,
    pub position: usize,
    pub original: u16,
    pub installed: u16,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Original {
    pub binding: Binding,
    pub firmware: Vec<u8>,
    pub geometry: Vec<u8>,
    pub active: Vec<u16>,
    pub defaults: [Vec<u16>; 2],
    pub requested: Vec<u8>,
    pub assignments: Vec<Assignment>,
}
fn assignments(
    model: &Model,
    active: &[u16],
    defaults: &[Vec<u16>; 2],
    requested: &[u8],
) -> Result<Vec<Assignment>> {
    let count = keymap::key_count(model)?;
    if active.len() != count
        || defaults.iter().any(|d| d.len() != count)
        || requested.is_empty()
        || requested.len() > 12
        || requested.iter().any(|k| !(1..=12).contains(k))
        || requested.windows(2).any(|p| p[0] >= p[1])
    {
        return Err(error(
            "FUNCTION_KEYS_INVALID",
            "功能键列表、完整矩阵或额外键位无效",
        ));
    }
    let mut result = Vec::new();
    for &function_key in requested {
        let standard = 57 + u16::from(function_key);
        let installed = 103 + u16::from(function_key);
        let positions: Vec<_> = defaults[1]
            .iter()
            .enumerate()
            .filter(|(_, v)| **v == standard)
            .map(|(p, _)| p)
            .collect();
        if positions.len() != 1
            || positions[0] >= usize::from(model.rows) * usize::from(model.columns)
        {
            return Err(error(
                "FUNCTION_KEYS_POSITION",
                "无法唯一核对当前功能键的物理位置",
            ));
        }
        let position = positions[0];
        if active[position] == installed {
            continue;
        }
        if active[position] != standard {
            return Err(error(
                "FUNCTION_KEYS_CUSTOMIZED",
                "此功能键已有自定义用途，请先保留或明确处理，未覆盖原配置",
            ));
        }
        if active.contains(&installed) {
            return Err(error(
                "FUNCTION_KEYS_SHARED",
                "目标扩展键已被其他位置使用，不能建立独立临时映射",
            ));
        }
        result.push(Assignment {
            function_key,
            position,
            original: standard,
            installed,
        });
    }
    Ok(result)
}
impl Original {
    pub(crate) fn validate(&self, model: &Model) -> Result<()> {
        qualify(model, &self.binding)?;
        if self.firmware.len() != 6
            || self.geometry.len() != 8
            || self.geometry[0] != self.binding.lighting_profile
            || self.geometry[1..5] != [8, 4, model.rows, model.columns]
            || (if self.geometry[5] & 0x80 != 0 {
                usize::from(self.geometry[5] & 0x7f) != model.extra_keys
            } else {
                model.extra_keys != 2
            })
            || self.assignments.is_empty()
            || assignments(model, &self.active, &self.defaults, &self.requested)?
                != self.assignments
        {
            return Err(error(
                "FUNCTION_KEYS_BACKUP_INVALID",
                "原功能键记录的身份、矩阵或限定修改范围无效",
            ));
        }
        Ok(())
    }
}
struct Observation {
    map: KeymapSnapshot,
    firmware: Vec<u8>,
    geometry: Vec<u8>,
    key: u8,
}
struct Reader<'a, T> {
    transport: &'a mut T,
    deadline: Instant,
}
impl<T: Transport> ReadTransport for Reader<'_, T> {
    fn read(
        &mut self,
        command: u8,
        length: u8,
        address: u16,
        handle: u8,
        key: u8,
    ) -> Result<Vec<u8>> {
        let frame = if matches!(command, 0xb1 | 0xb2) {
            keymap::bounded_read_frame(command, length, address, handle, key)?
        } else {
            if address != 0 || handle != 0 {
                return Err(error("READ_ONLY", "读取路由无效"));
            }
            crate::read_frame(command, length, key)?
        };
        exchange(self.transport, &frame, self.deadline)
    }
}
fn exchange(
    transport: &mut impl Transport,
    frame: &[u8; 64],
    deadline: Instant,
) -> Result<Vec<u8>> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(error(
            "FUNCTION_KEYS_TIMEOUT",
            "功能键事务已超时，未继续发送",
        ));
    }
    let value = transport.exchange(frame, left.min(Duration::from_millis(1200)))?;
    if Instant::now() >= deadline {
        return Err(error("FUNCTION_KEYS_TIMEOUT", "功能键回复超过本次操作期限"));
    }
    Ok(value)
}
fn observe(
    transport: &mut impl Transport,
    model: &Model,
    connection: &Connection,
    deadline: Instant,
) -> Result<Observation> {
    if &transport.connection() != connection {
        return Err(error(
            "FUNCTION_KEYS_CONNECTION_CHANGED",
            "设备连接已变化，原记录已保留",
        ));
    }
    let mut reader = Reader {
        transport,
        deadline,
    };
    let before = lighting::inspect(&mut reader, model)?;
    let geometry = crate::decode(
        &reader.read(0xa0, 8, 0, 0, before.key)?,
        0xa0,
        8,
        before.key,
    )?;
    let map = keymap::capture(&mut reader, model)?;
    let after = lighting::inspect(&mut reader, model)?;
    let after_geometry =
        crate::decode(&reader.read(0xa0, 8, 0, 0, after.key)?, 0xa0, 8, after.key)?;
    if before.firmware[..6] != after.firmware[..6]
        || before.key != after.key
        || geometry != after_geometry
        || before.lighting_profile != after.lighting_profile
        || before.version != map.firmware_version
        || before.lighting_profile != map.lighting_profile
        || &reader.transport.connection() != connection
    {
        return Err(error(
            "FUNCTION_KEYS_CONNECTION_CHANGED",
            "采集期间身份、档位、密钥或矩阵发生变化",
        ));
    }
    Ok(Observation {
        map,
        firmware: before.firmware[..6].to_vec(),
        geometry,
        key: before.key,
    })
}
fn binding(model: &Model, connection: &Connection, observed: &Observation) -> Result<Binding> {
    let value = Binding {
        model_id: model.id.clone(),
        vendor_id: connection.vendor_id,
        product_id: connection.product_id,
        firmware_version: observed.map.firmware_version.clone(),
        lighting_profile: observed.map.lighting_profile,
        identity: DeviceIdentity::Serial(connection.serial.clone().ok_or_else(|| {
            error(
                "FUNCTION_KEYS_UNQUALIFIED",
                "功能键恢复需要稳定且唯一的原生编号",
            )
        })?),
    };
    qualify(model, &value)?;
    Ok(value)
}
fn verify(
    original: &Original,
    model: &Model,
    connection: &Connection,
    observed: &Observation,
) -> Result<()> {
    if original.binding != binding(model, connection, observed)?
        || original.firmware != observed.firmware
        || original.geometry != observed.geometry
        || original.defaults != observed.map.defaults
    {
        return Err(error(
            "FUNCTION_KEYS_DEVICE_CHANGED",
            "当前设备、固件、档位或出厂层与原记录不一致",
        ));
    }
    Ok(())
}
// Private encoder: callers cannot submit arbitrary B3 frames via a read RPC.
fn write_frame(
    model: &Model,
    profile: u8,
    position: usize,
    value: u16,
    key: u8,
) -> Result<[u8; 64]> {
    if profile > 1 || position >= usize::from(model.rows) * usize::from(model.columns) {
        return Err(error(
            "FUNCTION_KEYS_WRITE_INVALID",
            "临时改键只允许矩阵内已核对的位置",
        ));
    }
    let address = ((usize::from(profile) * 4 * keymap::key_count(model)? + position) * 2) as u16;
    let mut frame = crate::read_route_frame(0xb3, 2, address, 0, key);
    for (i, byte) in value.to_be_bytes().iter().enumerate() {
        frame[8 + i] = byte ^ key;
    }
    frame[3] = crate::checksum(&frame);
    Ok(frame)
}
fn settle(transport: &mut impl Transport, deadline: Instant) -> Result<()> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(error("FUNCTION_KEYS_TIMEOUT", "确认提交已超出本次操作期限"));
    }
    transport.settle_function_key_writes(left)?;
    if Instant::now() >= deadline {
        return Err(error("FUNCTION_KEYS_TIMEOUT", "提交确认超过本次操作期限"));
    }
    Ok(())
}
fn write_once(
    transport: &mut impl Transport,
    model: &Model,
    original: &Original,
    assignment: &Assignment,
    value: u16,
    key: u8,
    deadline: Instant,
) -> Result<()> {
    if !original.assignments.contains(assignment)
        || ![assignment.original, assignment.installed].contains(&value)
    {
        return Err(error(
            "FUNCTION_KEYS_WRITE_INVALID",
            "写入不属于已保存原记录的功能键范围",
        ));
    }
    let frame = write_frame(
        model,
        original.binding.lighting_profile,
        assignment.position,
        value,
        key,
    )?;
    let reply = exchange(transport, &frame, deadline);
    // Even a lost/malformed ACK may have queued a write. Do not use an old
    // B2 value as evidence that an uncertain request cannot commit later.
    settle(transport, deadline)?;
    let reply = reply?;
    let address = ((4 * keymap::key_count(model)? + assignment.position) * 2) as u16;
    if crate::decode_routed(&reply, 0xb3, 2, address, 0, key)? != value.to_be_bytes() {
        return Err(error(
            "FUNCTION_KEYS_ACK_INVALID",
            "改键确认不匹配，不重发写入",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests;

pub(crate) struct VerifiedKeyRestoration {
    original: Original,
    observed: Vec<u16>,
}
impl VerifiedKeyRestoration {
    pub(crate) fn matches(&self, original: &Original) -> bool {
        &self.original == original
            && self.observed.len() == original.active.len()
            && original
                .assignments
                .iter()
                .all(|a| self.observed[a.position] == a.original)
    }
}
