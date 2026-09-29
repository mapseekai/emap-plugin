use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Write, path::PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedProfile {
    pub id: String, pub label: String, pub host: String, pub port: u16,
    pub database: String, pub user: String, pub tls: String,
    #[serde(default)] pub ca: String,
    pub remember_password: bool,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant { pub origin: String, pub connection_id: String,
    #[serde(default = "default_session_ms")] pub max_session_ms: u64 }
fn default_session_ms() -> u64 { 3_600_000 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings { pub version: u8, pub profiles: Vec<SavedProfile>, pub grants: Vec<Grant> }
impl Default for Settings {
    fn default() -> Self { Self { version: 1, profiles: vec![], grants: vec![] } }
}
pub struct Vault { path: PathBuf, pub settings: Settings }
fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.mapseekai.emap-connector", &format!("database-{id}"))
        .map_err(|_| "系统凭据存储不可用；可取消“记住密码”后仅本次使用。".to_string())
}
impl SavedProfile {
    pub fn with_password(&self, password: String) -> Value {
        json!({"id":self.id,"label":self.label,"host":self.host,"port":self.port,
            "database":self.database,"user":self.user,"tls":self.tls,"ca":self.ca,"password":password})
    }
}
impl Vault {
    pub fn load(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|_| "无法创建连接器配置目录")?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(|_| "无法保护配置目录")?;
        }
        let path = directory.join("settings.json");
        let settings: Settings = if path.exists() {
            if fs::metadata(&path).map_err(|_| "无法读取配置")?.len() > 4 * 1024 * 1024 { return Err("配置文件过大".into()); }
            serde_json::from_slice(&fs::read(&path).map_err(|_| "无法读取配置")?).map_err(|_| "配置文件损坏；为避免数据丢失，未覆盖原文件。")?
        } else { Settings::default() };
        if settings.version != 1 || settings.profiles.len() > 32 || settings.grants.len() > 128 { return Err("不支持的配置版本或大小".into()); }
        Ok(Self { path, settings })
    }
    pub fn available_profiles(&self) -> Vec<Value> {
        self.settings.profiles.iter().filter_map(|p| {
            if !p.remember_password { return None; }
            // A locked/missing keychain never downgrades to plaintext storage.
            let password = entry(&p.id).ok()?.get_password().ok()?;
            Some(p.with_password(password))
        }).collect()
    }
    fn persist(&self) -> Result<(), String> {
        let parent = self.path.parent().ok_or("无效配置路径")?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法保存配置")?;
        let data = serde_json::to_vec_pretty(&self.settings).map_err(|_| "无法序列化配置")?;
        file.write_all(&data).map_err(|_| "无法写入配置")?;
        file.as_file().sync_all().map_err(|_| "无法同步配置")?;
        file.persist(&self.path).map_err(|_| "无法原子替换配置")?;
        Ok(())
    }
    pub fn save(&mut self, profile: SavedProfile, password: &str) -> Result<(), String> {
        if self.settings.profiles.len() >= 32 && !self.settings.profiles.iter().any(|p| p.id == profile.id) { return Err("最多保存 32 个连接".into()); }
        if profile.remember_password {
            entry(&profile.id)?.set_password(password).map_err(|_| "系统凭据存储拒绝保存；请解锁钥匙串，或取消“记住密码”仅本次使用。")?;
        } else if self.settings.profiles.iter().any(|p| p.id == profile.id && p.remember_password) {
            // Session-only mode must also work without an OS keychain service.
            // Access the keychain only when deleting a previously persisted password.
            match entry(&profile.id)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => (),
                Err(_) => return Err("无法删除旧的系统凭据，请先解锁凭据存储。".into()),
            }
        }
        let old = self.settings.clone();
        self.settings.profiles.retain(|p| p.id != profile.id);
        self.settings.grants.retain(|g| g.connection_id != profile.id);
        self.settings.profiles.push(profile);
        if let Err(error) = self.persist() { self.settings = old; return Err(error); }
        Ok(())
    }
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        if self.settings.profiles.iter().any(|p| p.id == id && p.remember_password) {
            match entry(id)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => (), Err(_) => return Err("无法删除系统凭据，请先解锁。".into()) }
        }
        self.settings.profiles.retain(|p| p.id != id); self.settings.grants.retain(|g| g.connection_id != id); self.persist()
    }
    pub fn remember(&mut self, grant: Grant) -> Result<(), String> {
        let old = self.settings.grants.clone();
        self.settings.grants.retain(|g| !(g.origin == grant.origin && g.connection_id == grant.connection_id));
        self.settings.grants.push(grant);
        if let Err(error) = self.persist() { self.settings.grants = old; return Err(error); }
        Ok(())
    }
    pub fn revoke(&mut self, origin: &str, connection: &str) -> Result<(), String> {
        self.settings.grants.retain(|g| g.origin != origin || g.connection_id != connection); self.persist()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_cannot_serialize_a_password() {
        let p = SavedProfile { id:"a".into(),label:"A".into(),host:"127.0.0.1".into(),port:5432,database:"gis".into(),user:"reader".into(),tls:"local".into(),ca:"".into(),remember_password:false };
        let value = serde_json::to_value(&p).unwrap(); assert!(value.get("password").is_none());
        assert_eq!(p.with_password("test-only".into())["password"], "test-only");
    }
    #[test]
    fn session_only_profile_does_not_need_a_keychain() {
        let d = tempfile::tempdir().unwrap(); let mut v = Vault::load(d.path().into()).unwrap();
        let p = SavedProfile { id:"ephemeral-test".into(),label:"A".into(),host:"127.0.0.1".into(),port:5432,database:"gis".into(),user:"reader".into(),tls:"local".into(),ca:"".into(),remember_password:false };
        v.save(p, "ephemeral-secret-test-only").unwrap();
        let disk = fs::read_to_string(d.path().join("settings.json")).unwrap();
        assert!(!disk.contains("ephemeral-secret-test-only")); assert!(v.available_profiles().is_empty());
    }
    #[test]
    fn invalid_settings_are_not_overwritten() {
        let d = tempfile::tempdir().unwrap(); let path = d.path().join("settings.json");
        fs::write(&path, "corrupt").unwrap(); assert!(Vault::load(d.path().into()).is_err()); assert_eq!(fs::read_to_string(path).unwrap(), "corrupt");
    }
    #[test]
    fn stores_grants_without_secrets_and_supports_revocation() {
        let d = tempfile::tempdir().unwrap(); let mut v = Vault::load(d.path().into()).unwrap();
        v.remember(Grant { origin:"https://emap.example".into(), connection_id:"roads".into(), max_session_ms:3_600_000 }).unwrap();
        assert_eq!(Vault::load(d.path().into()).unwrap().settings.grants.len(), 1);
        v.revoke("https://emap.example", "roads").unwrap(); assert!(Vault::load(d.path().into()).unwrap().settings.grants.is_empty());
    }

    #[test]
    fn legacy_grants_default_to_one_hour_and_new_duration_is_persisted() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("settings.json"),r#"{"version":1,"profiles":[],"grants":[{"origin":"https://emap.example","connectionId":"roads"}]}"#).unwrap();
        let mut v = Vault::load(d.path().into()).unwrap();
        assert_eq!(v.settings.grants[0].max_session_ms,3_600_000);
        v.remember(Grant { origin:"https://emap.example".into(),connection_id:"roads".into(),max_session_ms:14_400_000 }).unwrap();
        let v = Vault::load(d.path().into()).unwrap();
        assert_eq!(v.settings.grants.len(),1);assert_eq!(v.settings.grants[0].max_session_ms,14_400_000);
    }
}
