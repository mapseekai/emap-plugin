import { it, expect, vi } from 'vitest';
import { createPostgisLayers } from './layers.js';
const result: any = {
  dataset: { layers: [{ geometry_type: 'point', shapes: [[[1, 2]]] }] }, rowCount: 1, srid: 4326,
};
function setup() {
  const sources = new Map(); const registered = new Map();
  const topology = {
    getLayers: () => [
      { name: 'points', geometry_type: 'point' },
      { name: 'lines', geometry_type: 'polyline' },
      { name: 'areas', geometry_type: 'polygon' },
    ], getExtent: () => ({}),
  };
  const host: any = {
    postgis: { queryDataset: vi.fn(async () => result) },
    sourceFactory: { fromDataset: vi.fn(() => topology) },
    source: {
      getSource: (id: string) => sources.get(id),
      addSource: vi.fn(async (id: string, item: unknown) => { sources.set(id, item); }),
      removeSource: (id: string) => sources.delete(id),
    },
    layers: {
      getLayer: (id: string) => registered.get(id), getLayers: () => [...registered.values()],
      addLayer: (layer: any) => registered.set(layer.id, layer), removeLayer: (id: string) => registered.delete(id),
    }, view: { setExtent: vi.fn() },
  };
  return { service: createPostgisLayers(host), host, sources, registered, topology };
}
const input = { sourceId: 'roads', query: { connectionId: 'main', sql: 'SELECT * FROM roads' } };
it('creates mixed geometry layers, fits extent and removes owned resources', async () => {
  const { service, sources, registered, host } = setup(); const loaded = await service.load(input);
  expect(loaded.layerIds).toEqual(['roads:0', 'roads:1', 'roads:2']);
  expect([...registered.values()].map((layer) => layer.type)).toEqual(['circle', 'line', 'fill']);
  expect(host.view.setExtent).toHaveBeenCalledOnce();
  await expect(service.load(input)).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
  service.dispose(); expect(sources.size).toBe(0); expect(registered.size).toBe(0);
});
it('discards query results arriving after unload', async () => {
  const { service, host, sources } = setup(); let resolve!: (value: any) => void;
  host.postgis.queryDataset.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const loading = service.load(input); service.dispose(); resolve(result);
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  expect(host.sourceFactory.fromDataset).not.toHaveBeenCalled(); expect(sources.size).toBe(0);
});
it('preserves unrelated replacements and adopted sources', async () => {
  const { service, sources, registered } = setup(); await service.load(input);
  registered.set('foreign', { id: 'foreign', source: 'roads', type: 'circle' });
  service.remove('roads'); expect(sources.has('roads')).toBe(true); expect(registered.size).toBe(1);
});
it('does not replace a conflicting source', async () => {
  const { service, sources } = setup(); const foreign = {}; sources.set('roads', foreign);
  await expect(service.load(input)).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
  service.dispose(); expect(sources.get('roads')).toBe(foreign);
});
it('uses the source committed by emap for extent and ownership', async () => {
  const { service, host, sources, registered, topology } = setup();
  const committedExtent = { xmin: 100, ymin: 200, xmax: 300, ymax: 400 };
  const committed = { ...topology, getExtent: () => committedExtent };
  host.source.addSource.mockImplementation(async (id: string) => { sources.set(id, committed); });
  await service.load(input);
  expect(host.view.setExtent).toHaveBeenCalledWith(committedExtent);
  service.dispose();
  expect(registered.size).toBe(0); expect(sources.size).toBe(0);
});
it('cleans up host layer snapshots instead of relying on object identity', async () => {
  const { service, host, registered, sources } = setup();
  host.layers.getLayer = (id: string) => { const layer = registered.get(id); return layer ? { ...layer } : undefined; };
  await service.load(input); service.dispose();
  expect(registered.size).toBe(0); expect(sources.size).toBe(0);
});
it('preserves a same-id layer replacement bound to a different source layer', async () => {
  const { service, registered, sources } = setup(); await service.load(input);
  registered.set('roads:0', { id: 'roads:0', source: 'roads', type: 'circle', 'source-layer': 'foreign' });
  service.remove('roads'); expect(registered.has('roads:0')).toBe(true); expect(sources.has('roads')).toBe(true);
});
