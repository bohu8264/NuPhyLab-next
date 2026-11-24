use base64::Engine;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    version: u8,
    pub enabled: bool,
    pub channel: String,
    pub pubkey: String,
    pub endpoints: Vec<String>,
    pub allowed_download_hosts: Vec<String>,
    pub trusted_signer_thumbprints: Vec<String>,
}
impl Release {
    pub fn configured(&self) -> bool {
        self.version == 1
            && self.enabled
            && matches!(self.channel.as_str(), "beta" | "stable")
            && self.pubkey.len() >= 40
            && self.pubkey.len() <= 2048
            && valid_key(&self.pubkey)
            && !self.endpoints.is_empty()
            && self.endpoints.len() <= 3
            && self.endpoints.iter().all(|u| secure(u).is_some())
            && !self.allowed_download_hosts.is_empty()
            && self.allowed_download_hosts.len() <= 16
            && self.allowed_download_hosts.iter().all(|h| {
                !h.is_empty()
                    && h.len() <= 253
                    && h.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            })
            && !self.trusted_signer_thumbprints.is_empty()
            && self.trusted_signer_thumbprints.len() <= 4
            && self
                .trusted_signer_thumbprints
                .iter()
                .all(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    }
    pub fn download_allowed(&self, uri: &str) -> bool {
        secure(uri).is_some_and(|u| {
            self.allowed_download_hosts
                .iter()
                .any(|h| Some(h.as_str()) == u.host_str())
                && u.path().to_ascii_lowercase().ends_with(".exe")
        })
    }
}
fn valid_key(value: &str) -> bool {
    let decoded = base64::engine::general_purpose::STANDARD.decode(value);
    let Ok(decoded) = decoded else {
        return false;
    };
    let Ok(text) = std::str::from_utf8(&decoded) else {
        return false;
    };
    text.starts_with("untrusted comment:")
        && text.lines().last().is_some_and(|line| {
            base64::engine::general_purpose::STANDARD
                .decode(line.trim())
                .is_ok_and(|raw| raw.len() == 42 && raw.starts_with(b"Ed"))
        })
}
pub fn secure(uri: &str) -> Option<update_http::Url> {
    let u = update_http::Url::parse(uri).ok()?;
    (u.scheme() == "https"
        && u.host_str().is_some()
        && u.username().is_empty()
        && u.password().is_none()
        && u.fragment().is_none()
        && u.port().is_none_or(|p| p == 443))
    .then_some(u)
}
pub fn config() -> &'static Release {
    static CONFIG: std::sync::OnceLock<Release> = std::sync::OnceLock::new();
    CONFIG.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../shared/contracts/windows-release.json"
        ))
        .expect("invalid Windows release config")
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn valid() -> Release {
        Release {
            version: 1,
            enabled: true,
            channel: "beta".into(),
            pubkey: {
                let mut raw = vec![1u8; 42];
                raw[..2].copy_from_slice(b"Ed");
                base64::engine::general_purpose::STANDARD.encode(format!(
                    "untrusted comment: test key\n{}",
                    base64::engine::general_purpose::STANDARD.encode(raw)
                ))
            },
            endpoints: vec!["https://updates.example/beta.json".into()],
            allowed_download_hosts: vec!["releases.example".into()],
            trusted_signer_thumbprints: vec!["A".repeat(40)],
        }
    }
    #[test]
    fn development_build_never_contacts_an_unconfigured_update_server() {
        assert!(!config().configured());
        let mut v = valid();
        assert!(v.configured());
        v.trusted_signer_thumbprints.clear();
        assert!(!v.configured());
    }
    #[test]
    fn update_paths_require_https_and_the_exact_configured_hosts() {
        let v = valid();
        assert!(v.download_allowed("https://releases.example/app.exe"));
        for u in [
            "http://releases.example/app.exe",
            "https://releases.example.evil/app.exe",
            "https://user@releases.example/app.exe",
            "file:///app.exe",
            "https://releases.example/app.zip",
            "https://releases.example:8443/app.exe",
        ] {
            assert!(!v.download_allowed(u));
        }
    }
}
