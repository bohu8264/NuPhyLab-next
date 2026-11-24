use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub protocol_version: u32,
    pub heartbeat_timeout_ms: u64,
    pub shutdown_timeout_ms: u64,
}
pub fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../shared/contracts/windows-host-v2.json"
        ))
        .expect("invalid Windows host contract")
    })
}
pub struct Monitor {
    id: String,
    armed: bool,
    receipt: Option<bool>,
    exited: Option<bool>,
    output_closed: bool,
    invalid: bool,
}
impl Monitor {
    pub fn new(id: String) -> Self {
        Self {
            id,
            armed: false,
            receipt: None,
            exited: None,
            output_closed: false,
            invalid: false,
        }
    }
    pub fn start(&mut self) {
        self.armed = true;
    }
    pub fn observe_output(&mut self, value: &Value) {
        if self.receipt.is_some() {
            self.invalid = true;
            return;
        }
        if value["event"] != "hostShutdownComplete" {
            return;
        }
        let fields = [
            "event",
            "protocolVersion",
            "shutdownId",
            "success",
            "keyboardVerified",
            "recoveryPending",
            "noMutation",
        ];
        if !self.armed
            || value["shutdownId"] != self.id
            || value["protocolVersion"] != contract().protocol_version
            || !value.as_object().is_some_and(|v| {
                v.len() == fields.len() && fields.iter().all(|key| v.contains_key(*key))
            })
            || [
                "success",
                "keyboardVerified",
                "recoveryPending",
                "noMutation",
            ]
            .iter()
            .any(|key| !value[*key].is_boolean())
        {
            self.invalid = true;
            return;
        }
        self.receipt = Some(
            value["success"] == true
                && value["keyboardVerified"] == true
                && value["recoveryPending"] == false,
        );
    }
    pub fn output_closed(&mut self) {
        self.output_closed = true;
    }
    pub fn invalid_output(&mut self) {
        self.invalid = true;
        self.output_closed = true;
    }
    pub fn exited(&mut self, success: bool) {
        self.exited = Some(success);
    }
    pub fn result(&self) -> Result<bool, String> {
        if self.invalid || self.receipt == Some(false) || self.exited == Some(false) {
            return Err("后台未确认本次退出恢复完成，请保留原记录并检查恢复状态".into());
        }
        if self.exited == Some(true) && self.output_closed {
            return if self.receipt == Some(true) {
                Ok(true)
            } else {
                Err("后台缺少本次退出的恢复确认".into())
            };
        }
        Ok(false)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn receipt(id: &str) -> Value {
        json!({"event":"hostShutdownComplete","protocolVersion":2,"shutdownId":id,"success":true,"keyboardVerified":true,"recoveryPending":false,"noMutation":false})
    }
    #[test]
    fn exit_requires_this_shutdown_receipt_successful_process_exit_and_drained_output() {
        let mut m = Monitor::new("a".repeat(64));
        m.start();
        m.observe_output(&receipt(&"a".repeat(64)));
        assert!(!m.result().unwrap());
        m.exited(true);
        assert!(!m.result().unwrap());
        m.output_closed();
        assert!(m.result().unwrap());
    }
    #[test]
    fn zero_exit_missing_stale_failed_or_duplicate_receipts_cannot_become_success_on_retry() {
        for kind in [
            "missing",
            "stale",
            "duplicate",
            "failed",
            "pending",
            "wrong-type",
            "extra",
            "nonzero",
            "before-start",
        ] {
            let mut m = Monitor::new("a".repeat(64));
            if kind != "before-start" {
                m.start();
            }
            let mut v = receipt(&"a".repeat(64));
            match kind {
                "stale" => v["shutdownId"] = "b".repeat(64).into(),
                "failed" => v["success"] = false.into(),
                "pending" => v["recoveryPending"] = true.into(),
                "wrong-type" => v["keyboardVerified"] = "true".into(),
                "extra" => v["serial"] = "not allowed".into(),
                _ => {}
            }
            if kind != "missing" {
                m.observe_output(&v);
            }
            if kind == "duplicate" {
                m.observe_output(&v);
            }
            m.exited(kind != "nonzero");
            m.output_closed();
            assert!(m.result().is_err(), "{kind}");
            m.start();
            assert!(m.result().is_err(), "retry: {kind}");
        }
    }
    #[test]
    fn host_budget_covers_native_shutdown_and_lost_host_is_not_the_exit_deadline() {
        let c = contract();
        assert_eq!(c.protocol_version, 2);
        assert_eq!(c.heartbeat_timeout_ms, 15000);
        assert!(
            c.shutdown_timeout_ms
                >= nuphylab_core::controller::contract().request_timeout_ms
                    + c.heartbeat_timeout_ms
        );
    }
}
