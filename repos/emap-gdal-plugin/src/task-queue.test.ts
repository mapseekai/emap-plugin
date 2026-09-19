import { it, expect, vi } from 'vitest';
import { TaskQueue } from './task-queue.js';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
it('releases admission before resolving an awaited task', async () => {
  const queue = new TaskQueue(1);
  expect(await queue.enqueue('first', {}, async () => 1)).toBe(1);
  expect(queue.pending).toBe(0);
  expect(await queue.enqueue('second', {}, async () => 2)).toBe(2);
  queue.dispose();
});
it('executes FIFO with one active task', async () => {
  const queue = new TaskQueue(), gate = deferred(), order: number[] = [];
  const a = queue.enqueue('a', {}, async () => { order.push(1); await gate.promise; order.push(2); });
  const b = queue.enqueue('b', {}, async () => { order.push(3); });
  await Promise.resolve();
  expect(order).toEqual([1]); gate.resolve();
  await Promise.all([a, b]); expect(order).toEqual([1, 2, 3]); queue.dispose();
});
it('cancels queued work before it starts', async () => {
  const queue = new TaskQueue(), gate = deferred(), signal = new AbortController(), run = vi.fn();
  const first = queue.enqueue('first', {}, () => gate.promise);
  const second = queue.enqueue('second', { signal: signal.signal }, async () => run());
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  signal.abort(); await rejected; gate.resolve(); await first; expect(run).not.toHaveBeenCalled(); queue.dispose();
});
it('enforces queue admission and execution timeouts', async () => {
  const queue = new TaskQueue(1, 10);
  const first = queue.enqueue('blocked', {}, () => new Promise(() => {}));
  await expect(queue.enqueue('extra', {}, async () => 1)).rejects.toMatchObject({ code: 'GDAL_QUEUE_FULL' });
  await expect(first).rejects.toMatchObject({ code: 'GDAL_TIMEOUT' }); queue.dispose();
});
it('unload aborts active and queued work and rejects future work', async () => {
  const queue = new TaskQueue();
  const active = queue.enqueue('active', {}, () => new Promise(() => {}));
  const queued = queue.enqueue('queued', {}, async () => 1);
  const a = expect(active).rejects.toMatchObject({ name: 'AbortError' });
  const b = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  queue.dispose(); await Promise.all([a, b]);
  await expect(queue.enqueue('later', {}, async () => 1)).rejects.toMatchObject({ code: 'GDAL_DISPOSED' });
});
it('observer failures do not affect successful work', async () => {
  const queue = new TaskQueue();
  const result = await queue.enqueue('success', { onProgress: () => { throw new Error('observer'); } }, async () => 42);
  expect(result).toBe(42); queue.dispose();
});
