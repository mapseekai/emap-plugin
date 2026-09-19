import { it, expect } from 'vitest';
import { inspectWkb, wkbBytes } from './wkb.js';
import { point, collection, hex } from '../test/fixtures/wkb.js';
it.each([true, false])('validates byte order %s and retains SRID/Z', (le) => {
  const inspected = inspectWkb(point(1, 2, 3857, le, 3));
  expect([...inspected.srids]).toEqual([3857]); expect(inspected.hasZ).toBe(true); expect(inspected.vertices).toBe(1);
});
it.each(['', 'z1', '012', '0x', '\\x01z2'])('rejects malformed hex %s', (text) => {
  expect(() => wkbBytes(text)).toThrow();
});
it('accepts byte views and PostgreSQL hex envelopes', () => {
  const bytes = point();
  for (const value of [bytes, bytes.buffer as ArrayBuffer, hex(bytes), '\\x' + hex(bytes), '0x' + hex(bytes)]) expect(wkbBytes(value)).toEqual(bytes);
  expect(() => wkbBytes(bytes, 2)).toThrow(/budget/);
});
it('rejects truncated data, trailing bytes, impossible counts and vertex limits', () => {
  expect(() => inspectWkb(point().subarray(0, 7))).toThrow(/Truncated/);
  expect(() => inspectWkb(new Uint8Array([...point(), 0]))).toThrow(/Trailing/);
  const huge = collection(4, []); new DataView(huge.buffer).setUint32(5, 0xffffffff, true);
  expect(() => inspectWkb(huge)).toThrow(/count/);
  expect(() => inspectWkb(point(), 0)).toThrow(/budget/);
});
it('validates collection nesting and Multi child types', () => {
  expect(inspectWkb(collection(7, [point(), point()])).parts).toHaveLength(2);
  expect(() => inspectWkb(collection(5, [point()]))).toThrow(/child/);
  let nested = point(); for (let i = 0; i < 18; i++) nested = collection(7, [nested]);
  expect(() => inspectWkb(nested)).toThrow(/nesting/);
});
