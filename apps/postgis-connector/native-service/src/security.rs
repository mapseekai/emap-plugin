use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone)]
pub struct Error {
    pub code: &'static str,
    pub message: &'static str,
    pub status: u16,
}
impl Error {
    pub fn new(code: &'static str, message: &'static str, status: u16) -> Self {
        Self {
            code,
            message,
            status,
        }
    }
    pub fn value(&self) -> Value {
        json!({"code": self.code, "message": self.message})
    }
}
impl From<tokio_postgres::Error> for Error {
    fn from(_: tokio_postgres::Error) -> Self {
        Self::new(
            "QUERY_FAILED",
            "Query failed; check SQL, permissions, database settings and TLS",
            400,
        )
    }
}
pub fn invalid() -> Error {
    Error::new(
        "INVALID_ARGUMENT",
        "Use documented fields and valid values only",
        400,
    )
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
pub fn equal(a: &str, b: &str) -> bool {
    bool::from(Sha256::digest(a.as_bytes()).ct_eq(&Sha256::digest(b.as_bytes())))
}
pub fn secret() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| Error::new("ENTROPY_FAILED", "System randomness unavailable", 500))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
pub fn request_id(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn connection_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn origin(s: &str) -> Result<String> {
    let denied = || {
        Error::new(
            "ORIGIN_DENIED",
            "Only exact HTTPS or loopback development origins are allowed",
            403,
        )
    };
    if s.len() > 2048 {
        return Err(denied());
    }
    let u = url::Url::parse(s).map_err(|_| denied())?;
    let local = matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if u.origin().ascii_serialization() != s
        || !u.username().is_empty()
        || u.password().is_some()
        || !(u.scheme() == "https" || (u.scheme() == "http" && local))
    {
        return Err(denied());
    }
    Ok(s.to_owned())
}
pub fn launch(s: &str) -> Result<String> {
    let denied = || Error::new("INVALID_LAUNCH", "Invalid connector launch URL", 400);
    let u = url::Url::parse(s).map_err(|_| denied())?;
    let pairs: Vec<_> = u.query_pairs().collect();
    if u.scheme() != "emap-connect"
        || u.host_str() != Some("start")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || !matches!(u.path(), "" | "/")
        || u.fragment().is_some()
        || pairs.len() != 1
        || pairs[0].0 != "request_id"
        || !request_id(&pairs[0].1)
    {
        return Err(denied());
    }
    Ok(pairs[0].1.to_string())
}
pub fn object(value: &Value, keys: &[&str]) -> Result<()> {
    match value.as_object() {
        Some(v) if v.keys().all(|k| keys.contains(&k.as_str())) => Ok(()),
        _ => Err(invalid()),
    }
}
pub fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().ok_or_else(invalid)
}
pub fn integer(v: &Value, default: u64, min: u64, max: u64) -> Result<u64> {
    let n = if v.is_null() {
        default
    } else {
        v.as_u64().ok_or_else(invalid)?
    };
    if n < min || n > max {
        Err(invalid())
    } else {
        Ok(n)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub tls: String,
    #[serde(default)]
    pub ca: String,
}
impl Profile {
    pub fn parse(value: Value) -> Result<Self> {
        let p: Self = serde_json::from_value(value).map_err(|_| invalid())?;
        if !connection_id(&p.id) || p.port == 0 {
            return Err(invalid());
        }
        for s in [&p.label, &p.database, &p.user, &p.password] {
            if s.is_empty() || s.len() > 1024 || s.contains('\0') {
                return Err(invalid());
            }
        }
        let ip = p.host.parse::<std::net::IpAddr>().is_ok();
        let hostname = !p.host.is_empty()
            && p.host.len() <= 253
            && p.host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
            && p.host.as_bytes()[0].is_ascii_alphanumeric()
            && p.host.as_bytes()[p.host.len() - 1].is_ascii_alphanumeric();
        if !(ip || hostname) || p.ca.len() > 65536 || !matches!(p.tls.as_str(), "local" | "verify")
        {
            return Err(invalid());
        }
        if p.tls == "local" && !matches!(p.host.as_str(), "127.0.0.1" | "::1") {
            return Err(Error::new(
                "TLS_REQUIRED",
                "Remote database connections require certificate-verified TLS",
                400,
            ));
        }
        Ok(p)
    }
    pub fn metadata(&self) -> Value {
        json!({"id":self.id,"label":self.label,"host":self.host,"port":self.port,"database":self.database,"user":self.user,"tls":self.tls})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origins_are_exact() {
        for s in [
            "null",
            "http://evil.example",
            "https://emap.example/",
            "https://user@emap.example",
            "file:///tmp/a",
        ] {
            assert!(origin(s).is_err());
        }
        for s in [
            "https://emap.example",
            "http://127.0.0.1:3000",
            "http://[::1]:80",
        ] {
            if s.ends_with(":80") {
                assert!(origin(s).is_err());
            } else {
                assert!(origin(s).is_ok());
            }
        }
    }
    #[test]
    fn launch_is_not_a_command() {
        let id = "a".repeat(43);
        assert_eq!(
            launch(&format!("emap-connect://start?request_id={id}")).unwrap(),
            id
        );
        for s in [
            format!("emap-connect://start?request_id={id}&sql=select"),
            format!("emap-connect://start?request_id={id}#a"),
            format!("emap-connect://user@start?request_id={id}"),
            "emap-connect://start?request_id=x".into(),
        ] {
            assert!(launch(&s).is_err());
        }
    }
    #[test]
    fn secrets_are_high_entropy() {
        let a = secret().unwrap();
        let b = secret().unwrap();
        assert!(request_id(&a));
        assert!(!equal(&a, &b));
        assert!(equal(&a, &a));
    }
}
