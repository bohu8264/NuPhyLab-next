//! A supervised, single-owner lighting worker. The Windows desktop and the
//! native binary's default mode still select the separate read-only bridge.
use crate::{
    output::{ArmKind, Connection, NativeLightingConfig, Session, Transport},
    recovery::{Completion, JournalStore, RecoveryObservation, RecoveryStatus},
    BridgeError, Model, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{BufReader, Read, Write},
    path::Path,
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub profile: String,
    pub protocol_version: u32,
    pub implementation: String,
    pub max_line_bytes: usize,
    pub max_pending: usize,
    pub handshake_timeout_ms: u64,
    pub heartbeat_interval_ms: u64,
    pub heartbeat_timeout_ms: u64,
    pub request_timeout_ms: u64,
    pub operation_timeout_ms: u64,
    pub max_frame_age_ms: u64,
    pub shutdown_timeout_ms: u64,
    pub operations: Vec<String>,
    pub capabilities: Value,
}
pub fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        let value: Contract = serde_json::from_str(include_str!(
            "../../../shared/contracts/native-lighting-v5.json"
        ))
        .expect("无效的灯光控制契约");
        assert_eq!(value.max_line_bytes, crate::MAX_LINE);
        assert_eq!(
            Duration::from_millis(value.operation_timeout_ms),
            crate::output::OPERATION_TIMEOUT
        );
        assert!(value.max_pending > 0);
        value
    })
}
#[derive(Clone, Copy)]
pub enum Backend {
    Simulated,
    WindowsHid,
}
impl Backend {
    fn name(self) -> &'static str {
        match self {
            Self::Simulated => "simulated",
            Self::WindowsHid => "windows-hid",
        }
    }
}
#[derive(Clone)]
struct Options {
    handshake: Duration,
    heartbeat: Duration,
    frame_age: Duration,
    pending: usize,
    shutdown: Duration,
}
impl Default for Options {
    fn default() -> Self {
        let c = contract();
        Self {
            handshake: Duration::from_millis(c.handshake_timeout_ms),
            heartbeat: Duration::from_millis(c.heartbeat_timeout_ms),
            frame_age: Duration::from_millis(c.max_frame_age_ms),
            pending: c.max_pending,
            shutdown: Duration::from_millis(c.shutdown_timeout_ms),
        }
    }
}
fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}
#[derive(Clone)]
struct Stop {
    error: BridgeError,
    quit: Option<u64>,
}
impl Stop {
    fn graceful(&self) -> bool {
        matches!(
            self.error.code.as_str(),
            "CONTROLLER_INPUT_CLOSED" | "CONTROLLER_QUIT"
        )
    }
}
struct Health {
    last: Instant,
    ready: bool,
    stop: Option<Stop>,
    received: u64,
}
struct Signal {
    health: Mutex<Health>,
    options: Options,
    clock: Arc<dyn Fn() -> Instant + Send + Sync>,
}
impl Signal {
    fn new(options: Options) -> Self {
        Self::with_clock(options, Arc::new(Instant::now))
    }
    fn with_clock(options: Options, clock: Arc<dyn Fn() -> Instant + Send + Sync>) -> Self {
        Self {
            health: Mutex::new(Health {
                last: clock(),
                ready: false,
                stop: None,
                received: 0,
            }),
            options,
            clock,
        }
    }
    fn stop(&self, cause: BridgeError, quit: Option<u64>) {
        let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
        if health.stop.is_none() {
            health.stop = Some(Stop { error: cause, quit });
        }
    }
    fn touch(&self, hello: bool) {
        let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
        // A late heartbeat cannot revive an expired output lease.
        self.expire(&mut health);
        if health.stop.is_none() {
            health.ready |= hello;
            health.last = (self.clock)();
            health.received = health.received.saturating_add(1);
        }
    }
    fn expire(&self, health: &mut Health) {
        let limit = if health.ready {
            self.options.heartbeat
        } else {
            self.options.handshake
        };
        if health.stop.is_none() && (self.clock)().saturating_duration_since(health.last) >= limit {
            health.stop = Some(Stop {
                error: if health.ready {
                    error("CONTROLLER_HEARTBEAT_LOST", "后台心跳已中断，已停止输出")
                } else {
                    error(
                        "CONTROLLER_HANDSHAKE_TIMEOUT",
                        "后台握手超时，未开启灯光事务",
                    )
                },
                quit: None,
            });
        }
    }
    fn cause(&self) -> Option<Stop> {
        let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
        self.expire(&mut health);
        health.stop.clone()
    }
    fn check(&self) -> Result<()> {
        self.cause().map_or(Ok(()), |cause| Err(cause.error))
    }
}
struct Budget {
    deadline: Mutex<Instant>,
    clock: Arc<dyn Fn() -> Instant + Send + Sync>,
}
impl Budget {
    fn new(signal: &Signal) -> Self {
        Self {
            deadline: Mutex::new((signal.clock)() + crate::output::OPERATION_TIMEOUT),
            clock: Arc::clone(&signal.clock),
        }
    }
    fn reset(&self) {
        *self.deadline.lock().unwrap_or_else(|e| e.into_inner()) =
            (self.clock)() + crate::output::OPERATION_TIMEOUT;
    }
    fn remaining(&self) -> Result<Duration> {
        let left = self
            .deadline
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .saturating_duration_since((self.clock)());
        if left.is_zero() {
            Err(error(
                "CONTROLLER_OPERATION_TIMEOUT",
                "本次设备操作超时，已停止普通输出",
            ))
        } else {
            Ok(left)
        }
    }
}
struct Guarded<T> {
    inner: T,
    signal: Arc<Signal>,
    recovering: bool,
    budget: Arc<Budget>,
}
impl<T: Transport> Transport for Guarded<T> {
    fn connection(&self) -> Connection {
        self.inner.connection()
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        if !self.recovering {
            self.signal.check()?;
        }
        let value = self
            .inner
            .exchange(frame, timeout.min(self.budget.remaining()?))?;
        self.budget.remaining()?;
        if !self.recovering {
            self.signal.check()?;
        }
        Ok(value)
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        let mut remaining = delay;
        while !remaining.is_zero() {
            if !self.recovering {
                self.signal.check()?;
            }
            let chunk = remaining.min(Duration::from_millis(25));
            if self.budget.remaining()? < chunk {
                return Err(error(
                    "CONTROLLER_OPERATION_TIMEOUT",
                    "设备等待超出本次操作期限",
                ));
            }
            self.inner.pause(chunk)?;
            remaining -= chunk;
        }
        Ok(())
    }
    fn settle_function_key_writes(&mut self, timeout: Duration) -> Result<()> {
        if !self.recovering {
            self.signal.check()?;
        }
        self.inner
            .settle_function_key_writes(timeout.min(self.budget.remaining()?))?;
        self.budget.remaining()?;
        if !self.recovering {
            self.signal.check()?;
        }
        Ok(())
    }
    fn begin_recovery(&mut self) {
        self.recovering = true;
        self.budget.reset();
        self.inner.begin_recovery();
    }
}

enum Action {
    Hello,
    Heartbeat,
    Arm {
        model_id: String,
        profile: u8,
        kind: ArmKind,
    },
    RecoveryStatus {
        model_id: String,
        profile: u8,
    },
    RecoverExisting {
        model_id: String,
        profile: u8,
    },
    Paint {
        lease: u64,
        colors: Vec<u8>,
        verify: bool,
    },
    Side {
        lease: u64,
        color: [u8; 3],
        brightness: u8,
    },
    Restore {
        lease: u64,
    },
    NativeLighting {
        lease: u64,
        config: NativeLightingConfig,
    },
    NativeSnapshot {
        lease: u64,
    },
    Quit,
}
struct Request {
    id: u64,
    action: Action,
    queued: Instant,
}
#[derive(Default)]
struct Protocol {
    session: Option<String>,
    last: u64,
}
impl Protocol {
    fn accept(&mut self, value: Value) -> Result<Request> {
        let invalid = || error("CONTROLLER_REQUEST_INVALID", "灯光命令编号、参数或会话无效");
        let id = value["id"]
            .as_u64()
            .filter(|&id| id > self.last && id <= 9_007_199_254_740_991)
            .ok_or_else(invalid)?;
        self.last = id;
        let op = value["op"].as_str().ok_or_else(invalid)?;
        let session = value["sessionId"].as_str().ok_or_else(invalid)?;
        let extra: &[&str] = match op {
            "hello" => &["protocolVersion"],
            "paint" => &["leaseId", "colors", "verify"],
            "side" => &["leaseId", "color", "brightness"],
            "restore" | "nativeSnapshot" => &["leaseId"],
            "nativeLighting" => &["leaseId", "mode", "brightness", "speed", "color"],
            "arm" | "armNative" | "armConnectionWake" | "recoveryStatus" | "recoverExisting" => {
                &["modelId", "lightingProfile"]
            }
            "heartbeat" | "quit" => &[],
            _ => return Err(invalid()),
        };
        if extra
            .iter()
            .any(|key| !value.as_object().is_some_and(|v| v.contains_key(*key)))
            || value.as_object().ok_or_else(invalid)?.keys().any(|key| {
                !["id", "op", "sessionId"].contains(&key.as_str()) && !extra.contains(&key.as_str())
            })
        {
            return Err(invalid());
        }
        if op == "hello" {
            if self.session.is_some()
                || !crate::bridge::valid_session_id(session)
                || value["protocolVersion"] != contract().protocol_version
            {
                return Err(error(
                    "CONTROLLER_PROTOCOL_MISMATCH",
                    "灯光控制协议或握手会话不匹配",
                ));
            }
            self.session = Some(session.into());
        } else if self.session.as_deref() != Some(session) {
            return Err(error(
                "CONTROLLER_HANDSHAKE_REQUIRED",
                "请先完成本次灯光控制握手",
            ));
        }
        let lease = || {
            value["leaseId"]
                .as_u64()
                .filter(|&v| v > 0 && v <= 9_007_199_254_740_991)
                .ok_or_else(invalid)
        };
        let action = match op {
            "hello" => Action::Hello,
            "heartbeat" => Action::Heartbeat,
            "arm" | "armNative" | "armConnectionWake" | "recoveryStatus" | "recoverExisting" => {
                let model_id = value["modelId"]
                    .as_str()
                    .filter(|v| {
                        !v.is_empty()
                            && v.len() <= 64
                            && v.bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    })
                    .ok_or_else(invalid)?
                    .into();
                let profile = value["lightingProfile"]
                    .as_u64()
                    .filter(|&v| v <= 1)
                    .ok_or_else(invalid)? as u8;
                match op {
                    "arm" | "armNative" | "armConnectionWake" => Action::Arm {
                        model_id,
                        profile,
                        kind: match op {
                            "armNative" => ArmKind::Native,
                            "armConnectionWake" => ArmKind::ConnectionWake,
                            _ => ArmKind::PerKey,
                        },
                    },
                    "recoveryStatus" => Action::RecoveryStatus { model_id, profile },
                    _ => Action::RecoverExisting { model_id, profile },
                }
            }
            "quit" => Action::Quit,
            "restore" => Action::Restore { lease: lease()? },
            "nativeSnapshot" => Action::NativeSnapshot { lease: lease()? },
            "nativeLighting" => {
                let config = NativeLightingConfig {
                    mode: serde_json::from_value(value["mode"].clone()).map_err(|_| invalid())?,
                    brightness: serde_json::from_value(value["brightness"].clone())
                        .map_err(|_| invalid())?,
                    speed: serde_json::from_value(value["speed"].clone()).map_err(|_| invalid())?,
                    color: serde_json::from_value(value["color"].clone()).map_err(|_| invalid())?,
                };
                config.validate().map_err(|_| invalid())?;
                Action::NativeLighting {
                    lease: lease()?,
                    config,
                }
            }
            "paint" => {
                let colors: Vec<u8> =
                    serde_json::from_value(value["colors"].clone()).map_err(|_| invalid())?;
                if colors.is_empty() || !colors.len().is_multiple_of(3) {
                    return Err(invalid());
                }
                Action::Paint {
                    lease: lease()?,
                    colors,
                    verify: value["verify"].as_bool().ok_or_else(invalid)?,
                }
            }
            "side" => Action::Side {
                lease: lease()?,
                color: serde_json::from_value(value["color"].clone()).map_err(|_| invalid())?,
                brightness: value["brightness"]
                    .as_u64()
                    .filter(|&v| v <= 100)
                    .ok_or_else(invalid)? as u8,
            },
            _ => unreachable!(),
        };
        Ok(Request {
            id,
            action,
            queued: Instant::now(),
        })
    }
}
struct Output {
    session: Option<String>,
    sequence: u64,
    closed: bool,
}
enum Packet {
    Message(Vec<u8>),
    Finish(mpsc::SyncSender<Result<()>>),
}
#[derive(Clone)]
struct Sink {
    output: Arc<Mutex<Output>>,
    sender: mpsc::SyncSender<Packet>,
    signal: Arc<Signal>,
}
impl Sink {
    fn new<W: Write + Send + 'static>(mut writer: W, signal: Arc<Signal>) -> Self {
        let (sender, receiver) = mpsc::sync_channel(signal.options.pending);
        let writer_signal = Arc::clone(&signal);
        std::thread::spawn(move || {
            while let Ok(packet) = receiver.recv() {
                match packet {
                    Packet::Message(bytes) => {
                        if writer
                            .write_all(&bytes)
                            .and_then(|_| writer.flush())
                            .is_err()
                        {
                            writer_signal.stop(
                                error("CONTROLLER_OUTPUT_CLOSED", "灯光回复通道已关闭"),
                                None,
                            );
                            break;
                        }
                    }
                    Packet::Finish(reply) => {
                        let result = writer.flush().map_err(|_| {
                            error("CONTROLLER_OUTPUT_CLOSED", "灯光回复通道无法完成清理")
                        });
                        let _ = reply.send(result);
                        break;
                    }
                }
            }
        });
        Self {
            output: Arc::new(Mutex::new(Output {
                session: None,
                sequence: 0,
                closed: false,
            })),
            sender,
            signal,
        }
    }
    fn write(&self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)
            .map_err(|_| error("CONTROLLER_OUTPUT_CLOSED", "灯光回复无法编码"))?;
        let result = if bytes.len() + 1 > crate::MAX_LINE {
            Err(error("CONTROLLER_OUTPUT_CLOSED", "灯光回复超过消息限制"))
        } else {
            bytes.push(b'\n');
            self.sender.try_send(Packet::Message(bytes)).map_err(|_| {
                error(
                    "CONTROLLER_OUTPUT_CLOSED",
                    "灯光回复通道关闭或积压，已停止输出",
                )
            })
        };
        if let Err(e) = &result {
            self.signal.stop(e.clone(), None);
        }
        result
    }
    fn reply(&self, id: u64, value: Result<Value>) -> Result<()> {
        let output = self.output.lock().unwrap_or_else(|e| e.into_inner());
        if output.closed {
            return Err(error("CONTROLLER_CLOSED", "灯光控制回复已经结束"));
        }
        self.write(&match value {
            Ok(value) => json!({"id":id,"ok":true,"result":value}),
            Err(error) => json!({"id":id,"ok":false,"error":error}),
        })
    }
    fn set_session(&self, session: &str) {
        self.output
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .session = Some(session.into());
    }
    fn shutdown(&self, report: &Report, cause: Option<&str>) -> Result<()> {
        let mut output = self.output.lock().unwrap_or_else(|e| e.into_inner());
        output.closed = true;
        if output.session.is_none() {
            return Ok(());
        }
        output.sequence += 1;
        self.write(
            &json!({"event":"shutdownComplete","sessionId":output.session,
            "eventSequence":output.sequence,"lightingRestored":report.restored,
            "recoveryPending":!report.restored,"noMutation":report.no_mutation,
            "reasonCode":cause}),
        )
    }
    fn finish(&self) -> Result<()> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .try_send(Packet::Finish(sender))
            .map_err(|_| error("CONTROLLER_OUTPUT_CLOSED", "退出回复无法入队"))?;
        receiver
            .recv_timeout(self.signal.options.shutdown)
            .map_err(|_| {
                error(
                    "CONTROLLER_OUTPUT_TIMEOUT",
                    "退出回复未及时完成，设备恢复已单独处理",
                )
            })?
    }
}
fn input<R: Read + Send + 'static>(reader: R, sender: mpsc::SyncSender<Request>, sink: Sink) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut protocol = Protocol::default();
        loop {
            if sink.signal.cause().is_some() {
                break;
            }
            let value = match crate::json_line(&mut reader) {
                Ok(Some(value)) => value,
                Ok(None) => {
                    sink.signal
                        .stop(error("CONTROLLER_INPUT_CLOSED", "后台输入通道已关闭"), None);
                    break;
                }
                Err(e) => {
                    sink.signal.stop(e, None);
                    break;
                }
            };
            let id = value["id"].as_u64();
            let mut request = match protocol.accept(value) {
                Ok(request) => request,
                Err(e) => {
                    sink.signal.stop(e.clone(), None);
                    if let Some(id) = id {
                        let _ = sink.reply(id, Err(e.clone()));
                    }
                    break;
                }
            };
            request.queued = (sink.signal.clock)();
            if matches!(request.action, Action::Hello) {
                sink.set_session(protocol.session.as_deref().unwrap());
            }
            if matches!(request.action, Action::Quit) {
                sink.signal
                    .stop(error("CONTROLLER_QUIT", "后台请求退出"), Some(request.id));
                break;
            }
            if matches!(request.action, Action::Heartbeat) {
                sink.signal.touch(false);
                if sink.signal.check().is_err() {
                    break;
                }
                if sink.reply(request.id, Ok(json!({"alive":true}))).is_err() {
                    break;
                }
                continue;
            }
            let hello = matches!(request.action, Action::Hello);
            match sender.try_send(request) {
                Ok(()) => sink.signal.touch(hello),
                Err(_) => {
                    sink.signal.stop(
                        error("CONTROLLER_QUEUE_FULL", "灯光命令积压，已停止后续输出"),
                        None,
                    );
                    break;
                }
            }
        }
    });
}
fn next(receiver: &Receiver<Request>, signal: &Signal) -> Result<Request> {
    loop {
        signal.check()?;
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(request) => {
                signal.check()?;
                return Ok(request);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                signal.check()?;
                return Err(error("CONTROLLER_INPUT_CLOSED", "后台输入通道已关闭"));
            }
        }
    }
}
#[derive(Clone)]
struct Report {
    restored: bool,
    no_mutation: bool,
}
impl Report {
    fn clean() -> Self {
        Self {
            restored: true,
            no_mutation: true,
        }
    }
    fn unknown() -> Self {
        Self {
            restored: false,
            no_mutation: false,
        }
    }
    fn from_completion(value: &Completion) -> Self {
        Self {
            restored: value.archived && (value.verified || value.no_mutation),
            no_mutation: value.no_mutation,
        }
    }
}
enum End {
    Restore(u64),
    Stop(BridgeError),
}
struct ActiveEnd {
    again: bool,
    result: Result<()>,
    report: Report,
}
fn active<T: Transport>(
    session: &mut Session<'_, Guarded<T>>,
    receiver: &Receiver<Request>,
    sink: &Sink,
    lease: u64,
    arm_id: u64,
    budget: &Budget,
) -> ActiveEnd {
    let end = (|| -> Result<End> {
        let mut armed = json!({"armed":true,"leaseId":lease,"boardSleepLease":session.board_sleep_status(),"device":session.device_status()});
        if let Some(preparation) = session.connection_wake_preparation() { armed["connectionWake"] = serde_json::to_value(preparation)
            .map_err(|_| error("CONTROLLER_RESULT_INVALID", "迎宾准备结果无法编码"))?; }
        sink.reply(arm_id, Ok(armed))?;
        loop {
            let request = next(receiver, &sink.signal)?;
            if matches!(request.action, Action::Paint { .. } | Action::Side { .. } | Action::NativeLighting { .. })
                && (sink.signal.clock)().saturating_duration_since(request.queued)
                    > sink.signal.options.frame_age
            {
                sink.reply(request.id, Err(error("FRAME_EXPIRED", "过期灯光帧已丢弃")))?;
                continue;
            }
            let result = match request.action {
                Action::Paint {
                    lease: given,
                    colors,
                    verify,
                } if given == lease => {budget.reset();session.paint(&colors, verify).and_then(|v| {
                    serde_json::to_value(v)
                        .map_err(|_| error("CONTROLLER_RESULT_INVALID", "绘图结果无法编码"))
                })},
                Action::Side {
                    lease: given,
                    color,
                    brightness,
                } if given == lease => {budget.reset();session
                    .side(color, brightness)
                    .map(|_| json!({"updated":true}))},
                Action::NativeLighting { lease: given, config } if given == lease => {
                    budget.reset();
                    session.native_lighting(&config).and_then(|v| serde_json::to_value(v)
                        .map_err(|_| error("CONTROLLER_RESULT_INVALID", "内置灯效结果无法编码")))
                },
                Action::NativeSnapshot { lease: given } if given == lease => {
                    budget.reset();
                    session.native_snapshot().and_then(|v| serde_json::to_value(v)
                        .map_err(|_| error("CONTROLLER_RESULT_INVALID", "内置灯效采样无法编码")))
                },
                Action::Restore { lease: given } if given == lease => {
                    return Ok(End::Restore(request.id))
                }
                _ => {
                    sink.reply(
                        request.id,
                        Err(error("LIGHTING_LEASE_MISMATCH", "灯光命令不属于当前事务")),
                    )?;
                    continue;
                }
            };
            let failed = result.as_ref().err().cloned();
            sink.reply(request.id, result)?;
            if let Some(error) = failed {
                return Ok(End::Stop(error));
            }
        }
    })()
    .unwrap_or_else(End::Stop);
    // paint/side can already have performed a scoped rollback. This call
    // reports that outcome without repeating a failed recovery.
    let complete = session.finish_once();
    let report = complete
        .as_ref()
        .map(Report::from_completion)
        .unwrap_or_else(|_| Report::unknown());
    match end {
        End::Restore(id) => {
            let reply = complete.and_then(|v| {
                serde_json::to_value(v)
                    .map_err(|_| error("CONTROLLER_RESULT_INVALID", "恢复结果无法编码"))
            });
            let failure = reply.as_ref().err().cloned();
            let result = sink
                .reply(id, reply)
                .and_then(|_| failure.map_or(Ok(()), Err));
            ActiveEnd {
                again: result.is_ok(),
                result,
                report,
            }
        }
        End::Stop(original) => ActiveEnd {
            again: false,
            result: complete.map(|_| ()).and(Err(original)),
            report,
        },
    }
}

/// A trusted native factory owns device selection and journal placement.
/// Opening/preflight must not mutate the device. Neither paths nor qualified
/// serials come from protocol messages. The journal must retain any native
/// directory guards for its complete lifetime.
pub trait DeviceFactory {
    type Transport: Transport;
    fn open_selected(&mut self, model_id: &str, profile: u8) -> Result<(Model, Self::Transport)>;
    fn journal(&mut self, model: &Model, connection: &Connection) -> Result<JournalStore>;
    fn open_for_recovery(
        &mut self,
        model_id: &str,
        profile: u8,
        _: bool,
    ) -> Result<(Model, Self::Transport, String)> {
        let (model, transport) = self.open_selected(model_id, profile)?;
        let lighting = crate::output::Lighting::open(transport, model.clone())?;
        let version = lighting.binding().firmware_version.clone();
        if lighting.binding().lighting_profile != profile {
            return Err(error("SESSION_CHANGED", "物理档位已改变"));
        }
        Ok((model, lighting.into_transport(), version))
    }
    fn existing_journal(&mut self, _: &Model, _: &Connection) -> Result<Option<JournalStore>> {
        Err(error("RECOVERY_UNAVAILABLE", "原生工厂未提供已有记录检查"))
    }
}
struct DirectoryFactory<'a, F> {
    open: F,
    directory: &'a Path,
}
impl<T: Transport, F: FnMut() -> Result<(Model, T)>> DeviceFactory for DirectoryFactory<'_, F> {
    type Transport = T;
    fn open_selected(&mut self, _: &str, _: u8) -> Result<(Model, T)> {
        (self.open)()
    }
    fn journal(&mut self, model: &Model, _: &Connection) -> Result<JournalStore> {
        JournalStore::open(self.directory, model)
    }
    fn existing_journal(&mut self, model: &Model, _: &Connection) -> Result<Option<JournalStore>> {
        if !self
            .directory
            .try_exists()
            .map_err(|_| error("BACKUP_PATH_INVALID", "无法检查已有目录"))?
        {
            return Ok(None);
        }
        JournalStore::open_existing(self.directory, model).map(Some)
    }
}
struct RecoveryCheck {
    model: Model,
    profile: u8,
    serial: String,
    firmware: String,
    observed: Option<RecoveryObservation>,
}
fn recovery_serial(model: &Model, selected: &str, connection: &Connection) -> Result<String> {
    if model.id != selected
        || connection.vendor_id != model.vendor_id
        || !model.product_ids.contains(&connection.product_id)
    {
        return Err(error("CONTROLLER_DEVICE_MISMATCH", "实际键盘与选择不一致"));
    }
    connection
        .serial
        .clone()
        .filter(|s| !s.trim().is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        .ok_or_else(|| {
            error(
                "RECOVERY_IDENTITY_UNVERIFIED",
                "恢复需要已核对的稳定唯一身份",
            )
        })
}
/// Run with a native factory that supplies a guarded journal after selection.
/// A handshake alone never opens either the device or the journal directory.
pub fn run_with_factory<F, R, W>(factory: F, reader: R, writer: W, backend: Backend) -> Result<()>
where
    F: DeviceFactory,
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    run_factory_with_signal(
        factory,
        reader,
        writer,
        backend,
        Arc::new(Signal::new(Options::default())),
    )
}
/// The caller supplies the trusted existing journal directory and a factory
/// which opens one verified control interface. Neither comes from a command.
/// Input parsing/heartbeats run independently; all device I/O has one owner.
pub fn run<T, F, R, W>(
    open: F,
    directory: &Path,
    reader: R,
    writer: W,
    backend: Backend,
) -> Result<()>
where
    T: Transport,
    F: FnMut() -> Result<(Model, T)>,
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    run_with_options(open, directory, reader, writer, backend, Options::default())
}
fn run_with_options<T, F, R, W>(
    open: F,
    directory: &Path,
    reader: R,
    writer: W,
    backend: Backend,
    options: Options,
) -> Result<()>
where
    T: Transport,
    F: FnMut() -> Result<(Model, T)>,
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    run_with_signal(
        open,
        directory,
        reader,
        writer,
        backend,
        Arc::new(Signal::new(options)),
    )
}
fn run_with_signal<T, F, R, W>(
    open: F,
    directory: &Path,
    reader: R,
    writer: W,
    backend: Backend,
    signal: Arc<Signal>,
) -> Result<()>
where
    T: Transport,
    F: FnMut() -> Result<(Model, T)>,
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    run_factory_with_signal(
        DirectoryFactory { open, directory },
        reader,
        writer,
        backend,
        signal,
    )
}
fn run_factory_with_signal<F, R, W>(
    mut factory: F,
    reader: R,
    writer: W,
    backend: Backend,
    signal: Arc<Signal>,
) -> Result<()>
where
    F: DeviceFactory,
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    let options = signal.options.clone();
    let sink = Sink::new(writer, Arc::clone(&signal));
    let (sender, receiver) = mpsc::sync_channel(options.pending);
    input(reader, sender, sink.clone());
    let mut report = Report::clean();
    let mut lease = 0;
    let mut recovery_check: Option<RecoveryCheck> = None;
    let outcome = (|| -> Result<()> {
        loop {
            let request = next(&receiver, &signal)?;
            match request.action {
                Action::Hello => {
                    let c = contract();
                    let session = sink
                        .output
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .session
                        .clone();
                    sink.reply(request.id, Ok(json!({"profile":c.profile,"protocolVersion":c.protocol_version,
                        "implementation":c.implementation,"implementationVersion":env!("CARGO_PKG_VERSION"),
                        "sessionId":session,"backend":backend.name(),"readOnly":false,
                        "maxLineBytes":c.max_line_bytes,"capabilities":c.capabilities})))?;
                }
                Action::RecoveryStatus { model_id, profile } => {
                    let result = (|| -> Result<Value> {
                        let (model, transport, firmware) =
                            factory.open_for_recovery(&model_id, profile, false)?;
                        let serial = recovery_serial(&model, &model_id, &transport.connection())?;
                        signal.check()?;
                        let previously_clean = report.restored;
                        report = Report::unknown();
                        let store = factory.existing_journal(&model, &transport.connection())?;
                        let observed = store
                            .as_ref()
                            .map(|s| {
                                s.require_model(&model)?;
                                s.observe_recovery()
                            })
                            .transpose()?;
                        let pending =
                            observed
                                .as_ref()
                                .map(|o| o.status.clone())
                                .unwrap_or(RecoveryStatus {
                                    lighting_profiles: vec![],
                                    board_sleep: false,
                                    keymap_profiles: vec![],
                                });
                        if !pending.has_pending() && previously_clean {
                            report = Report::clean();
                        }
                        let can_restore =
                            crate::lighting_policy::qualified(&model, &firmware).is_ok();
                        let value = json!({"modelId":model.id,"firmwareVersion":firmware,"lightingProfile":profile,"pending":pending,"canRestore":can_restore,"noMutation":true});
                        recovery_check = Some(RecoveryCheck {
                            model,
                            profile,
                            serial,
                            firmware,
                            observed,
                        });
                        Ok(value)
                    })();
                    sink.reply(request.id, result)?;
                }
                Action::RecoverExisting { model_id, profile } => {
                    let result = (|| -> Result<Value> {
                        let checked = recovery_check.take().ok_or_else(|| {
                            error("RECOVERY_CHECK_REQUIRED", "请先检查本次连接的待恢复记录")
                        })?;
                        if checked.model.id != model_id || checked.profile != profile {
                            return Err(error(
                                "RECOVERY_STATUS_CHANGED",
                                "所选键盘或档位已改变，请重新检查",
                            ));
                        }
                        let observed = checked
                            .observed
                            .ok_or_else(|| error("RECOVERY_NOT_REQUIRED", "未发现待恢复记录"))?;
                        if !observed.status.has_pending() {
                            return Err(error("RECOVERY_NOT_REQUIRED", "未发现待恢复记录"));
                        }
                        let (model, transport, firmware) =
                            factory.open_for_recovery(&model_id, profile, true)?;
                        if model != checked.model
                            || firmware != checked.firmware
                            || recovery_serial(&model, &model_id, &transport.connection())?
                                != checked.serial
                        {
                            return Err(error(
                                "RECOVERY_STATUS_CHANGED",
                                "键盘身份、固件或档位已改变，未执行恢复",
                            ));
                        }
                        signal.check()?;
                        let mut store = factory
                            .existing_journal(&model, &transport.connection())?
                            .ok_or_else(|| {
                                error(
                                    "RECOVERY_STATUS_CHANGED",
                                    "原记录已不在，请保留现场并重新检查",
                                )
                            })?;
                        store.require_model(&model)?;
                        store.require_observation(&observed)?;
                        signal.check()?;
                        report = Report::unknown();
                        let budget = Arc::new(Budget::new(&signal));
                        let mut transport = Guarded {
                            inner: transport,
                            signal: Arc::clone(&signal),
                            recovering: false,
                            budget,
                        };
                        transport.begin_recovery();
                        let recovered =
                            crate::output::recover_existing(transport, model, &mut store, profile)?;
                        if recovered.complete {
                            report = Report {
                                restored: true,
                                no_mutation: false,
                            };
                        }
                        let value = serde_json::to_value(recovered)
                            .map_err(|_| error("CONTROLLER_RESULT_INVALID", "恢复结果无法编码"))?;
                        Ok(value)
                    })();
                    sink.reply(request.id, result)?;
                }
                Action::Arm {
                    model_id,
                    profile,
                    kind,
                } => {
                    recovery_check = None;
                    // Failed preflight can leave an original on disk even
                    // when no RGB packet was sent. Never claim clean recovery.
                    signal.check()?;
                    let budget = Arc::new(Budget::new(&signal));
                    let (model, transport) =
                        factory.open_selected(&model_id, profile).inspect_err(|e| {
                            let _ = sink.reply(request.id, Err(e.clone()));
                        })?;
                    signal.check()?;
                    if model.id != model_id {
                        let e = error(
                            "CONTROLLER_DEVICE_MISMATCH",
                            "实际控制接口不属于所选键盘，未接管",
                        );
                        sink.reply(request.id, Err(e.clone()))?;
                        return Err(e);
                    }
                    if kind == ArmKind::Native && model.id != "kick75" {
                        let e = error("NATIVE_LIGHTING_UNSUPPORTED", "此型号尚未开放内置灯效事务");
                        sink.reply(request.id, Err(e.clone()))?;
                        return Err(e);
                    }
                    report = Report::unknown();
                    let mut store = factory
                        .journal(&model, &transport.connection())
                        .inspect_err(|e| {
                            let _ = sink.reply(request.id, Err(e.clone()));
                        })?;
                    store.require_model(&model).inspect_err(|e| {
                        let _ = sink.reply(request.id, Err(e.clone()));
                    })?;
                    let transport = Guarded {
                        inner: transport,
                        signal: Arc::clone(&signal),
                        recovering: false,
                        budget: Arc::clone(&budget),
                    };
                    let mut session = match Session::start_kind(
                        transport,
                        model,
                        &mut store,
                        Some(profile),
                        kind,
                        |completion| {
                            report = completion
                                .as_ref()
                                .map(Report::from_completion)
                                .unwrap_or_else(|_| Report::unknown());
                        },
                    ) {
                        Ok(session) => session,
                        Err(e) => {
                            let _ = sink.reply(request.id, Err(e.clone()));
                            return Err(e);
                        }
                    };
                    lease += 1;
                    let ended = active(&mut session, &receiver, &sink, lease, request.id, &budget);
                    report = ended.report;
                    ended.result?;
                    if !ended.again {
                        break;
                    }
                }
                _ => sink.reply(request.id, Err(error("NOT_ARMED", "请先开启本次灯光事务")))?,
            }
        }
        Ok(())
    })();
    let cause = signal.cause();
    let mut outcome = match &cause {
        Some(cause)
            if cause.graceful()
                && report.restored
                && outcome
                    .as_ref()
                    .err()
                    .is_some_and(|error| error.code == cause.error.code) =>
        {
            Ok(())
        }
        _ => outcome,
    };
    if let Some(id) = cause.as_ref().and_then(|v| v.quit) {
        let reply = if report.restored {
            Ok(json!({"quitting":true,"lightingRestored":true,"noMutation":report.no_mutation}))
        } else {
            Err(error("RESTORE_REQUIRED", "退出前恢复未完成，原记录已保留"))
        };
        if let Err(e) = sink.reply(id, reply) {
            outcome = Err(e);
        }
    }
    let reason = outcome
        .as_ref()
        .err()
        .map(|e| e.code.as_str())
        .or_else(|| cause.as_ref().map(|v| v.error.code.as_str()));
    let shutdown = sink.shutdown(&report, reason);
    let drained = sink.finish();
    // Tell an input thread still blocked in read that no more commands can be
    // accepted if it wakes. The process entry point need not join that read.
    signal.stop(error("CONTROLLER_CLOSED", "灯光控制进程已经结束"), None);
    shutdown?;
    drained?;
    outcome
}

#[cfg(test)]
mod tests;
