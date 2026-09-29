mod bridge;
mod vault;
use bridge::Bridge;
use vault::{Vault, SavedProfile, Grant};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use tauri::{AppHandle, Emitter, Manager, State, menu::{Menu, MenuItem}, tray::TrayIconBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

struct AppState {
    bridge: Arc<Bridge>, vault: Mutex<Vault>, gate: tokio::sync::Mutex<()>,
    initialized: AtomicBool, error: Mutex<Option<String>>,
}
fn ready(state: &AppState) -> Result<(), String> {
    if let Some(error) = state.error.lock().unwrap().clone() { return Err(error); }
    if !state.initialized.load(Ordering::Acquire) { return Err("正在启动本地连接器…".into()); }
    Ok(())
}
pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); }
}
fn valid_launch(input: &str) -> bool {
    let Ok(url) = url::Url::parse(input) else { return false; };
    let pairs: Vec<_> = url.query_pairs().collect();
    url.scheme() == "emap-connect" && url.host_str() == Some("start") && url.username().is_empty() && url.password().is_none() &&
        url.port().is_none() && (url.path().is_empty() || url.path() == "/") && url.fragment().is_none() &&
        pairs.len() == 1 && pairs[0].0 == "request_id" && pairs[0].1.len() == 43 &&
        pairs[0].1.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn launch(app: AppHandle, input: String) {
    if !valid_launch(&input) { return; }
    tauri::async_runtime::spawn(async move {
        // Keep the launch pending while the user unlocks the OS credential store.
        // Do not issue the ticket until profiles AND remembered grants are restored:
        // otherwise a fast webpage could pair before its existing consent is loaded.
        for _ in 0..1200 {
            if let Some(state) = app.try_state::<AppState>() {
                if state.initialized.load(Ordering::Acquire) {
                    if state.bridge.request("open", json!({"url":input})).await.is_err() { show_main(&app); }
                    return;
                }
                if state.error.lock().unwrap().is_some() { show_main(&app); return; }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        show_main(&app);
    });
}
#[tauri::command]
async fn snapshot(state: State<'_, AppState>) -> Result<Value, String> {
    ready(&state)?;
    let mut value = state.bridge.request("snapshot", json!({})).await?;
    value["savedProfiles"] = serde_json::to_value(&state.vault.lock().unwrap().settings.profiles).map_err(|_| "无法读取连接列表")?;
    Ok(value)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveInput {
    id: Option<String>, label: String, host: String, port: u16, database: String,
    user: String, password: String, tls: String, #[serde(default)] ca: String, remember_password: bool,
}
#[tauri::command]
async fn save_connection(state: State<'_, AppState>, input: SaveInput) -> Result<Value, String> {
    ready(&state)?; let _guard = state.gate.lock().await;
    let profile = SavedProfile { id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()), label:input.label,
        host:input.host,port:input.port,database:input.database,user:input.user,tls:input.tls,ca:input.ca,remember_password:input.remember_password };
    let config = profile.with_password(input.password.clone());
    state.bridge.request("validate", config.clone()).await?;
    // Revoke old access before a profile can be repointed at another database.
    state.bridge.request("remove", json!({"connectionId":profile.id})).await?;
    state.vault.lock().unwrap().save(profile.clone(), &input.password)?;
    state.bridge.request("upsert", config).await?;
    Ok(json!({"id":profile.id}))
}
#[tauri::command]
async fn test_connection(state: State<'_, AppState>, connection_id: String) -> Result<Value, String> {
    ready(&state)?; state.bridge.request("test", json!({"connectionId":connection_id})).await
}
#[tauri::command]
async fn delete_connection(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    ready(&state)?; let _guard = state.gate.lock().await;
    state.bridge.request("remove", json!({"connectionId":connection_id})).await?;
    state.vault.lock().unwrap().remove(&connection_id)
}
#[tauri::command]
async fn approve(state: State<'_, AppState>, request_id: String, connection_id: String, remember: bool) -> Result<(), String> {
    ready(&state)?; let _guard = state.gate.lock().await;
    let result = state.bridge.request("approve", json!({"requestId":request_id,"connectionId":connection_id,"remember":remember})).await?;
    if remember {
        let grant: Grant = serde_json::from_value(result["grant"].clone()).map_err(|_| "无效授权记录")?;
        let saved = state.vault.lock().unwrap().remember(grant.clone());
        if saved.is_err() {
            let _ = state.bridge.request("revoke", json!({"origin":grant.origin,"connectionId":grant.connection_id})).await;
            return Err("无法保存授权，已撤销本次授权，请重试。".into());
        }
    }
    Ok(())
}
#[tauri::command]
async fn deny(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    ready(&state)?; state.bridge.request("deny", json!({"requestId":request_id})).await?; Ok(())
}
#[tauri::command]
async fn revoke(state: State<'_, AppState>, origin: String, connection_id: String) -> Result<(), String> {
    ready(&state)?; let _guard = state.gate.lock().await;
    state.bridge.request("revoke", json!({"origin":origin,"connectionId":connection_id})).await?;
    state.vault.lock().unwrap().revoke(&origin, &connection_id)
}
#[tauri::command]
fn quit(app: AppHandle) { if let Some(state) = app.try_state::<AppState>() { state.bridge.kill(); } app.exit(0); }

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !argv.iter().any(|v| v.starts_with("emap-connect:")) { show_main(app); }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![snapshot, save_connection, test_connection, delete_connection, approve, deny, revoke, quit])
        .setup(|app| {
            let handle = app.handle().clone();
            let vault = Vault::load(app.path().app_config_dir()?).map_err(std::io::Error::other)?;
            let bridge = Bridge::start(&handle).map_err(std::io::Error::other)?;
            app.manage(AppState { bridge:bridge.clone(),vault:Mutex::new(vault),gate:tokio::sync::Mutex::new(()),initialized:AtomicBool::new(false),error:Mutex::new(None) });
            let show = MenuItem::with_id(app, "show", "打开 postgis-connector", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "quit", "退出连接器", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &exit])?;
            let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("postgis-connector · 本地数据库连接器").on_menu_event(|app, event| {
                match event.id.as_ref() { "show" => show_main(app), "quit" => quit(app.clone()), _ => () }
            });
            // Monochrome template on macOS; full-color PostGIS mark on Windows and Linux.
            #[cfg(target_os = "macos")]
            { tray = tray.icon(tauri::include_image!("icons/tray/32x32.png")).icon_as_template(true); }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            // Some Linux desktops have no tray host. The window remains the exit/control surface.
            let tray_ok = tray.build(app).is_ok();
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if tray_ok { api.prevent_close(); let _ = w.hide(); }
                    }
                });
            }
            #[cfg(target_os = "linux")]
            if let Err(_) = app.deep_link().register_all() { let _ = handle.emit("connector-event", json!({"event":"registration-warning"})); }
            let listener = handle.clone();
            app.deep_link().on_open_url(move |event| { for url in event.urls() { launch(listener.clone(), url.to_string()); } });
            let current = app.deep_link().get_current()?.unwrap_or_default();
            let opened_from_link = current.iter().any(|u| valid_launch(u.as_str()));
            for url in current { launch(handle.clone(), url.to_string()); }
            if !opened_from_link || !tray_ok { show_main(&handle); }
            tauri::async_runtime::spawn(async move {
                let initialized = async {
                    bridge.wait_ready().await?;
                    let (profiles, grants) = {
                        let state = handle.state::<AppState>(); let v = state.vault.lock().unwrap();
                        (v.available_profiles(), v.settings.grants.clone())
                    };
                    bridge.request("initialize", json!({"profiles":profiles,"grants":grants})).await?;
                    Ok::<(), String>(())
                }.await;
                let state = handle.state::<AppState>();
                if let Err(error) = initialized { *state.error.lock().unwrap() = Some(error); show_main(&handle); }
                else { state.initialized.store(true, Ordering::Release); }
                let _ = handle.emit("connector-event", json!({"event":"initialized"}));
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Unable to start postgis-connector");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) { if let Some(state) = handle.try_state::<AppState>() { state.bridge.kill(); } }
    });
}
#[cfg(test)]
mod tests {
    use super::valid_launch;
    #[test] fn deep_links_cannot_contain_commands_credentials_or_redirects() {
        let id = "a".repeat(43); assert!(valid_launch(&format!("emap-connect://start?request_id={id}")));
        for bad in [format!("emap-connect://start?request_id={id}&sql=select"), format!("emap-connect://start?request_id={id}&request_id={id}"), format!("emap-connect://user:pass@start?request_id={id}"), "emap-connect://start?request_id=short".into(), format!("emap-connect://start?request_id={id}#secret")] { assert!(!valid_launch(&bad)); }
    }
}
