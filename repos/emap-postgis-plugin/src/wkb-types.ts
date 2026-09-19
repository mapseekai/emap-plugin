import type { MapshaperDataset } from '@mapseekai/emap';
import type { QueryRequest, RequestOptions } from './types.js';
export interface WkbQueryRequest extends QueryRequest {
  geometryColumn?: string; idColumn?: string;
  sourceSrid?: number; targetSrid?: number; format?: 'ewkb' | 'wkb';
}
export interface WkbStreamRequest extends Omit<WkbQueryRequest, 'limit' | 'offset'> {
  /** Omit to read the entire SELECT result using a single snapshot/cursor. */
  maxRows?: number;
  batchSize?: number;
}
export interface StreamRequestOptions extends RequestOptions {
  onProgress?: (progress: { rowsRead: number }) => void;
}
/** Hex is only the HTTP envelope; coordinates never pass through GeoJSON. */
export interface WkbRow {
  geometry: string | null; properties: Record<string, unknown>; id?: string;
}
export interface WkbQueryResult {
  rows: WkbRow[]; geometryColumn: string; srid: number;
  format: 'ewkb' | 'wkb'; encoding: 'hex';
  rowCount: number; hasMore: boolean; limit: number; offset: number;
}
export interface DatasetQueryResult extends Omit<WkbQueryResult, 'rows'> {
  dataset: MapshaperDataset;
}
export interface DatasetOptions {
  layerName?: string; noTopology?: boolean;
  maxVertices?: number; maxGeometryBytes?: number;
}
export interface ConversionOptions extends DatasetOptions {
  worker?: boolean; workerUrl?: string | URL;
  timeoutMs?: number; maxConcurrent?: number;
}
export interface DatasetConverter {
  convert(result: WkbQueryResult, options?: RequestOptions): Promise<DatasetQueryResult>;
  convertPages(pages: AsyncIterable<WkbQueryResult>, options?: StreamRequestOptions): Promise<DatasetQueryResult>;
  dispose(): void;
}
