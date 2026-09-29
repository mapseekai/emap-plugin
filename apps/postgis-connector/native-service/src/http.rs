use crate::{database::MAX_BYTES, security::*, service::Service};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited, StreamBody, combinators::UnsyncBoxBody};
use hyper::{body::Incoming, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

type Reply = Response<UnsyncBoxBody<Bytes, Infallible>>;
enum Payload { Json(Vec<u8>), Stream(tokio::sync::mpsc::Receiver<Bytes>, tokio_util::sync::DropGuard) }
async fn stream_route(s: &Arc<Service>, req: Request<Incoming>, site: &str,
    disconnected: CancellationToken, permit: tokio::sync::OwnedSemaphorePermit) -> Result<Payload> {
    let token = header(&req,"authorization").strip_prefix("Bearer ").unwrap_or("");
    let session = s.broker.lock().unwrap().authorize(site,token)?;
    let p = body(req).await?;
    object(&p,&["connectionId","sql","parameters","geometryColumn","idColumn","sourceSrid","targetSrid","format","batchSize","maxRows"])?;
    if p["connectionId"].as_str() != Some(&session.connection_id) {
        return Err(Error::new("CONNECTION_DENIED","Session is not authorized for this database",403));
    }
    let gateway = s.gateway(&session.connection_id)?;
    let cancel = disconnected.child_token(); let guard = cancel.clone().drop_guard();
    let (tx,rx) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        let _permit = permit;
        gateway.stream_wkb(p,session.cancel,cancel,tx).await;
    });
    Ok(Payload::Stream(rx,guard))
}
fn header<'a>(r: &'a Request<Incoming>, name: &str) -> &'a str {
    r.headers()
        .get(name)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
}
async fn body(req: Request<Incoming>) -> Result<Value> {
    if header(&req, "content-type")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
        != "application/json"
    {
        return Err(Error::new("CONTENT_TYPE", "Use application/json", 415));
    }
    let bytes = tokio::time::timeout(
        Duration::from_secs(10),
        Limited::new(req.into_body(), 65536).collect(),
    )
    .await
    .map_err(|_| Error::new("TIMEOUT", "Request body timed out", 408))?
    .map_err(|_| {
        Error::new(
            "BODY_TOO_LARGE",
            "Request exceeds 64 KiB or is incomplete",
            413,
        )
    })?
    .to_bytes();
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::new("INVALID_JSON", "A JSON object is required", 400))?;
    if !value.is_object() {
        return Err(invalid());
    }
    Ok(value)
}
async fn route(
    s: &Arc<Service>,
    req: Request<Incoming>,
    site: &str,
    disconnected: CancellationToken,
) -> Result<Value> {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    if method == Method::GET && path == "/connector/health" {
        return Ok(json!({"app":"emap-connector","protocolVersion":1,"capabilities":{"sessionDuration":{"minMs":60000,"maxMs":86400000,"defaultMs":3600000},"wkbStream":true}}));
    }
    if method == Method::POST && path == "/connector/pair" {
        let p = body(req).await?;
        object(&p, &["requestId", "challenge", "preferredConnectionId", "sessionDurationMs"])?;
        let preferred = match p.get("preferredConnectionId") {
            None => None,
            Some(Value::String(v)) => Some(v.clone()),
            _ => return Err(invalid()),
        };
        let show = s.broker.lock().unwrap().pair(
            site,
            text(&p, "requestId")?,
            text(&p, "challenge")?,
            preferred,
            match p.get("sessionDurationMs") { None => None, Some(v) => Some(v.as_u64().ok_or_else(invalid)?) },
        )?;
        if show {
            s.notify("pairing");
        }
        return Ok(json!({"state":"pending"}));
    }
    if method == Method::POST
        && ["/connector/pair/status", "/connector/pair/cancel"].contains(&path.as_str())
    {
        let p = body(req).await?;
        object(&p, &["requestId", "verifier"])?;
        let mut broker = s.broker.lock().unwrap();
        if path.ends_with("/cancel") {
            broker.cancel_pair(site, text(&p, "requestId")?, text(&p, "verifier")?);
            s.notify("changed");
            return Ok(json!({"ok":true}));
        }
        return broker.redeem(site, text(&p, "requestId")?, text(&p, "verifier")?);
    }
    let token = header(&req, "authorization")
        .strip_prefix("Bearer ")
        .unwrap_or("")
        .to_owned();
    let session = s.broker.lock().unwrap().authorize(site, &token)?;
    if method == Method::POST && path == "/connector/session/close" {
        s.broker.lock().unwrap().release(site, &token)?;
        return Ok(json!({"ok":true}));
    }
    let gateway = s.gateway(&session.connection_id)?;
    let value = if method == Method::GET && path == "/postgis/connections" {
        json!([{"id":gateway.profile.id,"label":gateway.profile.label}])
    } else {
        let (kind, p) = if method == Method::GET && path == "/postgis/tables" {
            let params = url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
                .collect::<Vec<_>>();
            let id = params
                .iter()
                .find(|(k, _)| k == "connectionId")
                .map(|(_, v)| v.to_string());
            if id.as_deref() != Some(&session.connection_id) {
                return Err(Error::new(
                    "CONNECTION_DENIED",
                    "Session is not authorized for this database",
                    403,
                ));
            }
            ("tables", json!({}))
        } else if method == Method::POST
            && ["/postgis/query", "/postgis/wkb", "/postgis/test"].contains(&path.as_str())
        {
            let p = body(req).await?;
            object(
                &p,
                &[
                    "connectionId",
                    "sql",
                    "parameters",
                    "limit",
                    "offset",
                    "geometryColumn",
                    "idColumn",
                    "sourceSrid",
                    "targetSrid",
                    "format",
                ],
            )?;
            if p["connectionId"].as_str() != Some(&session.connection_id) {
                return Err(Error::new(
                    "CONNECTION_DENIED",
                    "Session is not authorized for this database",
                    403,
                ));
            }
            (path.rsplit('/').next().unwrap(), p)
        } else {
            return Err(Error::new("NOT_FOUND", "Unknown endpoint", 404));
        };
        tokio::select! {
            biased;
            _=disconnected.cancelled()=>return Err(Error::new("CANCELLED","Browser disconnected",499)),
            result=gateway.execute(kind,p,session.cancel.clone())=>result?,
        }
    };
    if session.cancel.is_cancelled() || gateway.cancel.is_cancelled() {
        return Err(Error::new("REVOKED", "Authorization revoked", 403));
    }
    Ok(value)
}
async fn respond(
    s: Arc<Service>,
    req: Request<Incoming>,
    disconnected: CancellationToken,
) -> std::result::Result<Reply, Infallible> {
    let port = s.port.load(Ordering::Acquire);
    let site = origin(header(&req, "origin"));
    let host_ok = header(&req, "host") == format!("127.0.0.1:{port}")
        && req.uri().scheme().is_none()
        && req.uri().authority().is_none()
        && !req.uri().path().starts_with("//");
    let preflight = req.method() == Method::OPTIONS;
    let private = header(&req, "access-control-request-private-network") == "true";
    let result = async {
        if !host_ok {
            return Err(Error::new("HOST_DENIED", "Invalid loopback host", 403));
        }
        let site = site.as_ref().map_err(Clone::clone)?;
        {
            let mut rate = s.rate.lock().unwrap();
            if now().saturating_sub(rate.0) > 60_000 {
                *rate = (now(), 0);
            }
            rate.1 += 1;
            if rate.1 > 600 {
                return Err(Error::new("BUSY", "Connector request budget exceeded", 429));
            }
        }
        if preflight {
            return Ok(None);
        }
        let _permit = s
            .requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("BUSY", "Too many active requests", 429))?;
        if req.method() == Method::POST && req.uri().path() == "/postgis/wkb/stream" {
            return Ok(Some(stream_route(&s, req, site, disconnected, _permit).await?));
        }
        let value =
            tokio::time::timeout(Duration::from_secs(25), route(&s, req, site, disconnected))
                .await
                .map_err(|_| Error::new("TIMEOUT", "Request timed out", 408))??;
        let bytes = serde_json::to_vec(&value).map_err(|_| invalid())?;
        if bytes.len() > MAX_BYTES {
            return Err(Error::new(
                "RESULT_TOO_LARGE",
                "Response exceeds byte budget",
                413,
            ));
        }
        Ok(Some(Payload::Json(bytes)))
    }
    .await;
    let (status, payload) = match result {
        Ok(Some(payload)) => (StatusCode::OK, payload),
        Ok(None) => (StatusCode::NO_CONTENT, Payload::Json(vec![])),
        Err(e) => (
            StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_REQUEST),
            Payload::Json(serde_json::to_vec(&json!({"error":e.value()})).unwrap()),
        ),
    };
    let is_stream = matches!(&payload, Payload::Stream(..));
    let mut reply = Response::builder()
        .status(status)
        .header("Content-Type", if is_stream { "application/x-ndjson" } else { "application/json; charset=utf-8" })
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer");
    if host_ok {
        if let Ok(site) = site {
            reply = reply
                .header("Access-Control-Allow-Origin", site)
                .header("Vary", "Origin");
        }
    }
    if status == StatusCode::NO_CONTENT {
        reply = reply
            .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            .header(
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization",
            );
        if private {
            reply = reply.header("Access-Control-Allow-Private-Network", "true");
        }
    }
    if status.is_client_error() || status.is_server_error() {
        reply = reply.header("Connection", "close");
    }
    let body = match payload {
        Payload::Json(bytes) => Full::new(Bytes::from(bytes)).boxed_unsync(),
        Payload::Stream(rx,guard) => {
            let stream = futures_util::stream::unfold((rx,guard),|(mut rx,guard)|async move {
                rx.recv().await.map(|bytes|(Ok::<_,Infallible>(hyper::body::Frame::data(bytes)),(rx,guard)))
            });
            StreamBody::new(stream).boxed_unsync()
        }
    };
    Ok(reply.body(body).unwrap())
}
pub async fn start(s: Arc<Service>, port: u16) -> std::io::Result<()> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    s.port
        .store(listener.local_addr()?.port(), Ordering::Release);
    let sockets = Arc::new(tokio::sync::Semaphore::new(64));
    let state = s.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _=state.stop.cancelled()=>break,
                _=interval.tick()=>state.broker.lock().unwrap().sweep(),
                accepted=listener.accept()=>{
                    let Ok((socket,_))=accepted else{break;};let Ok(permit)=sockets.clone().try_acquire_owned() else{drop(socket);continue;};
                    let service=state.clone();let cancel=CancellationToken::new();
                    tokio::spawn(async move {
                        let _permit=permit;let handler_state=service.clone();let handler_cancel=cancel.clone();
                        let mut builder=hyper::server::conn::http1::Builder::new();
                        builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10)).max_buf_size(65536);
                        let connection=builder.serve_connection(TokioIo::new(socket),hyper::service::service_fn(move|req|respond(handler_state.clone(),req,handler_cancel.clone())));
                        tokio::select!{_=service.stop.cancelled()=>(),_=connection=>()};cancel.cancel();
                    });
                },
            }
        }
    });
    Ok(())
}
