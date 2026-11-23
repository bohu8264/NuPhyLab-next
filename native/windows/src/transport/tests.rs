use super::*;
use std::{cell::RefCell, collections::VecDeque, rc::Rc};
#[derive(Default)]
struct State {
    writes: Vec<Vec<u8>>,
    reads: Vec<i32>,
    replies: VecDeque<Vec<u8>>,
    short_write: bool,
    dropped: usize,
}
struct Device(Rc<RefCell<State>>);
impl Drop for Device {
    fn drop(&mut self) {
        self.0.borrow_mut().dropped += 1;
    }
}
impl Io for Device {
    fn write(&self, report: &[u8]) -> Result<usize> {
        let mut state = self.0.borrow_mut();
        state.writes.push(report.to_vec());
        Ok(report.len() - usize::from(state.short_write))
    }
    fn read_timeout(&self, report: &mut [u8], timeout_ms: i32) -> Result<usize> {
        let mut state = self.0.borrow_mut();
        state.reads.push(timeout_ms);
        if let Some(bytes) = state.replies.pop_front() {
            report[..bytes.len()].copy_from_slice(&bytes);
            Ok(bytes.len())
        } else {
            Ok(0)
        }
    }
}
fn setup(deadline: Option<Instant>) -> (ControlTransport<Device>, Rc<RefCell<State>>) {
    let state = Rc::new(RefCell::new(State::default()));
    let connection = Connection {
        vendor_id: 0x19f5,
        product_id: 0x1028,
        serial: None,
        token: "owned-handle".into(),
    };
    (
        ControlTransport::new(Device(Rc::clone(&state)), connection, deadline),
        state,
    )
}
fn reply(command: u8) -> Vec<u8> {
    let mut bytes = vec![0; 64];
    bytes[0] = 0xaa;
    bytes[1] = command;
    bytes[4] = 8;
    bytes[3] = nuphylab_core::checksum(&bytes);
    bytes
}
#[test]
fn read_adapter_rejects_sleep_setters_and_alternate_routes_before_device_io() {
    use nuphylab_core::lighting::ReadTransport;
    let (mut transport, state) = setup(None);
    for (command, length, address, handle) in [
        (0xf5, 1, 0, 0),
        (0xf3, 1, 0, 0),
        (0xf3, 4, 1, 0),
        (0xf3, 4, 0, 1),
    ] {
        assert_eq!(
            transport
                .read(command, length, address, handle, 0x80)
                .unwrap_err()
                .code,
            "READ_ONLY"
        );
    }
    assert!(state.borrow().writes.is_empty());
    state.borrow_mut().replies.push_back(reply(0xf3));
    transport.read(0xf3, 4, 0, 0, 0x80).unwrap();
    assert_eq!(state.borrow().writes.len(), 1);
    assert_eq!(
        &state.borrow().writes[0][1..],
        &nuphylab_core::sleep_inspection::read_frame(4, 0, 0, 0x80).unwrap()
    );
}
#[test]
fn keymap_reads_allow_only_bounded_read_commands_and_never_remap_or_reset() {
    use nuphylab_core::lighting::ReadTransport;
    let (mut transport, state) = setup(None);
    for (command, length, address, handle) in [
        (0xb3, 2, 0, 0),
        (0xb4, 2, 0, 0),
        (0xb1, 1, 0, 0),
        (0xb2, 58, 0, 0),
        (0xb2, 2, 1, 0),
        (0xb1, 2, 4096, 0),
        (0xb1, 2, 0, 1),
    ] {
        assert_eq!(
            transport
                .read(command, length, address, handle, 0x80)
                .unwrap_err()
                .code,
            "READ_ONLY"
        );
    }
    assert!(state.borrow().writes.is_empty());
    for command in [0xb1, 0xb2] {
        state.borrow_mut().replies.push_back(reply(command));
        transport.read(command, 28, 952, 0, 0x80).unwrap();
        assert_eq!(
            &state.borrow().writes.last().unwrap()[1..],
            &nuphylab_core::keymap::bounded_read_frame(command, 28, 952, 0, 0x80).unwrap()
        );
    }
    assert_eq!(state.borrow().writes.len(), 2);
}
#[test]
fn owned_handle_lives_across_exchanges_and_normalizes_both_input_report_forms() {
    let (mut transport, state) = setup(None);
    for leading_zero in [false, true] {
        let mut bytes = reply(0xa1);
        if leading_zero {
            bytes.insert(0, 0);
        }
        state.borrow_mut().replies.push_back(bytes);
        let frame = nuphylab_core::read_frame(0xa1, 8, 0).unwrap();
        assert_eq!(
            transport
                .exchange(&frame, Duration::from_millis(1200))
                .unwrap(),
            reply(0xa1)
        );
        assert_eq!(state.borrow().dropped, 0);
        assert_eq!(
            state.borrow().writes.last().unwrap(),
            &[vec![0], frame.to_vec()].concat()
        );
    }
    drop(transport);
    assert_eq!(state.borrow().dropped, 1);
}
#[test]
fn a_transient_deadline_or_zero_timeout_prevents_any_write_but_persistent_handles_have_no_total_deadline(
) {
    for expired in [false, true] {
        let (mut transport, state) =
            setup(expired.then(|| Instant::now() - Duration::from_millis(1)));
        let result = transport.exchange(
            &nuphylab_core::read_frame(0xa1, 8, 0).unwrap(),
            if expired {
                Duration::from_secs(1)
            } else {
                Duration::ZERO
            },
        );
        assert_eq!(result.unwrap_err().code, "HID_TIMEOUT");
        assert!(state.borrow().writes.is_empty());
    }
    let (transport, _) = setup(None);
    assert!(transport.deadline.is_none());
}
#[test]
fn unrelated_replies_are_skipped_but_checksum_errors_and_short_writes_are_not_replayed() {
    let frame = nuphylab_core::read_frame(0xa1, 8, 0).unwrap();
    let (mut transport, state) = setup(None);
    state
        .borrow_mut()
        .replies
        .extend([reply(0xa0), reply(0xa1)]);
    transport
        .exchange(&frame, Duration::from_millis(5))
        .unwrap();
    assert_eq!(state.borrow().writes.len(), 1);
    assert!(state.borrow().reads.iter().all(|&t| (1..=5).contains(&t)));
    let mut damaged = reply(0xa1);
    damaged[9] ^= 1;
    state.borrow_mut().replies.push_back(damaged);
    assert_eq!(
        transport
            .exchange(&frame, Duration::from_millis(5))
            .unwrap_err()
            .code,
        "INVALID_CHECKSUM"
    );
    assert_eq!(state.borrow().writes.len(), 2);
    state.borrow_mut().short_write = true;
    assert_eq!(
        transport
            .exchange(&frame, Duration::from_millis(5))
            .unwrap_err()
            .code,
        "HID_WRITE_FAILED"
    );
    assert_eq!(state.borrow().writes.len(), 3);
}
#[test]
fn a_missing_reply_times_out_after_one_report_and_the_read_adapter_stays_read_only() {
    let (mut transport, state) = setup(None);
    assert_eq!(
        transport
            .exchange(
                &nuphylab_core::read_frame(0xa1, 8, 0).unwrap(),
                Duration::from_millis(1)
            )
            .unwrap_err()
            .code,
        "HID_TIMEOUT"
    );
    assert_eq!(state.borrow().writes.len(), 1);
    for command in [0xd6, 0xd8, 0xf3, 0xf5, 0xee] {
        assert!(
            nuphylab_core::lighting::ReadTransport::read(&mut transport, command, 1, 0, 0, 0)
                .is_err()
        );
    }
    assert_eq!(state.borrow().writes.len(), 1);
}
