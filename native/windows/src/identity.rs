//! Native USB serial evidence. Cached hidapi strings, paths and ContainerIDs
//! alone never qualify a device for replaying saved settings.
use nuphylab_core::Model;
use serde_json::{json, Value};

// Enabled only after the hardware family has completed the documented
// direct-string/USB-parent and cross-port qualification checks.
#[cfg(windows)]
const AIR_USB_SERIAL_QUALIFIED: bool = true;

pub(crate) struct Identity {
    pub serial: Option<String>,
    pub report: Value,
}
fn unverified(reason: &str) -> Identity {
    Identity {
        serial: None,
        report: json!({"status":"unverified","source":"none","reasonCode":reason}),
    }
}
fn evaluate(
    model: &Model,
    product: u16,
    cached: Option<&str>,
    embedded: &str,
    parent: &str,
    unique: bool,
    family_qualified: bool,
) -> Identity {
    if !unique {
        return unverified("IDENTITY_USB_NOT_UNIQUE");
    }
    if embedded.len() != 12
        || !embedded.bytes().all(|b| b.is_ascii_hexdigit())
        || embedded.bytes().all(|b| b == embedded.as_bytes()[0])
        || [
            "000000000001",
            "123456789012",
            "0123456789AB",
            "123456789ABC",
        ]
        .iter()
        .any(|p| embedded.eq_ignore_ascii_case(p))
    {
        return unverified("IDENTITY_SERIAL_UNSUPPORTED");
    }
    let parts: Vec<_> = parent.split('\\').collect();
    let device = format!("VID_{:04X}&PID_{product:04X}", model.vendor_id);
    if cached != Some(embedded)
        || parts.len() != 3
        || !parts[0].eq_ignore_ascii_case("USB")
        || !parts[1].eq_ignore_ascii_case(&device)
        || parts[2] != embedded
    {
        return unverified("IDENTITY_SERIAL_MISMATCH");
    }
    let supported = model.id == "air75-v3"
        && model.vendor_id == 0x19f5
        && product == 0x1028
        && model.product_ids.contains(&product);
    if !supported || !family_qualified {
        return Identity {
            serial: None,
            report: json!({"status":"candidate","source":"embeddedUsbSerial","reasonCode":"IDENTITY_FAMILY_UNVERIFIED"}),
        };
    }
    Identity {
        serial: Some(embedded.into()),
        report: json!({"status":"qualified","source":"embeddedUsbSerial","reasonCode":null}),
    }
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::input_parent;
#[cfg(windows)]
pub(crate) use windows::inspect;

#[cfg(test)]
mod tests;
