import { buildWkbQuery } from './wkb-query.js';
import { Pool } from 'pg';
import type { PoolClient, PoolConfig, FieldDef } from 'pg';
import Cursor from 'pg-cursor';
import type { ConnectionInfo, QueryRequest, WkbQueryRequest, QueryResult, WkbQueryResult, SpatialTable } from '../types.js';
import { PostgisError, assertActive, integer } from '../errors.js';
import { selectSql, identifier as qi } from './sql.js';
export interface GatewayOptions {
  connections: Record<string, { label?: string; config: PoolConfig }>;
  maxRows?: number; maxResponseBytes?: number; timeoutMs?: number; maxConcurrent?: number;
  onError?: (error: unknown) => void;
}
export class PostgisGateway {
  private pools = new Map<string, Pool>(); private catalog: ConnectionInfo[] = [];
  private active = new Set<AbortController>(); private disposed = false;
  readonly maxRows: number; readonly maxResponseBytes: number; readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  constructor(private options: GatewayOptions) {
    this.maxRows = integer(options.maxRows, 10000, 1, 100000, 'maxRows');
    this.maxResponseBytes = integer(options.maxResponseBytes, 10485760, 1024, 104857600, 'maxResponseBytes');
    this.timeoutMs = integer(options.timeoutMs, 15000, 1, 120000, 'timeoutMs');
    this.maxConcurrent = integer(options.maxConcurrent, 8, 1, 64, 'maxConcurrent');
    for (const [id, connection] of Object.entries(options.connections)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid connection id');
      const pool = new Pool({ ...connection.config, max: 4, connectionTimeoutMillis: 5000, application_name: 'emap-postgis' });
      pool.on('error', (error) => options.onError?.(error));
      this.pools.set(id, pool); this.catalog.push({ id, label: connection.label ?? id });
    }
    if (!this.pools.size) throw new Error('At least one server-side connection is required');
  }
  connections(): ConnectionInfo[] { return this.catalog.map((item) => ({ ...item })); }
  private async read<T>(id: string, signal: AbortSignal | undefined, operation: (client: PoolClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw new PostgisError('DISPOSED', 'Gateway is closed', 503);
    const pool = this.pools.get(id);
    if (!pool) throw new PostgisError('UNKNOWN_CONNECTION', 'Unknown connection', 404);
    if (this.active.size >= this.maxConcurrent) throw new PostgisError('BUSY', 'Gateway is busy; retry later', 429);
    const task = new AbortController(); const cancel = () => task.abort(signal?.reason);
    this.active.add(task); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => task.abort(new PostgisError('TIMEOUT', 'Query time limit exceeded', 408)), this.timeoutMs);
    let client: PoolClient | undefined; let released = false;
    const release = () => { if (client && !released) { released = true; client.release(true); } };
    task.signal.addEventListener('abort', release, { once: true });
    try {
      assertActive(task.signal); client = await pool.connect(); assertActive(task.signal);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${this.timeoutMs}; SET LOCAL lock_timeout = ${Math.min(2000, this.timeoutMs)}`);
      const role = await client.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user');
      if (!role.rows[0] || Object.values(role.rows[0]).some(Boolean))
        throw new PostgisError('UNSAFE_DB_ROLE', 'Configure a dedicated non-administrative SELECT-only database role', 403);
      assertActive(task.signal); const result = await operation(client, task.signal); assertActive(task.signal);
      await client.query('ROLLBACK'); return result;
    } catch (error) {
      if (task.signal.aborted) throw task.signal.reason;
      if (error instanceof PostgisError) throw error;
      this.options.onError?.(error);
      throw new PostgisError('QUERY_FAILED', 'Query failed; check SQL, permissions, geometry type and SRID in server logs', 400);
    } finally {
      clearTimeout(timer); release(); this.active.delete(task); signal?.removeEventListener('abort', cancel);
      task.signal.removeEventListener('abort', release);
    }
  }
  private async spatialTypes(client: PoolClient): Promise<{ schema: string; oids: number[] }> {
    const result = await client.query("SELECT n.nspname AS schema, t.oid FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace JOIN pg_catalog.pg_type t ON t.typnamespace=n.oid AND t.typname IN ('geometry','geography') WHERE e.extname='postgis'");
    if (!result.rows.length) throw new PostgisError('POSTGIS_REQUIRED', 'PostGIS extension is not installed');
    return { schema: result.rows[0].schema, oids: result.rows.map((row) => row.oid) };
  }
  async testConnection(connectionId: string, signal?: AbortSignal): Promise<{ ok: true; postgisVersion: string }> {
    return this.read(connectionId, signal, async (client) => {
      const { schema } = await this.spatialTypes(client);
      const result = await client.query(`SELECT ${qi(schema)}.postgis_lib_version() AS version`);
      return { ok: true, postgisVersion: result.rows[0].version };
    });
  }
  async tables(connectionId: string, signal?: AbortSignal): Promise<SpatialTable[]> {
    return this.read(connectionId, signal, async (client) => {
      const { schema } = await this.spatialTypes(client); const ns = qi(schema);
      const sql = `SELECT f_table_schema AS schema, f_table_name AS "table", f_geometry_column AS "geometryColumn", type AS "geometryType", srid, 'geometry' AS kind FROM ${ns}.geometry_columns
        UNION ALL SELECT f_table_schema, f_table_name, f_geography_column, type, srid, 'geography' FROM ${ns}.geography_columns`;
      const filtered = `SELECT * FROM (${sql}) t WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=t.schema AND c.relname=t."table" AND has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT')) ORDER BY schema, "table", "geometryColumn" LIMIT 10000`;
      return (await client.query(filtered)).rows;
    });
  }
  private async prepare(client: PoolClient, request: QueryRequest): Promise<{ sql: string; values: unknown[]; fields: FieldDef[]; limit: number; offset: number }> {
    const sql = await selectSql(request.sql);
    if (request.parameters !== undefined && (!Array.isArray(request.parameters) || request.parameters.length > 100))
      throw new PostgisError('INVALID_ARGUMENT', 'parameters must be an array with at most 100 entries');
    const values = request.parameters ?? [];
    const limit = integer(request.limit, Math.min(1000, this.maxRows), 1, this.maxRows, 'limit');
    const offset = integer(request.offset, 0, 0, 10000000, 'offset');
    const metadata = await client.query(`SELECT * FROM (${sql}\n) AS emap_query LIMIT 0`, values);
    const names = metadata.fields.map((field) => field.name);
    if (new Set(names).size !== names.length) throw new PostgisError('DUPLICATE_COLUMNS', 'Use unique SELECT aliases for every output column');
    return { sql, values, fields: metadata.fields, limit, offset };
  }
  private async collect(client: PoolClient, sql: string, values: unknown[], signal: AbortSignal): Promise<Record<string, any>[]> {
    assertActive(signal); const cursor = client.query(new Cursor(sql, values));
    const rows: Record<string, any>[] = []; let bytes = 0;
    try {
      while (true) {
        const batch = await cursor.read(32); assertActive(signal);
        if (!batch.length) break;
        for (const row of batch) {
          bytes += Buffer.byteLength(JSON.stringify(row));
          if (bytes > this.maxResponseBytes) throw new PostgisError('RESULT_TOO_LARGE', 'Result exceeds byte budget; reduce limit or simplify geometry', 413);
          rows.push(row);
        }
      }
      return rows;
    } finally { await cursor.close().catch(() => {}); }
  }
  async query(request: QueryRequest, signal?: AbortSignal): Promise<QueryResult> {
    return this.read(request.connectionId, signal, async (client, active) => {
      const { sql, values, fields, limit, offset } = await this.prepare(client, request);
      const rows = await this.collect(client, `SELECT * FROM (${sql}\n) q LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit + 1, offset], active);
      return { rows: rows.slice(0, limit), fields: fields.map(({ name, dataTypeID }) => ({ name, dataTypeId: dataTypeID })), rowCount: Math.min(rows.length, limit), hasMore: rows.length > limit, limit, offset };
    });
  }
  async queryWkb(request: WkbQueryRequest, signal?: AbortSignal): Promise<WkbQueryResult> {
    return this.read(request.connectionId, signal, async (client, active) => {
      const prepared = await this.prepare(client, request);
      const plan = buildWkbQuery(request, prepared, await this.spatialTypes(client));
      const rows = await this.collect(client, plan.statement, plan.bindings, active);
      const page = rows.slice(0, plan.limit).map((row) => ({
        geometry: row.geometry, properties: row.properties,
        ...(row.id === null ? {} : { id: row.id }),
      }));
      return { rows: page, rowCount: page.length, hasMore: rows.length > plan.limit,
        limit: plan.limit, offset: plan.offset, geometryColumn: plan.geometryColumn,
        srid: plan.srid, format: plan.format, encoding: 'hex' };
    });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const task of this.active) task.abort(new PostgisError('DISPOSED', 'Gateway is closed', 503));
    await Promise.all([...this.pools.values()].map((pool) => pool.end()));
    this.pools.clear();
  }
}
