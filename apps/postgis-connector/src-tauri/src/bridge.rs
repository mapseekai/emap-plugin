use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::{ShellExt, process::{CommandChild, CommandEvent}};
use tokio::sync::oneshot;

type Reply = oneshot::Sender<Result<Value, String>>;
pub struct Bridge {
    child: Mutex<Option<CommandChild>>, pending: Mutex<HashMap<String, Reply>>,
    ready: AtomicBool, pub failed: Mutex<Option<String>>,
}
impl Bridge {
    pub fn start(app: &AppHandle) -> Result<Arc<Self>, String> {
        let command = app.shell().sidecar("postgis-connector-service").map_err(|_| "无法定位原生查询服务")?
            .args(["--stdio"]);
        let (mut rx, child) = command.spawn().map_err(|_| "无法启动本地查询进程")?;
        let bridge = Arc::new(Self { child: Mutex::new(Some(child)), pending: Mutex::new(HashMap::new()), ready: AtomicBool::new(false), failed: Mutex::new(None) });
        let reader = bridge.clone(); let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        if bytes.len() > 262144 { reader.fail("服务返回异常大小的数据"); continue; }
                        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                            if let Some(id) = value["id"].as_str() {
                                if let Some(tx) = reader.pending.lock().unwrap().remove(id) {
                                    let result = if value.get("error").is_some() {
                                        Err(format!("{}: {}", value["error"]["code"].as_str().unwrap_or("ERROR"), value["error"]["message"].as_str().unwrap_or("操作失败")))
                                    } else { Ok(value["result"].clone()) };
                                    let _ = tx.send(result);
                                }
                            } else if let Some(event) = value["event"].as_str() {
                                if event == "ready" { reader.ready.store(true, Ordering::Release); }
                                if event == "fatal" { reader.fail(value["error"]["message"].as_str().unwrap_or("本地服务启动失败")); }
                                let _ = handle.emit("connector-event", &value);
                                if event == "pairing" || event == "fatal" { super::show_main(&handle); }
                            }
                        }
                    }
                    CommandEvent::Terminated(_) | CommandEvent::Error(_) => {
                        reader.fail("本地查询服务已停止，请退出并重新打开连接器。");
                        let _ = handle.emit("connector-event", json!({"event":"stopped"}));
                    }
                    // Never relay stderr to the webview; driver errors may include sensitive input.
                    _ => (),
                }
            }
            reader.fail("本地查询服务连接已关闭");
        });
        Ok(bridge)
    }
    fn fail(&self, message: &str) {
        *self.failed.lock().unwrap() = Some(message.into());
        for (_, tx) in self.pending.lock().unwrap().drain() { let _ = tx.send(Err(message.into())); }
    }
    pub async fn wait_ready(&self) -> Result<(), String> {
        for _ in 0..200 {
            if let Some(error) = self.failed.lock().unwrap().clone() { return Err(error); }
            if self.ready.load(Ordering::Acquire) { return Ok(()); }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("连接器启动超时".into())
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if let Some(error) = self.failed.lock().unwrap().clone() { return Err(error); }
        let id = uuid::Uuid::new_v4().to_string(); let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 32 { return Err("连接器忙，请稍后重试".into()); }
            pending.insert(id.clone(), tx);
        }
        let payload = serde_json::to_string(&json!({"id":id,"method":method,"params":params})).map_err(|_| "无法编码命令")? + "\n";
        let written = self.child.lock().unwrap().as_mut().ok_or("查询进程已关闭".to_string()).and_then(|child| child.write(payload.as_bytes()).map_err(|_| "无法写入查询进程".to_string()));
        if let Err(error) = written { self.pending.lock().unwrap().remove(&id); return Err(error); }
        let result = tokio::time::timeout(Duration::from_secs(25), rx).await;
        self.pending.lock().unwrap().remove(&id);
        match result { Ok(Ok(value)) => value, Ok(Err(_)) => Err("查询进程已退出".into()), Err(_) => Err("本地操作超时".into()) }
    }
    pub fn kill(&self) { if let Some(child) = self.child.lock().unwrap().take() { let _ = child.kill(); } }
}
