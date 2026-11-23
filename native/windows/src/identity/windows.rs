use super::*;
use std::{
    fs::OpenOptions,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    ptr,
};
use windows_sys::Win32::{
    Devices::{
        DeviceAndDriverInstallation::{
            CM_Get_DevNode_PropertyW, CM_Get_Device_Interface_PropertyW, CM_Get_Parent,
            CM_Locate_DevNodeW, CM_DEVCAP_UNIQUEID, CR_BUFFER_SMALL, CR_SUCCESS,
        },
        HumanInterfaceDevice::HidD_GetSerialNumberString,
        Properties::{
            DEVPKEY_Device_Capabilities, DEVPKEY_Device_InstanceId, DEVPROP_TYPE_STRING,
            DEVPROP_TYPE_UINT32,
        },
    },
    Foundation::DEVPROPKEY,
};
fn property(
    mut read: impl FnMut(*mut u8, &mut u32, &mut u32) -> u32,
    expected: u32,
) -> Option<Vec<u8>> {
    let (mut len, mut kind) = (0, 0);
    if read(ptr::null_mut(), &mut len, &mut kind) != CR_BUFFER_SMALL || !(2..=4096).contains(&len) {
        return None;
    }
    let mut bytes = vec![0u8; len as usize];
    let capacity = len;
    if read(bytes.as_mut_ptr(), &mut len, &mut kind) != CR_SUCCESS
        || kind != expected
        || len > capacity
    {
        return None;
    }
    bytes.truncate(len as usize);
    Some(bytes)
}
fn text(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 2 || !bytes.len().is_multiple_of(2) {
        return None;
    }
    let words: Vec<_> = bytes
        .chunks_exact(2)
        .map(|p| u16::from_le_bytes([p[0], p[1]]))
        .collect();
    if words.last() != Some(&0) || words[..words.len() - 1].contains(&0) {
        return None;
    }
    String::from_utf16(&words[..words.len() - 1]).ok()
}
fn node_property(node: u32, key: &DEVPROPKEY, kind: u32) -> Option<Vec<u8>> {
    property(
        |buffer, len, ty| unsafe { CM_Get_DevNode_PropertyW(node, key, ty, buffer, len, 0) },
        kind,
    )
}
fn parent(path: &[u16], model: &Model, product: u16) -> Option<(String, bool)> {
    let bytes = property(
        |buffer, len, kind| unsafe {
            CM_Get_Device_Interface_PropertyW(
                path.as_ptr(),
                &DEVPKEY_Device_InstanceId,
                kind,
                buffer,
                len,
                0,
            )
        },
        DEVPROP_TYPE_STRING,
    )?;
    let id = text(&bytes)?;
    let wide: Vec<_> = id.encode_utf16().chain(Some(0)).collect();
    let mut node = 0;
    if unsafe { CM_Locate_DevNodeW(&mut node, wide.as_ptr(), 0) } != CR_SUCCESS {
        return None;
    }
    let wanted = format!("USB\\VID_{:04X}&PID_{product:04X}\\", model.vendor_id);
    for _ in 0..5 {
        let id = text(&node_property(
            node,
            &DEVPKEY_Device_InstanceId,
            DEVPROP_TYPE_STRING,
        )?)?;
        if id
            .get(..wanted.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(&wanted))
        {
            let caps = node_property(node, &DEVPKEY_Device_Capabilities, DEVPROP_TYPE_UINT32)?;
            let caps = u32::from_le_bytes(caps.try_into().ok()?);
            return Some((id, caps & CM_DEVCAP_UNIQUEID != 0));
        }
        let mut next = 0;
        if unsafe { CM_Get_Parent(&mut next, node, 0) } != CR_SUCCESS || next == node {
            return None;
        }
        node = next;
    }
    None
}
fn embedded(file: &std::fs::File) -> Option<String> {
    let mut words = [0u16; 256];
    if !unsafe { HidD_GetSerialNumberString(file.as_raw_handle(), words.as_mut_ptr().cast(), 512) }
    {
        return None;
    }
    let end = words.iter().position(|&c| c == 0)?;
    String::from_utf16(&words[..end]).ok()
}
pub(crate) fn input_parent(path: &str, model: &Model, product: u16) -> Option<(String, bool)> {
    let wide: Vec<_> = path.encode_utf16().chain(Some(0)).collect();
    parent(&wide, model, product)
}
pub(crate) fn inspect(device: &hidapi::DeviceInfo, model: &Model) -> Identity {
    let Some(result) = (|| {
        let path = device.path().to_str().ok()?;
        let wide: Vec<_> = path.encode_utf16().chain(Some(0)).collect();
        let file = OpenOptions::new()
            .access_mode(0)
            .share_mode(3)
            .open(path)
            .ok()?;
        let first = embedded(&file)?;
        let (parent, unique) = parent(&wide, model, device.product_id())?;
        if embedded(&file)? != first {
            return None;
        }
        Some(evaluate(
            model,
            device.product_id(),
            device.serial_number(),
            &first,
            &parent,
            unique,
            AIR_USB_SERIAL_QUALIFIED,
        ))
    })() else {
        return unverified("IDENTITY_EVIDENCE_UNAVAILABLE");
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn property_strings_require_bounded_complete_utf16_and_exact_types() {
        for bytes in [
            vec![],
            vec![0],
            vec![65, 0],
            vec![0, 0, 65, 0],
            vec![0, 0, 0, 0],
            vec![0, 216, 0, 0],
        ] {
            assert!(text(&bytes).is_none());
        }
        assert_eq!(text(&[65, 0, 0, 0]).as_deref(), Some("A"));
        assert!(property(
            |_, len, _| {
                *len = 4097;
                CR_BUFFER_SMALL
            },
            DEVPROP_TYPE_STRING
        )
        .is_none());
        let mut called = false;
        assert!(property(
            |_, len, ty| {
                if !called {
                    called = true;
                    *len = 2;
                    CR_BUFFER_SMALL
                } else {
                    *ty = DEVPROP_TYPE_UINT32;
                    CR_SUCCESS
                }
            },
            DEVPROP_TYPE_STRING
        )
        .is_none());
    }
}
