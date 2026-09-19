use crate::{
    broker::{Broker, Grant},
    database::Gateway,
    security::*,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU16, Ordering},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

pub struct Service {
    pub broker: Mutex<Broker>,
    pub gateways: Mutex<HashMap<String, Arc<Gateway>>>,
    pub output: mpsc::Sender<Value>,
    pub port: AtomicU16,
    pub stop: CancellationToken,
    pub requests: Arc<Semaphore>,
    pub rate: Mutex<(u64, u32)>,
}
impl Service {
    pub fn new(output: mpsc::Sender<Value>) -> Arc<Self> {
        Arc::new(Self {
            broker: Mutex::new(Broker::default()),
            gateways: Mutex::new(HashMap::new()),
            output,
            port: AtomicU16::new(0),
            stop: CancellationToken::new(),
            requests: Arc::new(Semaphore::new(16)),
            rate: Mutex::new((now(), 0)),
        })
    }
    pub fn notify(&self, event: &str) {
        let _ = self.output.try_send(json!({"event":event}));
    }
    pub fn shutdown(&self) {
        self.stop.cancel();
        self.broker.lock().unwrap().revoke(None, None);
        for g in self.gateways.lock().unwrap().values() {
            g.cancel.cancel();
        }
    }
    pub fn gateway(&self, id: &str) -> Result<Arc<Gateway>> {
        self.gateways
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or(Error::new(
                "UNKNOWN_CONNECTION",
                "Connection unavailable",
                404,
            ))
    }
    fn upsert(&self, profile: Profile) -> Result<()> {
        let mut gateways = self.gateways.lock().unwrap();
        if gateways.len() >= 32 && !gateways.contains_key(&profile.id) {
            return Err(Error::new(
                "CONNECTION_LIMIT",
                "At most 32 connections are supported",
                429,
            ));
        }
        let mut broker = self.broker.lock().unwrap();
        broker.revoke(None, Some(&profile.id));
        broker.connections.insert(profile.id.clone());
        if let Some(old) = gateways.insert(profile.id.clone(), Arc::new(Gateway::new(profile))) {
            old.cancel.cancel();
        }
        self.notify("changed");
        Ok(())
    }
    pub async fn command(&self, method: &str, p: Value) -> Result<Value> {
        match method {
            "initialize" => {
                object(&p, &["profiles", "grants"])?;
                let profiles = p["profiles"]
                    .as_array()
                    .filter(|v| v.len() <= 32)
                    .ok_or_else(invalid)?;
                let grants: Vec<Grant> =
                    serde_json::from_value(p["grants"].clone()).map_err(|_| invalid())?;
                if grants.len() > 128 {
                    return Err(invalid());
                }
                let profiles = profiles
                    .iter()
                    .cloned()
                    .map(Profile::parse)
                    .collect::<Result<Vec<_>>>()?;
                for profile in profiles {
                    self.upsert(profile)?;
                }
                self.broker.lock().unwrap().restore(grants)?;
                self.notify("changed");
                Ok(json!({"ok":true}))
            }
            "open" => {
                object(&p, &["url"])?;
                self.broker
                    .lock()
                    .unwrap()
                    .open(launch(text(&p, "url")?)?)?;
                Ok(json!({"ok":true}))
            }
            "validate" => {
                Profile::parse(p)?;
                Ok(json!({"ok":true}))
            }
            "upsert" => {
                self.upsert(Profile::parse(p)?)?;
                Ok(json!({"ok":true}))
            }
            "remove" => {
                object(&p, &["connectionId"])?;
                let id = text(&p, "connectionId")?;
                if !connection_id(id) {
                    return Err(invalid());
                }
                if let Some(g) = self.gateways.lock().unwrap().remove(id) {
                    g.cancel.cancel();
                }
                let mut broker = self.broker.lock().unwrap();
                broker.revoke(None, Some(id));
                broker.connections.remove(id);
                self.notify("changed");
                Ok(json!({"ok":true}))
            }
            "test" => {
                object(&p, &["connectionId"])?;
                self.gateway(text(&p, "connectionId")?)?
                    .execute("test", json!({}), self.stop.child_token())
                    .await
            }
            "approve" => {
                object(&p, &["requestId", "connectionId", "remember"])?;
                let grant = self.broker.lock().unwrap().approve(
                    text(&p, "requestId")?,
                    text(&p, "connectionId")?,
                    p["remember"].as_bool().ok_or_else(invalid)?,
                )?;
                self.notify("changed");
                Ok(json!({"grant":grant}))
            }
            "deny" => {
                object(&p, &["requestId"])?;
                self.broker.lock().unwrap().deny(text(&p, "requestId")?);
                self.notify("changed");
                Ok(json!({"ok":true}))
            }
            "revoke" => {
                object(&p, &["origin", "connectionId"])?;
                self.broker
                    .lock()
                    .unwrap()
                    .revoke(Some(text(&p, "origin")?), Some(text(&p, "connectionId")?));
                self.notify("changed");
                Ok(json!({"ok":true}))
            }
            "snapshot" => {
                object(&p, &[])?;
                let mut snapshot = self.broker.lock().unwrap().snapshot();
                snapshot["connections"] = json!(self
                    .gateways
                    .lock()
                    .unwrap()
                    .values()
                    .map(|g| g.profile.metadata())
                    .collect::<Vec<_>>());
                snapshot["port"] = json!(self.port.load(Ordering::Acquire));
                Ok(snapshot)
            }
            "shutdown" => {
                self.shutdown();
                Ok(json!({"ok":true}))
            }
            _ => Err(Error::new("INVALID_COMMAND", "Unknown native command", 400)),
        }
    }
}
