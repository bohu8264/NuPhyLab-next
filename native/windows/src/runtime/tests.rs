use super::*;
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Cursor},
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
#[allow(dead_code)]
#[path = "../../../core/test-support/lighting_board.rs"]
mod board;
const SESSION: &str = "87654321-4321-4321-4321-cba987654321";

#[derive(Clone)]
struct Observed(Arc<Mutex<board::Board>>);
impl Transport for Observed {
    fn connection(&self) -> Connection {
        self.0.lock().unwrap().connection()
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        self.0.lock().unwrap().exchange(frame, timeout)
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.0.lock().unwrap().pause(delay)
    }
}
fn observed(model: &Model) -> Observed {
    Observed(Arc::new(Mutex::new(board::Board::new(model))))
}
fn identity_only(board: &Observed) {
    assert!(board
        .0
        .lock()
        .unwrap()
        .calls
        .iter()
        .all(|f| [0xa1, 0xa0, 0xd1].contains(&f[1])));
}
fn file_bytes(directory: &Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
    let mut files = std::collections::BTreeMap::new();
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(file_bytes(&path));
        } else {
            files.insert(path.clone(), fs::read(path).unwrap());
        }
    }
    files
}
fn store(directory: &Path, model: &Model, connection: &Connection) -> Result<JournalStore> {
    #[cfg(windows)]
    {
        crate::storage::RecoveryRoot::open_test_root(directory)?
            .device(model, connection)?
            .journal_store()
    }
    #[cfg(not(windows))]
    {
        let _ = connection;
        JournalStore::open(directory, model)
    }
}
struct Input {
    receiver: mpsc::Receiver<Vec<u8>>,
    bytes: Cursor<Vec<u8>>,
}
impl Read for Input {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.bytes.position() as usize == self.bytes.get_ref().len() {
            match self.receiver.recv() {
                Ok(bytes) => self.bytes = Cursor::new(bytes),
                Err(_) => return Ok(0),
            }
        }
        self.bytes.read(out)
    }
}
struct Output(mpsc::Sender<Value>);
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let value = serde_json::from_slice(bytes).map_err(io::Error::other)?;
        self.0.send(value).map_err(io::Error::other)?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct Worker {
    input: Option<mpsc::Sender<Vec<u8>>>,
    output: mpsc::Receiver<Value>,
    thread: Option<JoinHandle<Result<()>>>,
}
impl Worker {
    fn new<F: DeviceFactory + Send + 'static>(factory: F) -> Self {
        let (input, receiver) = mpsc::channel();
        let (writer, output) = mpsc::channel();
        let thread = thread::spawn(move || {
            controller::run_with_factory(
                factory,
                Input {
                    receiver,
                    bytes: Cursor::new(vec![]),
                },
                Output(writer),
                Backend::Simulated,
            )
        });
        Self {
            input: Some(input),
            output,
            thread: Some(thread),
        }
    }
    fn request(&self, id: u64, op: &str, fields: Value) -> Value {
        let mut request = json!({"id":id,"op":op,"sessionId":SESSION});
        request
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        self.input.as_ref().unwrap().send(bytes).unwrap();
        let reply = self.output.recv_timeout(Duration::from_secs(8)).unwrap();
        assert_eq!(reply["id"], id, "{reply}");
        reply
    }
    fn hello(&self) {
        assert_eq!(
            self.request(
                1,
                "hello",
                json!({"protocolVersion":controller::contract().protocol_version})
            )["ok"],
            true
        );
    }
    fn shutdown(&mut self, success: bool) -> Value {
        let event = self.output.recv_timeout(Duration::from_secs(8)).unwrap();
        assert_eq!(event["event"], "shutdownComplete");
        assert_eq!(self.thread.take().unwrap().join().unwrap().is_ok(), success);
        event
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.input.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
#[test]
fn all_qualified_models_and_profiles_preflight_with_identity_reads_only() {
    for model in board::fixture().models {
        for profile in [0, 1] {
            let board = observed(&model);
            board.0.lock().unwrap().profile = profile;
            let (_, returned, firmware) =
                qualify(model.clone(), board.clone(), &model.id, profile).unwrap();
            assert_eq!(firmware, model.qualified_firmware);
            assert_eq!(returned.connection(), board.connection());
            assert_eq!(board.0.lock().unwrap().calls.len(), 3);
            identity_only(&board);
        }
    }
}
#[test]
fn mismatched_selection_firmware_and_unqualified_identity_never_reach_a_journal() {
    for fault in [
        "model",
        "profile",
        "firmware",
        "missing-serial",
        "blank-serial",
        "control-serial",
        "oversized-serial",
    ] {
        let model = board::model();
        let board = observed(&model);
        let selected = if fault == "model" {
            "kick75"
        } else {
            &model.id
        };
        match fault {
            "profile" => board.0.lock().unwrap().profile = 0,
            "firmware" => board.0.lock().unwrap().firmware[0] ^= 1,
            "missing-serial" => board.0.lock().unwrap().connection.serial = None,
            "blank-serial" => board.0.lock().unwrap().connection.serial = Some("  ".into()),
            "control-serial" => board.0.lock().unwrap().connection.serial = Some("serial\0".into()),
            "oversized-serial" => board.0.lock().unwrap().connection.serial = Some("a".repeat(257)),
            _ => {}
        }
        let count = Arc::new(AtomicUsize::new(0));
        let journals = Arc::clone(&count);
        let source = board.clone();
        let m = model.clone();
        let mut worker = Worker::new(Factory {
            open: move || Ok((m.clone(), source.clone())),
            journal: move |_: &Model, _: &Connection| {
                journals.fetch_add(1, Ordering::SeqCst);
                Err(BridgeError::new("UNEXPECTED_STORE", "no journal expected"))
            },
        });
        worker.hello();
        let reply = worker.request(2, "arm", json!({"modelId":selected,"lightingProfile":1}));
        assert_eq!(reply["ok"], false, "{fault}: {reply}");
        let expected = match fault {
            "model" => "CONTROLLER_DEVICE_MISMATCH",
            "profile" => "SESSION_CHANGED",
            "firmware" => "RECOVERY_POLICY_UNVERIFIED",
            _ => "RECOVERY_IDENTITY_UNVERIFIED",
        };
        assert_eq!(reply["error"]["code"], expected, "{fault}");
        assert_eq!(worker.shutdown(false)["noMutation"], true);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        identity_only(&board);
    }
}
#[test]
fn handshake_heartbeat_and_quit_never_open_a_device_or_store() {
    let opens = Arc::new(AtomicUsize::new(0));
    let reads = Arc::clone(&opens);
    let journals = Arc::new(AtomicUsize::new(0));
    let stores = Arc::clone(&journals);
    let mut worker = Worker::new(Factory {
        open: move || -> Result<(Model, Observed)> {
            reads.fetch_add(1, Ordering::SeqCst);
            Err(BridgeError::new("UNEXPECTED_OPEN", "no device expected"))
        },
        journal: move |_: &Model, _: &Connection| {
            stores.fetch_add(1, Ordering::SeqCst);
            Err(BridgeError::new("UNEXPECTED_STORE", "no store expected"))
        },
    });
    worker.hello();
    assert_eq!(
        worker.request(2, "heartbeat", json!({}))["result"]["alive"],
        true
    );
    assert_eq!(worker.request(3, "quit", json!({}))["ok"], true);
    assert_eq!(worker.shutdown(true)["noMutation"], true);
    assert_eq!(opens.load(Ordering::SeqCst), 0);
    assert_eq!(journals.load(Ordering::SeqCst), 0);
}
#[test]
fn pending_originals_stop_before_lighting_reads_and_preserve_every_byte() {
    let (_temp, directory) = board::directory();
    let model = board::model();
    let c = board::Board::new(&model).connection();
    let mut journal = store(&directory, &model, &c).unwrap();
    let baseline = Lighting::open(board::Board::new(&model), model.clone())
        .unwrap()
        .capture_baseline()
        .unwrap();
    drop(journal.begin(baseline).unwrap());
    drop(journal);
    let before = file_bytes(&directory);
    let model_copy = model.clone();
    let path = directory.clone();
    let board = observed(&model);
    let source = board.clone();
    let mut worker = Worker::new(Factory {
        open: move || Ok((model_copy.clone(), source.clone())),
        journal: move |m: &Model, c: &Connection| store(&path, m, c),
    });
    worker.hello();
    let reply = worker.request(2, "arm", json!({"modelId":model.id,"lightingProfile":1}));
    assert_eq!(reply["error"]["code"], "RECOVERY_REQUIRED");
    assert_eq!(worker.shutdown(false)["recoveryPending"], true);
    identity_only(&board);
    let journal = store(&directory, &model, &c).unwrap();
    assert!(journal.recovery_status().unwrap().has_pending());
    drop(journal);
    assert_eq!(file_bytes(&directory), before);
}
#[test]
fn a_journal_for_another_model_is_rejected_before_lighting_capture() {
    let (_temp, directory) = board::directory();
    let model = board::model();
    let model_copy = model.clone();
    let other = board::fixture().models.remove(1);
    let board = observed(&model);
    let source = board.clone();
    let mut worker = Worker::new(Factory {
        open: move || Ok((model_copy.clone(), source.clone())),
        journal: move |_: &Model, c: &Connection| {
            let mut connection = c.clone();
            connection.vendor_id = other.vendor_id;
            connection.product_id = other.product_ids[0];
            store(&directory, &other, &connection)
        },
    });
    worker.hello();
    let reply = worker.request(2, "arm", json!({"modelId":model.id,"lightingProfile":1}));
    assert_eq!(reply["error"]["code"], "BACKUP_DEVICE_MISMATCH");
    worker.shutdown(false);
    identity_only(&board);
}
#[test]
fn composed_factory_restores_rearms_and_releases_guarded_stores_with_new_connection_tokens() {
    let (_temp, directory) = board::directory();
    let model = board::model();
    let m = model.clone();
    let path = directory.clone();
    let boards = Arc::new(Mutex::new(Vec::new()));
    let all = Arc::clone(&boards);
    let bindings = Arc::new(Mutex::new(Vec::new()));
    let selected = Arc::clone(&bindings);
    let mut worker = Worker::new(Factory {
        open: move || {
            let value = observed(&m);
            let mut list = all.lock().unwrap();
            value.0.lock().unwrap().connection.token = format!("factory-handle-{}", list.len() + 1);
            list.push(value.clone());
            Ok((m.clone(), value))
        },
        journal: move |m: &Model, c: &Connection| {
            selected.lock().unwrap().push(c.clone());
            store(&path, m, c)
        },
    });
    worker.hello();
    for (arm, paint, restore) in [(2, 3, Some(4)), (5, 6, None)] {
        let reply = worker.request(arm, "arm", json!({"modelId":model.id,"lightingProfile":1}));
        assert_eq!(reply["ok"], true, "{reply}");
        let lease = reply["result"]["leaseId"].clone();
        assert_eq!(
            worker.request(
                paint,
                "paint",
                json!({"leaseId":lease,"colors":vec![0x42;model.key_count*3],"verify":true})
            )["ok"],
            true
        );
        if let Some(id) = restore {
            assert_eq!(
                worker.request(id, "restore", json!({"leaseId":lease}))["ok"],
                true
            );
        }
    }
    assert_eq!(worker.request(7, "quit", json!({}))["ok"], true);
    assert_eq!(worker.shutdown(true)["lightingRestored"], true);
    let bindings = bindings.lock().unwrap();
    assert_eq!(bindings.len(), 2);
    assert_ne!(bindings[0].token, bindings[1].token);
    for board in boards.lock().unwrap().iter() {
        let board = board.0.lock().unwrap();
        let original = board::Board::new(&model);
        assert_eq!(board.state, original.state);
        assert_eq!(board.rgb(), original.rgb());
        assert_eq!(board.sleep, original.sleep);
        assert!(board.calls.iter().any(|frame| frame[1] == 0xd8));
    }
    assert!(!store(&directory, &model, &bindings[1])
        .unwrap()
        .recovery_status()
        .unwrap()
        .has_pending());
    assert!(fs::read_dir(directory).unwrap().next().is_some());
}
