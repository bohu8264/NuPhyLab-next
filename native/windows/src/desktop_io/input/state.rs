//! Bounded, non-suppressing key observations. A reset uses an independent
//! atomic latch, so a full event queue cannot hide lost key transitions.
use super::*;
#[cfg(any(windows, test))]
use std::collections::HashSet;
use std::sync::atomic::AtomicU8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ResetReason {
    DeviceChanged = 1,
    Overflow = 2,
    WorkerFailed = 3,
    SourceLimit = 4,
    ChannelClosed = 5,
}
impl ResetReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::DeviceChanged => "INPUT_SOURCE_CHANGED",
            Self::Overflow => "INPUT_EVENT_OVERFLOW",
            Self::WorkerFailed => "INPUT_WORKER_FAILED",
            Self::SourceLimit => "INPUT_SOURCE_LIMIT",
            Self::ChannelClosed => "INPUT_CHANNEL_CLOSED",
        }
    }
}
#[derive(Default)]
pub struct MonitorSignal(AtomicU8);
impl MonitorSignal {
    pub fn invalidate(&self, reason: ResetReason) {
        let _ = self
            .0
            .compare_exchange(0, reason as u8, Ordering::AcqRel, Ordering::Acquire);
    }
    pub fn reason(&self) -> Option<ResetReason> {
        match self.0.load(Ordering::Acquire) {
            1 => Some(ResetReason::DeviceChanged),
            2 => Some(ResetReason::Overflow),
            3 => Some(ResetReason::WorkerFailed),
            4 => Some(ResetReason::SourceLimit),
            5 => Some(ResetReason::ChannelClosed),
            _ => None,
        }
    }
    pub fn accepts(&self, event: &Value, model: &str, monitor: &str) -> bool {
        self.reason().is_none() && event["modelId"] == model && event["monitorId"] == monitor
    }
}
#[cfg(any(windows, test))]
pub struct KeyState {
    model: String,
    monitor: String,
    codes: HashSet<String>,
    held: HashSet<(usize, String)>,
    pub signal: Arc<MonitorSignal>,
}
#[cfg(any(windows, test))]
impl KeyState {
    pub fn new(
        model: String,
        monitor: String,
        codes: Vec<String>,
        signal: Arc<MonitorSignal>,
    ) -> Self {
        Self {
            model,
            monitor,
            codes: codes.into_iter().collect(),
            held: HashSet::new(),
            signal,
        }
    }
    pub fn invalidate(&mut self, reason: ResetReason) {
        self.signal.invalidate(reason);
        self.held.clear();
    }
    pub fn observe(&mut self, device: usize, code: String, down: bool, events: &SyncSender<Value>) {
        if device == 0 || self.signal.reason().is_some() || !self.codes.contains(&code) {
            return;
        }
        let before = self.held.iter().any(|(_, key)| key == &code);
        let held = (device, code.clone());
        let changed = if down {
            self.held.insert(held)
        } else {
            self.held.remove(&held)
        };
        let after = self.held.iter().any(|(_, key)| key == &code);
        // Boot/NKRO siblings can describe the same press. Release only after
        // every accepted sibling releases it; repeats and orphan ups are inert.
        if !changed || before == after {
            return;
        }
        let event = json!({"event":"key","monitorId":self.monitor,"source":"windowsRawInput","modelId":self.model,"code":code,"phase":if after{"down"}else{"up"},"sensitiveKeys":false});
        if let Err(error) = events.try_send(event) {
            self.invalidate(match error {
                mpsc::TrySendError::Full(_) => ResetReason::Overflow,
                mpsc::TrySendError::Disconnected(_) => ResetReason::ChannelClosed,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> KeyState {
        KeyState::new(
            "air75-v3".into(),
            "test-monitor".into(),
            vec!["KeyA".into()],
            Arc::default(),
        )
    }
    #[test]
    fn repeats_unknown_sources_and_orphan_releases_cannot_create_presses() {
        let (tx, rx) = mpsc::sync_channel(8);
        let mut s = state();
        for (device, code, down) in [
            (0, "KeyA", true),
            (1, "KeyB", true),
            (1, "KeyA", false),
            (1, "KeyA", true),
            (1, "KeyA", true),
            (1, "KeyA", false),
            (1, "KeyA", false),
        ] {
            s.observe(device, code.into(), down, &tx);
        }
        let events: Vec<_> = rx.try_iter().collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["phase"], "down");
        assert_eq!(events[1]["phase"], "up");
        assert!(s.held.is_empty());
    }
    #[test]
    fn sibling_interfaces_share_one_logical_hold_until_both_release() {
        let (tx, rx) = mpsc::sync_channel(8);
        let mut s = state();
        for (device, down) in [(1, true), (2, true), (1, false)] {
            s.observe(device, "KeyA".into(), down, &tx);
        }
        assert_eq!(rx.try_recv().unwrap()["phase"], "down");
        assert!(rx.try_recv().is_err());
        s.observe(2, "KeyA".into(), false, &tx);
        assert_eq!(rx.try_recv().unwrap()["phase"], "up");
    }
    #[test]
    fn saturated_queue_latches_reset_without_enqueuing_and_never_replays() {
        let (tx, rx) = mpsc::sync_channel(1);
        let mut s = state();
        s.observe(1, "KeyA".into(), true, &tx);
        s.observe(1, "KeyA".into(), false, &tx);
        assert_eq!(s.signal.reason(), Some(ResetReason::Overflow));
        assert!(s.held.is_empty());
        let queued = rx.try_recv().unwrap();
        assert!(!s.signal.accepts(&queued, "air75-v3", "test-monitor"));
        s.observe(1, "KeyA".into(), true, &tx);
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn disconnected_channel_and_device_reset_retire_the_whole_monitor() {
        let (tx, rx) = mpsc::sync_channel(1);
        drop(rx);
        let mut s = state();
        s.observe(1, "KeyA".into(), true, &tx);
        assert_eq!(s.signal.reason(), Some(ResetReason::ChannelClosed));
        s.invalidate(ResetReason::DeviceChanged);
        assert_eq!(s.signal.reason(), Some(ResetReason::ChannelClosed));
        let fresh = state();
        let event = json!({"modelId":"air75-v3","monitorId":"test-monitor"});
        assert!(fresh.signal.accepts(&event, "air75-v3", "test-monitor"));
        assert!(!fresh.signal.accepts(&event, "air75-v3", "replacement"));
    }
}
