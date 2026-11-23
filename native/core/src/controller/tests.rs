use super::*;
use crate::output::tests::{directory, model, Board};
use std::{
    fs::{self, File},
    io::{self, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Condvar,
    },
    thread::{self, JoinHandle},
};
const SESSION: &str = "12345678-1234-1234-1234-123456789abc";
fn request(id: u64, op: &str) -> Value {
    let mut value = json!({"id":id,"op":op,"sessionId":SESSION});
    if op == "arm" {
        value["modelId"] = model().id.into();
        value["lightingProfile"] = 1.into();
    }
    value
}
fn hello() -> Value {
    let mut value = request(1, "hello");
    value["protocolVersion"] = contract().protocol_version.into();
    value
}
fn paint(id: u64, lease: u64, color: u8) -> Value {
    static COUNT: OnceLock<usize> = OnceLock::new();
    let mut value = request(id, "paint");
    value["leaseId"] = lease.into();
    value["colors"] = json!(vec![color; *COUNT.get_or_init(|| model().key_count * 3)]);
    value["verify"] = false.into();
    value
}
fn restore(id: u64, lease: u64) -> Value {
    let mut value = request(id, "restore");
    value["leaseId"] = lease.into();
    value
}
fn options() -> Options {
    Options {
        handshake: Duration::from_secs(2),
        heartbeat: Duration::from_secs(3),
        frame_age: Duration::from_millis(500),
        pending: 8,
        shutdown: Duration::from_millis(150),
    }
}
fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if predicate() {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("controller condition did not complete");
}

struct Inbox {
    receiver: mpsc::Receiver<Vec<u8>>,
    pending: std::io::Cursor<Vec<u8>>,
}
impl Read for Inbox {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.pending.position() as usize == self.pending.get_ref().len() {
            match self.receiver.recv() {
                Ok(bytes) => self.pending = std::io::Cursor::new(bytes),
                Err(_) => return Ok(0),
            }
        }
        self.pending.read(buffer)
    }
}
#[derive(Default)]
struct Written {
    bytes: Vec<u8>,
    packets: usize,
    block_after: Option<usize>,
    fail_after: Option<usize>,
    release: bool,
}
type SharedWritten = Arc<(Mutex<Written>, Condvar)>;
#[derive(Clone)]
struct Writer(SharedWritten);
impl Write for Writer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let (lock, wake) = &*self.0;
        let mut written = lock.lock().unwrap();
        if written.fail_after.is_some_and(|n| written.packets >= n) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "simulated closed reply pipe",
            ));
        }
        while written.block_after.is_some_and(|n| written.packets >= n) && !written.release {
            written = wake.wait(written).unwrap();
        }
        written.bytes.extend_from_slice(bytes);
        written.packets += 1;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[derive(Default)]
struct Observed {
    frames: Vec<Vec<u8>>,
    state: Vec<u8>,
    rgb: Vec<u8>,
    original: Vec<u8>,
    original_rgb: Vec<u8>,
    sleep: [u8; 4],
    original_sleep: [u8; 4],
}
#[derive(Clone, Default)]
struct Faults {
    gate: Option<Arc<(Mutex<bool>, Condvar)>>,
    fail_restore: bool,
    output_block_after: Option<usize>,
    output_fail_after: Option<usize>,
    fail_takeover: bool,
}
struct ObservedBoard {
    board: Board,
    observed: Arc<Mutex<Observed>>,
    faults: Faults,
    painted: bool,
    artifact: Option<std::path::PathBuf>,
}
impl ObservedBoard {
    fn new(
        observed: Arc<Mutex<Observed>>,
        faults: Faults,
        artifact: Option<std::path::PathBuf>,
    ) -> Self {
        let mut board = Board::new(&model());
        if faults.fail_takeover {
            board.fail_command = Some(0xd6);
        }
        {
            let mut data = observed.lock().unwrap();
            data.original = board.state.clone();
            data.original_rgb = board.rgb();
            data.original_sleep = board.sleep;
        }
        Self {
            board,
            observed,
            faults,
            painted: false,
            artifact,
        }
    }
    fn observe(&self) {
        let mut data = self.observed.lock().unwrap();
        data.state = self.board.state.clone();
        data.rgb = self.board.rgb();
        data.sleep = self.board.sleep;
    }
}
impl Drop for ObservedBoard {
    fn drop(&mut self) {
        self.observe();
        if let Some(path) = &self.artifact {
            let data = self.observed.lock().unwrap();
            fs::write(
                path,
                serde_json::to_vec(&json!({
                    "state":data.state,"rgb":data.rgb,"original":data.original,
                    "originalRgb":data.original_rgb,"frames":data.frames,"sleep":data.sleep,"originalSleep":data.original_sleep,
                }))
                .unwrap(),
            )
            .unwrap();
        }
    }
}
impl Transport for ObservedBoard {
    fn connection(&self) -> Connection {
        self.board.connection()
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.board.pause(delay)
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        self.observed.lock().unwrap().frames.push(frame.to_vec());
        if frame[1] == 0xd6 && self.painted && self.faults.fail_restore {
            return Err(error("RESTORE_TEST_FAILURE", "模拟恢复设置写入失败"));
        }
        let result = self.board.exchange(frame, timeout);
        self.observe();
        if frame[1] == 0xd8 && !self.painted {
            self.painted = true;
            if let Some(gate) = &self.faults.gate {
                let mut released = gate.0.lock().unwrap();
                while !*released {
                    released = gate.1.wait(released).unwrap();
                }
            }
        }
        result
    }
}
struct Harness {
    sender: Option<mpsc::Sender<Vec<u8>>>,
    output: SharedWritten,
    observed: Arc<Mutex<Observed>>,
    opens: Arc<AtomicUsize>,
    signal: Arc<Signal>,
    clock: Arc<AtomicU64>,
    gate: Option<Arc<(Mutex<bool>, Condvar)>>,
    worker: Option<JoinHandle<Result<()>>>,
    _tmp: tempfile::TempDir,
    directory: std::path::PathBuf,
}
impl Harness {
    fn start(options: Options, faults: Faults) -> Self {
        let (tmp, directory) = directory();
        let (sender, receiver) = mpsc::channel();
        let output = Arc::new((
            Mutex::new(Written {
                block_after: faults.output_block_after,
                fail_after: faults.output_fail_after,
                ..Written::default()
            }),
            Condvar::new(),
        ));
        let observed = Arc::new(Mutex::new(Observed::default()));
        let opens = Arc::new(AtomicUsize::new(0));
        let clock = Arc::new(AtomicU64::new(0));
        let start = Instant::now();
        let source = Arc::clone(&clock);
        let signal = Arc::new(Signal::with_clock(
            options,
            Arc::new(move || start + Duration::from_millis(source.load(Ordering::SeqCst))),
        ));
        let gate = faults.gate.clone();
        let worker = {
            let output = Arc::clone(&output);
            let observed = Arc::clone(&observed);
            let opens = Arc::clone(&opens);
            let directory = directory.clone();
            let signal = Arc::clone(&signal);
            thread::spawn(move || {
                run_with_signal(
                    || {
                        opens.fetch_add(1, Ordering::SeqCst);
                        Ok((
                            model(),
                            ObservedBoard::new(Arc::clone(&observed), faults.clone(), None),
                        ))
                    },
                    &directory,
                    Inbox {
                        receiver,
                        pending: std::io::Cursor::new(vec![]),
                    },
                    Writer(output),
                    Backend::Simulated,
                    signal,
                )
            })
        };
        Self {
            sender: Some(sender),
            output,
            observed,
            opens,
            signal,
            clock,
            gate,
            worker: Some(worker),
            _tmp: tmp,
            directory,
        }
    }
    fn advance(&self, millis: u64) {
        self.clock.fetch_add(millis, Ordering::SeqCst);
    }
    fn accepted(&self, count: u64) {
        until(|| self.signal.health.lock().unwrap().received >= count);
    }
    fn release(&self) {
        if let Some(gate) = &self.gate {
            *gate.0.lock().unwrap() = true;
            gate.1.notify_all();
        }
    }
    fn send(&self, value: Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        self.sender.as_ref().unwrap().send(bytes).unwrap();
    }
    fn messages(&self) -> Vec<Value> {
        self.output
            .0
            .lock()
            .unwrap()
            .bytes
            .split(|&b| b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }
    fn reply(&self, id: u64) -> Value {
        until(|| self.messages().iter().any(|v| v["id"] == id));
        self.messages().into_iter().find(|v| v["id"] == id).unwrap()
    }
    fn arm(&self) -> u64 {
        self.send(hello());
        assert_eq!(self.reply(1)["result"]["backend"], "simulated");
        self.send(request(2, "arm"));
        let reply = self.reply(2);
        assert_eq!(reply["ok"], true, "{reply}");
        reply["result"]["leaseId"].as_u64().unwrap()
    }
    fn join(&mut self) -> Result<()> {
        until(|| self.worker.as_ref().unwrap().is_finished());
        self.worker.take().unwrap().join().unwrap()
    }
    fn restored(&self) {
        let observed = self.observed.lock().unwrap();
        assert_eq!(observed.state, observed.original);
        assert_eq!(observed.rgb, observed.original_rgb);
        assert_eq!(observed.sleep, observed.original_sleep);
        assert!(!self.directory.join("board-sleep.json").exists());
        assert!(!self.directory.join("profile-1.json").exists());
        assert!(!self.directory.join("profile-1.completed.json").exists());
        assert!(self
            .messages()
            .iter()
            .any(|v| v["event"] == "shutdownComplete"
                && v["lightingRestored"] == true
                && v["recoveryPending"] == false));
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.sender.take();
        self.release();
        let (lock, wake) = &*self.output;
        lock.lock().unwrap().release = true;
        wake.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn painted_frames(data: &Observed, color: u8) -> usize {
    data.frames
        .iter()
        .filter(|frame| {
            frame[1] == 0xd8
                && frame[8..8 + usize::from(frame[4] ^ 0x80)]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .all(|record| record[1..].iter().all(|&b| b ^ 0x80 == color))
        })
        .count()
}

#[test]
fn strict_protocol_rejects_replay_headers_shapes_and_foreign_sessions_before_open() {
    let mut protocol = Protocol::default();
    assert!(protocol.accept(request(1, "arm")).is_err());
    protocol
        .accept({
            let mut h = hello();
            h["id"] = 2.into();
            h
        })
        .unwrap();
    assert!(protocol.accept(request(2, "arm")).is_err());
    let mut extra = request(3, "arm");
    extra["directory"] = "another path".into();
    assert!(protocol.accept(extra).is_err());
    let mut foreign = request(4, "arm");
    foreign["sessionId"] = "87654321-1234-1234-1234-123456789abc".into();
    assert!(protocol.accept(foreign).is_err());
    let mut invalid = paint(5, 1, 55);
    invalid["verify"] = "yes".into();
    assert!(protocol.accept(invalid).is_err());
    let mut invalid = paint(6, 1, 55);
    invalid["colors"] = json!([-1, 256, 0]);
    assert!(protocol.accept(invalid).is_err());
    let mut invalid = request(7, "side");
    invalid["leaseId"] = 1.into();
    invalid["color"] = json!([1, 2, 3]);
    invalid["brightness"] = 101.into();
    assert!(protocol.accept(invalid).is_err());
    let mut h = Harness::start(options(), Faults::default());
    h.send(request(1, "arm"));
    assert!(h.join().is_err());
    assert_eq!(h.opens.load(Ordering::SeqCst), 0);
}

#[test]
fn native_protocol_requires_all_fields_and_an_eligible_model_before_journaling() {
    let mut p = Protocol::default();
    p.accept(hello()).unwrap();
    let native = json!({"id":2,"op":"nativeLighting","sessionId":SESSION,"leaseId":1,"mode":3,"brightness":60,"speed":2,"color":null});
    assert!(matches!(
        p.accept(native.clone()).unwrap().action,
        Action::NativeLighting { .. }
    ));
    let mut id = 3;
    for (field, value) in [
        ("mode", json!(0)),
        ("mode", json!(21)),
        ("brightness", json!(101)),
        ("speed", json!(5)),
        ("color", json!([1, 2])),
        ("path", json!("external")),
    ] {
        let mut value2 = native.clone();
        value2["id"] = id.into();
        id += 1;
        value2[field] = value;
        assert!(p.accept(value2).is_err());
    }
    let mut missing = native;
    missing["id"] = id.into();
    missing.as_object_mut().unwrap().remove("color");
    assert!(p.accept(missing).is_err());
    let mut h = Harness::start(options(), Faults::default());
    h.send(hello());
    assert_eq!(h.reply(1)["ok"], true);
    h.send(json!({"id":2,"op":"armNative","sessionId":SESSION,"modelId":model().id,"lightingProfile":1}));
    assert_eq!(h.reply(2)["error"]["code"], "NATIVE_LIGHTING_UNSUPPORTED");
    assert!(h.join().is_err());
    assert!(fs::read_dir(&h.directory).unwrap().next().is_none());
    assert!(h.observed.lock().unwrap().frames.is_empty());
}

#[test]
fn arm_selection_is_checked_before_baseline_capture_or_sleep_mutation() {
    for (field, value, expected) in [
        ("modelId", json!("kick75"), "CONTROLLER_DEVICE_MISMATCH"),
        ("lightingProfile", json!(0), "SESSION_CHANGED"),
    ] {
        let mut h = Harness::start(options(), Faults::default());
        h.send(hello());
        assert_eq!(h.reply(1)["ok"], true);
        let mut arm = request(2, "arm");
        arm[field] = value;
        h.send(arm);
        assert_eq!(h.reply(2)["error"]["code"], expected);
        assert_eq!(h.join().unwrap_err().code, expected);
        assert!(h
            .observed
            .lock()
            .unwrap()
            .frames
            .iter()
            .all(|f| !matches!(f[1], 0xd5 | 0xd6 | 0xd8 | 0xf3 | 0xf5)));
        assert!(!h.directory.join("profile-1.json").exists());
        assert!(!h.directory.join("board-sleep.json").exists());
    }
}

#[test]
fn clean_restore_opens_a_new_lease_without_accepting_frames_from_the_previous_one() {
    let mut h = Harness::start(options(), Faults::default());
    let first = h.arm();
    h.send(paint(3, first, 99));
    assert_eq!(h.reply(3)["ok"], true);
    let mut side = request(4, "side");
    side["leaseId"] = first.into();
    side["color"] = json!([42, 13, 57]);
    side["brightness"] = 75.into();
    h.send(side);
    assert_eq!(h.reply(4)["result"]["updated"], true);
    h.send(restore(5, first));
    assert_eq!(h.reply(5)["result"]["verified"], true);
    h.send(request(6, "arm"));
    let second = h.reply(6)["result"]["leaseId"].as_u64().unwrap();
    assert_ne!(first, second);
    h.send(paint(7, first, 100));
    assert_eq!(h.reply(7)["error"]["code"], "LIGHTING_LEASE_MISMATCH");
    h.send(paint(8, second, 101));
    assert_eq!(h.reply(8)["ok"], true);
    h.send(request(9, "quit"));
    assert_eq!(h.reply(9)["result"]["lightingRestored"], true);
    assert!(h.join().is_ok());
    h.restored();
    assert_eq!(h.opens.load(Ordering::SeqCst), 2);
}

#[test]
fn eof_or_quit_in_an_applied_frame_cancels_remaining_packets_and_restores_once() {
    for quit in [false, true] {
        let mut h = Harness::start(
            options(),
            Faults {
                gate: Some(Arc::new((Mutex::new(false), Condvar::new()))),
                ..Faults::default()
            },
        );
        let lease = h.arm();
        h.send(paint(3, lease, 99));
        until(|| painted_frames(&h.observed.lock().unwrap(), 99) > 0);
        if quit {
            h.send(request(4, "quit"));
        } else {
            h.sender.take();
        }
        until(|| h.signal.cause().is_some());
        h.release();
        assert!(h.join().is_ok());
        h.restored();
        assert_eq!(painted_frames(&h.observed.lock().unwrap(), 99), 1);
        if quit {
            assert_eq!(h.reply(4)["result"]["lightingRestored"], true);
        }
        assert_eq!(h.messages().last().unwrap()["event"], "shutdownComplete");
    }
}

#[test]
fn wake_blackout_keeps_heartbeats_and_priority_quit_or_eof_during_preparation() {
    for quit in [false, true] {
        let mut h = Harness::start(
            options(),
            Faults {
                gate: Some(Arc::new((Mutex::new(false), Condvar::new()))),
                ..Faults::default()
            },
        );
        h.send(hello());
        assert_eq!(h.reply(1)["ok"], true);
        h.send(json!({"id":2,"op":"armConnectionWake","sessionId":SESSION,"modelId":model().id,"lightingProfile":1}));
        until(|| painted_frames(&h.observed.lock().unwrap(), 0) > 0);
        assert!(!h.messages().iter().any(|v| v["id"] == 2)); // No ready lease before full blackout.
        h.send(request(3, "heartbeat"));
        assert_eq!(h.reply(3)["result"]["alive"], true);
        if quit {
            h.send(request(4, "quit"));
        } else {
            h.sender.take();
        }
        until(|| h.signal.cause().is_some());
        h.release();
        assert!(h.join().is_ok());
        h.restored();
        assert_eq!(painted_frames(&h.observed.lock().unwrap(), 0), 1);
        assert_eq!(h.reply(2)["ok"], false);
        if quit {
            assert_eq!(h.reply(4)["result"]["lightingRestored"], true);
        }
        assert_eq!(h.messages().last().unwrap()["event"], "shutdownComplete");
    }
}

#[test]
fn heartbeat_is_received_and_acknowledged_while_device_io_is_busy() {
    let mut limits = options();
    limits.heartbeat = Duration::from_millis(200);
    let mut h = Harness::start(
        limits,
        Faults {
            gate: Some(Arc::new((Mutex::new(false), Condvar::new()))),
            ..Faults::default()
        },
    );
    let lease = h.arm();
    h.send(paint(3, lease, 99));
    until(|| painted_frames(&h.observed.lock().unwrap(), 99) > 0);
    for id in 4..=7 {
        h.advance(60);
        h.send(request(id, "heartbeat"));
        assert_eq!(h.reply(id)["result"]["alive"], true);
    }
    assert!(!h.messages().iter().any(|v| v["id"] == 3));
    h.release();
    assert_eq!(h.reply(3)["ok"], true);
    h.send(request(8, "quit"));
    assert!(h.join().is_ok());
    h.restored();
}

#[test]
fn lost_heartbeat_and_input_queue_overflow_stop_output_and_restore() {
    for overflow in [false, true] {
        let mut limits = options();
        limits.heartbeat = Duration::from_millis(180);
        let mut h = Harness::start(
            limits,
            Faults {
                gate: overflow.then(|| Arc::new((Mutex::new(false), Condvar::new()))),
                ..Faults::default()
            },
        );
        let lease = h.arm();
        h.send(paint(3, lease, 99));
        if overflow {
            until(|| painted_frames(&h.observed.lock().unwrap(), 99) > 0);
            let flood = (4..25)
                .map(|id| format!("{}\n", paint(id, lease, 100)))
                .collect::<String>();
            h.sender.as_ref().unwrap().send(flood.into_bytes()).unwrap();
            until(|| h.signal.cause().is_some());
            h.release();
        } else {
            assert_eq!(h.reply(3)["ok"], true);
            h.advance(181);
        }
        assert!(h.join().is_err());
        h.restored();
        let events = h.messages();
        let final_event = events
            .iter()
            .find(|v| v["event"] == "shutdownComplete")
            .unwrap();
        assert_eq!(
            final_event["reasonCode"],
            if overflow {
                "CONTROLLER_QUEUE_FULL"
            } else {
                "CONTROLLER_HEARTBEAT_LOST"
            }
        );
        if overflow {
            assert_eq!(painted_frames(&h.observed.lock().unwrap(), 99), 1);
            assert_eq!(painted_frames(&h.observed.lock().unwrap(), 100), 0);
        }
    }
}

#[test]
fn operation_budget_stops_a_busy_frame_even_with_heartbeats_and_cleanup_gets_fresh_budgets() {
    let mut h = Harness::start(
        options(),
        Faults {
            gate: Some(Arc::new((Mutex::new(false), Condvar::new()))),
            ..Faults::default()
        },
    );
    let lease = h.arm();
    h.send(paint(3, lease, 99));
    until(|| painted_frames(&h.observed.lock().unwrap(), 99) > 0);
    for id in 4..=34 {
        h.advance(1000);
        h.send(request(id, "heartbeat"));
        assert_eq!(h.reply(id)["result"]["alive"], true);
    }
    assert!(h.signal.cause().is_none());
    h.release();
    assert!(h.join().is_err());
    h.restored();
    assert_eq!(painted_frames(&h.observed.lock().unwrap(), 99), 1);
    assert!(h
        .messages()
        .iter()
        .any(|v| v["event"] == "shutdownComplete"
            && v["reasonCode"] == "CONTROLLER_OPERATION_TIMEOUT"));
}

#[test]
fn expired_frames_are_rejected_without_replaying_them_or_ending_the_lease() {
    let mut limits = options();
    limits.frame_age = Duration::from_millis(30);
    let mut h = Harness::start(
        limits,
        Faults {
            gate: Some(Arc::new((Mutex::new(false), Condvar::new()))),
            ..Faults::default()
        },
    );
    let lease = h.arm();
    h.send(paint(3, lease, 99));
    until(|| painted_frames(&h.observed.lock().unwrap(), 99) > 0);
    h.send(paint(4, lease, 100));
    let mut side = request(5, "side");
    side["leaseId"] = lease.into();
    side["color"] = json!([10, 20, 30]);
    side["brightness"] = 42.into();
    h.send(side);
    h.accepted(5);
    h.advance(31);
    h.release();
    assert_eq!(h.reply(3)["ok"], true);
    assert_eq!(h.reply(4)["error"]["code"], "FRAME_EXPIRED");
    assert_eq!(h.reply(5)["error"]["code"], "FRAME_EXPIRED");
    h.send(paint(6, lease, 101));
    assert_eq!(h.reply(6)["ok"], true);
    h.send(request(7, "quit"));
    assert!(h.join().is_ok());
    h.restored();
    assert_eq!(painted_frames(&h.observed.lock().unwrap(), 100), 0);
}

#[test]
fn failed_restoration_keeps_the_original_and_supervision_never_retries_on_exit() {
    let mut h = Harness::start(
        options(),
        Faults {
            fail_restore: true,
            ..Faults::default()
        },
    );
    let lease = h.arm();
    h.send(paint(3, lease, 99));
    assert_eq!(h.reply(3)["ok"], true);
    let original = fs::read(h.directory.join("profile-1.json")).unwrap();
    h.send(request(4, "quit"));
    assert!(h.join().is_err());
    assert_eq!(
        fs::read(h.directory.join("profile-1.json")).unwrap(),
        original
    );
    let data = h.observed.lock().unwrap();
    assert_eq!(
        data.frames.iter().filter(|f| f[1] == 0xd6).count(),
        2,
        "one takeover, one failed restoration, no exit retry"
    );
    assert!(h.messages().iter().any(|v| v["event"] == "shutdownComplete"
        && v["recoveryPending"] == true
        && v["lightingRestored"] == false));
}

#[test]
fn blocked_reply_pipe_does_not_block_device_recovery_or_wait_indefinitely() {
    let mut limits = options();
    limits.heartbeat = Duration::from_millis(160);
    let mut h = Harness::start(
        limits,
        Faults {
            output_block_after: Some(2),
            ..Faults::default()
        },
    );
    let lease = h.arm();
    h.send(paint(3, lease, 99));
    h.accepted(3);
    until(|| painted_frames(&h.observed.lock().unwrap(), 99) > 0);
    h.advance(161);
    let started = Instant::now();
    assert!(h.join().is_err());
    assert!(started.elapsed() < Duration::from_secs(3));
    let data = h.observed.lock().unwrap();
    assert_eq!(data.state, data.original);
    assert_eq!(data.rgb, data.original_rgb);
    assert_eq!(data.sleep, data.original_sleep);
    assert!(!h.directory.join("profile-1.json").exists());
}

#[test]
fn handshake_timeout_does_not_open_a_device_and_a_late_heartbeat_cannot_revive_output() {
    let mut limits = options();
    limits.handshake = Duration::from_millis(80);
    let mut h = Harness::start(limits.clone(), Faults::default());
    h.advance(81);
    assert_eq!(h.join().unwrap_err().code, "CONTROLLER_HANDSHAKE_TIMEOUT");
    assert_eq!(h.opens.load(Ordering::SeqCst), 0);
    limits.heartbeat = Duration::from_millis(20);
    let clock = Arc::new(AtomicU64::new(0));
    let source = Arc::clone(&clock);
    let start = Instant::now();
    let signal = Signal::with_clock(
        limits,
        Arc::new(move || start + Duration::from_millis(source.load(Ordering::SeqCst))),
    );
    signal.touch(true);
    clock.fetch_add(25, Ordering::SeqCst);
    signal.touch(false);
    assert_eq!(
        signal.check().unwrap_err().code,
        "CONTROLLER_HEARTBEAT_LOST"
    );
}

#[test]
fn closed_reply_pipe_and_failed_takeover_report_the_actual_scoped_recovery() {
    for failed_takeover in [false, true] {
        let mut h = Harness::start(
            options(),
            Faults {
                fail_takeover: failed_takeover,
                output_fail_after: (!failed_takeover).then_some(2),
                ..Faults::default()
            },
        );
        if failed_takeover {
            h.send(hello());
            assert_eq!(h.reply(1)["ok"], true);
            h.send(request(2, "arm"));
            assert_eq!(h.reply(2)["error"]["code"], "HID_TIMEOUT");
            assert!(h.join().is_err());
            h.restored();
        } else {
            let lease = h.arm();
            h.send(paint(3, lease, 99));
            assert!(h.join().is_err());
            let data = h.observed.lock().unwrap();
            assert_eq!(data.state, data.original);
            assert_eq!(data.rgb, data.original_rgb);
            assert_eq!(data.sleep, data.original_sleep);
            assert!(!h.directory.join("profile-1.json").exists());
        }
    }
}

#[test]
fn malformed_truncated_oversized_or_invalid_utf8_input_restores_the_owned_session() {
    for bytes in [
        b"not-json\n".to_vec(),
        b"{\"id\":4".to_vec(),
        vec![b' '; crate::MAX_LINE + 1],
        vec![0xff, b'\n'],
    ] {
        let mut h = Harness::start(options(), Faults::default());
        let lease = h.arm();
        h.send(paint(3, lease, 99));
        assert_eq!(h.reply(3)["ok"], true);
        h.sender.as_ref().unwrap().send(bytes).unwrap();
        h.sender.take();
        assert!(h.join().is_err());
        h.restored();
    }
}

#[test]
fn existing_original_blocks_a_new_takeover_and_is_never_overwritten() {
    let mut h = Harness::start(options(), Faults::default());
    let baseline = crate::output::Lighting::open(Board::new(&model()), model())
        .unwrap()
        .capture_baseline()
        .unwrap();
    let mut store = JournalStore::open(&h.directory, &model()).unwrap();
    let tx = store.begin(baseline).unwrap();
    drop(tx);
    drop(store);
    let original = fs::read(h.directory.join("profile-1.json")).unwrap();
    h.send(hello());
    assert_eq!(h.reply(1)["ok"], true);
    h.send(request(2, "arm"));
    assert_eq!(h.reply(2)["error"]["code"], "RECOVERY_REQUIRED");
    assert!(h.join().is_err());
    assert_eq!(
        fs::read(h.directory.join("profile-1.json")).unwrap(),
        original
    );
    assert!(!h
        .observed
        .lock()
        .unwrap()
        .frames
        .iter()
        .any(|f| matches!(f[1], 0xd6 | 0xd8)));
    assert!(h
        .messages()
        .iter()
        .any(|v| v["event"] == "shutdownComplete" && v["recoveryPending"] == true));
}

fn file_messages(path: &Path) -> Vec<Value> {
    fs::read(path)
        .unwrap_or_default()
        .split(|&b| b == b'\n')
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect()
}
fn child(dir: &Path, mode: &str) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "controller::tests::process_entry",
            "--ignored",
            "--nocapture",
        ])
        .env("NUPHYLAB_CONTROLLER_TEST_DIRECTORY", dir)
        .env("NUPHYLAB_CONTROLLER_TEST_MODE", mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}
fn child_send(child: &mut Child, value: Value) {
    let input = child.stdin.as_mut().unwrap();
    writeln!(input, "{value}").unwrap();
    input.flush().unwrap();
}
fn child_reply(child: &mut Child, output: &Path, id: u64, next_id: &mut u64) -> Value {
    let mut heartbeat = Instant::now();
    until(|| {
        if file_messages(output).iter().any(|v| v["id"] == id) {
            return true;
        }
        if heartbeat.elapsed() >= Duration::from_millis(150) {
            child_send(child, request(*next_id, "heartbeat"));
            *next_id += 1;
            heartbeat = Instant::now();
        }
        false
    });
    let reply = file_messages(output)
        .into_iter()
        .find(|v| v["id"] == id)
        .unwrap();
    assert_eq!(reply["ok"], true, "{reply}");
    reply
}
#[test]
fn process_eof_and_missing_heartbeat_restore_but_forced_native_exit_retains_the_journal() {
    for mode in ["eof", "heartbeat", "kill"] {
        let (_tmp, dir) = directory();
        let mut child = child(&dir, mode);
        let output = dir.join("process-replies.jsonl");
        child_send(&mut child, hello());
        until(|| file_messages(&output).iter().any(|v| v["id"] == 1));
        child_send(&mut child, request(2, "arm"));
        let mut next_id = 3;
        let lease = child_reply(&mut child, &output, 2, &mut next_id)["result"]["leaseId"]
            .as_u64()
            .unwrap();
        let paint_id = next_id;
        next_id += 1;
        child_send(&mut child, paint(paint_id, lease, 99));
        child_reply(&mut child, &output, paint_id, &mut next_id);
        let original = fs::read(dir.join("profile-1.json")).unwrap();
        if mode == "kill" {
            child.kill().unwrap();
        } else if mode == "eof" {
            child.stdin.take();
        }
        until(|| child.try_wait().unwrap().is_some());
        let status = child.wait().unwrap();
        if mode == "kill" {
            assert!(!status.success());
            assert_eq!(fs::read(dir.join("profile-1.json")).unwrap(), original);
            let mut store = JournalStore::open(&dir, &model()).unwrap();
            assert_eq!(
                store
                    .begin(
                        crate::output::Lighting::open(Board::new(&model()), model())
                            .unwrap()
                            .capture_baseline()
                            .unwrap()
                    )
                    .err()
                    .unwrap()
                    .code,
                "SLEEP_RECOVERY_REQUIRED"
            );
        } else {
            assert!(status.success());
            assert!(!dir.join("profile-1.json").exists());
            assert!(file_messages(&output)
                .iter()
                .any(|v| v["event"] == "shutdownComplete" && v["lightingRestored"] == true));
            let data: Value =
                serde_json::from_slice(&fs::read(dir.join("process-board.json")).unwrap()).unwrap();
            assert_eq!(data["state"], data["original"]);
            assert_eq!(data["rgb"], data["originalRgb"]);
            assert_eq!(data["sleep"], data["originalSleep"]);
        }
    }
}

#[test]
#[ignore = "isolated pipe worker invoked by the parent process test"]
fn process_entry() {
    let Some(dir) = std::env::var_os("NUPHYLAB_CONTROLLER_TEST_DIRECTORY") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let mode = std::env::var("NUPHYLAB_CONTROLLER_TEST_MODE").unwrap();
    let observed = Arc::new(Mutex::new(Observed::default()));
    let mut limits = options();
    limits.heartbeat = Duration::from_millis(600);
    let result = run_with_options(
        || {
            Ok((
                model(),
                ObservedBoard::new(
                    Arc::clone(&observed),
                    Faults::default(),
                    Some(dir.join("process-board.json")),
                ),
            ))
        },
        &dir,
        io::stdin(),
        File::create(dir.join("process-replies.jsonl")).unwrap(),
        Backend::Simulated,
        limits,
    );
    if mode == "heartbeat" {
        assert_eq!(result.unwrap_err().code, "CONTROLLER_HEARTBEAT_LOST");
    } else {
        result.unwrap();
    }
}

#[test]
fn cancellation_during_device_open_never_obtains_a_journal_or_starts_a_session() {
    let (_temporary, directory) = directory();
    let (sender, receiver) = mpsc::channel();
    for value in [hello(), request(2, "arm")] {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        sender.send(bytes).unwrap();
    }
    let signal = Arc::new(Signal::new(options()));
    let cancelled = Arc::clone(&signal);
    let output = Arc::new((Mutex::new(Written::default()), Condvar::new()));
    let mut opened = false;
    run_with_signal(
        || {
            opened = true;
            // Deterministically model an input EOF accepted while native
            // discovery/preflight is returning its still read-only handle.
            cancelled.stop(
                error("CONTROLLER_INPUT_CLOSED", "test EOF during open"),
                None,
            );
            Ok((model(), Board::new(&model())))
        },
        &directory,
        Inbox {
            receiver,
            pending: std::io::Cursor::new(vec![]),
        },
        Writer(Arc::clone(&output)),
        Backend::Simulated,
        signal,
    )
    .unwrap();
    assert!(opened);
    assert_eq!(fs::read_dir(directory).unwrap().count(), 0);
    let messages: Vec<Value> = output
        .0
        .lock()
        .unwrap()
        .bytes
        .split(|&b| b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    assert_eq!(messages.last().unwrap()["noMutation"], true);
    drop(sender);
}
