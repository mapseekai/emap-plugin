import { it, expect, vi, afterEach } from 'vitest';
import { createDatasetConverter } from './converter.js';
import { point, result } from '../test/fixtures/wkb.js';
afterEach(() => vi.unstubAllGlobals());
it('uses the real direct converter in Node', async () => {
  const converter = createDatasetConverter({ worker: false });
  const converted = await converter.convert(result([point()]));
  expect(converted.dataset.layers[0].geometry_type).toBe('point'); converter.dispose();
  await expect(converter.convert(result([]))).rejects.toMatchObject({ code: 'DISPOSED' });
});
it('bounds worker concurrency, cancels, recovers and terminates on unload', async () => {
  const workers: { terminate: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('Worker', class {
    terminate = vi.fn(); postMessage = vi.fn();
    constructor() { workers.push(this); }
  });
  const converter = createDatasetConverter({ maxConcurrent: 1 }); const abort = new AbortController();
  const first = converter.convert(result([point()]), { signal: abort.signal });
  await expect(converter.convert(result([]))).rejects.toMatchObject({ code: 'BUSY' });
  abort.abort(); await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(workers[0].terminate).toHaveBeenCalled();
  const next = converter.convert(result([point()])); converter.dispose();
  await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  expect(workers[1].terminate).toHaveBeenCalled();
});
