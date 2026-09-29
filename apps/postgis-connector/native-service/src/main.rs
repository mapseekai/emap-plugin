mod broker;
mod database;
mod http;
mod security;
mod service;
mod sql;
use security::*;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--stdio") || args.len() > 3 {
        println!("postgis-connector native service; managed by the desktop app. Developer IPC: --stdio [port]");
        return;
    }
    let port = match args.get(2) {
        None => 18787,
        Some(s) => match s.parse::<u16>() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("Invalid port");
                std::process::exit(1);
            }
        },
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(64);
    let s = service::Service::new(tx.clone());
    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(v) = rx.recv().await {
            let mut bytes = serde_json::to_vec(&v).unwrap();
            bytes.push(b'\n');
            if out.write_all(&bytes).await.is_err() || out.flush().await.is_err() {
                break;
            }
        }
    });
    if let Err(error) = http::start(s.clone(), port).await {
        let code = if error.kind() == std::io::ErrorKind::AddrInUse {
            "EADDRINUSE"
        } else {
            "START_FAILED"
        };
        let _=tx.send(json!({"event":"fatal","error":{"code":code,"message":"Unable to start the local connector; check for a conflicting process"}})).await;
        drop(s);
        drop(tx);
        let _ = writer.await;
        std::process::exit(1);
    }
    let _ = tx
        .send(json!({"event":"ready","port":s.port.load(Ordering::Acquire),"protocolVersion":1}))
        .await;
    let mut input = tokio::io::stdin();
    let mut buffer = Vec::<u8>::new();
    let mut chunk = [0u8; 8192];
    'read: loop {
        let count = tokio::select! {_=s.stop.cancelled()=>break,_=tokio::signal::ctrl_c()=>break,result=input.read(&mut chunk)=>match result{Ok(n)=>n,Err(_)=>break}};
        if count == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.len() > 262144 {
            break;
        }
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            let message = serde_json::from_slice::<Value>(&line);
            let id = message
                .as_ref()
                .ok()
                .and_then(|v| v["id"].as_str())
                .filter(|s| !s.is_empty() && s.len() <= 80)
                .map(str::to_owned);
            let result = async {
                let v = message.map_err(|_| invalid())?;
                object(&v, &["id", "method", "params"])?;
                if id.is_none() {
                    return Err(invalid());
                }
                s.command(
                    text(&v, "method")?,
                    v.get("params").cloned().unwrap_or(json!({})),
                )
                .await
            }
            .await;
            let value = match result {
                Ok(v) => json!({"id":id,"result":v}),
                Err(e) => json!({"id":id,"error":e.value()}),
            };
            if tx.send(value).await.is_err() {
                break 'read;
            }
        }
    }
    s.shutdown();
    drop(s);
    drop(tx);
    // The HTTP listener releases its final service reference after cancellation.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), writer).await;
}
