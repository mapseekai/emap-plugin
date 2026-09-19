import { getDefaultMapshaperAdapter } from '@mapseekai/emap';
import { decodeWkb } from '@mapseekai/emap/arrow';
import type { WkbGeometry } from '@mapseekai/emap/arrow';
import type { DatasetOptions, DatasetQueryResult, WkbQueryResult } from './wkb-types.js';
import { PostgisError, integer } from './errors.js';
import { inspectWkb, wkbBytes } from './wkb.js';
export { inspectWkb, wkbBytes } from './wkb.js';
/** Same PathImporter -> cleanup -> topology pipeline as emap GeoParquet. */
export function wkbToDataset(result: WkbQueryResult, options: DatasetOptions = {}): DatasetQueryResult {
  if (result.encoding !== 'hex' || !['wkb', 'ewkb'].includes(result.format) || !Array.isArray(result.rows) ||
      result.rows.length !== result.rowCount || result.rows.length > 100000)
    throw new PostgisError('INVALID_RESPONSE', 'Expected a bounded WKB query result');
  const srid = integer(result.srid, 0, 1, 998999, 'srid');
  const maxVertices = integer(options.maxVertices, 1000000, 1, 10000000, 'maxVertices');
  const maxBytes = integer(options.maxGeometryBytes, 10485760, 1, 104857600, 'maxGeometryBytes');
  const adapter = getDefaultMapshaperAdapter(); const importer = adapter.createPathImporter({});
  let vertices = 0; let bytesUsed = 0;
  for (const row of result.rows) {
    if (!row || !row.properties || typeof row.properties !== 'object' || Array.isArray(row.properties))
      throw new PostgisError('INVALID_RESPONSE', 'Each row needs an attribute object');
    const groups = new Map<WkbGeometry['type'], WkbGeometry[]>();
    if (row.geometry !== null) {
      const bytes = wkbBytes(row.geometry, maxBytes - bytesUsed); bytesUsed += bytes.length;
      const inspected = inspectWkb(bytes, maxVertices - vertices);
      vertices += inspected.vertices;
      if (inspected.srids.size > 1) throw new PostgisError('MIXED_SRID', 'Geometry contains mixed SRIDs');
      for (const embedded of inspected.srids) if (embedded !== srid)
        throw new PostgisError('SRID_MISMATCH', 'EWKB SRID differs from response metadata');
      for (const part of inspected.parts) {
        const geometry = decodeWkb(part); if (!geometry) continue;
        if (geometry.type === 'point') geometry.points = geometry.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
        const group = groups.get(geometry.type) ?? []; group.push(geometry); groups.set(geometry.type, group);
      }
    }
    // A mixed GeometryCollection becomes one shape per family, retaining its attributes.
    const properties = { ...row.properties };
    if (row.id !== undefined && !Object.hasOwn(properties, 'id')) properties.id = row.id;
    if (!groups.size) importer.startShape(properties);
    for (const group of groups.values()) {
      importer.startShape({ ...properties });
      for (const geometry of group) {
        if (geometry.type === 'point' && geometry.points.length) importer.importPoints(geometry.points);
        else if (geometry.type === 'polyline') {
          for (const path of geometry.paths) if (path.length) importer.importLine(path);
        } else if (geometry.type === 'polygon') {
          for (let i = 0; i < geometry.rings.length; i++) importer.importRing(geometry.rings[i], geometry.ringIsHole[i]);
        }
      }
    }
  }
  const dataset = importer.done(); adapter.cleanPathsAfterImport(dataset, {});
  if (dataset.arcs && !options.noTopology) adapter.buildTopology(dataset);
  dataset.layers.forEach((layer, i) => { layer.name = `${options.layerName ?? 'postgis'}_${layer.geometry_type ?? 'table'}_${i}`; });
  dataset.info = { ...dataset.info, crs_string: `EPSG:${srid}`, input_formats: ['postgis-wkb'] };
  const { rows: _rows, ...metadata } = result;
  return { ...metadata, dataset };
}
