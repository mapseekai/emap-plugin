import { it, expect, vi } from 'vitest';
import { WkbWriter } from '@mapseekai/emap/arrow';
import { getDefaultMapshaperAdapter } from '@mapseekai/emap';
import { wkbToDataset } from './dataset.js';
import { point, collection, result } from '../test/fixtures/wkb.js';
function polygon(x = 0, hole = false) {
  const w = new WkbWriter();
  const xx = new Float64Array([x,x+1,x+1,x,x, x+.2,x+.2,x+.8,x+.8,x+.2]);
  const yy = new Float64Array([0,0,1,1,0, .2,.8,.8,.2,.2]);
  w.writePolygons(xx, yy, [hole ? [[0,5],[5,10]] : [[0,5]]]); return w.finish().bytes;
}
it.each([true, false])('directly imports EWKB %s without GeoJSON', (le) => {
  const adapter = getDefaultMapshaperAdapter(); const spy = vi.spyOn(adapter, 'runImport');
  const { dataset } = wkbToDataset(result([point(10, 20, 4326, le)]));
  expect(dataset.layers[0].geometry_type).toBe('point');
  expect(dataset.layers[0].data?.getRecords?.()[0]).toMatchObject({ name: 'row-0', precise: '9007199254740993', id: '0' });
  expect(dataset.info?.crs_string).toBe('EPSG:4326'); expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
});
it('builds shared topology for adjacent polygons and preserves holes', () => {
  const { dataset } = wkbToDataset(result([polygon(), polygon(1)]));
  expect(dataset.arcs?.size()).toBe(3);
  const withHole = wkbToDataset(result([polygon(0, true)])).dataset;
  expect(withHole.layers[0].shapes?.[0]).toHaveLength(2);
  const shape = withHole.layers[0].shapes![0] as number[][];
  expect(getDefaultMapshaperAdapter().testPointInPolygon(.1, .1, shape, withHole.arcs!)).toBe(true);
  expect(getDefaultMapshaperAdapter().testPointInPolygon(.5, .5, shape, withHole.arcs!)).toBe(false);
});
it('groups mixed collections without losing properties or multipart geometry', () => {
  const { dataset } = wkbToDataset(result([collection(7, [collection(4, [point(), point(11,21)]), polygon()])]));
  expect(new Set(dataset.layers.map((layer) => layer.geometry_type))).toEqual(new Set(['point','polygon']));
  for (const layer of dataset.layers) expect(layer.data?.getRecords?.()[0].name).toBe('row-0');
});
it('retains null and empty geometry records, including a completely empty page', () => {
  const { dataset } = wkbToDataset(result([null, point(NaN,NaN), collection(7,[])]));
  expect(dataset.layers.reduce((n, layer) => n + (layer.data?.getRecords?.().length ?? 0), 0)).toBe(3);
  expect(dataset.layers.some((layer) => layer.shapes?.some(Boolean))).toBe(false);
  expect(() => wkbToDataset(result([]))).not.toThrow();
});
it('uses response CRS for standard WKB and rejects conflicting EWKB', () => {
  expect(wkbToDataset({ ...result([point(1,2,0)]), format: 'wkb', srid: 3857 }).dataset.info?.crs_string).toBe('EPSG:3857');
  expect(() => wkbToDataset(result([point(1,2,3857)]))).toThrow(/SRID/);
  expect(() => wkbToDataset(result([collection(7,[point(),point(1,2,3857)])]))).toThrow(/mixed SRID/);
});
it('supports Z as XY and fails explicitly on M or malformed bytes', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(wkbToDataset(result([point(1,2,4326,true,7)])).dataset.layers[0].shapes?.[0]).toEqual([[1,2]]);
  warning.mockRestore();
  const m = point(); new DataView(m.buffer).setUint32(1, 0x60000001, true);
  expect(() => wkbToDataset(result([m]))).toThrow(/M\/ZM/);
  expect(() => wkbToDataset(result([point(), point()]), { maxVertices: 1 })).toThrow(/budget/);
});
