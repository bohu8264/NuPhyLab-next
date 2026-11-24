//! A reserved v1 baseline filename makes an older complete application
//! fail closed, including after the owner process has exited or crashed.
use super::*;

pub(crate) const NAME: &str = "profile-0.json";
const FEATURE: &str = "function-key-legacy-fence-v1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fence {
    feature: String,
    binding: Binding,
    original_digest: String,
}
pub(super) fn bytes(original: &Original, encoded: &[u8]) -> Result<Vec<u8>> {
    encode(&Fence {
        feature: FEATURE.into(),
        binding: original.binding.clone(),
        original_digest: digest(encoded),
    })
}
/// A corrupt or unrelated baseline stays an ordinary pending RGB record.
/// Never interpret its name alone as permission to skip or retire it.
pub(crate) fn profile(directory: &Path, model: &Model) -> Result<Option<u8>> {
    let path = directory.join(NAME);
    if !exists(&path)? {
        return Ok(None);
    }
    let bytes = read(&path)?;
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if value["data"]["feature"] != FEATURE {
        return Ok(None);
    }
    let fence: Fence = match decode(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if fence.feature != FEATURE
        || !valid_digest(&fence.original_digest)
        || crate::function_keys::qualify(model, &fence.binding).is_err()
    {
        return Ok(None);
    }
    Ok(Some(fence.binding.lighting_profile))
}
