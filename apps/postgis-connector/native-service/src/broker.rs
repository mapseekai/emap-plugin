use crate::security::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tokio_util::sync::CancellationToken;

pub const MIN_SESSION_MS: u64 = 60_000;
pub const MAX_SESSION_MS: u64 = 86_400_000;
pub fn default_session_ms() -> u64 { 3_600_000 }
fn validate_duration(ms: u64) -> Result<()> {
    if !(MIN_SESSION_MS..=MAX_SESSION_MS).contains(&ms) {
        return Err(Error::new("INVALID_SESSION_DURATION", "Session duration must be between 1 minute and 24 hours", 400));
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub origin: String,
    pub connection_id: String,
    #[serde(default = "default_session_ms")]
    pub max_session_ms: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub request_id: String,
    pub origin: String,
    #[serde(skip)]
    pub challenge: String,
    pub expires_at: u64,
    pub preferred_connection_id: Option<String>,
    pub session_duration_ms: u64,
    pub state: String,
    pub connection_id: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub origin: String,
    pub connection_id: String,
    pub expires_at: u64,
    #[serde(skip)]
    pub cancel: CancellationToken,
}
#[derive(Default)]
pub struct Broker {
    tickets: HashMap<String, u64>,
    pairs: HashMap<String, Pair>,
    sessions: HashMap<String, Session>,
    grants: Vec<Grant>,
    pub connections: HashSet<String>,
}
impl Broker {
    pub fn sweep(&mut self) {
        let t = now();
        self.tickets.retain(|_, v| *v > t);
        self.pairs.retain(|_, v| v.expires_at > t);
        self.sessions.retain(|_, v| {
            if v.expires_at <= t {
                v.cancel.cancel();
                false
            } else {
                true
            }
        });
    }
    pub fn open(&mut self, id: String) -> Result<()> {
        if !request_id(&id) {
            return Err(invalid());
        }
        self.sweep();
        if self.pairs.contains_key(&id) || self.tickets.contains_key(&id) {
            return Ok(());
        }
        if self.tickets.len() >= 16 {
            return Err(Error::new("BUSY", "Too many launch requests", 429));
        }
        self.tickets.insert(id, now() + 120_000);
        Ok(())
    }
    pub fn pair(
        &mut self,
        site: &str,
        id: &str,
        challenge: &str,
        preferred: Option<String>,
        session_duration_ms: Option<u64>,
    ) -> Result<bool> {
        origin(site)?;
        let duration = session_duration_ms.unwrap_or_else(default_session_ms);
        validate_duration(duration)?;
        if !request_id(id)
            || !request_id(challenge)
            || preferred.as_ref().is_some_and(|s| !connection_id(s))
        {
            return Err(invalid());
        }
        self.sweep();
        if let Some(p) = self.pairs.get(id) {
            if p.origin != site
                || !equal(&p.challenge, challenge)
                || p.preferred_connection_id != preferred
                || p.session_duration_ms != duration
            {
                return Err(Error::new(
                    "PAIR_CONFLICT",
                    "Pairing belongs to another request",
                    409,
                ));
            }
            return Ok(false);
        }
        if !self.tickets.contains_key(id) {
            return Err(Error::new(
                "LAUNCH_REQUIRED",
                "Open the connector using the web button first",
                409,
            ));
        }
        if self.pairs.len() >= 16 {
            return Err(Error::new("BUSY", "Too many pending approvals", 429));
        }
        self.tickets.remove(id);
        let matches: Vec<_> = self
            .grants
            .iter()
            .filter(|g| {
                g.origin == site
                    && self.connections.contains(&g.connection_id)
                    && duration <= g.max_session_ms
                    && preferred.as_ref().is_none_or(|id| id == &g.connection_id)
            })
            .collect();
        let selected = if matches.len() == 1 {
            Some(matches[0].connection_id.clone())
        } else {
            None
        };
        let pending = selected.is_none();
        self.pairs.insert(
            id.into(),
            Pair {
                request_id: id.into(),
                origin: site.into(),
                challenge: challenge.into(),
                expires_at: now() + 120_000,
                preferred_connection_id: preferred,
                session_duration_ms: duration,
                state: if pending { "pending" } else { "approved" }.into(),
                connection_id: selected,
            },
        );
        Ok(pending)
    }
    pub fn approve(&mut self, id: &str, conn: &str, remember: bool) -> Result<Option<Grant>> {
        self.sweep();
        if !self.connections.contains(conn) {
            return Err(Error::new(
                "UNKNOWN_CONNECTION",
                "Unlock or configure this connection first",
                404,
            ));
        }
        let p = self
            .pairs
            .get_mut(id)
            .filter(|p| p.state == "pending")
            .ok_or(Error::new(
                "PAIR_EXPIRED",
                "This pairing is no longer pending",
                410,
            ))?;
        let grant = Grant {
            origin: p.origin.clone(),
            connection_id: conn.into(),
            max_session_ms: p.session_duration_ms,
        };
        if remember && self.grants.len() >= 128 && !self.grants.iter().any(|g|g.origin == grant.origin && g.connection_id == grant.connection_id) {
            return Err(Error::new(
                "GRANT_LIMIT",
                "Revoke an unused authorization first",
                429,
            ));
        }
        p.state = "approved".into();
        p.connection_id = Some(conn.into());
        if remember {
            self.grants.retain(|g| !(g.origin == grant.origin && g.connection_id == grant.connection_id));
            self.grants.push(grant.clone());
            Ok(Some(grant))
        } else {
            Ok(None)
        }
    }
    pub fn deny(&mut self, id: &str) {
        if let Some(p) = self.pairs.get_mut(id) {
            p.state = "denied".into();
        }
    }
    pub fn redeem(&mut self, site: &str, id: &str, verifier: &str) -> Result<Value> {
        self.sweep();
        if !request_id(verifier) {
            return Err(invalid());
        }
        let p = self
            .pairs
            .get(id)
            .filter(|p| p.origin == site && equal(&hash(verifier), &p.challenge))
            .ok_or(Error::new(
                "PAIR_INVALID",
                "Pairing not found or proof invalid",
                403,
            ))?;
        if p.state == "denied" {
            self.pairs.remove(id);
            return Err(Error::new(
                "PAIR_DENIED",
                "The user denied this request",
                403,
            ));
        }
        if p.state == "pending" {
            return Ok(json!({"state":"pending"}));
        }
        let conn = p
            .connection_id
            .clone()
            .filter(|s| self.connections.contains(s))
            .ok_or(Error::new(
                "UNKNOWN_CONNECTION",
                "Connection unavailable",
                404,
            ))?;
        if self.sessions.len() >= 64 {
            return Err(Error::new("BUSY", "Too many active sessions", 429));
        }
        let token = secret()?;
        let expires = now() + p.session_duration_ms;
        self.sessions.insert(
            hash(&token),
            Session {
                origin: site.into(),
                connection_id: conn.clone(),
                expires_at: expires,
                cancel: CancellationToken::new(),
            },
        );
        self.pairs.remove(id);
        Ok(json!({"state":"approved","token":token,"connectionId":conn,"expiresAt":expires}))
    }
    pub fn authorize(&mut self, site: &str, token: &str) -> Result<Session> {
        self.sweep();
        self.sessions
            .get(&hash(token))
            .filter(|s| request_id(token) && s.origin == site)
            .cloned()
            .ok_or(Error::new(
                "UNAUTHORIZED",
                "A valid origin-bound session is required",
                401,
            ))
    }
    pub fn release(&mut self, site: &str, token: &str) -> Result<()> {
        self.authorize(site, token)?.cancel.cancel();
        self.sessions.remove(&hash(token));
        Ok(())
    }
    pub fn cancel_pair(&mut self, site: &str, id: &str, verifier: &str) {
        if self
            .pairs
            .get(id)
            .is_some_and(|p| p.origin == site && equal(&hash(verifier), &p.challenge))
        {
            self.pairs.remove(id);
        }
    }
    pub fn restore(&mut self, grants: Vec<Grant>) -> Result<()> {
        if grants.len() > 128 {
            return Err(invalid());
        }
        for g in &grants {
            origin(&g.origin)?;
            validate_duration(g.max_session_ms)?;
            if !connection_id(&g.connection_id) {
                return Err(invalid());
            }
        }
        self.grants = grants;
        Ok(())
    }
    pub fn revoke(&mut self, site: Option<&str>, conn: Option<&str>) {
        let matches = |o: &str, c: &str| site.is_none_or(|v| v == o) && conn.is_none_or(|v| v == c);
        self.grants
            .retain(|g| !matches(&g.origin, &g.connection_id));
        self.sessions.retain(|_, s| {
            if matches(&s.origin, &s.connection_id) {
                s.cancel.cancel();
                false
            } else {
                true
            }
        });
        self.pairs.retain(|_, p| {
            !(site.is_none_or(|v| v == p.origin)
                && conn.is_none_or(|v| p.connection_id.as_deref() == Some(v)))
        });
    }
    pub fn snapshot(&mut self) -> Value {
        self.sweep();
        json!({"pending":self.pairs.values().filter(|p|p.state=="pending").collect::<Vec<_>>(),"grants":self.grants,"sessions":self.sessions.values().collect::<Vec<_>>()})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (Broker, String, String) {
        let mut b = Broker::default();
        b.connections.insert("db".into());
        let id = secret().unwrap();
        let v = secret().unwrap();
        b.open(id.clone()).unwrap();
        b.pair("https://emap.example", &id, &hash(&v), None, None)
            .unwrap();
        (b, id, v)
    }
    #[test]
    fn approval_and_single_use_proof() {
        let (mut b, id, v) = setup();
        assert_eq!(
            b.redeem("https://emap.example", &id, &v).unwrap()["state"],
            "pending"
        );
        b.approve(&id, "db", false).unwrap();
        let t = b.redeem("https://emap.example", &id, &v).unwrap();
        assert!(b.redeem("https://emap.example", &id, &v).is_err());
        assert!(b
            .authorize("https://evil.example", t["token"].as_str().unwrap())
            .is_err());
    }
    #[test]
    fn revocation_cancels_active_work() {
        let (mut b, id, v) = setup();
        b.approve(&id, "db", true).unwrap();
        let t = b.redeem("https://emap.example", &id, &v).unwrap();
        let s = b
            .authorize("https://emap.example", t["token"].as_str().unwrap())
            .unwrap();
        b.revoke(None, Some("db"));
        assert!(s.cancel.is_cancelled());
        assert!(b
            .authorize("https://emap.example", t["token"].as_str().unwrap())
            .is_err());
    }
    #[test]
    fn proof_and_ticket_are_required() {
        let (mut b, id, _) = setup();
        assert!(b
            .redeem("https://emap.example", &id, &secret().unwrap())
            .is_err());
        assert!(b
            .pair(
                "https://emap.example",
                &secret().unwrap(),
                &secret().unwrap(),
                None, None
            )
            .is_err());
    }
    #[test]
    fn snapshots_never_contain_secrets() {
        let (mut b, id, v) = setup();
        let s = b.snapshot().to_string();
        assert!(!s.contains(&v));
        assert!(!s.contains(&hash(&v)));
        assert!(s.contains(&id));
    }

    #[test]
    fn duration_controls_actual_expiry_and_longer_grants_need_consent() {
        let (mut b,id,v)=setup();
        b.approve(&id,"db",true).unwrap();
        let first=b.redeem("https://emap.example",&id,&v).unwrap();
        assert!(first["expiresAt"].as_u64().unwrap() <= now()+3_600_000);
        let id=secret().unwrap();let v=secret().unwrap();b.open(id.clone()).unwrap();
        assert!(b.pair("https://emap.example",&id,&hash(&v),None,Some(14_400_000)).unwrap());
        assert_eq!(b.snapshot()["pending"][0]["sessionDurationMs"],14_400_000);
        assert!(b.pair("https://emap.example",&id,&hash(&v),None,Some(3_600_000)).is_err());
        b.approve(&id,"db",true).unwrap();let before=now();
        let session=b.redeem("https://emap.example",&id,&v).unwrap();
        assert!(session["expiresAt"].as_u64().unwrap()>=before+14_400_000);
        let token=session["token"].as_str().unwrap();let held=b.authorize("https://emap.example",token).unwrap();
        b.sessions.get_mut(&hash(token)).unwrap().expires_at=0;b.sweep();
        assert!(held.cancel.is_cancelled());assert!(b.authorize("https://emap.example",token).is_err());
        let id=secret().unwrap();b.open(id.clone()).unwrap();
        assert!(!b.pair("https://emap.example",&id,&hash(&secret().unwrap()),None,Some(14_400_000)).unwrap());
    }
    #[test]
    fn invalid_duration_is_not_a_launch_ticket_consumer() {
        let (mut b,_,_)=setup();let id=secret().unwrap();let proof=secret().unwrap();b.open(id.clone()).unwrap();
        for ms in [0,59_999,86_400_001,u64::MAX] { assert!(b.pair("https://emap.example",&id,&proof,None,Some(ms)).is_err()); }
        assert!(b.pair("https://emap.example",&id,&proof,None,Some(60_000)).unwrap());
    }
}
