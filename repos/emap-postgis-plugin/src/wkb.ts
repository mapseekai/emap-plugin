import { PostgisError } from './errors.js';
export interface WkbInspection {
  parts: Uint8Array[]; srids: Set<number>; vertices: number; hasZ: boolean;
}
export function wkbBytes(value: string | Uint8Array | ArrayBuffer, maxBytes = 10485760): Uint8Array {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (bytes.byteLength > maxBytes) throw new PostgisError('GEOMETRY_TOO_LARGE', 'WKB byte budget exceeded');
    return bytes;
  }
  if (typeof value !== 'string') throw new PostgisError('INVALID_WKB', 'Expected WKB bytes or hexadecimal text');
  const hex = value.replace(/^(?:\\x|0x)/i, '');
  if (hex.length > maxBytes * 2) throw new PostgisError('GEOMETRY_TOO_LARGE', 'WKB byte budget exceeded');
  if (!hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex))
    throw new PostgisError('INVALID_WKB', 'Malformed hexadecimal WKB');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
/** Validate bounds before emap.decodeWkb; retain SRIDs and split collections. */
export function inspectWkb(bytes: Uint8Array, maxVertices = 1000000): WkbInspection {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: WkbInspection = { parts: [], srids: new Set(), vertices: 0, hasZ: false };
  let pos = 0; let geometries = 0;
  const fail = (message: string): never => { throw new PostgisError('INVALID_WKB', message); };
  const need = (count: number) => { if (count > bytes.length - pos) fail('Truncated WKB'); };
  const uint = (le: boolean): number => { need(4); const n = view.getUint32(pos, le); pos += 4; return n; };
  const sequence = (count: number, dims: number, le: boolean, point = false) => {
    if (count > maxVertices - result.vertices) throw new PostgisError('VERTEX_LIMIT', 'WKB vertex budget exceeded');
    need(count * dims * 8); result.vertices += count;
    for (let i = 0; i < count; i++) {
      const x = view.getFloat64(pos, le); const y = view.getFloat64(pos + 8, le);
      if (!(Number.isFinite(x) && Number.isFinite(y)) && !(point && Number.isNaN(x) && Number.isNaN(y)))
        fail('Non-finite WKB coordinate');
      pos += dims * 8;
    }
  };
  const geometry = (depth: number, expected?: number): void => {
    if (depth > 16 || ++geometries > 100000) fail('WKB nesting or component budget exceeded');
    const start = pos; need(5); const byteOrder = view.getUint8(pos++);
    if (byteOrder !== 0 && byteOrder !== 1) fail('Invalid WKB byte order');
    const le = byteOrder === 1; const word = uint(le);
    let type = word & 0x1fffffff;
    const z = !!(word & 0x80000000) || (type >= 1000 && type < 2000);
    if ((word & 0x40000000) || type >= 2000)
      throw new PostgisError('UNSUPPORTED_WKB', 'M/ZM requires ST_Force2D before direct import');
    if (type >= 1000) type -= 1000;
    if (type < 1 || type > 7) throw new PostgisError('UNSUPPORTED_WKB', 'Use simple geometries or ST_CurveToLine');
    if (expected !== undefined && type !== expected) fail('Invalid child type in WKB Multi geometry');
    result.hasZ ||= z;
    if (word & 0x20000000) {
      const srid = uint(le);
      if (srid > 998999) fail('Invalid EWKB SRID');
      if (srid) result.srids.add(srid);
    }
    const dims = z ? 3 : 2;
    if (type === 1) sequence(1, dims, le, true);
    else if (type === 2) {
      const count = uint(le);
      if (count === 1) fail('LineString requires zero or at least two coordinates');
      sequence(count, dims, le);
    } else if (type === 3) {
      const rings = uint(le);
      if (rings > Math.floor((bytes.length - pos) / 4)) fail('Invalid WKB ring count');
      for (let i = 0; i < rings; i++) {
        const count = uint(le); const startRing = pos;
        if (count < 4) fail('Polygon rings require at least four coordinates');
        sequence(count, dims, le);
        const end = pos - dims * 8;
        if (view.getFloat64(startRing, le) !== view.getFloat64(end, le) ||
            view.getFloat64(startRing + 8, le) !== view.getFloat64(end + 8, le)) fail('Unclosed WKB polygon ring');
      }
    } else {
      const count = uint(le);
      if (count > Math.floor((bytes.length - pos) / 5)) fail('Invalid WKB component count');
      for (let i = 0; i < count; i++) geometry(depth + 1, type === 7 ? undefined : type - 3);
    }
    if (type <= 3) result.parts.push(bytes.subarray(start, pos));
  };
  geometry(0);
  if (pos !== bytes.length) fail('Trailing bytes after WKB geometry');
  return result;
}
