use nuphylab_core::{BridgeError, Model, Result};
#[cfg(windows)]
use serde_json::json;
use serde_json::Value;

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::identified;
    use crate::transport::{connection, ControlTransport};
    use hidapi::{HidApi, HidDevice};
    use std::time::{Duration, Instant};
    fn error(e: impl std::fmt::Display) -> BridgeError {
        BridgeError::new("HID_IO", format!("无法读取键盘：{e}"))
    }
    fn model<'a>(models: &'a [Model], device: &hidapi::DeviceInfo) -> Option<&'a Model> {
        models.iter().find(|m| {
            m.vendor_id == device.vendor_id() && m.product_ids.contains(&device.product_id())
        })
    }
    pub fn enumerate(models: &[Model]) -> Result<Value> {
        let api = HidApi::new().map_err(error)?;
        // Do not open typing/consumer collections. Inventory paths stay local.
        let devices:Vec<Value>=api.device_list().filter_map(|d|model(models,d).map(|m|json!({
            "modelId":m.id,"vendorId":d.vendor_id(),"productId":d.product_id(),
            "usagePage":d.usage_page(),"usage":d.usage(),"interface":d.interface_number(),
            "transport":format!("{:?}",d.bus_type()),"controlCandidate":d.usage_page()==1&&d.usage()==0&&matches!(d.bus_type(),hidapi::BusType::Usb)
        }))).collect();
        Ok(json!({"devices":devices,"readOnly":true,"opened":false}))
    }
    fn open(
        models: &[Model],
        budget: Option<Duration>,
    ) -> Result<(Model, ControlTransport<HidDevice>, Value)> {
        let api = HidApi::new().map_err(error)?;
        let candidates: Vec<_> = api
            .device_list()
            .filter(|d| {
                model(models, d).is_some()
                    && d.usage_page() == 1
                    && d.usage() == 0
                    && matches!(d.bus_type(), hidapi::BusType::Usb)
            })
            .collect();
        if candidates.is_empty() {
            return Err(BridgeError::new(
                "DEVICE_NOT_FOUND",
                "请用 USB 数据线连接键盘，并切换到有线模式",
            ));
        }
        if candidates.len() != 1 {
            return Err(BridgeError::new(
                "DEVICE_AMBIGUOUS",
                "检测到多个控制接口，请只连接一把要测试的键盘",
            ));
        }
        let selected = candidates[0];
        let profile = model(models, selected).unwrap();
        let device = selected.open_device(&api).map_err(error)?;
        let mut descriptor = [0u8; 4096];
        let count = device
            .get_report_descriptor(&mut descriptor)
            .map_err(error)?;
        if count == descriptor.len() {
            return Err(BridgeError::new("INVALID_DESCRIPTOR", "控制接口描述符过大"));
        }
        nuphylab_core::verify_control_descriptor(&descriptor[..count])?;
        let unique = crate::identity::inspect(selected, profile);
        let mut metadata = connection(selected.vendor_id(), selected.product_id());
        metadata.serial = unique.serial;
        Ok((
            profile.clone(),
            ControlTransport::new(device, metadata, budget.map(|value| Instant::now() + value)),
            unique.report,
        ))
    }
    /// The controller owns this handle. Only direct native USB evidence for
    /// a qualified family can supply a serial; all other cases retain None.
    pub fn open_lighting_transport(
        models: &[Model],
    ) -> Result<(Model, impl nuphylab_core::output::Transport)> {
        open(models, None).map(|(model, transport, _)| (model, transport))
    }
    pub fn connect(models: &[Model]) -> Result<Value> {
        let (model, mut transport, unique) = open(models, Some(Duration::from_secs(8)))?;
        let identity = nuphylab_core::lighting::inspect(&mut transport, &model)?;
        let product = nuphylab_core::output::Transport::connection(&transport).product_id;
        Ok(identified(&model, product, identity, unique))
    }
    pub fn lighting_snapshot(models: &[Model]) -> Result<Value> {
        let (model, mut transport, _) = open(models, Some(Duration::from_secs(8)))?;
        let snapshot = nuphylab_core::lighting::capture(&mut transport, &model)?;
        serde_json::to_value(snapshot)
            .map_err(|_| BridgeError::new("SNAPSHOT_INVALID", "无法编码灯效读取结果"))
    }
    pub fn sleep_snapshot(models: &[Model]) -> Result<Value> {
        let (model, mut transport, _) = open(models, Some(Duration::from_secs(8)))?;
        let snapshot = nuphylab_core::sleep_inspection::capture(&mut transport, &model)?;
        serde_json::to_value(snapshot)
            .map_err(|_| BridgeError::new("SNAPSHOT_INVALID", "无法编码休眠读取结果"))
    }
    pub fn keymap_snapshot(models: &[Model]) -> Result<Value> {
        let (model, mut transport, _) = open(models, Some(Duration::from_secs(8)))?;
        let snapshot = nuphylab_core::keymap::capture(&mut transport, &model)?;
        serde_json::to_value(snapshot)
            .map_err(|_| BridgeError::new("SNAPSHOT_INVALID", "无法编码功能键读取结果"))
    }
}
#[cfg(windows)]
pub use windows::{
    connect, enumerate, keymap_snapshot, lighting_snapshot, open_lighting_transport, sleep_snapshot,
};
#[cfg(not(windows))]
pub fn enumerate(_: &[Model]) -> Result<Value> {
    Err(BridgeError::new(
        "WINDOWS_REQUIRED",
        "此探针仅在 Windows 运行",
    ))
}
#[cfg(not(windows))]
pub fn connect(models: &[Model]) -> Result<Value> {
    enumerate(models)
}
#[cfg(not(windows))]
pub fn lighting_snapshot(models: &[Model]) -> Result<Value> {
    enumerate(models)
}
#[cfg(not(windows))]
pub fn sleep_snapshot(models: &[Model]) -> Result<Value> {
    enumerate(models)
}
#[cfg(not(windows))]
pub fn keymap_snapshot(models: &[Model]) -> Result<Value> {
    enumerate(models)
}
#[cfg(not(windows))]
pub(crate) struct UnavailableTransport;
#[cfg(not(windows))]
impl nuphylab_core::output::Transport for UnavailableTransport {
    fn connection(&self) -> nuphylab_core::output::Connection {
        unreachable!("non-Windows device factory never returns a transport")
    }
    fn exchange(&mut self, _: &[u8; 64], _: std::time::Duration) -> Result<Vec<u8>> {
        unreachable!("non-Windows device factory never returns a transport")
    }
    fn pause(&mut self, _: std::time::Duration) -> Result<()> {
        unreachable!("non-Windows device factory never returns a transport")
    }
}
#[cfg(not(windows))]
pub(crate) fn open_lighting_transport(_: &[Model]) -> Result<(Model, UnavailableTransport)> {
    Err(BridgeError::new(
        "WINDOWS_REQUIRED",
        "此设备工厂仅在 Windows 运行",
    ))
}
