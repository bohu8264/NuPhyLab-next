//! Independent desktop IO child. No HID writer, recovery store or shell entry.
mod audio;
#[cfg(any(windows, test))]
mod dsp;
mod input;
#[cfg(windows)]
mod power;
use nuphylab_core::{BridgeError, Result};
use serde_json::{json, Value};
use std::{
    io::{self, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
fn failure(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}
struct Worker {
    stop: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
}
impl Worker {
    fn stop(self) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        self.thread
            .join()
            .map_err(|_| failure("IO_THREAD_FAILED", "原生采集线程未正常结束"))
    }
}
struct AudioWorker {
    worker: Worker,
    failure: Arc<OnceLock<BridgeError>>,
    session: String,
}
impl AudioWorker {
    fn stop(self) -> Result<()> {
        self.worker.stop()
    }
    fn accepts(&self, event: &Value) -> bool {
        self.failure.get().is_none()
            && !self.worker.thread.is_finished()
            && event["session"] == self.session
    }
}
fn retire_failed_audio(audio: &mut Option<AudioWorker>) -> Result<Option<Value>> {
    let Some(capture) = audio.as_ref() else {
        return Ok(None);
    };
    let error = capture.failure.get().cloned().or_else(|| {
        (capture.worker.thread.is_finished() && !capture.worker.stop.load(Ordering::Acquire))
            .then(|| failure("AUDIO_WORKER_FAILED", "声音采集线程意外结束，请重新开始"))
    });
    let Some(error) = error else {
        return Ok(None);
    };
    let capture = audio.take().expect("failed audio missing");
    capture.worker.stop()?;
    Ok(Some(
        json!({"event":"audioFeature","session":capture.session,"status":"error","error":"systemCapture","reasonCode":error.code}),
    ))
}
struct KeyWorker {
    worker: Worker,
    signal: Arc<input::MonitorSignal>,
    model: String,
    monitor: String,
}
impl KeyWorker {
    fn stop(self) -> Result<()> {
        self.worker.stop()
    }
}
fn retire_invalid_keys(keys: &mut Option<KeyWorker>) -> Result<Option<Value>> {
    if let Some(key) = keys.as_ref() {
        if key.worker.thread.is_finished() && !key.worker.stop.load(Ordering::Acquire) {
            key.signal.invalidate(input::ResetReason::WorkerFailed);
        }
    }
    let Some(reason) = keys.as_ref().and_then(|k| k.signal.reason()) else {
        return Ok(None);
    };
    let key = keys.take().expect("reset monitor missing");
    key.worker.stop()?;
    Ok(Some(
        json!({"event":"keysReset","modelId":key.model,"monitorId":key.monitor,"reasonCode":reason.code()}),
    ))
}
fn send(value: Value) -> Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{value}")
        .and_then(|_| out.flush())
        .map_err(|_| failure("PIPE_WRITE", "原生输出通道已关闭"))
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--models" {
        return Err(failure("INVALID_ARGUMENT", "桌面采集只接受固定型号资源"));
    }
    let models = nuphylab_core::models(
        &std::fs::read_to_string(&args[2])
            .map_err(|_| failure("INVALID_MODELS", "无法读取型号资源"))?,
    )?;
    let (requests, input) = mpsc::sync_channel(32);
    thread::spawn(move || {
        let mut r = io::stdin().lock();
        loop {
            match nuphylab_core::json_line(&mut r) {
                Ok(Some(v)) => {
                    if requests.send(Ok(v)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = requests.send(Err(e));
                    break;
                }
            }
        }
    });
    let (events, output) = mpsc::sync_channel::<Value>(128);
    let mut session = None::<String>;
    let mut last_id = 0;
    let mut sequence = 0;
    let mut last_ping = Instant::now();
    let mut worker = None::<AudioWorker>;
    let mut keys = None::<KeyWorker>;
    #[cfg(windows)]
    let power_reset = Arc::new(AtomicBool::new(false));
    #[cfg(windows)]
    let power_worker = {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let reset = power_reset.clone();
        let (ready, receiver) = mpsc::sync_channel(1);
        let thread = thread::spawn(move || {
            if let Err(error) = power::watch(flag, reset, ready.clone()) {
                let _ = ready.try_send(Err(error));
            }
        });
        let worker = Worker { stop, thread };
        if let Err(error) = receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| failure("POWER_INIT", "系统休眠状态订阅超时"))
            .and_then(|r| r)
        {
            let _ = worker.stop();
            return Err(error);
        }
        worker
    };
    let outcome = (|| -> Result<()> {
        loop {
            #[cfg(windows)]
            if power_reset.swap(false, Ordering::AcqRel) {
                if let Some(w) = worker.take() {
                    w.stop()?;
                }
                if let Some(w) = keys.take() {
                    w.stop()?;
                }
                // Drop pre-suspend features and keys, then notify the service.
                while output.try_recv().is_ok() {}
                if session.is_some() {
                    sequence += 1;
                    send(
                        json!({"event":"systemSuspend","sessionId":session,"eventSequence":sequence}),
                    )?;
                }
            }
            // Capture failures also bypass the bounded sample/key queue.
            if let Some(mut event) = retire_failed_audio(&mut worker)? {
                sequence += 1;
                event["eventSequence"] = sequence.into();
                event["sessionId"] = json!(session);
                send(event)?;
            }
            // This reset bypasses the bounded audio/key queue. Discard stale
            // queued keys below before assigning public event sequence numbers.
            if let Some(mut event) = retire_invalid_keys(&mut keys)? {
                sequence += 1;
                event["eventSequence"] = sequence.into();
                event["sessionId"] = json!(session);
                send(event)?;
            }
            for _ in 0..64 {
                let Ok(mut event) = output.try_recv() else {
                    break;
                };
                if event["event"] == "key"
                    && !keys
                        .as_ref()
                        .is_some_and(|k| k.signal.accepts(&event, &k.model, &k.monitor))
                {
                    continue;
                }
                if event["event"] == "audioFeature"
                    && !worker.as_ref().is_some_and(|a| a.accepts(&event))
                {
                    continue;
                }
                sequence += 1;
                event["eventSequence"] = sequence.into();
                event["sessionId"] = json!(session);
                send(event)?;
            }
            if last_ping.elapsed() > Duration::from_secs(15) {
                return Err(failure("IO_HEARTBEAT_LOST", "应用后台已失联"));
            }
            let request = match input.recv_timeout(Duration::from_millis(10)) {
                Ok(r) => r?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            };
            let id = request["id"]
                .as_u64()
                .filter(|n| *n > last_id && *n <= 9007199254740991)
                .ok_or_else(|| failure("IO_REQUEST_INVALID", "采集请求编号无效"))?;
            last_id = id;
            let op = request["op"]
                .as_str()
                .ok_or_else(|| failure("IO_REQUEST_INVALID", "采集请求无效"))?;
            let contract: Value = serde_json::from_str(include_str!(
                "../../../../shared/contracts/windows-desktop-io-v2.json"
            ))
            .expect("invalid desktop io contract");
            let allowed = contract["operations"][op].as_array();
            let result = (|| -> Result<Value> {
                if request.as_object().is_none_or(|o| {
                    allowed.is_none()
                        || o.keys().any(|k| {
                            k != "id" && k != "op" && !allowed.unwrap().iter().any(|f| f == k)
                        })
                }) {
                    return Err(failure("IO_REQUEST_INVALID", "采集请求不接受额外参数"));
                }
                if op == "hello" {
                    let s = request["sessionId"]
                        .as_str()
                        .filter(|s| {
                            s.len() == 36 && s.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
                        })
                        .ok_or_else(|| failure("IO_HANDSHAKE_INVALID", "采集会话无效"))?;
                    if request["protocolVersion"] != contract["protocolVersion"]
                        || session.as_ref().is_some_and(|old| old != s)
                    {
                        return Err(failure("IO_HANDSHAKE_INVALID", "采集协议或会话不匹配"));
                    }
                    session = Some(s.into());
                    last_ping = Instant::now();
                    return Ok(
                        json!({"protocolVersion":contract["protocolVersion"],"implementation":"windows-desktop-io","sessionId":s,"platform":"win32","capabilities":{"audio":cfg!(windows),"globalKeys":cfg!(windows),"sensitiveKeys":false,"orderedKeyEvents":true}}),
                    );
                }
                if session.is_none() && op != "quit" {
                    return Err(failure("IO_HANDSHAKE_REQUIRED", "请先确认采集协议"));
                }
                match op {
                    "heartbeat" => {
                        last_ping = Instant::now();
                        Ok(json!({"alive":true}))
                    }
                    "inventory" => audio::inventory(),
                    "stopKeys" => {
                        if let Some(k) = keys.take() {
                            k.stop()?;
                        }
                        Ok(json!({"stopped":true}))
                    }
                    "monitorKeys" => {
                        let monitor_id = request["monitorId"]
                            .as_str()
                            .filter(|v| {
                                v.len() == 36
                                    && v.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                            })
                            .ok_or_else(|| failure("IO_REQUEST_INVALID", "监听代次无效"))?
                            .to_string();
                        let model = models
                            .iter()
                            .find(|m| request["modelId"] == m.id)
                            .ok_or_else(|| failure("IO_REQUEST_INVALID", "键盘型号无效"))?
                            .clone();
                        let codes: Vec<String> =
                            serde_json::from_value(request["codes"].clone())
                                .map_err(|_| failure("IO_REQUEST_INVALID", "按键列表无效"))?;
                        if codes.is_empty()
                            || codes.len() > 256
                            || codes.iter().any(|c| !input::valid_code(c))
                        {
                            return Err(failure("IO_REQUEST_INVALID", "按键列表无效"));
                        }
                        if let Some(k) = keys.take() {
                            k.stop()?;
                        }
                        let stop = Arc::new(AtomicBool::new(false));
                        let flag = stop.clone();
                        let event = events.clone();
                        let (ready, rx) = mpsc::sync_channel(1);
                        let input_models = models.clone();
                        let input_model_id = model.id.clone();
                        let input_monitor_id = monitor_id.clone();
                        let signal = Arc::new(input::MonitorSignal::default());
                        let input_signal = signal.clone();
                        let thread = thread::spawn(move || {
                            if let Err(e) = input::monitor(
                                input_models,
                                model,
                                codes,
                                monitor_id,
                                flag,
                                event.clone(),
                                input::MonitorStatus {
                                    reset: input_signal.clone(),
                                    ready: ready.clone(),
                                },
                            ) {
                                let _ = ready.try_send(Err(e.clone()));
                                input_signal.invalidate(input::ResetReason::WorkerFailed);
                            }
                        });
                        keys = Some(KeyWorker {
                            worker: Worker { stop, thread },
                            signal,
                            model: input_model_id,
                            monitor: input_monitor_id,
                        });
                        rx.recv_timeout(Duration::from_secs(5))
                            .map_err(|_| failure("INPUT_START_TIMEOUT", "按键监听启动超时"))??;
                        Ok(json!({"monitoring":true,"suppressing":false,"sensitiveKeys":false}))
                    }
                    "stopAudio" => {
                        if let Some(w) = worker.take() {
                            w.stop()?;
                        }
                        Ok(json!({"stopped":true}))
                    }
                    "startAudio" => {
                        if !matches!(request["source"].as_str(), Some("system" | "microphone"))
                            || request["session"].as_str().is_none_or(|s| {
                                s.len() != 36
                                    || !s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                            })
                            || request["deviceId"]
                                .as_str()
                                .is_none_or(|s| s.len() > 256 || s.chars().any(char::is_control))
                        {
                            return Err(failure("IO_REQUEST_INVALID", "声音来源、设备或会话无效"));
                        }
                        if let Some(w) = worker.take() {
                            w.stop()?;
                        }
                        let stop = Arc::new(AtomicBool::new(false));
                        let flag = stop.clone();
                        let event = events.clone();
                        let config = request.clone();
                        let (ready, receiver) = mpsc::sync_channel(1);
                        let failed = Arc::new(OnceLock::new());
                        let failed_capture = failed.clone();
                        let thread = thread::spawn(move || {
                            if let Err(e) = audio::capture(config, flag, event, ready.clone()) {
                                let _ = failed_capture.set(e.clone());
                                let _ = ready.try_send(Err(e));
                            }
                        });
                        worker = Some(AudioWorker {
                            worker: Worker { stop, thread },
                            failure: failed,
                            session: request["session"].as_str().unwrap().into(),
                        });
                        receiver
                            .recv_timeout(Duration::from_secs(5))
                            .map_err(|_| failure("AUDIO_START_TIMEOUT", "声音采集启动超时"))??;
                        Ok(json!({"started":true,"session":request["session"]}))
                    }
                    "quit" => Ok(json!({"quitting":true})),
                    _ => Err(failure("IO_OPERATION_UNAVAILABLE", "不支持的原生采集操作")),
                }
            })();
            match result {
                Ok(result) => send(json!({"id":id,"ok":true,"result":result}))?,
                Err(error) => send(json!({"id":id,"ok":false,"error":error}))?,
            }
            if op == "quit" {
                break;
            }
        }
        Ok(())
    })();
    let stopped = worker.map(AudioWorker::stop).transpose();
    let keys_stopped = keys.map(KeyWorker::stop).transpose();
    #[cfg(windows)]
    let power_stopped = power_worker.stop();
    #[cfg(not(windows))]
    let power_stopped = Ok::<_, BridgeError>(());
    sequence += 1;
    send(
        json!({"event":"shutdownComplete","sessionId":session,"eventSequence":sequence,"audioStopped":stopped.is_ok(),"keysStopped":keys_stopped.is_ok()}),
    )?;
    outcome
        .and(stopped.map(|_| ()))
        .and(keys_stopped.map(|_| ()))
        .and(power_stopped)
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{}: {}", e.code, e.message);
        std::process::exit(1);
    }
}
#[cfg(test)]
mod input_lifecycle_tests {
    use super::*;
    #[test]
    fn reset_bypasses_a_saturated_queue_and_joins_the_retired_monitor_once() {
        let (events, output) = mpsc::sync_channel(1);
        events
            .try_send(json!({"event":"key","modelId":"air75-v3","monitorId":"old"}))
            .unwrap();
        let signal = Arc::new(input::MonitorSignal::default());
        signal.invalidate(input::ResetReason::Overflow);
        let mut keys = Some(KeyWorker {
            worker: Worker {
                stop: Arc::default(),
                thread: thread::spawn(|| {}),
            },
            signal,
            model: "air75-v3".into(),
            monitor: "old".into(),
        });
        let reset = retire_invalid_keys(&mut keys).unwrap().unwrap();
        assert_eq!(reset["event"], "keysReset");
        assert_eq!(reset["reasonCode"], "INPUT_EVENT_OVERFLOW");
        assert!(keys.is_none());
        assert!(retire_invalid_keys(&mut keys).unwrap().is_none());
        assert_eq!(
            output.try_recv().unwrap()["event"],
            "key",
            "the full queue was never needed to deliver the reset"
        );
    }
    #[test]
    fn an_unexpected_worker_exit_is_reported_without_a_best_effort_event() {
        let worker = thread::spawn(|| {});
        let deadline = Instant::now() + Duration::from_secs(1);
        while !worker.is_finished() {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        let mut keys = Some(KeyWorker {
            worker: Worker {
                stop: Arc::default(),
                thread: worker,
            },
            signal: Arc::default(),
            model: "air75-v3".into(),
            monitor: "stopped".into(),
        });
        assert_eq!(
            retire_invalid_keys(&mut keys).unwrap().unwrap()["reasonCode"],
            "INPUT_WORKER_FAILED"
        );
        assert!(keys.is_none());
    }
}

#[cfg(test)]
mod audio_lifecycle_tests {
    use super::*;
    fn capture(session: &str) -> AudioWorker {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        AudioWorker {
            worker: Worker {
                stop,
                thread: thread::spawn(move || {
                    while !flag.load(Ordering::Acquire) {
                        thread::yield_now();
                    }
                }),
            },
            failure: Arc::default(),
            session: session.into(),
        }
    }
    #[test]
    fn capture_failure_bypasses_full_queue_joins_once_and_rejects_queued_samples() {
        let (events, output) = mpsc::sync_channel(1);
        let sample = json!({"event":"audioFeature","session":"first","status":"listening"});
        events.try_send(sample.clone()).unwrap();
        let worker = capture("first");
        assert!(worker.accepts(&sample));
        worker
            .failure
            .set(failure("AUDIO_DEVICE_CHANGED", "test endpoint changed"))
            .unwrap();
        assert!(!worker.accepts(&sample));
        assert!(worker
            .failure
            .set(failure("AUDIO_WORKER_FAILED", "later error"))
            .is_err());
        let mut worker = Some(worker);
        let error = retire_failed_audio(&mut worker).unwrap().unwrap();
        assert_eq!(error["reasonCode"], "AUDIO_DEVICE_CHANGED");
        assert_eq!(error["session"], "first");
        assert_eq!(error["status"], "error");
        assert!(worker.is_none());
        assert!(retire_failed_audio(&mut worker).unwrap().is_none());
        assert_eq!(output.try_recv().unwrap(), sample);
    }
    #[test]
    fn replacement_capture_rejects_the_stopped_sessions_queued_features() {
        let sample = json!({"session":"first"});
        let first = capture("first");
        assert!(first.accepts(&sample));
        first.stop().unwrap();
        let next = capture("next");
        assert!(!next.accepts(&sample));
        assert!(next.accepts(&json!({"session":"next"})));
        next.stop().unwrap();
    }
    #[test]
    fn unexpected_capture_exit_is_not_left_listening_without_a_failure_receipt() {
        let thread = thread::spawn(|| {});
        let deadline = Instant::now() + Duration::from_secs(1);
        while !thread.is_finished() {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        let worker = AudioWorker {
            worker: Worker {
                stop: Arc::default(),
                thread,
            },
            failure: Arc::default(),
            session: "ended".into(),
        };
        assert!(!worker.accepts(&json!({"session":"ended"})));
        let mut worker = Some(worker);
        let event = retire_failed_audio(&mut worker).unwrap().unwrap();
        assert_eq!(event["reasonCode"], "AUDIO_WORKER_FAILED");
        assert_eq!(event["session"], "ended");
        assert!(worker.is_none());
    }
}
