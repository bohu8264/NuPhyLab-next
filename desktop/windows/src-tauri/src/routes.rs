use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub const LIMIT: usize = 8 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    version: u32,
    read_routes: Vec<String>,
    command_route: String,
    max_bytes: usize,
    operations: Vec<String>,
    editor_operations: BTreeMap<String, Vec<String>>,
    inspection_operations: Vec<String>,
    handoff_operations: Vec<String>,
    lighting_operations: BTreeMap<String, Vec<String>>,
    native_requirements: BTreeMap<String, String>,
    agent_operations: BTreeMap<String, Vec<String>>,
    agent_settings: Vec<String>,
    recovery_operations: Vec<String>,
    settings: Vec<String>,
    feature_ids: Vec<String>,
}
fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        let value: Policy = serde_json::from_str(include_str!(
            "../../../../shared/contracts/windows-preview.json"
        ))
        .expect("无效的预览命令契约");
        assert_eq!(value.version, 15);
        assert!(value
            .native_requirements
            .values()
            .all(|v| matches!(v.as_str(), "audio" | "globalKeys")));
        assert_eq!(value.max_bytes, LIMIT);
        value
    })
}
pub fn validate(route: &str, body: &Value) -> Result<(), String> {
    let policy = policy();
    if policy.read_routes.iter().any(|value| value == route) && body.is_null() {
        return Ok(());
    }
    if route != policy.command_route || !body.is_object() {
        return Err("不支持的桌面请求".into());
    }
    if serde_json::to_vec(body).map_err(|_| "请求格式无效")?.len() > LIMIT {
        return Err("文件过大，最大 8 MB".into());
    }
    let op = body["op"].as_str().unwrap_or("");
    if policy.editor_operations.contains_key(op) {
        return if body.as_object().unwrap().len() == 2
            && body["editorId"]
                .as_str()
                .is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= 80)
        {
            Ok(())
        } else {
            Err("不支持的桌面请求".into())
        };
    }
    if policy.operations.iter().any(|value| value == op) {
        return Ok(());
    }
    if policy
        .inspection_operations
        .iter()
        .chain(policy.handoff_operations.iter())
        .any(|value| value == op)
    {
        return if body.as_object().unwrap().len() == 1 {
            Ok(())
        } else {
            Err("只读检查不接受外部身份、路径或其他参数".into())
        };
    }
    if policy.recovery_operations.iter().any(|value| value == op) {
        return if body.as_object().unwrap().len() == 1 {
            Ok(())
        } else {
            Err("恢复操作不接受外部身份、路径或其他参数".into())
        };
    }
    if let Some(fields) = policy.lighting_operations.get(op) {
        for (key, max) in [("editorId", 80), ("connectionSessionId", 128)] {
            if let Some(value) = body.get(key) {
                if !value
                    .as_str()
                    .is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= max)
                {
                    return Err("不支持的 Windows 灯光参数".into());
                }
            }
        }
        if op == "nativeLighting"
            && (!body["mode"].as_u64().is_some_and(|v| (1..=20).contains(&v))
                || body["brightness"].as_u64().is_none_or(|v| v > 100)
                || body["speed"].as_u64().is_none_or(|v| v > 4)
                || body.get("color").is_some_and(|v| {
                    !v.as_str().is_some_and(|v| {
                        v.len() == 7
                            && v.starts_with('#')
                            && v[1..].bytes().all(|b| b.is_ascii_hexdigit())
                    })
                }))
        {
            return Err("内置灯效参数无效".into());
        }
        // The Node service independently requires its native identity and
        // firmware qualification; the page cannot provide those conditions.
        return if body
            .as_object()
            .unwrap()
            .keys()
            .all(|key| key == "op" || fields.contains(key))
        {
            Ok(())
        } else {
            Err("不支持的 Windows 灯光参数".into())
        };
    }
    if let Some(fields) = policy.agent_operations.get(op) {
        return if body
            .as_object()
            .unwrap()
            .keys()
            .all(|k| k == "op" || fields.contains(k))
        {
            Ok(())
        } else {
            Err("不支持的 Windows AI 参数".into())
        };
    }
    match op {
        "settings" => {
            let settings = body["settings"].as_object().ok_or("设置格式无效")?;
            if let Some(value) = settings.get("sidebarFeatures") {
                let ids = value.as_array().ok_or("设置格式无效")?;
                if settings.len() != 1
                    || ids.len() > policy.feature_ids.len()
                    || ids.iter().enumerate().any(|(i, v)| {
                        !v.as_str()
                            .is_some_and(|id| policy.feature_ids.iter().any(|s| s == id))
                            || ids[..i].contains(v)
                    })
                {
                    return Err("Windows 预览版尚未开放这些设置".into());
                }
            }
            if settings.get("codexKeyAdaptation") == Some(&Value::Bool(true)) {
                return Err("Windows 实体任务键尚未通过来源核对".into());
            }
            if settings
                .keys()
                .all(|key| policy.settings.contains(key) || policy.agent_settings.contains(key))
            {
                Ok(())
            } else {
                Err("Windows 预览版尚未开放这些设置".into())
            }
        }
        _ => Err("Windows 预览版目前仅支持离线作品与只读键盘识别".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn proxy_is_not_a_generic_http_or_privileged_event_bridge() {
        assert!(validate("/api/state", &Value::Null).is_ok());
        assert!(validate("http://evil.test/", &Value::Null).is_err());
        assert!(validate("/api/state?extra", &Value::Null).is_err());
        for op in [
            "codexKey",
            "nativePermissions",
            "audioInventory",
            "audioPacket",
            "prepareAppUpdate",
            "arbitraryShell",
        ] {
            assert!(validate("/api/command", &json!({"op":op})).is_err(), "{op}");
        }
        assert!(validate(
            "/api/command",
            &json!({"op":"settings","settings":{"codexKeyAdaptation":true}})
        )
        .is_err());
        assert!(validate(
            "/api/command",
            &json!({"op":"settings","settings":{"language":"en"}})
        )
        .is_ok());
        assert!(validate("/api/command", &json!({"op":"saveScene","scene":{}})).is_ok());
    }
    #[test]
    fn shared_policy_remains_bounded_and_does_not_accept_unknown_operations() {
        for op in &policy().operations {
            assert!(validate("/api/command", &json!({"op":op})).is_ok());
        }
        assert!(validate("/api/command", &json!({"op":"hello"})).is_err());
        assert!(validate(
            "/api/command",
            &json!({"op":"play","colors":[],"animation":{}})
        )
        .is_ok());
        assert!(validate("/api/command", &json!({"op":"play","serial":"invented"})).is_err());
        for op in policy()
            .recovery_operations
            .iter()
            .chain(&policy().inspection_operations)
        {
            assert!(validate("/api/command", &json!({"op":op})).is_ok());
            for field in ["serial", "path", "modelId", "lightingProfile", "confirmed"] {
                let mut body = json!({"op":op});
                body[field] = json!("invented");
                assert!(validate("/api/command", &body).is_err());
            }
        }
        assert!(validate("/api/command", &json!({"op":"settings","settings":[]})).is_err());
        assert!(validate("/api/state", &json!({"op":"saveScene"})).is_err());
        assert!(validate(
            "/api/command",
            &json!({"op":"saveScene","scene":{"name":"x".repeat(LIMIT)}})
        )
        .is_err());
    }
    #[test]
    fn native_effects_accept_only_stock_parameters_without_paths_or_identity() {
        let valid =
            json!({"op":"nativeLighting","mode":4,"brightness":50,"speed":2,"color":"#123456"});
        assert!(validate("/api/command", &valid).is_ok());
        for (field, value) in [
            ("mode", json!(21)),
            ("mode", json!(0)),
            ("brightness", json!(101)),
            ("speed", json!(5)),
            ("color", Value::Null),
            ("color", json!("#💡")),
            ("path", json!("external")),
            ("leaseId", json!(1)),
        ] {
            let mut body = valid.clone();
            body[field] = value;
            assert!(validate("/api/command", &body).is_err());
        }
        for field in ["mode", "brightness", "speed"] {
            let mut body = valid.clone();
            body.as_object_mut().unwrap().remove(field);
            assert!(validate("/api/command", &body).is_err());
        }
    }
    #[test]
    fn resume_requests_cannot_supply_the_executable_arguments_or_prompt() {
        let public = json!({"op":"windowsAgentAction","source":"codex","action":"resumeTerminal","id":"12345678-1234-1234-1234-123456789abc"});
        let focus = json!({"op":"windowsAgentAction","source":"codex","action":"focusTerminal","id":"12345678-1234-1234-1234-123456789abc"});
        let private = json!({"op":"windowsPrepareResume","source":"codex","id":"12345678-1234-1234-1234-123456789abc","requestId":"a".repeat(64)});
        let task = json!({"op":"windowsAgentAction","source":"codex","action":"focusTask","id":"12345678-1234-1234-1234-123456789abc"});
        let preparation = json!({"op":"windowsPrepareTaskFocus","source":"codex","id":"12345678-1234-1234-1234-123456789abc","requestId":"a".repeat(64)});
        for body in [public, private, focus, task, preparation] {
            assert!(validate("/api/command", &body).is_ok());
            for field in [
                "executable",
                "cwd",
                "args",
                "prompt",
                "preparedAt",
                "pid",
                "hwnd",
                "ownerPid",
            ] {
                let mut injected = body.clone();
                injected[field] = json!("invented");
                assert!(validate("/api/command", &injected).is_err());
            }
        }
    }

    #[test]
    fn official_editor_metadata_is_bounded_without_native_identity_or_paths() {
        let valid = json!({"op":"preview","colors":[],"animation":{},"editorId":"editor-1","connectionSessionId":"probe:1"});
        assert!(validate("/api/command", &valid).is_ok());
        for field in ["path", "serial", "pid"] {
            let mut value = valid.clone();
            value[field] = json!("invented");
            assert!(validate("/api/command", &value).is_err());
        }
        for value in [json!({}), json!("x".repeat(81)), json!("😀".repeat(41))] {
            let mut request = valid.clone();
            request["editorId"] = value;
            assert!(validate("/api/command", &request).is_err());
        }
        assert!(validate(
            "/api/command",
            &json!({"op":"endEditorLighting","editorId":"editor-1"})
        )
        .is_ok());
        assert!(validate(
            "/api/command",
            &json!({"op":"endEditorLighting","editorId":""})
        )
        .is_err());
    }
    #[test]
    fn windows_feature_settings_do_not_grant_unported_mac_capabilities() {
        assert!(validate("/api/command", &json!({"op":"settings","settings":{"sidebarFeatures":["studio","library","codex","game"]}})).is_ok());
        for ids in [
            json!(["screen-replay"]),
            json!(["dock-scenes"]),
            json!(["studio", "studio"]),
        ] {
            assert!(validate(
                "/api/command",
                &json!({"op":"settings","settings":{"sidebarFeatures":ids}})
            )
            .is_err());
        }
        assert!(validate(
            "/api/command",
            &json!({"op":"settings","settings":{"sidebarFeatures":[],"brightness":25}})
        )
        .is_err());
    }
}
