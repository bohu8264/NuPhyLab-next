//! Qualified recovery calculations only. This module has no HID writer and
//! cannot enable the read-only Windows protocol or clear a recovery journal.
use crate::{
    lighting::validate_state,
    recovery::{Baseline, Binding},
    BridgeError, Model, Result,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum PolicyKind {
    #[serde(rename = "air75-v3-1.0.23.6")]
    Air75,
    #[serde(rename = "air75-v3-2.0.0.7")]
    Air75V2,
    #[serde(rename = "kick75-4.0.18.6")]
    Kick75,
    #[serde(rename = "s4-qualified-17")]
    Additional,
}
impl PolicyKind {
    pub fn accepts(self, model: &Model) -> bool {
        match self {
            Self::Air75 | Self::Air75V2 => {
                model.id == "air75-v3"
                    && model.qualified_firmware
                        == (if self == Self::Air75 {
                            "1.0.23.6"
                        } else {
                            "2.0.0.7"
                        })
                    && model.lighting_state_length == 22
                    && model.key_count == 84
                    && model.side_count == 20
            }
            Self::Kick75 => {
                model.id == "kick75"
                    && model.qualified_firmware == "4.0.18.6"
                    && model.lighting_state_length == 17
                    && model.key_count == 80
                    && model.side_count == 5
            }
            Self::Additional => {
                model.id != "air75-v3"
                    && model.id != "kick75"
                    && model.lighting_state_length == 17
                    && model.key_count > 0
                    && model.key_count + model.side_count <= 255
            }
        }
    }
    fn reserved(self, offset: usize) -> bool {
        match self {
            Self::Air75 | Self::Air75V2 => offset == 13,
            Self::Kick75 => false,
            Self::Additional => matches!(offset, 5 | 13),
        }
    }
    fn retained(self, offset: usize) -> bool {
        self.is_air() && (offset == 5 || offset >= 17)
    }
    fn is_air(self) -> bool {
        matches!(self, Self::Air75 | Self::Air75V2)
    }
    pub fn settle_ms(self) -> u64 {
        if self.is_air() {
            1150
        } else {
            0
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirmwareRegistration {
    model_id: String,
    firmware_version: String,
    policy: PolicyKind,
    state_length: u8,
    key_count: usize,
    side_count: usize,
    board_sleep: bool,
}
fn registered(model: &Model, version: &str) -> Option<&'static FirmwareRegistration> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Versions {
        version: u8,
        additional_versions: Vec<FirmwareRegistration>,
    }
    static VERSIONS: std::sync::OnceLock<Versions> = std::sync::OnceLock::new();
    let versions = VERSIONS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../shared/contracts/windows-lighting-firmware.json"
        ))
        .expect("invalid Windows lighting firmware registry")
    });
    assert_eq!(versions.version, 1);
    versions.additional_versions.iter().find(|v| {
        v.model_id == model.id
            && v.firmware_version == version
            && v.state_length == model.lighting_state_length
            && v.key_count == model.key_count
            && v.side_count == model.side_count
    })
}
pub fn qualified(model: &Model, version: &str) -> Result<PolicyKind> {
    if model.lighting_recovery_policy.accepts(model) {
        if version == model.qualified_firmware {
            return Ok(model.lighting_recovery_policy);
        }
        if let Some(v) = registered(model, version) {
            let mut selected = model.clone();
            selected.qualified_firmware = version.into();
            selected.lighting_recovery_policy = v.policy;
            if v.policy == PolicyKind::Air75V2 && v.policy.accepts(&selected) {
                return Ok(v.policy);
            }
        }
    }
    Err(error(
        "RECOVERY_POLICY_UNVERIFIED",
        "该型号或固件的恢复规则尚未核对",
    ))
}
pub fn supports_board_sleep(model: &Model, version: &str) -> bool {
    match qualified(model, version) {
        Ok(PolicyKind::Air75) => true,
        Ok(PolicyKind::Air75V2) => registered(model, version).is_some_and(|v| v.board_sleep),
        _ => false,
    }
}
fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}

/// Firmware's full-brightness renderer. Index is a byte in the key RGB table,
/// not a canvas index or a D8 physical LED address.
pub fn rendered_palette(model: &Model, version: &str, colors: &[u8]) -> Result<Vec<u8>> {
    let kind = qualified(model, version)?;
    if colors.len() != model.key_count * 3 {
        return Err(error("INVALID_PALETTE", "调色板长度与型号不一致"));
    }
    Ok(colors
        .iter()
        .enumerate()
        .map(|(index, &value)| rendered_byte(kind, value, index))
        .collect())
}
fn rendered_byte(kind: PolicyKind, value: u8, index: usize) -> u8 {
    if !kind.is_air() {
        return value;
    }
    let scaled = u16::from(value) * 200 / 255;
    if index >= 250 {
        (scaled * 150 / 255) as u8
    } else {
        scaled as u8
    }
}
fn inverse(kind: PolicyKind, colors: &[u8], high: bool) -> Result<Vec<u8>> {
    colors
        .iter()
        .enumerate()
        .map(|(index, &value)| {
            let values = 0..=255u8;
            let candidate = if high {
                values
                    .rev()
                    .find(|&v| rendered_byte(kind, v, index) == value)
            } else {
                values
                    .into_iter()
                    .find(|&v| rendered_byte(kind, v, index) == value)
            };
            candidate
                .ok_or_else(|| error("CUSTOM_BACKUP_LOSSY", "读取的颜色无法重建为等效原调色板"))
        })
        .collect()
}

/// An equivalent palette with a checkable full-brightness observation. The
/// quantized AIR output does not identify the original stored bytes uniquely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconstructedPalette {
    proof_version: u8,
    binding: Binding,
    observed_state: Vec<u8>,
    observed_colors: Vec<u8>,
    colors: Vec<u8>,
}
impl ReconstructedPalette {
    /// The future native transport must freshly identify the same physical
    /// device before and after the observation; storage cannot prove its origin.
    pub fn capture(
        model: &Model,
        current: &Binding,
        state: &[u8],
        rendered: &[u8],
    ) -> Result<Self> {
        current.validate(model)?;
        let kind = qualified(model, &current.firmware_version)?;
        validate_state(state, model)?;
        if rendered.len() != (model.key_count + model.side_count) * 3 {
            return Err(error("INVALID_PALETTE", "颜色采样不完整"));
        }
        if state[0] != 21
            || state[1] != 100
            || state[4] != 1
            || (kind==PolicyKind::Air75 && state[6..9] != [255, 255, 255])
            // The 2.0.0.7 custom renderer consumes HSV value only. A readback
            // maximum of 255 proves value=200; hue/saturation do not filter it.
            || (kind==PolicyKind::Air75V2 && state[6..9].iter().max()!=Some(&255))
        {
            return Err(error(
                "PALETTE_NOT_OBSERVABLE",
                "需要已核对的全亮度自定义灯效，当前采样不能作为原调色板",
            ));
        }
        let colors = inverse(kind, &rendered[..model.key_count * 3], false)?;
        Ok(Self {
            proof_version: 1,
            binding: current.clone(),
            observed_state: state.to_vec(),
            observed_colors: rendered.to_vec(),
            colors,
        })
    }
    pub fn colors(&self) -> &[u8] {
        &self.colors
    }
    pub(crate) fn validate(&self, model: &Model, current: &Binding) -> Result<()> {
        if self.proof_version != 1 || &self.binding != current {
            return Err(error("INVALID_PALETTE", "调色板证明的版本或设备身份不一致"));
        }
        let rebuilt = Self::capture(model, current, &self.observed_state, &self.observed_colors)?;
        if rebuilt.colors != self.colors {
            return Err(error("INVALID_PALETTE", "调色板与原采样的计算结果不一致"));
        }
        Ok(())
    }
    /// AIR's quantization has multiple equivalent inputs. A later dimmed
    /// readback may require the upper end, only for the channels that differ.
    /// This computes a candidate; independent device readback remains required.
    pub fn dimmed_candidate(
        &self,
        model: &Model,
        actual: &[u8],
        expected: &[u8],
    ) -> Result<Vec<u8>> {
        self.validate(model, &self.binding)?;
        let kind = qualified(model, &self.binding.firmware_version)?;
        if !kind.is_air() || actual.len() != model.key_count * 3 || expected.len() != actual.len() {
            return Err(error("INVALID_PALETTE", "此采样不适用量化候选调整"));
        }
        let upper = inverse(kind, &self.observed_colors[..model.key_count * 3], true)?;
        Ok(self
            .colors
            .iter()
            .enumerate()
            .map(|(i, &low)| {
                if actual[i] != expected[i] {
                    upper[i]
                } else {
                    low
                }
            })
            .collect())
    }
}

pub fn owned_state_matches(
    model: &Model,
    version: &str,
    expected: &[u8],
    observed: &[u8],
) -> Result<bool> {
    let kind = qualified(model, version)?;
    validate_state(expected, model)?;
    validate_state(observed, model)?;
    Ok(expected
        .iter()
        .zip(observed)
        .enumerate()
        .all(|(i, (a, b))| kind.reserved(i) || kind.retained(i) || a == b))
}
pub fn preset_fields_differ(
    model: &Model,
    version: &str,
    saved: &[u8],
    observed: &[u8],
) -> Result<bool> {
    let kind = qualified(model, version)?;
    validate_state(saved, model)?;
    validate_state(observed, model)?;
    Ok(saved
        .iter()
        .zip(observed)
        .enumerate()
        .any(|(i, (a, b))| kind.retained(i) && a != b))
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateWritePlan {
    pub address: u16,
    pub payload: Vec<u8>,
}
/// A proposed settings payload, never a serialized HID frame. Preset fields
/// and their AIR mirror keep live values; readback colours need exact encoding.
pub fn state_write_plan(
    model: &Model,
    version: &str,
    target: &[u8],
    live: &[u8],
) -> Result<StateWritePlan> {
    let kind = qualified(model, version)?;
    validate_state(target, model)?;
    validate_state(live, model)?;
    if target[0] == 0 {
        return Err(error(
            "UNWRITABLE_OFF_MODE",
            "关闭状态需要经过单独的全黑恢复规则",
        ));
    }
    let mut payload = target[..17].to_vec();
    if kind.is_air() {
        payload[5] = live[5];
        payload[6..9].copy_from_slice(&exact_color_input(kind, target[6..9].try_into().unwrap())?);
    }
    Ok(StateWritePlan {
        address: 0,
        payload,
    })
}

#[derive(Debug, Clone)]
pub struct RestorePlan {
    original: Baseline,
    original_palette: Option<ReconstructedPalette>,
    expected_state: Vec<u8>,
    original_key_colors: Option<Vec<u8>>,
    all_dark: bool,
    pub settings: Option<StateWritePlan>,
    pub archive_required: bool,
    pub palette_required: bool,
    pub palette_settle_ms: u64,
}
impl RestorePlan {
    pub(crate) fn belongs_to(&self, baseline: &Baseline) -> bool {
        &self.original == baseline
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreAssessment {
    pub owned_state_verified: bool,
    pub palette_verified: bool,
    pub custom_colors_verified: bool,
    pub all_dark_verified: bool,
    pub archive_required: bool,
}
pub fn plan_restore(
    model: &Model,
    saved: &Baseline,
    current: &Binding,
    live: &[u8],
    palette: Option<&ReconstructedPalette>,
) -> Result<RestorePlan> {
    saved.validate(model)?;
    current.validate(model)?;
    if &saved.binding != current {
        return Err(error(
            "BACKUP_DEVICE_MISMATCH",
            "键盘身份、固件或档位已改变",
        ));
    }
    let kind = qualified(model, &current.firmware_version)?;
    validate_state(live, model)?;
    if let Some(palette) = palette {
        palette.validate(model, current)?;
    }
    if saved.state[0] == 21 && palette.is_none() {
        return Err(error(
            "BACKUP_INCOMPLETE",
            "自定义原灯效缺少已验证的原调色板",
        ));
    }
    let all_dark = saved.state[0] == 0 && saved.state[1] == 0 && saved.state[10] == 0;
    let mut expected = saved.state.clone();
    let same = owned_state_matches(model, &current.firmware_version, &expected, live)?;
    let settings = if same && palette.is_none() {
        None
    } else {
        if all_dark {
            expected[0] = 2;
        }
        Some(state_write_plan(
            model,
            &current.firmware_version,
            &expected,
            live,
        )?)
    };
    Ok(RestorePlan {
        original: saved.clone(),
        original_palette: palette.cloned(),
        expected_state: expected,
        original_key_colors: (saved.state[0] == 21)
            .then(|| saved.rendered_colors[..model.key_count * 3].to_vec()),
        all_dark,
        settings,
        archive_required: preset_fields_differ(
            model,
            &current.firmware_version,
            &saved.state,
            live,
        )?,
        palette_required: palette.is_some(),
        palette_settle_ms: if palette.is_some() {
            kind.settle_ms()
        } else {
            0
        },
    })
}
/// Assessment is an offline comparison, not permission to delete a journal.
/// The future transport must supply independent, fresh readback and archive any
/// retained preset change, including changes occurring during restoration.
pub fn assess_restore(
    model: &Model,
    plan: &RestorePlan,
    current: &Binding,
    state: &[u8],
    rendered: Option<&[u8]>,
    palette_readback: Option<&PaletteReadback>,
) -> Result<RestoreAssessment> {
    current.validate(model)?;
    if current != &plan.original.binding {
        return Err(error(
            "BACKUP_DEVICE_MISMATCH",
            "恢复验证的设备身份或档位不一致",
        ));
    }
    match (&plan.original_palette, palette_readback) {
        (Some(original), Some(evidence))
            if original == &evidence.original && current == &evidence.current => {}
        (None, None) => {}
        (Some(_), None) => {
            return Err(error(
                "PALETTE_VERIFY_REQUIRED",
                "原调色板缺少全亮度独立读回，记录应保留",
            ))
        }
        _ => {
            return Err(error(
                "RESTORE_COLOR_MISMATCH",
                "调色板读回不属于本次恢复的原始记录",
            ))
        }
    }
    if !owned_state_matches(
        model,
        &current.firmware_version,
        &plan.expected_state,
        state,
    )? {
        return Err(error(
            "RESTORE_STATE_MISMATCH",
            "原灯效设置未通过独立读回，记录应保留",
        ));
    }
    if let Some(colors) = rendered {
        if colors.len() != (model.key_count + model.side_count) * 3 {
            return Err(error("RESTORE_COLOR_MISMATCH", "恢复后的颜色采样不完整"));
        }
    }
    if plan.all_dark && !rendered.is_some_and(|colors| colors.iter().all(|&v| v == 0)) {
        return Err(error(
            "RESTORE_COLOR_MISMATCH",
            "原关闭状态尚未验证为全部灯位全黑",
        ));
    }
    if let Some(expected) = &plan.original_key_colors {
        if rendered.is_none_or(|colors| colors[..model.key_count * 3] != *expected) {
            return Err(error(
                "RESTORE_COLOR_MISMATCH",
                "原自定义颜色尚未通过独立读回，记录应保留",
            ));
        }
    }
    Ok(RestoreAssessment {
        owned_state_verified: true,
        palette_verified: plan.original_palette.is_some(),
        custom_colors_verified: plan.original_key_colors.is_some(),
        all_dark_verified: plan.all_dark,
        archive_required: plan.archive_required
            || preset_fields_differ(
                model,
                &current.firmware_version,
                &plan.original.state,
                state,
            )?,
    })
}

/// Full-brightness comparison kept separately from the final stock/custom
/// state. It is not serialized or exposed as a frontend command.
#[derive(Debug, Clone)]
pub struct PaletteReadback {
    original: ReconstructedPalette,
    current: Binding,
}
pub fn verify_palette_readback(
    model: &Model,
    original: &ReconstructedPalette,
    current: &Binding,
    state: &[u8],
    rendered: &[u8],
) -> Result<PaletteReadback> {
    original.validate(model, current)?;
    let observed = ReconstructedPalette::capture(model, current, state, rendered)?;
    if original.colors != observed.colors {
        return Err(error(
            "RESTORE_COLOR_MISMATCH",
            "恢复后的全亮度调色板与原采样不一致",
        ));
    }
    Ok(PaletteReadback {
        original: original.clone(),
        current: current.clone(),
    })
}

// Exact port of the already-qualified Swift firmware renderer, including
// Float32 rounding and hue branch order. Conformance fixtures come from Swift.
pub fn main_color_readback(rgb: [u8; 3]) -> [u8; 3] {
    let [r, g, b] = rgb.map(i32::from);
    let hi = r.max(g).max(b);
    let lo = r.min(g).min(b);
    let delta = hi - lo;
    let value = ((hi * 200 / 255) * 255 + 100) / 200;
    if delta == 0 {
        return [value as u8; 3];
    }
    let saturation = (delta as f32 / hi as f32 * 255.0 + 0.5) as i32;
    let mut hue = if hi == r {
        (g - b) as f32 / delta as f32 * 43.0
    } else if hi == g {
        ((b - r) as f32 / delta as f32 + 2.0) * 43.0
    } else {
        ((r - g) as f32 / delta as f32 + 4.0) * 43.0
    };
    if hue < 0.0 {
        hue += 255.0;
    }
    let h = ((hue + 0.5) as i32) & 255;
    let region = h / 43;
    let remainder = (h - region * 43) * 6;
    let p = ((255 - saturation) * value + 127) / 255;
    let q = ((255 - saturation * remainder / 255) * value + 127) / 255;
    let t = ((255 - saturation * (255 - remainder) / 255) * value + 127) / 255;
    let result = match region {
        0 => [value, t, p],
        1 => [q, value, p],
        2 => [p, value, t],
        3 => [p, q, value],
        4 => [t, p, value],
        _ => [value, p, q],
    };
    result.map(|v| v as u8)
}
pub fn exact_main_color_input(target: [u8; 3]) -> Result<[u8; 3]> {
    exact_color_input(PolicyKind::Air75, target)
}
fn exact_color_input(kind: PolicyKind, target: [u8; 3]) -> Result<[u8; 3]> {
    let render = if kind == PolicyKind::Air75V2 {
        main_color_readback_v2
    } else {
        main_color_readback
    };
    if render(target) == target {
        return Ok(target);
    }
    for radius in [4, 8, 16] {
        let [r, g, b] = target.map(i32::from);
        for r in (r - radius).max(0)..=(r + radius).min(255) {
            for g in (g - radius).max(0)..=(g + radius).min(255) {
                for b in (b - radius).max(0)..=(b + radius).min(255) {
                    let candidate = [r as u8, g as u8, b as u8];
                    if render(candidate) == target {
                        return Ok(candidate);
                    }
                }
            }
        }
    }
    Err(error(
        "RESTORE_COLOR_UNREPRESENTABLE",
        "原主灯颜色没有已验证的精确编码，记录应保留",
    ))
}

/// Integer RGB/HSV routine in the pinned 2.0.0.7 image (0x7052 / 0x71d6).
/// The half-step exceptions are real firmware branches, not relaxed equality.
pub fn main_color_readback_v2(rgb: [u8; 3]) -> [u8; 3] {
    let [r, g, b] = rgb.map(i32::from);
    let hi = r.max(g).max(b);
    let delta = hi - r.min(g).min(b);
    let value = ((hi * 200 / 255) * 255 + 100) / 200;
    if delta == 0 {
        return [value as u8; 3];
    }
    let saturation = (delta * 255 + hi / 2) / hi;
    let mut raw = if hi == r {
        g - b
    } else if hi == g {
        b - r + 2 * delta
    } else {
        r - g + 4 * delta
    } * 43;
    if raw < 0 {
        raw += 255 * delta;
    }
    let mut hue = ((raw + delta / 2) / delta) & 255;
    if matches!(delta, 86 | 172)
        && 2 * raw == (2 * hue - 1) * delta
        && (matches!(hue,8|25|57..=60|97..=99|173..=177) || hi == b && hue & 0xfd == 213)
    {
        hue = (hue - 1) & 255;
    }
    let region = hue / 43;
    let remainder = ((hue - region * 43) * 6) & 255;
    let p = ((255 - saturation) * value + 127) / 255;
    let q = ((255 - saturation * remainder / 255) * value + 127) / 255;
    let t = ((255 - saturation * (255 - remainder) / 255) * value + 127) / 255;
    match region {
        0 => [value, t, p],
        1 => [q, value, p],
        2 => [p, value, t],
        3 => [p, q, value],
        4 => [t, p, value],
        _ => [value, p, q],
    }
    .map(|v| v as u8)
}
pub fn main_color_readback_for(model: &Model, version: &str, rgb: [u8; 3]) -> Result<[u8; 3]> {
    Ok(match qualified(model, version)? {
        PolicyKind::Air75 => main_color_readback(rgb),
        PolicyKind::Air75V2 => main_color_readback_v2(rgb),
        _ => rgb,
    })
}

#[cfg(test)]
mod air2_tests;
#[cfg(test)]
mod tests;
