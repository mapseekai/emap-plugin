import { describe, it, expect } from 'vitest';
import { planOverviews, normalizeOverviews, inputSet, filename } from './validation.js';
describe('overview validation', () => {
  it('includes the final ceil-sized overview for odd dimensions', () => {
    expect(planOverviews(2049, 1001).map((v) => [v.factor, v.width, v.height]))
      .toEqual([[2, 1025, 501], [4, 513, 251], [8, 257, 126], [16, 129, 63]]);
  });
  it('sorts and deduplicates explicit factors without changing the input', () => {
    const levels = [8, 2, 4, 2];
    expect(planOverviews(64, 48, { levels }).map((v) => v.factor)).toEqual([2, 4, 8]);
    expect(levels).toEqual([8, 2, 4, 2]);
  });
  it('does not invent an overview for an already-small raster', () => {
    expect(() => planOverviews(256, 256)).toThrow(/already fits/);
  });
  it.each([[], [1], [-2], [2.5], [Infinity], [2147483648]])('rejects bad factors %j', (...levels) => {
    expect(() => normalizeOverviews({ levels: levels.flat() as number[] })).toThrow();
  });
  it('rejects internal mutation and per-task cache settings', () => {
    expect(() => normalizeOverviews({ external: false } as never)).toThrow();
    expect(() => normalizeOverviews({ config: { GDAL_CACHEMAX: '64' } })).toThrow();
    expect(() => normalizeOverviews({ config: { USE_RRD: 'YES' } })).toThrow();
  });
  it.each(['../x', 'a/b', 'a\\b', '..', 'bad\0name', '.gdal3-overviews-x'])('rejects unsafe filename %s', (name) => {
    expect(() => filename(name)).toThrow();
  });
  it('accepts Unicode names and preserves File identity', () => {
    const file = new File(['test'], '高景.test.tif');
    expect(inputSet(file).files[0]).toBe(file);
  });
});
