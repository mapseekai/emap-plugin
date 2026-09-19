import { it, expect } from 'vitest';
import { Context } from 'cordis';
import { gdalPlugin } from './plugin.js';
import { FakeWorker } from '../test/fixtures/fake-worker.js';
it('is lazy, preserves native Context identity and creates a new service on restart', async () => {
  const workers: FakeWorker[] = [], ctx = new Context();
  const fiber = ctx.plugin(gdalPlugin({ createWorker: () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  } }));
  await fiber.await();
  expect(Context.is(ctx)).toBe(true); expect(workers).toHaveLength(0);
  const service = ctx.gdal;
  expect((await service.drivers()).raster).toHaveProperty('GTiff');
  expect(workers[0].terminated).toBe(true);
  await fiber.restart(); await fiber.await();
  expect(ctx.gdal).not.toBe(service);
  await expect(service.drivers()).rejects.toMatchObject({ code: 'GDAL_DISPOSED' });
  await fiber.dispose();
});
it('unloading aborts initialization but does not affect another map', async () => {
  const a = new Context(), b = new Context(), worker = new FakeWorker(true);
  const fa = a.plugin(gdalPlugin({ createWorker: () => worker }));
  const fb = b.plugin(gdalPlugin({ createWorker: () => new FakeWorker() }));
  await Promise.all([fa.await(), fb.await()]);
  const pending = a.gdal.drivers();
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve(); await fa.dispose(); await rejected;
  expect(worker.terminated).toBe(true);
  expect((await b.gdal.drivers()).raster).toHaveProperty('GTiff'); await fb.dispose();
});
