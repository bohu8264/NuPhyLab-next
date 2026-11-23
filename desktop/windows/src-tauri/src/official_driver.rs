use serde_json::Value;

pub fn destination(prepared: &Value) -> Result<String, String> {
    let links: Value = serde_json::from_str(include_str!(
        "../../../../shared/contracts/firmware-links.json"
    ))
    .expect("valid bundled firmware links");
    let url = links["officialDriverUrl"]
        .as_str()
        .expect("bundled official driver URL");
    if prepared["ok"] != true || prepared["result"]["url"] != url {
        return Err("键盘尚未安全释放，请先处理恢复提示".into());
    }
    Ok(url.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn configured() -> String {
        let links: Value = serde_json::from_str(include_str!(
            "../../../../shared/contracts/firmware-links.json"
        ))
        .unwrap();
        links["officialDriverUrl"].as_str().unwrap().to_owned()
    }
    #[test]
    fn released_keyboard_accepts_the_current_official_destination() {
        let url = configured();
        assert_eq!(
            destination(&json!({"ok":true,"result":{"url":url}})).unwrap(),
            url
        );
    }
    #[test]
    fn failed_release_or_unexpected_url_cannot_open_the_browser() {
        let url = configured();
        for prepared in [
            json!({"ok":false,"result":{"url":url}}),
            json!({"ok":true,"result":{"url":"https://example.invalid/"}}),
            json!({"ok":true,"result":{"url":"https://drive.nuphyio.com/#/setting"}}),
            json!({"ok":true,"result":{}}),
            json!(null),
        ] {
            assert!(destination(&prepared).is_err());
        }
    }
}
