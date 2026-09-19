import { it, expect } from 'vitest';
import { GdalWorkerClient, resolveAssets } from './worker-client.js';
import { FakeWorker } from '../test/fixtures/fake-worker.js';
it('uses pinned upstream initialization and explicit asset URLs', async () => {
  const worker = new FakeWorker(), client = new GdalWorkerClient(worker, new AbortController().signal);
  const assets = resolveAssets({ assetPath: 'https://example.test/gdal' });
  expect((await client.initialize(assets, { GDAL_CACHEMAX: '64' })).raster).toHaveProperty('GTiff');
  expect(worker.messages[0]).toMatchObject({ func: 'constructor', params: { config: {
    useWorker: false, paths: { wasm: 'https://example.test/gdal/gdal3WebAssembly.wasm' },
    env: { GDAL_CACHEMAX: '64' },
  } } });
  client.dispose(); expect(worker.terminated).toBe(true);
});
it('aborts a hanging initialization and releases the Worker', async () => {
  const worker = new FakeWorker(true), controller = new AbortController();
  const client = new GdalWorkerClient(worker, controller.signal);
  const pending = client.initialize(resolveAssets({}), {});
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await rejected; expect(worker.terminated).toBe(true);
});
it('rejects every outstanding call when the Worker crashes', async () => {
  const worker = new FakeWorker(true), client = new GdalWorkerClient(worker, new AbortController().signal);
  const first = client.call('getInfo'), second = client.call('gdalinfo');
  const assertions = [first, second].map((p) => expect(p).rejects.toMatchObject({ code: 'GDAL_WORKER_ERROR' }));
  worker.onerror?.({ message: 'WASM crash', preventDefault() {} } as ErrorEvent);
  await Promise.all(assertions); expect(worker.terminated).toBe(true);
});
