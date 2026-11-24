use crate::{BridgeError, Result, MAX_LINE};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub profile: String,
    pub protocol_version: u32,
    pub implementation: String,
    pub platform: String,
    pub max_line_bytes: usize,
    pub operations: Vec<String>,
    pub capabilities: Value,
}
pub fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        let value: Contract = serde_json::from_str(include_str!(
            "../../../shared/contracts/native-readonly-v1.json"
        ))
        .expect("无效的原生桥接契约");
        assert_eq!(value.protocol_version, 1);
        assert_eq!(value.max_line_bytes, MAX_LINE);
        value
    })
}

#[derive(Default)]
pub struct Session {
    session_id: Option<String>,
    last_id: u64,
    event_sequence: u64,
}
impl Session {
    pub fn accept(&mut self, request: &Value) -> Result<String> {
        let invalid = || BridgeError::new("BRIDGE_REQUEST_INVALID", "桥接命令编号、参数或顺序无效");
        let object = request.as_object().ok_or_else(invalid)?;
        let id = request["id"]
            .as_u64()
            .filter(|id| *id > self.last_id && *id <= 9_007_199_254_740_991)
            .ok_or_else(invalid)?;
        self.last_id = id;
        let op = request["op"].as_str().ok_or_else(invalid)?;
        let fields: &[&str] = if op == "hello" {
            &["id", "op", "protocolVersion", "sessionId"]
        } else {
            &["id", "op"]
        };
        if object.keys().any(|key| !fields.contains(&key.as_str())) {
            return Err(invalid());
        }
        if op == "hello" {
            if request["protocolVersion"] != contract().protocol_version {
                return Err(BridgeError::new(
                    "BRIDGE_PROTOCOL_MISMATCH",
                    "桥接协议版本不匹配",
                ));
            }
            let session_id = request["sessionId"]
                .as_str()
                .filter(|value| valid_session_id(value))
                .ok_or_else(invalid)?;
            if self
                .session_id
                .as_ref()
                .is_some_and(|value| value != session_id)
            {
                return Err(BridgeError::new(
                    "BRIDGE_PROTOCOL_MISMATCH",
                    "桥接进程不能切换到另一会话",
                ));
            }
            self.session_id = Some(session_id.into());
        } else if op != "quit" {
            if self.session_id.is_none() {
                return Err(BridgeError::new(
                    "BRIDGE_HANDSHAKE_REQUIRED",
                    "请先确认桥接协议与能力",
                ));
            }
            if !contract().operations.iter().any(|allowed| allowed == op) {
                return Err(BridgeError::new(
                    "WINDOWS_PROBE_ONLY",
                    "此桥接仅允许只读识别",
                ));
            }
        }
        Ok(op.into())
    }
    pub fn hello(&self, implementation_version: &str) -> Value {
        let contract = contract();
        json!({"protocolVersion":contract.protocol_version,"implementation":contract.implementation,
            "implementationVersion":implementation_version,"platform":contract.platform,
            "sessionId":self.session_id,"readOnly":true,"maxLineBytes":contract.max_line_bytes,"capabilities":contract.capabilities})
    }
    pub fn event(&mut self, name: &str, mut value: Value) -> Value {
        self.event_sequence += 1;
        value["event"] = name.into();
        value["sessionId"] = self.session_id.clone().into();
        value["eventSequence"] = self.event_sequence.into();
        value
    }
}
pub(crate) fn valid_session_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: &str = "12345678-1234-1234-1234-123456789abc";
    fn hello(id: u64) -> Value {
        json!({"id":id,"op":"hello","protocolVersion":1,"sessionId":SESSION})
    }
    #[test]
    fn handshake_precedes_reads_and_never_enables_writes() {
        let mut session = Session::default();
        assert_eq!(
            session
                .accept(&json!({"id":1,"op":"connect"}))
                .unwrap_err()
                .code,
            "BRIDGE_HANDSHAKE_REQUIRED"
        );
        session.accept(&hello(2)).unwrap();
        assert_eq!(
            session.hello("1.2.40")["capabilities"]["lightingWrite"],
            false
        );
        assert_eq!(
            session.accept(&json!({"id":3,"op":"connect"})).unwrap(),
            "connect"
        );
        assert_eq!(
            session
                .accept(&json!({"id":4,"op":"arm"}))
                .unwrap_err()
                .code,
            "WINDOWS_PROBE_ONLY"
        );
    }
    #[test]
    fn rejects_bad_headers_replay_extra_fields_and_changed_sessions() {
        let mut session = Session::default();
        for value in [
            Value::Null,
            json!([]),
            json!({"id":0,"op":"hello"}),
            json!({"id":1.5,"op":"hello"}),
        ] {
            assert!(session.accept(&value).is_err());
        }
        let mut wrong = hello(1);
        wrong["protocolVersion"] = 2.into();
        assert_eq!(
            session.accept(&wrong).unwrap_err().code,
            "BRIDGE_PROTOCOL_MISMATCH"
        );
        session.accept(&hello(2)).unwrap();
        assert!(session.accept(&hello(2)).is_err());
        assert!(session
            .accept(&json!({"id":3,"op":"connect","colors":[]}))
            .is_err());
        let mut other = hello(4);
        other["sessionId"] = "87654321-1234-1234-1234-123456789abc".into();
        assert!(session.accept(&other).is_err());
        assert!(session
            .accept(&json!({"id":9_007_199_254_740_992u64,"op":"quit"}))
            .is_err());
    }
    #[test]
    fn events_are_bound_to_the_handshake_and_ordered_and_quit_can_precede_hello() {
        let mut session = Session::default();
        assert_eq!(
            session.accept(&json!({"id":1,"op":"quit"})).unwrap(),
            "quit"
        );
        session.accept(&hello(2)).unwrap();
        let first = session.event("disconnected", json!({"needsRestore":false}));
        let last = session.event("shutdownComplete", json!({"noMutation":true}));
        assert_eq!(first["sessionId"], SESSION);
        assert_eq!(first["eventSequence"], 1);
        assert_eq!(last["eventSequence"], 2);
    }
}
