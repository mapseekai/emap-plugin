use crate::{
    security::*,
    sql::{identifier as qi, literal as qs, select_sql},
};
use bytes::BytesMut;
use futures_util::{pin_mut, TryStreamExt};
use native_tls::{Certificate, TlsConnector};
use postgres_native_tls::MakeTlsConnector;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{sync::Semaphore, task::JoinHandle};
use tokio_postgres::{
    types::{Format, IsNull, Kind, ToSql, Type},
    Client, Config, NoTls,
};
use tokio_util::sync::CancellationToken;

pub const MAX_BYTES: usize = 10_485_760;
pub struct Gateway {
    pub profile: Profile,
    permits: Arc<Semaphore>,
    pub cancel: CancellationToken,
}
struct Connection {
    client: Client,
    driver: Option<JoinHandle<()>>,
    tls: Option<MakeTlsConnector>,
    finished: bool,
}
// Closing TCP alone does not promptly interrupt PostgreSQL's CPU/pg_sleep work.
// Send a protocol CancelRequest first, then close our never-reused connection.
impl Drop for Connection {
    fn drop(&mut self) {
        let Some(driver) = self.driver.take() else {
            return;
        };
        if self.finished {
            driver.abort();
            return;
        }
        let token = self.client.cancel_token();
        let tls = self.tls.clone();
        tokio::spawn(async move {
            let cancel = async {
                match tls {
                    Some(tls) => {
                        let _ = token.cancel_query(tls).await;
                    }
                    None => {
                        let _ = token.cancel_query(NoTls).await;
                    }
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(1), cancel).await;
            driver.abort();
        });
    }
}
impl Gateway {
    pub fn new(profile: Profile) -> Self {
        Self {
            profile,
            permits: Arc::new(Semaphore::new(4)),
            cancel: CancellationToken::new(),
        }
    }
    async fn connect(&self) -> Result<Connection> {
        let p = &self.profile;
        let mut config = Config::new();
        config
            .host(&p.host)
            .port(p.port)
            .dbname(&p.database)
            .user(&p.user)
            .password(&p.password)
            .application_name("postgis-connector")
            .connect_timeout(Duration::from_secs(5));
        let connection = if p.tls == "local" {
            config.ssl_mode(tokio_postgres::config::SslMode::Disable);
            let (client, connection) = config.connect(NoTls).await?;
            Connection {
                client,
                driver: Some(tokio::spawn(async move {
                    let _ = connection.await;
                })),
                tls: None,
                finished: false,
            }
        } else {
            config.ssl_mode(tokio_postgres::config::SslMode::Require);
            let mut tls = TlsConnector::builder();
            if !p.ca.is_empty() {
                // Accept a PEM CA chain without weakening certificate or hostname verification.
                let mut count = 0;
                for part in p.ca.split_inclusive("-----END CERTIFICATE-----") {
                    if part.trim().is_empty() {
                        continue;
                    }
                    let cert = Certificate::from_pem(part.as_bytes())
                        .map_err(|_| Error::new("INVALID_CA", "Invalid CA certificate", 400))?;
                    tls.add_root_certificate(cert);
                    count += 1;
                }
                if count == 0 {
                    return Err(Error::new("INVALID_CA", "Invalid CA certificate", 400));
                }
            }
            let tls = tls
                .build()
                .map_err(|_| Error::new("TLS_FAILED", "Unable to initialize verified TLS", 400))?;
            let tls = MakeTlsConnector::new(tls);
            let (client, connection) = config.connect(tls.clone()).await?;
            Connection {
                client,
                driver: Some(tokio::spawn(async move {
                    let _ = connection.await;
                })),
                tls: Some(tls),
                finished: false,
            }
        };
        connection.client.batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout=15000; SET LOCAL lock_timeout=2000; SET LOCAL standard_conforming_strings=on").await?;
        // Accept all login roles, including administrators. SQL policy and the
        // READ ONLY transaction still apply; only trusted sites should be authorized.
        Ok(connection)
    }
    pub async fn execute(
        &self,
        kind: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let _permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("BUSY", "Database query budget exceeded", 429))?;
        let work = async {
            let mut conn = self.connect().await?;
            let result = match kind {
                "test" => {
                    let (ns, _) = spatial(&conn.client).await?;
                    let row = conn
                        .client
                        .query_one(&format!("SELECT {}.postgis_lib_version()", qi(&ns)), &[])
                        .await?;
                    json!({"ok":true,"postgisVersion":row.try_get::<_,String>(0)?})
                }
                "tables" => tables(&conn.client).await?,
                "query" | "wkb" => query(&conn.client, &input, kind == "wkb").await?,
                _ => return Err(invalid()),
            };
            conn.client.batch_execute("ROLLBACK").await?;
            conn.finished = true;
            Ok(result)
        };
        tokio::select! {
            biased;
            _=self.cancel.cancelled()=>Err(Error::new("REVOKED","Connection was removed or changed",403)),
            _=cancel.cancelled()=>Err(Error::new("REVOKED","Query cancelled or authorization revoked",403)),
            result=tokio::time::timeout(Duration::from_secs(15),work)=>result.map_err(|_|Error::new("TIMEOUT","Query time limit exceeded",408))?,
        }
    }
}
async fn spatial(client: &Client) -> Result<(String, Vec<u32>)> {
    let rows=client.query("SELECT n.nspname AS schema,t.oid FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace JOIN pg_catalog.pg_type t ON t.typnamespace=n.oid AND t.typname IN ('geometry','geography') WHERE e.extname='postgis'",&[]).await?;
    if rows.is_empty() {
        return Err(Error::new(
            "POSTGIS_REQUIRED",
            "PostGIS extension is not installed",
            400,
        ));
    }
    Ok((
        rows[0].try_get(0)?,
        rows.iter()
            .map(|r| r.try_get(1))
            .collect::<std::result::Result<Vec<u32>, _>>()?,
    ))
}
async fn tables(client: &Client) -> Result<Value> {
    let (ns, _) = spatial(client).await?;
    let ns = qi(&ns);
    let sql=format!("SELECT f_table_schema AS schema,f_table_name AS \"table\",f_geometry_column AS \"geometryColumn\",type AS \"geometryType\",srid,'geometry' AS kind FROM {ns}.geometry_columns UNION ALL SELECT f_table_schema,f_table_name,f_geography_column,type,srid,'geography' FROM {ns}.geography_columns");
    let sql=format!("SELECT row_to_json(t)::text FROM ({sql}) t WHERE EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=t.schema AND c.relname=t.\"table\" AND has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT')) ORDER BY schema,\"table\",\"geometryColumn\" LIMIT 10000");
    Ok(Value::Array(collect(client, &sql, &[]).await?))
}
#[derive(Debug)]
struct Parameter(Value);
fn array_text(v: &Value) -> std::result::Result<String, Box<dyn std::error::Error + Send + Sync>> {
    Ok(match v {
        Value::Array(a) => format!(
            "{{{}}}",
            a.iter()
                .map(array_text)
                .collect::<std::result::Result<Vec<_>, _>>()?
                .join(",")
        ),
        Value::Null => "NULL".into(),
        Value::String(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
        Value::Bool(_) | Value::Number(_) => v.to_string(),
        _ => format!(
            "\"{}\"",
            v.to_string().replace('\\', "\\\\").replace('"', "\\\"")
        ),
    })
}
impl ToSql for Parameter {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut BytesMut,
    ) -> std::result::Result<IsNull, Box<dyn std::error::Error + Send + Sync>> {
        if self.0.is_null() {
            return Ok(IsNull::Yes);
        }
        let value = match &self.0 {
            Value::String(s) => s.clone(),
            v if matches!(ty.kind(), Kind::Array(_)) => array_text(v)?,
            v => v.to_string(),
        };
        out.extend_from_slice(value.as_bytes());
        Ok(IsNull::No)
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    fn encode_format(&self, _: &Type) -> Format {
        Format::Text
    }
    tokio_postgres::types::to_sql_checked!();
}
async fn collect(client: &Client, sql: &str, params: &[Parameter]) -> Result<Vec<Value>> {
    let statement = client.prepare(sql).await?;
    if statement.params().len() != params.len() {
        return Err(invalid());
    }
    let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
    let rows = client.query_raw(&statement, refs).await?;
    pin_mut!(rows);
    let mut result = Vec::new();
    let mut bytes = 0;
    while let Some(row) = rows.try_next().await? {
        let raw: String = row.try_get(0)?;
        bytes += raw.len();
        if bytes > MAX_BYTES {
            return Err(Error::new(
                "RESULT_TOO_LARGE",
                "Result exceeds byte budget; reduce limit or simplify geometry",
                413,
            ));
        }
        result.push(
            serde_json::from_str(&raw)
                .map_err(|_| Error::new("INVALID_RESULT", "Unable to decode query result", 500))?,
        );
    }
    Ok(result)
}
struct Prepared { sql: String, params: Vec<Parameter>, fields: Vec<(String, u32)> }
struct WkbPlan { statement: String, params: Vec<Parameter>, metadata: Value }
async fn prepare_request(client: &Client, input: &Value) -> Result<Prepared> {
    let raw = text(input, "sql")?.to_owned();
    let sql = tokio::task::spawn_blocking(move || select_sql(&raw))
        .await
        .map_err(|_| invalid())??;
    let params = match input.get("parameters") {
        None => vec![],
        Some(Value::Array(a)) if a.len() <= 100 => a.iter().cloned().map(Parameter).collect(),
        _ => return Err(invalid()),
    };
    let metadata = client
        .prepare(&format!("SELECT * FROM ({sql}\n) emap_query LIMIT 0"))
        .await?;
    if metadata.params().len() != params.len() {
        return Err(invalid());
    }
    let fields: Vec<(String, u32)> = metadata
        .columns()
        .iter()
        .map(|c| (c.name().to_owned(), c.type_().oid()))
        .collect();
    let mut names = std::collections::HashSet::new();
    for (name, _) in &fields {
        if !names.insert(name) {
            return Err(Error::new(
                "DUPLICATE_COLUMNS",
                "Use unique SELECT aliases for every output column",
                400,
            ));
        }
    }
    Ok(Prepared { sql, params, fields })
}
async fn query(client: &Client, input: &Value, wkb: bool) -> Result<Value> {
    let Prepared { sql, params, fields } = prepare_request(client, input).await?;
    let limit = integer(&input["limit"], 1000, 1, 10000)?;
    let offset = integer(&input["offset"], 0, 0, 10_000_000)?;
    if !wkb {
        let mut projection = "to_jsonb(q)".to_owned();
        for (name, oid) in &fields {
            if [20, 1700].contains(oid) {
                projection += &format!(" || jsonb_build_object({},q.{}::text)", qs(name), qi(name));
            }
        }
        let statement = format!(
            "SELECT ({projection})::text FROM ({sql}\n) q LIMIT {} OFFSET {offset}",
            limit + 1
        );
        let mut rows = collect(client, &statement, &params).await?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        return Ok(
            json!({"rowCount":rows.len(),"rows":rows,"fields":fields.iter().map(|(name,oid)|json!({"name":name,"dataTypeId":oid})).collect::<Vec<_>>(),"limit":limit,"offset":offset,"hasMore":more}),
        );
    }
    let plan = wkb_plan(client, input, Prepared { sql, params, fields }).await?;
    let mut rows = collect(client, &format!("{} LIMIT {} OFFSET {offset}",plan.statement,limit+1), &plan.params).await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    for row in &mut rows { if row["id"].is_null() { row.as_object_mut().unwrap().remove("id"); } }
    let mut value = plan.metadata;
    value["rowCount"] = json!(rows.len()); value["rows"] = json!(rows);
    value["hasMore"] = json!(more); value["limit"] = json!(limit); value["offset"] = json!(offset);
    Ok(value)
}
async fn wkb_plan(client: &Client, input: &Value, prepared: Prepared) -> Result<WkbPlan> {
    let Prepared {sql, params, fields} = prepared;
    let (ns, oids) = spatial(client).await?;
    let ns = qi(&ns);
    let spatial_fields: Vec<String> = fields
        .iter()
        .filter(|(_, id)| oids.contains(id))
        .map(|(s, _)| s.clone())
        .collect();
    let geometry = match input.get("geometryColumn") {
        Some(Value::String(s)) => s.clone(),
        None if spatial_fields.len() == 1 => spatial_fields[0].clone(),
        _ => {
            return Err(Error::new(
                "GEOMETRY_COLUMN_REQUIRED",
                "Select an output geometryColumn; bytea/hex columns require an explicit alias",
                400,
            ))
        }
    };
    let (_, oid) = fields
        .iter()
        .find(|(name, _)| name == &geometry)
        .ok_or(Error::new(
            "GEOMETRY_COLUMN_REQUIRED",
            "Geometry column not found",
            400,
        ))?;
    let id = match input.get("idColumn") {
        None => "NULL::text".into(),
        Some(Value::String(s)) if fields.iter().any(|(n, _)| n == s) => {
            format!("q.{}::text", qi(s))
        }
        _ => {
            return Err(Error::new(
                "INVALID_ID_COLUMN",
                "idColumn must name an output column",
                400,
            ))
        }
    };
    let format = match input.get("format") {
        None => "ewkb",
        Some(Value::String(s)) if ["wkb", "ewkb"].contains(&s.as_str()) => s,
        _ => return Err(invalid()),
    };
    let target = integer(&input["targetSrid"], 4326, 1, 998999)?;
    let column = format!("q.{}", qi(&geometry));
    let mut geom = if oids.contains(oid) {
        format!("{column}::{ns}.geometry")
    } else if *oid == 17 {
        format!("{ns}.ST_GeomFromEWKB({column})")
    } else if [25, 1042, 1043].contains(oid) {
        format!("{ns}.ST_GeomFromEWKB(decode(CASE WHEN lower(left({column},2)) IN (chr(92)||'x','0x') THEN substr({column},3) ELSE {column} END,'hex'))")
    } else {
        return Err(Error::new(
            "GEOMETRY_TYPE_REQUIRED",
            "Use geometry, geography, bytea WKB/EWKB, or hexadecimal text",
            400,
        ));
    };
    if let Some(s) = input.get("sourceSrid") {
        let srid = integer(s, 4326, 1, 998999)?;
        geom=format!("(CASE WHEN {ns}.ST_SRID({geom})=0 THEN {ns}.ST_SetSRID({geom},{srid}) ELSE {geom} END)");
    }
    let encoder = if format == "ewkb" {
        "ST_AsEWKB"
    } else {
        "ST_AsBinary"
    };
    let binary=format!("CASE WHEN {geom} IS NULL THEN NULL ELSE encode({ns}.{encoder}({ns}.ST_Transform({ns}.ST_CurveToLine({ns}.ST_Force2D({geom})),{target}),'NDR'),'hex') END");
    let mut excluded = spatial_fields;
    if !excluded.contains(&geometry) {
        excluded.push(geometry.clone());
    }
    // Project attributes BEFORE JSON encoding. to_jsonb(q)-keys first tries to
    // serialize every geometry as GeoJSON, wasting memory and failing on curves.
    let attributes: Vec<String> = fields
        .iter()
        .filter(|(name, _)| !excluded.contains(name))
        .map(|(name, oid)| {
            format!(
                "{},q.{}{}",
                qs(name),
                qi(name),
                if [20, 1700].contains(oid) {
                    "::text"
                } else {
                    ""
                }
            )
        })
        .collect();
    // PostgreSQL functions accept at most 100 arguments: 50 key/value pairs.
    let parts: Vec<String> = attributes
        .chunks(50)
        .map(|chunk| format!("jsonb_build_object({})", chunk.join(",")))
        .collect();
    let properties = if parts.is_empty() {
        "'{}'::jsonb".into()
    } else {
        parts.join(" || ")
    };
    let statement=format!("SELECT json_build_object('geometry',{binary},'properties',({properties}),'id',{id})::text FROM ({sql}\n) q");
    Ok(WkbPlan { statement, params, metadata: json!({"geometryColumn":geometry,"srid":target,"format":format,"encoding":"hex"}) })
}

// A single PostgreSQL cursor holds one REPEATABLE READ snapshot for the entire
// export. No OFFSET loop, no fixed total row ceiling, no duplicate/missing rows
// from concurrent edits between pages. The channel provides bounded backpressure.
async fn send_frame(tx: &tokio::sync::mpsc::Sender<bytes::Bytes>, value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| invalid())?;
    if bytes.len() > MAX_BYTES { return Err(Error::new("RESULT_TOO_LARGE", "A stream frame exceeds the byte budget", 413)); }
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(60), tx.send(bytes.into())).await
        .map_err(|_| Error::new("TIMEOUT", "Stream consumer stopped reading", 408))?
        .map_err(|_| Error::new("CANCELLED", "Stream consumer disconnected", 499))
}
impl Gateway {
    pub async fn stream_wkb(&self, input: Value, session: CancellationToken,
        disconnected: CancellationToken, tx: tokio::sync::mpsc::Sender<bytes::Bytes>) {
        let work = async {
            let _permit = self.permits.clone().try_acquire_owned()
                .map_err(|_|Error::new("BUSY","Database query budget exceeded",429))?;
            let batch_size = integer(&input["batchSize"], 256, 1, 2000)? as usize;
            let max_rows = match input.get("maxRows") {
                None => None, Some(v) => Some(integer(v, 0, 1, 9_007_199_254_740_990)?),
            };
            let mut conn = self.connect().await?;
            conn.client.batch_execute("SET LOCAL idle_in_transaction_session_timeout=60000").await?;
            let prepared = prepare_request(&conn.client,&input).await?;
            let plan = wkb_plan(&conn.client,&input,prepared).await?;
            let limit = max_rows.map(|n|format!(" LIMIT {}",n+1)).unwrap_or_default();
            let declaration = format!("DECLARE emap_export NO SCROLL CURSOR FOR {}{limit}",plan.statement);
            let refs: Vec<&(dyn ToSql + Sync)> = plan.params.iter().map(|p|p as &(dyn ToSql+Sync)).collect();
            conn.client.execute(&declaration,&refs).await?;
            let mut meta = plan.metadata; meta["type"] = json!("meta");
            send_frame(&tx,meta).await?;
            let mut total = 0u64; let mut rows = Vec::new(); let mut size = 0usize; let mut more = false;
            'export: loop {
                let batch = conn.client.query_raw("FETCH FORWARD 64 FROM emap_export",std::iter::empty::<&(dyn ToSql+Sync)>()).await?;
                pin_mut!(batch);
                let mut fetched = 0;
                while let Some(row) = batch.try_next().await? {
                    fetched += 1;
                    if max_rows.is_some_and(|n|total + rows.len() as u64 >= n) { more = true; break 'export; }
                    let raw: String = row.try_get(0)?;
                    if raw.len() > MAX_BYTES - 1024 { return Err(Error::new("RESULT_TOO_LARGE","A geometry/attribute row exceeds the byte budget",413)); }
                    if !rows.is_empty() && (size + raw.len() > 524288 || rows.len() >= batch_size) {
                        let count = rows.len();
                        send_frame(&tx,json!({"type":"batch","rows":rows,"rowCount":count,"offset":total})).await?;
                        total += count as u64; rows = Vec::new(); size = 0;
                    }
                    let mut value: Value = serde_json::from_str(&raw).map_err(|_|Error::new("INVALID_RESULT","Unable to decode query result",500))?;
                    if value["id"].is_null() { value.as_object_mut().ok_or_else(invalid)?.remove("id"); }
                    size += raw.len(); rows.push(value);
                }
                if fetched < 64 { break; }
            }
            if !rows.is_empty() {
                let count = rows.len();
                send_frame(&tx,json!({"type":"batch","rows":rows,"rowCount":count,"offset":total})).await?;
                total += count as u64;
            }
            conn.client.batch_execute("CLOSE emap_export; ROLLBACK").await?;
            conn.finished = true;
            send_frame(&tx,json!({"type":"end","rowCount":total,"hasMore":more,"limit":max_rows.unwrap_or(total)})).await?;
            Ok::<(),Error>(())
        };
        let result = tokio::select! {
            biased;
            _=self.cancel.cancelled()=>Err(Error::new("REVOKED","Connection changed or removed",403)),
            _=session.cancelled()=>Err(Error::new("REVOKED","Session expired or authorization revoked",403)),
            _=disconnected.cancelled()=>Err(Error::new("CANCELLED","Browser disconnected",499)),
            _=tx.closed()=>Err(Error::new("CANCELLED","Stream consumer disconnected",499)),
            result=work=>result,
        };
        if let Err(error) = result {
            // Missing success terminator is always an error on the client. Never
            // silently accept a partial table after revocation/timeout/disconnect.
            let _ = tokio::time::timeout(Duration::from_secs(1),send_frame(&tx,json!({"type":"error","error":error.value()}))).await;
        }
    }
}
