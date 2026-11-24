//! Windows probe and explicit lighting runtime. The binary defaults to the
//! read-only protocol; the application starts lighting only after qualification.
#[cfg(any(windows, test))]
mod identity;
#[cfg(windows)]
pub mod input_binding;
mod probe;
pub mod runtime;
pub mod storage;
pub mod transport;
#[cfg(windows)]
use nuphylab_core::Model;
#[cfg(windows)]
pub use probe::open_lighting_transport;
pub use probe::{connect, enumerate, keymap_snapshot, lighting_snapshot, sleep_snapshot};
#[cfg(windows)]
use serde_json::{json, Value};
#[cfg(windows)]
fn identified(
    model: &Model,
    product: u16,
    identity: nuphylab_core::lighting::Identity,
    unique: Value,
) -> Value {
    let schema_verified =
        nuphylab_core::lighting::read_state_length(model, &identity.version).is_some();
    json!({"connected":true,"identified":true,"armed":false,"readOnly":true,
        "modelId":model.id,"model":format!("{} ANSI",model.name),"vendorId":model.vendor_id,"productId":product,"transport":"USB",
        "firmware":identity.firmware,"firmwareVersion":identity.version,"firmwareDetectionAvailable":true,
        "lightingProfile":identity.lighting_profile,"identityQualification":unique,
        "lightingInspection":{"available":schema_verified,"qualifiedFirmware":model.qualified_firmware,
            "reasonCode":if schema_verified {Value::Null}else{json!("LIGHTING_SCHEMA_UNVERIFIED")}},
        "sleepInspection":{"available":nuphylab_core::sleep_inspection::read_length(model, &identity.version).is_some()},
        "keymapInspection":{"available":nuphylab_core::keymap::readable(model,&identity.version)},
        "ledCount":identity.led_count,"keyLedCount":model.key_count,"sideLedCount":model.side_count,
        "recoveryPending":false,"needsRestore":false,"protocolReady":false,
        "errorCode":"WINDOWS_PROBE_ONLY","error":"键盘已识别。Windows 预览版尚未开放灯光写入。",
        "capabilities":{"perKey":false,"mainWholeZone":false,"stockEffects":false,"connectionWake":false,"functionKeyAdaptation":false,"readOnlyProbe":true},
        "permissions":{"inputMonitoring":false,"accessibility":false,"canPostEvents":false}})
}
