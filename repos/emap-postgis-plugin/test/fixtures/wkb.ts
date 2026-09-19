import type { WkbQueryResult } from '../../src/types.js';
export function point(x = 10.5, y = 20.5, srid = 4326, le = true, z?: number): Uint8Array {
  const bytes = new Uint8Array(5 + (srid ? 4 : 0) + (z === undefined ? 16 : 24));
  const view = new DataView(bytes.buffer); view.setUint8(0, le ? 1 : 0);
  view.setUint32(1, (1 | (srid ? 0x20000000 : 0) | (z === undefined ? 0 : 0x80000000)) >>> 0, le);
  let p = 5; if (srid) { view.setUint32(p, srid, le); p += 4; }
  view.setFloat64(p, x, le); view.setFloat64(p + 8, y, le);
  if (z !== undefined) view.setFloat64(p + 16, z, le);
  return bytes;
}
export function collection(type: number, parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(9 + parts.reduce((n, part) => n + part.length, 0));
  const view = new DataView(bytes.buffer); view.setUint8(0, 1); view.setUint32(1, type, true); view.setUint32(5, parts.length, true);
  let p = 9; for (const part of parts) { bytes.set(part, p); p += part.length; } return bytes;
}
export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
export function result(geometries: (Uint8Array | null)[]): WkbQueryResult {
  return { rows: geometries.map((geometry, i) => ({ geometry: geometry === null ? null : hex(geometry),
    properties: { name: `row-${i}`, precise: '9007199254740993' }, id: String(i) })),
    geometryColumn: 'geom', srid: 4326, encoding: 'hex', format: 'ewkb',
    rowCount: geometries.length, hasMore: false, limit: 1000, offset: 0 };
}
