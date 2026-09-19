// Known little-endian WKB fixtures; no database is accessed by the browser suite.
const u32 = (value) => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const f64 = (value) => { const out = Buffer.alloc(8); out.writeDoubleLE(value); return out; };
const header = (type) => Buffer.concat([Buffer.from([1]), u32(type)]);
const xy = ([x, y]) => Buffer.concat([f64(x), f64(y)]);
const path = (points) => Buffer.concat([u32(points.length), ...points.map(xy)]);
const point = Buffer.concat([header(1), xy([10.5, 20.5])]);
const line = Buffer.concat([header(2), path([[10, 20], [11, 21]])]);
const polygon = Buffer.concat([header(3), u32(1), path([[10,20],[11,20],[11,21],[10,21],[10,20]])]);
export const rows = [point, line, polygon].map((bytes, index) => ({
  id: String(index + 1), geometry: bytes.toString('hex'),
  properties: { id: index + 1, name: ['point', 'line', 'area'][index] },
}));
