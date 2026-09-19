import type { FieldDef } from 'pg';
import type { WkbQueryRequest } from '../wkb-types.js';
import { PostgisError, integer } from '../errors.js';
import { identifier as qi } from './sql.js';
interface Prepared { sql: string; values: unknown[]; fields: FieldDef[]; limit: number; offset: number; }
export function buildWkbQuery(request: WkbQueryRequest, query: Prepared, spatial: { schema: string; oids: number[] }) {
  const { sql, values, fields, limit, offset } = query; const ns = qi(spatial.schema);
  const spatialFields = fields.filter((field) => spatial.oids.includes(field.dataTypeID)).map((field) => field.name);
  const geometryColumn = request.geometryColumn ?? (spatialFields.length === 1 ? spatialFields[0] : undefined);
  const field = fields.find((item) => item.name === geometryColumn);
  if (typeof geometryColumn !== 'string' || !field)
    throw new PostgisError('GEOMETRY_COLUMN_REQUIRED', 'Select an output geometryColumn; bytea/hex columns require an explicit alias');
  if (request.idColumn !== undefined && (typeof request.idColumn !== 'string' || !fields.some((item) => item.name === request.idColumn)))
    throw new PostgisError('INVALID_ID_COLUMN', 'idColumn must name an output column');
  const format = request.format ?? 'ewkb';
  if (format !== 'ewkb' && format !== 'wkb') throw new PostgisError('INVALID_ARGUMENT', 'format must be ewkb or wkb');
  const targetSrid = integer(request.targetSrid, 4326, 1, 998999, 'targetSrid');
  const column = `q.${qi(geometryColumn)}`;
  let geometry: string;
  if (spatial.oids.includes(field.dataTypeID)) geometry = `${column}::${ns}.geometry`;
  else if (field.dataTypeID === 17) geometry = `${ns}.ST_GeomFromEWKB(${column})`;
  else if ([25, 1042, 1043].includes(field.dataTypeID)) {
    const hex = `CASE WHEN lower(left(${column},2)) IN (chr(92)||'x','0x') THEN substr(${column},3) ELSE ${column} END`;
    geometry = `${ns}.ST_GeomFromEWKB(decode(${hex},'hex'))`;
  } else throw new PostgisError('GEOMETRY_TYPE_REQUIRED', 'Use geometry, geography, bytea WKB/EWKB, or hexadecimal text');
  if (request.sourceSrid !== undefined) {
    const srid = integer(request.sourceSrid, 4326, 1, 998999, 'sourceSrid');
    geometry = `(CASE WHEN ${ns}.ST_SRID(${geometry})=0 THEN ${ns}.ST_SetSRID(${geometry},${srid}) ELSE ${geometry} END)`;
  }
  const normalized = `${ns}.ST_Transform(${ns}.ST_CurveToLine(${ns}.ST_Force2D(${geometry})),${targetSrid})`;
  const encoder = format === 'ewkb' ? 'ST_AsEWKB' : 'ST_AsBinary';
  const binary = `CASE WHEN ${geometry} IS NULL THEN NULL ELSE encode(${ns}.${encoder}(${normalized},'NDR'),'hex') END`;
  const excluded = [...new Set([...spatialFields, geometryColumn])];
  const n = values.length; const bindings: unknown[] = [...values, excluded, limit + 1, offset];
  let properties = `to_jsonb(q) - $${n + 1}::text[]`;
  // JSON numbers would round PostgreSQL int8/numeric before reaching a DataTable.
  for (const item of fields) if (!excluded.includes(item.name) && [20, 1700].includes(item.dataTypeID)) {
    bindings.push(item.name);
    properties += ` || jsonb_build_object($${bindings.length}::text,q.${qi(item.name)}::text)`;
  }
  const id = request.idColumn === undefined ? 'NULL::text' : `q.${qi(request.idColumn)}::text`;
  const statement = `SELECT ${binary} AS geometry, ${properties} AS properties, ${id} AS id FROM (${sql}\n) q LIMIT $${n + 2} OFFSET $${n + 3}`;
  return { statement, bindings, geometryColumn, srid: targetSrid, format, limit, offset };
}
