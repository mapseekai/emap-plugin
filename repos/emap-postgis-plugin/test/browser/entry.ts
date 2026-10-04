import { Emap, Context } from '@mapseekai/emap';
import type { Fiber } from 'cordis';
import { postgisPlugin } from '../../src/index.js';
import { postgisLayerPlugin } from '../../src/layers.js';
import { postgisControl } from '../../src/control.js';
let map: Emap; let fiber: Fiber;
const checks: string[] = [];
function check(value: unknown, label: string): void { if (!value) throw new Error(label); checks.push(label); }
export async function run(options: { endpoint: string; token: string }) {
  map = await Emap.create({ container: 'map', preset: 'viewer', plugins: [postgisPlugin(options)] });
  await map.setCRS('EPSG:3857');
  fiber = map.ctx.plugin(postgisLayerPlugin()); await fiber.await();
  check(Context.is(map.ctx), 'native Cordis context identity');
  check((await map.ctx.postgis.connections()).length === 1, 'authenticated HTTP connection discovery');
  const loaded = await map.ctx.postgisLayers.load({ sourceId: 'mixed', query: { connectionId: 'main', sql: 'SELECT id, name, geom FROM shapes', idColumn: 'id' } });
  check(loaded.layerIds.length === 3, 'real emap imports three geometry families');
  const types = new Set(map.getLayers().map((layer) => layer.type));
  check(types.has('circle') && types.has('line') && types.has('fill'), 'point, line and polygon render layers');
  check(map.getSource('mixed')?.getCRS?.() === 'EPSG:3857', 'host reprojects source into map CRS');
  await map.addControl(postgisControl({ postgis: map.ctx.postgis, layers: map.ctx.postgisLayers, sql: 'SELECT id, name, geom FROM shapes' }), 'top-right');
  await new Promise((resolve) => setTimeout(resolve, 900));
  check(document.querySelector('section[aria-label="PostGIS 查询"]'), 'SQL control is mounted');
  check(map.getRenderedLayers().length >= 3, 'emap exposes rendered vector layers');
  check(diagnostics().coloredPixels > 100, 'canvas contains rendered geometry pixels');
  return { count: checks.length, checks, backend: 'isolated PostGIS + HTTP + Dataset Worker + real emap; delayed transport for cancellation only', emap: '0.14.1' };
}
export async function dispose() {
  try {
    await fiber.restart(); await fiber.await();
    check(!map.getSource('mixed'), 'feature restart removes its own source');
    check(map.getLayers().length === 0, 'feature restart removes its own layers');
    const stale = map.ctx.postgisLayers;
    const pending = stale.load({ sourceId: 'slow', query: { connectionId: 'main', sql: 'SELECT slow' } });
    const rejected = pending.then(() => false, () => true);
    await new Promise((resolve) => setTimeout(resolve, 30)); await fiber.dispose();
    check(await rejected, 'unload cancels an in-flight HTTP query');
    check(!map.getSource('slow'), 'late results cannot create a source after unload');
    check((await map.ctx.postgis.connections()).length === 1, 'layer feature unload preserves provider');
    return { count: checks.length, checks };
  } finally { await map.dispose(); }
}
export function diagnostics() {
  const source = map.getSource('mixed') as import('@mapseekai/emap').TopologySource | undefined;
  let coloredPixels = 0;
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('#map canvas')) {
    if (!canvas.width || !canvas.height) continue;
    // EMAP 0.14 uses a GPU canvas; sample through a separate 2D canvas.
    const snapshot = document.createElement('canvas');
    snapshot.width = canvas.width; snapshot.height = canvas.height;
    const context = snapshot.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i + 3] && (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250)) coloredPixels++;
  }
  return {
    sourceReferenceStable: source === map.getSource('mixed'),
    layerReferenceStable: map.getLayer('mixed:0') === map.getLayer('mixed:0'),
    sourceExtent: source?.getExtent(), viewExtent: map.ctx.view.getExtent(),
    center: map.ctx.view.getCenter(), zoom: map.ctx.view.getZoom(),
    layers: map.getLayers(), coloredPixels,
    sourceLayers: source?.getLayers().map((layer) => ({ name: layer.name, type: layer.geometry_type, shape: layer.shapes?.[0] })),
  };
}
