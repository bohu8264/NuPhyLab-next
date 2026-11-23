//! Private binding between the sole control interface and Raw Input siblings.
//! The serial and interface path never leave this native process.
use nuphylab_core::{BridgeError, Model, Result};
pub struct InputBinding {
    model: Model,
    product: u16,
    parent: String,
}
impl InputBinding {
    pub fn qualify(models: &[Model], selected: &str) -> Result<Self> {
        let error = || {
            BridgeError::new(
                "INPUT_IDENTITY_UNVERIFIED",
                "无法唯一核对按键来源，请只连接当前键盘并重新启用触发",
            )
        };
        let api = hidapi::HidApi::new().map_err(|_| error())?;
        let candidates: Vec<_> = api
            .device_list()
            .filter_map(|device| {
                models
                    .iter()
                    .find(|model| {
                        model.vendor_id == device.vendor_id()
                            && model.product_ids.contains(&device.product_id())
                    })
                    .filter(|_| {
                        device.usage_page() == 1
                            && device.usage() == 0
                            && matches!(device.bus_type(), hidapi::BusType::Usb)
                    })
                    .map(|model| (device, model))
            })
            .collect();
        if candidates.len() != 1 {
            return Err(error());
        }
        let (device, model) = candidates[0];
        if model.id != selected {
            return Err(error());
        }
        let identity = crate::identity::inspect(device, model);
        let serial = identity.serial.ok_or_else(error)?;
        Ok(Self {
            model: model.clone(),
            product: device.product_id(),
            parent: format!(
                "USB\\VID_{:04X}&PID_{:04X}\\{serial}",
                model.vendor_id,
                device.product_id()
            ),
        })
    }
    pub fn accepts_interface(&self, path: &str) -> bool {
        if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
            return false;
        }
        crate::identity::input_parent(path, &self.model, self.product)
            .is_some_and(|(parent, unique)| unique && parent == self.parent)
    }
}
