//! A fresh, journaled connection introduction. Existing recovery records must
//! be explicitly recovered first; this path never resumes or replaces them.
use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionWakePreparation {
    pub main_black_verified: bool,
    pub side_muted: bool,
    pub side_indicator_observed: bool,
    pub all_lights_black: bool,
    /// A stock original's persistent palette cannot be read until entering
    /// custom mode. Do not promise a dark gate that this firmware lacks.
    pub palette_exposure_required: bool,
}
impl<T: Transport> Lighting<T> {
    pub(super) fn arm_connection_wake(
        &mut self,
        tx: &mut Transaction<'_>,
    ) -> Result<ConnectionWakePreparation> {
        let captured = self.prepare_arm(tx)?;
        let mut ready = self.full_custom()?;
        // Mute the stock side zone in the first D6, before sampling the
        // persistent palette. Firmware-owned indicators can still be visible.
        ready[9] = 2;
        ready[10] = 0;
        ready[12] = 0;
        ready[13] = 0;
        ready[14..17].fill(0);
        self.settings(tx, &ready, false)?;
        if !captured {
            let state = self.state()?;
            let colors = self.colors()?;
            let after = self.state()?;
            self.check_wake_state(&ready, &state)?;
            self.check_wake_state(&ready, &after)?;
            tx.preserve_palette(ReconstructedPalette::capture(
                &self.model,
                &self.binding,
                &state,
                &colors,
            )?)?;
        }
        // Every D8 requires a durable, independently sampled palette preimage.
        let black = vec![0; self.model.key_count * 3];
        self.palette(tx, &black, None, false)?;
        let mut side_indicator_observed = false;
        let mut verified_colors = None;
        for delay in [0, 50, 70] {
            if delay > 0 {
                self.pause(delay)?;
            }
            let before = self.state()?;
            self.check_wake_state(&ready, &before)?;
            let colors = self.colors()?;
            let after = self.state()?;
            self.check_wake_state(&ready, &after)?;
            tx.output_guard(&self.binding)?;
            side_indicator_observed |= colors[self.model.key_count * 3..].iter().any(|&v| v != 0);
            if colors[..self.model.key_count * 3].iter().all(|&v| v == 0) {
                verified_colors = Some(colors);
                break;
            }
            // A delayed rendered buffer permits only more observations, never
            // another write to an uncertain settings or palette transaction.
        }
        let colors = verified_colors.ok_or_else(|| {
            error(
                "COLOR_VERIFY_FAILED",
                "迎宾灯效未确认所有键灯为黑色，已停止输出",
            )
        })?;
        self.armed = true;
        self.failed = false;
        self.lease = Some(tx.token().0);
        self.last = Some(black);
        Ok(ConnectionWakePreparation {
            main_black_verified: true,
            side_muted: true,
            side_indicator_observed,
            all_lights_black: colors.iter().all(|&v| v == 0),
            palette_exposure_required: !captured,
        })
    }
    fn check_wake_state(&self, ready: &[u8], observed: &[u8]) -> Result<()> {
        if !lighting_policy::owned_state_matches(
            &self.model,
            &self.binding.firmware_version,
            ready,
            observed,
        )? || lighting_policy::preset_fields_differ(
            &self.model,
            &self.binding.firmware_version,
            ready,
            observed,
        )? {
            return Err(error(
                "OWNERSHIP_CHANGED",
                "迎宾灯效准备期间键盘设置发生变化，已停止输出",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
