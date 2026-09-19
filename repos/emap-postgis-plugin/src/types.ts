import type { WkbQueryRequest, WkbQueryResult, DatasetQueryResult, ConversionOptions } from './wkb-types.js';
export type * from './wkb-types.js';
export interface ConnectionInfo { id: string; label: string; }
export interface SpatialTable {
  schema: string; table: string; geometryColumn: string;
  geometryType: string; srid: number; kind: 'geometry' | 'geography';
}
export interface QueryRequest {
  connectionId: string;
  /** One SELECT, including read-only WITH, joins and spatial functions. */
  sql: string;
  parameters?: unknown[]; limit?: number; offset?: number;
}
export type FeatureQueryRequest = WkbQueryRequest;
export interface QueryResult {
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeId: number }[];
  rowCount: number; hasMore: boolean; limit: number; offset: number;
}
export interface RequestOptions { signal?: AbortSignal; }
export interface PostgisContract {
  connections(options?: RequestOptions): Promise<ConnectionInfo[]>;
  testConnection(connectionId: string, options?: RequestOptions): Promise<{ ok: true; postgisVersion: string }>;
  tables(connectionId: string, options?: RequestOptions): Promise<SpatialTable[]>;
  query(request: QueryRequest, options?: RequestOptions): Promise<QueryResult>;
  queryWkb(request: WkbQueryRequest, options?: RequestOptions): Promise<WkbQueryResult>;
  queryDataset(request: WkbQueryRequest, options?: RequestOptions): Promise<DatasetQueryResult>;
  dispose(): void;
}
export interface PostgisOptions {
  /** Gateway base URL, not a PostgreSQL connection string. */
  endpoint: string;
  /** Application API token, never a PostgreSQL password. Not persisted. */
  token?: string | (() => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number; maxResponseBytes?: number;
  conversion?: ConversionOptions;
}
