//! Guarded raw-report transactions over one native control handle. Sessions
//! restore independent RGB, sleep and candidate key originals. The shipping
//! preview protocol still grants no function-key write capability.
use crate::{
    lighting,
    lighting_policy::{self, ReconstructedPalette},
    recovery::{Baseline, Binding, DeviceIdentity, Mutation, Transaction},
    BridgeError, Model, Result,
};
use serde::Serialize;
use std::time::{Duration, Instant};
pub(crate) mod sleep;
pub use sleep::{recover_board_sleep, SleepCompletion, SleepStatus};
mod native;
mod recover;
mod wake;
pub use native::{NativeLightingConfig, NativeSnapshot};
pub use recover::{recover_existing, RecoveryPart, RecoveryReport};
pub use wake::ConnectionWakePreparation;
pub(crate) const OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArmKind {
    PerKey,
    Native,
    ConnectionWake,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connection {
    pub vendor_id: u16,
    pub product_id: u16,
    /// A qualified stable and unique serial. Unverified HID strings stay None.
    pub serial: Option<String>,
    pub token: String,
}
/// Implementations must keep one control handle, honor the timeout, and never
/// reopen a removed device under the same token. pause must honor the delay.
pub trait Transport {
    fn connection(&self) -> Connection;
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>>;
    fn pause(&mut self, delay: Duration) -> Result<()>;
    /// Device-specific ordering proof: every earlier B3 request has either
    /// committed or been rejected and cannot change a key after this returns.
    /// A sleep or one equal B2 sample is not such a proof. Platform transports
    /// remain unqualified until their actual firmware supplies this guarantee.
    fn settle_function_key_writes(&mut self, _timeout: Duration) -> Result<()> {
        Err(error(
            "FUNCTION_KEYS_BARRIER_UNQUALIFIED",
            "当前传输尚未核对改键提交顺序，不能写入或确认恢复",
        ))
    }
    /// Cancellation stops ordinary output, but restoration keeps its own
    /// bounded budget after the controller or its input pipe has gone away.
    fn begin_recovery(&mut self) {}
}
fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}

struct ReadAdapter<'a, T> {
    transport: &'a mut T,
    deadline: Instant,
}
impl<T: Transport> lighting::ReadTransport for ReadAdapter<'_, T> {
    fn read(
        &mut self,
        command: u8,
        length: u8,
        address: u16,
        handle: u8,
        key: u8,
    ) -> Result<Vec<u8>> {
        let frame = if matches!(command, 0xd5 | 0xd2) {
            crate::lighting_read_frame(command, length, address, handle, key)?
        } else {
            crate::read_frame(command, length, key)?
        };
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(error("HID_TIMEOUT", "灯光事务读取超时"));
        }
        self.transport
            .exchange(&frame, left.min(Duration::from_millis(1200)))
    }
}

pub struct Lighting<T> {
    transport: T,
    model: Model,
    connection: Connection,
    binding: Binding,
    key: u8,
    firmware: Vec<u8>,
    deadline: Instant,
    armed: bool,
    failed: bool,
    last: Option<Vec<u8>>,
    lease: Option<u64>,
    native_expected: Option<Vec<u8>>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaintResult {
    pub painted: usize,
    pub skipped: bool,
    pub readback: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub model_id: String,
    pub firmware_version: String,
    pub lighting_profile: u8,
    pub vendor_id: u16,
    pub product_id: u16,
    pub key_led_count: usize,
    pub led_count: usize,
    pub canvas_count: usize,
    pub connection_token: String,
}
/// Only raw transport verification can construct this receipt; it is neither
/// serializable nor accepted from a service/page command.
pub struct VerifiedRestoration {
    baseline: Baseline,
    token: (u64, u64),
    no_mutation: bool,
}
/// A scoped owner restores once on operation errors or normal scope exit.
/// Explicit close reports failures; Drop never retries an uncertain close.
pub struct Session<'a, T: Transport> {
    lighting: Lighting<sleep::Guard<T>>,
    sleep: crate::recovery::sleep::Journal,
    transaction: Option<Transaction<'a>>,
    rgb_completion: Option<crate::recovery::Completion>,
    close_attempted: bool,
    completion: Option<crate::recovery::Completion>,
    wake_preparation: Option<ConnectionWakePreparation>,
    function_keys: Option<crate::function_keys::FunctionKeyLease>,
    function_keys_unconfirmed: bool,
}
impl<'a, T: Transport> Session<'a, T> {
    pub fn start(
        transport: T,
        model: Model,
        store: &'a mut crate::recovery::JournalStore,
    ) -> Result<Self> {
        Self::start_with_rollback_report(transport, model, store, |_| {})
    }
    pub fn start_with_rollback_report(
        transport: T,
        model: Model,
        store: &'a mut crate::recovery::JournalStore,
        on_rollback: impl FnOnce(&Result<crate::recovery::Completion>),
    ) -> Result<Self> {
        Self::start_selected(transport, model, store, None, on_rollback)
    }
    pub(crate) fn start_selected(
        transport: T,
        model: Model,
        store: &'a mut crate::recovery::JournalStore,
        profile: Option<u8>,
        on_rollback: impl FnOnce(&Result<crate::recovery::Completion>),
    ) -> Result<Self> {
        Self::start_kind(
            transport,
            model,
            store,
            profile,
            ArmKind::PerKey,
            on_rollback,
        )
    }
    pub(crate) fn start_kind(
        transport: T,
        model: Model,
        store: &'a mut crate::recovery::JournalStore,
        profile: Option<u8>,
        kind: ArmKind,
        on_rollback: impl FnOnce(&Result<crate::recovery::Completion>),
    ) -> Result<Self> {
        let lighting = Lighting::open(transport, model)?;
        if profile.is_some_and(|profile| profile != lighting.binding.lighting_profile) {
            return Err(error(
                "SESSION_CHANGED",
                "键盘物理档位与所选设备不一致，未接管",
            ));
        }
        let sleep = store.sleep_journal(lighting.binding(), false)?;
        let mut lighting = lighting.guard_sleep(sleep.watch());
        let original = if kind == ArmKind::Native {
            lighting.capture_native_baseline()?
        } else {
            lighting.capture_baseline()?
        };
        let transaction = store.begin(original)?;
        let mut session = Self {
            lighting,
            sleep,
            transaction: Some(transaction),
            rgb_completion: None,
            close_attempted: false,
            completion: None,
            wake_preparation: None,
            function_keys: None,
            function_keys_unconfirmed: false,
        };
        let armed = session
            .lighting
            .acquire_sleep(&mut session.sleep)
            .and_then(|_| match kind {
                ArmKind::Native => session
                    .lighting
                    .arm_native(session.transaction.as_mut().unwrap()),
                ArmKind::PerKey => session.lighting.arm(session.transaction.as_mut().unwrap()),
                ArmKind::ConnectionWake => session
                    .lighting
                    .arm_connection_wake(session.transaction.as_mut().unwrap())
                    .map(|value| session.wake_preparation = Some(value)),
            });
        if let Err(original) = armed {
            let recovery = session.close();
            on_rollback(&recovery);
            return Err(match recovery {
                Ok(_) => original,
                Err(recovery) => error(
                    "RESTORE_REQUIRED",
                    &format!(
                        "接管未完成：{}；恢复未完成：{}，原记录已保留",
                        original.message, recovery.message
                    ),
                ),
            });
        }
        Ok(session)
    }
    fn rollback_error(&mut self, original: BridgeError) -> BridgeError {
        match self.close() {
            Ok(_) => original,
            Err(recovery) => error(
                "RESTORE_REQUIRED",
                &format!(
                    "灯光操作未完成：{}；恢复未完成：{}，原记录已保留",
                    original.message, recovery.message
                ),
            ),
        }
    }
    /// Native composition only. No controller RPC grants this candidate
    /// capability until its firmware and input qualification are complete.
    pub fn prepare_function_keys(&mut self, requested: &[u8]) -> Result<bool> {
        if self.close_attempted || self.function_keys.is_some() {
            return Err(error(
                "FUNCTION_KEYS_LEASE_ACTIVE",
                "功能键事务已经开始或正在关闭",
            ));
        }
        self.lighting.start();
        if let Err(cause) = self.lighting.check() {
            return Err(self.rollback_error(cause));
        }
        let transaction = self
            .transaction
            .as_mut()
            .ok_or_else(|| error("SESSION_CLOSED", "灯光事务已经关闭"))?;
        match crate::function_keys::FunctionKeyLease::prepare_for_lighting(
            &mut self.lighting.transport,
            &self.lighting.model,
            transaction,
            requested,
            &self.lighting.connection,
            self.lighting.key,
        ) {
            Ok(keys) => {
                let changed = keys.is_some();
                self.function_keys = keys;
                Ok(changed)
            }
            Err(cause) => {
                // An error can leave a partial original before a lease object
                // is returned. Empty RGB/sleep results cannot wash it away.
                self.function_keys_unconfirmed =
                    transaction.function_key_records_pending().unwrap_or(true);
                Err(self.rollback_error(cause))
            }
        }
    }
    fn check_function_key_journal(&self) -> Result<()> {
        self.function_keys.as_ref().map_or(
            Ok(()),
            crate::function_keys::FunctionKeyLease::validate_journal,
        )
    }
    fn close_function_keys(&mut self) -> Result<crate::recovery::Completion> {
        if self.function_keys_unconfirmed {
            return Err(error(
                "FUNCTION_KEYS_RESTORE_REQUIRED",
                "本次功能键原记录尚未取得恢复证明，请保留记录并重新检查",
            ));
        }
        match self.function_keys.as_mut() {
            Some(keys) => {
                keys.restore(&mut self.lighting.transport)
                    .map(|done| crate::recovery::Completion {
                        verified: done.verified,
                        no_mutation: done.no_mutation,
                        archived: done.archived,
                    })
            }
            None => Ok(crate::recovery::Completion {
                verified: false,
                no_mutation: true,
                archived: true,
            }),
        }
    }
    pub fn paint(&mut self, colors: &[u8], verify: bool) -> Result<PaintResult> {
        if self.close_attempted {
            return Err(error("SESSION_CLOSED", "灯光事务已经停止"));
        }
        if let Err(cause) = self.check_function_key_journal() {
            return Err(self.rollback_error(cause));
        }
        let transaction = self
            .transaction
            .as_mut()
            .ok_or_else(|| error("SESSION_CLOSED", "灯光事务已经关闭"))?;
        self.lighting
            .ensure_sleep(&self.sleep)
            .and_then(|_| self.lighting.paint(transaction, colors, verify))
            .map_err(|error| self.rollback_error(error))
    }
    pub fn side(&mut self, color: [u8; 3], brightness: u8) -> Result<()> {
        if self.close_attempted {
            return Err(error("SESSION_CLOSED", "灯光事务已经停止"));
        }
        if let Err(cause) = self.check_function_key_journal() {
            return Err(self.rollback_error(cause));
        }
        let transaction = self
            .transaction
            .as_mut()
            .ok_or_else(|| error("SESSION_CLOSED", "灯光事务已经关闭"))?;
        self.lighting
            .ensure_sleep(&self.sleep)
            .and_then(|_| self.lighting.side(transaction, color, brightness))
            .map_err(|error| self.rollback_error(error))
    }
    pub fn close(&mut self) -> Result<crate::recovery::Completion> {
        self.close_attempted = true;
        if let Some(completion) = &self.completion {
            return Ok(completion.clone());
        }
        // Each owned setting gets a cleanup attempt even when another region
        // fails or unwinds. A verified region can retire its own original.
        let keys =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.close_function_keys()));
        let rgb = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.close_lighting()));
        let sleep = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.lighting.release_sleep(&mut self.sleep)
        }));
        let rgb = match rgb {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        };
        let sleep = match sleep {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        };
        let keys = match keys {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        };
        let key_error = keys.as_ref().err().cloned();
        let (rgb, sleep) = match (rgb, sleep) {
            (Ok(rgb), Ok(sleep)) => (rgb, sleep),
            (Err(rgb), Err(sleep)) => {
                return Err(error(
                    "RESTORE_REQUIRED",
                    &format!(
                        "灯光恢复未完成：{}；休眠恢复未完成：{}",
                        rgb.message, sleep.message
                    ),
                ))
            }
            (Err(e), _) | (_, Err(e)) => return Err(e),
        };
        if let Some(cause) = key_error {
            return Err(cause);
        }
        let keys = keys?;
        let no_mutation = rgb.no_mutation && sleep.no_mutation && keys.no_mutation;
        let completion = crate::recovery::Completion {
            verified: !no_mutation,
            no_mutation,
            archived: rgb.archived && sleep.archived && keys.archived,
        };
        self.completion = Some(completion.clone());
        Ok(completion)
    }
    fn close_lighting(&mut self) -> Result<crate::recovery::Completion> {
        if let Some(completion) = &self.rgb_completion {
            return Ok(completion.clone());
        }
        let transaction = self.transaction.as_mut().ok_or_else(|| {
            error(
                "BACKUP_CLEANUP_FAILED",
                "事务关闭未完成，请检查保留的恢复记录",
            )
        })?;
        let receipt = self.lighting.restore(transaction)?;
        let transaction = self.transaction.take().unwrap();
        let completion = transaction.complete(receipt)?;
        self.rgb_completion = Some(completion.clone());
        Ok(completion)
    }
    pub fn board_sleep_status(&self) -> SleepStatus {
        SleepStatus {
            supported: self.sleep.supported(),
            active: self.sleep.acquired,
            pending: self.sleep.pending(),
        }
    }
    pub fn connection_wake_preparation(&self) -> Option<&ConnectionWakePreparation> {
        self.wake_preparation.as_ref()
    }
    pub fn device_status(&self) -> DeviceStatus {
        DeviceStatus {
            model_id: self.lighting.model.id.clone(),
            firmware_version: self.lighting.binding.firmware_version.clone(),
            lighting_profile: self.lighting.binding.lighting_profile,
            vendor_id: self.lighting.binding.vendor_id,
            product_id: self.lighting.binding.product_id,
            key_led_count: self.lighting.model.key_count,
            led_count: self.lighting.model.key_count + self.lighting.model.side_count,
            canvas_count: self.lighting.model.canvas_count,
            connection_token: self.lighting.connection.token.clone(),
        }
    }
    /// Supervisors use this after an operation error as well as on exit. A
    /// failed automatic close must never turn into a second implicit replay.
    pub fn finish_once(&mut self) -> Result<crate::recovery::Completion> {
        if self.close_attempted {
            return self.completion.clone().ok_or_else(|| {
                error(
                    "RESTORE_REQUIRED",
                    "恢复尝试未完成，原记录已保留，不自动重试",
                )
            });
        }
        self.close()
    }
}
impl<T: Transport> Drop for Session<'_, T> {
    fn drop(&mut self) {
        if !self.close_attempted {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.close()));
        }
    }
}
impl VerifiedRestoration {
    pub(crate) fn belongs_to(&self, baseline: &Baseline) -> bool {
        &self.baseline == baseline
    }
    pub(crate) fn token(&self) -> (u64, u64) {
        self.token
    }
    pub(crate) fn no_mutation(&self) -> bool {
        self.no_mutation
    }
}
impl<T: Transport> Lighting<T> {
    pub fn open(mut transport: T, model: Model) -> Result<Self> {
        // Reuse the complete public model validator, including physical maps.
        crate::models(
            &serde_json::to_string(&vec![&model])
                .map_err(|_| error("INVALID_MODELS", "型号配置无法编码"))?,
        )?;
        let connection = transport.connection();
        if connection.vendor_id != model.vendor_id
            || !model.product_ids.contains(&connection.product_id)
            || connection.token.is_empty()
            || connection.token.len() > 256
        {
            return Err(error("WRONG_DEVICE", "USB 控制接口身份不匹配"));
        }
        let deadline = Instant::now() + OPERATION_TIMEOUT;
        let identity = lighting::inspect(
            &mut ReadAdapter {
                transport: &mut transport,
                deadline,
            },
            &model,
        )?;
        lighting_policy::qualified(&model, &identity.version)?;
        let binding = Binding {
            model_id: model.id.clone(),
            vendor_id: connection.vendor_id,
            product_id: connection.product_id,
            firmware_version: identity.version,
            lighting_profile: identity.lighting_profile,
            identity: connection
                .serial
                .as_ref()
                .filter(|s| !s.is_empty())
                .map(|s| DeviceIdentity::Serial(s.clone()))
                .unwrap_or_else(|| DeviceIdentity::Connection(connection.token.clone())),
        };
        binding.validate(&model)?;
        Ok(Self {
            transport,
            model,
            connection,
            binding,
            key: identity.key,
            firmware: identity.firmware,
            deadline,
            armed: false,
            failed: false,
            last: None,
            lease: None,
            native_expected: None,
        })
    }
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
    pub fn into_transport(self) -> T {
        self.transport
    }
    fn start(&mut self) {
        self.deadline = Instant::now() + OPERATION_TIMEOUT;
    }
    fn raw(&mut self, frame: &[u8; 64]) -> Result<Vec<u8>> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(error("HID_TIMEOUT", "灯光事务超时，原记录应保留"));
        }
        self.transport
            .exchange(frame, left.min(Duration::from_millis(1200)))
    }
    fn pause(&mut self, ms: u64) -> Result<()> {
        let delay = Duration::from_millis(ms);
        if self.deadline.saturating_duration_since(Instant::now()) < delay {
            return Err(error("HID_TIMEOUT", "灯光事务等待超时"));
        }
        self.transport.pause(delay)
    }
    fn check(&mut self) -> Result<()> {
        if self.transport.connection() != self.connection {
            return Err(error(
                "SESSION_CHANGED",
                "USB 控制句柄代次已改变，已停止输出",
            ));
        }
        let identity = lighting::inspect(
            &mut ReadAdapter {
                transport: &mut self.transport,
                deadline: self.deadline,
            },
            &self.model,
        )?;
        if identity.key != self.key
            || identity.firmware[..6] != self.firmware[..6]
            || identity.lighting_profile != self.binding.lighting_profile
        {
            return Err(error(
                "SESSION_CHANGED",
                "固件、密钥或键盘档位已改变，已停止输出",
            ));
        }
        Ok(())
    }
    fn read(&mut self, command: u8, length: u8, address: u16, handle: u8) -> Result<Vec<u8>> {
        let frame = crate::lighting_read_frame(command, length, address, handle, self.key)?;
        let reply = self.raw(&frame)?;
        crate::decode_routed(
            &reply,
            command,
            usize::from(length),
            address,
            handle,
            self.key,
        )
    }
    fn state(&mut self) -> Result<Vec<u8>> {
        self.check()?;
        let state = self.read(
            0xd5,
            self.model.lighting_state_length,
            0,
            self.binding.lighting_profile,
        )?;
        lighting::validate_state(&state, &self.model)?;
        Ok(state)
    }
    fn colors(&mut self) -> Result<Vec<u8>> {
        self.check()?;
        let total = (self.model.key_count + self.model.side_count) * 3;
        let mut colors = Vec::with_capacity(total);
        while colors.len() < total {
            let count = (total - colors.len()).min(54) as u8;
            colors.extend(self.read(0xd2, count, colors.len() as u16, 0)?);
        }
        self.check()?;
        Ok(colors)
    }
    pub fn capture_baseline(&mut self) -> Result<Baseline> {
        self.start();
        let state = self.state()?;
        let colors = self.colors()?;
        let after = self.state()?;
        if !lighting_policy::owned_state_matches(
            &self.model,
            &self.binding.firmware_version,
            &state,
            &after,
        )? || lighting_policy::preset_fields_differ(
            &self.model,
            &self.binding.firmware_version,
            &state,
            &after,
        )? {
            return Err(error(
                "SNAPSHOT_SESSION_CHANGED",
                "采集期间灯效设置发生变化，未写入键盘",
            ));
        }
        // First writable preview deliberately refuses dimmed/custom-filtered
        // originals before any mutation. Broader AIR recovery remains planned.
        if state[0] == 21 {
            ReconstructedPalette::capture(&self.model, &self.binding, &state, &colors)?;
        }
        let mut restorable = state.clone();
        if state[0] == 0 && state[1] == 0 && state[10] == 0 {
            restorable[0] = 2;
        }
        lighting_policy::state_write_plan(
            &self.model,
            &self.binding.firmware_version,
            &restorable,
            &state,
        )?;
        Ok(Baseline {
            binding: self.binding.clone(),
            state,
            rendered_colors: colors,
        })
    }
    fn frame(&self, command: u8, payload: &[u8]) -> Result<[u8; 64]> {
        let valid = match command {
            0xd6 => payload.len() == 17,
            0xd8 => !payload.is_empty() && payload.len() <= 52 && payload.len().is_multiple_of(4),
            _ => false,
        };
        if !valid {
            return Err(error(
                "WRITE_SCOPE_INVALID",
                "灯光事务只允许限定的设置与键灯颜色报文",
            ));
        }
        let mut bytes = [0; 64];
        bytes[0] = 0x55;
        bytes[1] = command;
        bytes[4] = payload.len() as u8 ^ self.key;
        bytes[5] = self.key;
        bytes[6] = self.key;
        bytes[7] = self.binding.lighting_profile ^ self.key;
        for (i, &value) in payload.iter().enumerate() {
            bytes[8 + i] = value ^ self.key;
        }
        bytes[3] = crate::checksum(&bytes);
        Ok(bytes)
    }
    fn send(
        &mut self,
        transaction: &mut Transaction<'_>,
        command: u8,
        payload: &[u8],
        recovering: bool,
    ) -> Result<()> {
        self.check()?;
        let frame = self.frame(command, payload)?;
        let binding = self.binding.clone();
        let kind = if command == 0xd8 {
            Mutation::Palette
        } else {
            Mutation::Settings
        };
        let action = || {
            let reply = self.raw(&frame)?;
            let echoed = crate::decode_routed(
                &reply,
                command,
                payload.len(),
                0,
                binding.lighting_profile,
                self.key,
            )?;
            if echoed != payload {
                return Err(error(
                    "WRITE_ACK_MISMATCH",
                    "灯光写入确认不一致，原记录应保留",
                ));
            }
            self.check()
        };
        if recovering {
            transaction.recovery_write(&binding, kind, action)
        } else {
            transaction.mutate(&binding, kind, action)
        }
    }
    fn settings(
        &mut self,
        transaction: &mut Transaction<'_>,
        target: &[u8],
        recovering: bool,
    ) -> Result<()> {
        let current = self.state()?;
        let plan = lighting_policy::state_write_plan(
            &self.model,
            &self.binding.firmware_version,
            target,
            &current,
        )?;
        self.send(transaction, 0xd6, &plan.payload, recovering)?;
        self.pause(120)?;
        for attempt in 0..5 {
            let observed = self.state()?;
            if lighting_policy::owned_state_matches(
                &self.model,
                &self.binding.firmware_version,
                target,
                &observed,
            )? {
                return Ok(());
            }
            if attempt < 4 {
                self.pause(120)?;
            }
        }
        Err(error(
            "STATE_VERIFY_FAILED",
            "设置独立读回不一致，不重发写入",
        ))
    }
    fn full_custom(&mut self) -> Result<Vec<u8>> {
        let mut state = self.state()?;
        state[0] = 21;
        state[1] = 100;
        state[4] = 1;
        if state.len() == 22 {
            state[6..9].copy_from_slice(&[255, 255, 255]);
        }
        Ok(state)
    }
    fn palette(
        &mut self,
        transaction: &mut Transaction<'_>,
        colors: &[u8],
        previous: Option<&[u8]>,
        recovering: bool,
    ) -> Result<()> {
        if colors.len() != self.model.key_count * 3 {
            return Err(error("INVALID_COLORS", "键灯颜色数量不一致"));
        }
        let changed: Vec<usize> = (0..self.model.key_count)
            .filter(|&i| previous.is_none_or(|p| p[i * 3..i * 3 + 3] != colors[i * 3..i * 3 + 3]))
            .collect();
        for chunk in changed.chunks(13) {
            let mut payload = Vec::with_capacity(chunk.len() * 4);
            for &i in chunk {
                payload.push(self.model.rgb_write_indices[i]);
                payload.extend_from_slice(&colors[i * 3..i * 3 + 3]);
            }
            self.send(transaction, 0xd8, &payload, recovering)?;
        }
        Ok(())
    }
    fn prepare_arm(&mut self, transaction: &mut Transaction<'_>) -> Result<bool> {
        self.start();
        self.native_expected = None;
        self.armed = false;
        self.failed = true;
        self.last = None;
        if transaction.baseline().binding != self.binding {
            return Err(error("BACKUP_DEVICE_MISMATCH", "原记录不属于当前键盘"));
        }
        let original = transaction.baseline().clone();
        let live = self.state()?;
        if !lighting_policy::owned_state_matches(
            &self.model,
            &self.binding.firmware_version,
            &original.state,
            &live,
        )? || lighting_policy::preset_fields_differ(
            &self.model,
            &self.binding.firmware_version,
            &original.state,
            &live,
        )? {
            return Err(error(
                "SNAPSHOT_SESSION_CHANGED",
                "原记录保存后设置已变化，未接管键盘",
            ));
        }
        if original.state[0] == 21 {
            if self.colors()?[..self.model.key_count * 3]
                != original.rendered_colors[..self.model.key_count * 3]
            {
                return Err(error(
                    "SNAPSHOT_SESSION_CHANGED",
                    "原自定义颜色已改变，未接管键盘",
                ));
            }
            transaction.preserve_palette(ReconstructedPalette::capture(
                &self.model,
                &self.binding,
                &original.state,
                &original.rendered_colors,
            )?)?;
        }
        Ok(original.state[0] == 21)
    }
    pub fn arm(&mut self, transaction: &mut Transaction<'_>) -> Result<()> {
        let captured = self.prepare_arm(transaction)?;
        let target = self.full_custom()?;
        self.settings(transaction, &target, false)?;
        let state = self.state()?;
        let colors = self.colors()?;
        if !captured {
            transaction.preserve_palette(ReconstructedPalette::capture(
                &self.model,
                &self.binding,
                &state,
                &colors,
            )?)?;
        }
        self.check()?;
        self.armed = true;
        self.failed = false;
        self.lease = Some(transaction.token().0);
        Ok(())
    }
    pub fn paint(
        &mut self,
        transaction: &mut Transaction<'_>,
        colors: &[u8],
        verify: bool,
    ) -> Result<PaintResult> {
        self.start();
        if self.native_expected.is_some() {
            return Err(error(
                "LIGHTING_PURPOSE_MISMATCH",
                "请先恢复内置灯效，再开启逐键绘图",
            ));
        }
        if !self.armed || self.failed || self.lease != Some(transaction.token().0) {
            return Err(error("NOT_ARMED", "灯光事务尚未接管或已失效"));
        }
        if colors.len() != self.model.key_count * 3 && colors.len() != self.model.canvas_count * 3 {
            return Err(error("INVALID_COLORS", "画布颜色数量不一致"));
        }
        let colors = &colors[..self.model.key_count * 3];
        self.failed = true;
        self.check()?;
        transaction.output_guard(&self.binding)?;
        let state = self.state()?;
        if state[0] != 21
            || state[1] != 100
            || state[4] != 1
            || (state.len() == 22 && state[6..9] != [255, 255, 255])
        {
            return Err(error("OWNERSHIP_CHANGED", "键盘灯效模式已改变，已停止输出"));
        }
        let skipped = self.last.as_deref() == Some(colors);
        if !skipped || verify {
            let previous = if verify { None } else { self.last.clone() };
            self.palette(transaction, colors, previous.as_deref(), false)?;
        }
        let readback = verify || self.last.is_none();
        if readback {
            let expected = lighting_policy::rendered_palette(
                &self.model,
                &self.binding.firmware_version,
                colors,
            )?;
            // D8 updates the 2.0.0.7 palette and dirty flag; its renderer runs
            // later. Allow bounded fresh observations, never a repeated write.
            let delayed = lighting_policy::qualified(&self.model, &self.binding.firmware_version)?
                == lighting_policy::PolicyKind::Air75V2;
            let delays: &[u64] = if delayed { &[0, 20, 40] } else { &[0] };
            let mut verified = false;
            for &delay in delays {
                if delay > 0 {
                    self.pause(delay)?;
                }
                let observed = self.colors()?;
                if delayed {
                    let after = self.state()?;
                    if !lighting_policy::owned_state_matches(
                        &self.model,
                        &self.binding.firmware_version,
                        &state,
                        &after,
                    )? {
                        return Err(error(
                            "OWNERSHIP_CHANGED",
                            "等待颜色读回期间灯光设置已变化，已停止输出",
                        ));
                    }
                    transaction.output_guard(&self.binding)?;
                }
                if observed[..self.model.key_count * 3] == expected {
                    verified = true;
                    break;
                }
            }
            if !verified {
                return Err(error(
                    "COLOR_VERIFY_FAILED",
                    "键灯独立读回不一致，已停止后续输出",
                ));
            }
        }
        self.last = Some(colors.to_vec());
        self.failed = false;
        Ok(PaintResult {
            painted: self.model.key_count,
            skipped,
            readback,
        })
    }
    pub fn side(
        &mut self,
        transaction: &mut Transaction<'_>,
        color: [u8; 3],
        brightness: u8,
    ) -> Result<()> {
        self.start();
        if self.native_expected.is_some() {
            return Err(error("LIGHTING_PURPOSE_MISMATCH", "内置灯效事务不接管侧灯"));
        }
        if !self.armed || self.failed || self.lease != Some(transaction.token().0) {
            return Err(error("NOT_ARMED", "灯光事务尚未接管或已失效"));
        }
        if brightness > 100 {
            return Err(error("INVALID_SIDE", "侧灯亮度超出范围"));
        }
        self.failed = true;
        let mut target = self.state()?;
        target[9] = 2;
        target[10] = brightness;
        target[12] = 0;
        target[13] = 0;
        target[14..17].copy_from_slice(&color);
        self.settings(transaction, &target, false)?;
        self.failed = false;
        Ok(())
    }
    pub fn restore(&mut self, transaction: &mut Transaction<'_>) -> Result<VerifiedRestoration> {
        self.start();
        self.native_expected = None;
        self.transport.begin_recovery();
        self.armed = false;
        self.failed = true;
        self.last = None;
        self.lease = None;
        transaction.prepare_recovery(&self.binding)?;
        self.check()?;
        if transaction.baseline().binding != self.binding {
            return Err(error("BACKUP_DEVICE_MISMATCH", "恢复记录不属于当前键盘"));
        }
        let original = transaction.baseline().clone();
        if !transaction.mutation_started()? {
            return Ok(VerifiedRestoration {
                baseline: original,
                token: transaction.token(),
                no_mutation: true,
            });
        }
        let palette = transaction.recover(&self.binding, |_, palette| Ok(palette.cloned()))?;
        let initial = self.state()?;
        transaction.plan_restoration(&self.binding, &initial)?;
        let mut evidence = None;
        if let Some(palette) = &palette {
            let custom = self.full_custom()?;
            self.settings(transaction, &custom, true)?;
            self.palette(transaction, palette.colors(), None, true)?;
            self.pause(
                lighting_policy::qualified(&self.model, &self.binding.firmware_version)?
                    .settle_ms(),
            )?;
            let state = self.state()?;
            let colors = self.colors()?;
            evidence = Some(lighting_policy::verify_palette_readback(
                &self.model,
                palette,
                &self.binding,
                &state,
                &colors,
            )?);
        }
        let live = self.state()?;
        let plan = transaction.plan_restoration(&self.binding, &live)?;
        if plan.settings.is_some() {
            let mut target = original.state.clone();
            if target[0] == 0 && target[1] == 0 && target[10] == 0 {
                target[0] = 2;
            }
            self.settings(transaction, &target, true)?;
        }
        let state = self.state()?;
        let colors = self.colors()?;
        transaction.assess_restoration(
            &plan,
            &self.binding,
            &state,
            Some(&colors),
            evidence.as_ref(),
        )?;
        self.check()?;
        Ok(VerifiedRestoration {
            baseline: original,
            token: transaction.token(),
            no_mutation: false,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests;
