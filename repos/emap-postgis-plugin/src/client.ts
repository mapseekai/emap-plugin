import { readWkbStream } from './stream.js';
import { createDatasetConverter } from './converter.js';
import type { WkbQueryResult } from './wkb-types.js';
import { PostgisError, assertActive, integer } from './errors.js';
import type { PostgisContract, PostgisOptions, RequestOptions } from './types.js';

/** Browser transport. Database credentials are never accepted by this client. */
export function createPostgisClient(options: PostgisOptions): PostgisContract {
  const base = new URL(options.endpoint, typeof location === 'undefined' ? undefined : location.href);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new PostgisError('INVALID_ENDPOINT', 'An HTTP(S) gateway URL without credentials is required');
  }
  const endpoint = base.href.replace(/\/$/, '');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeout = integer(options.timeoutMs, 30000, 1, 300000, 'timeoutMs');
  const budget = integer(options.maxResponseBytes, 12582912, 1024, 104857600, 'maxResponseBytes');
  const pending = new Set<AbortController>();
  let disposed = false;
  const converter = createDatasetConverter(options.conversion);
  async function request<T>(path: string, body: unknown, call: RequestOptions = {}): Promise<T> {
    if (disposed) throw new PostgisError('DISPOSED', 'PostGIS client is disposed');
    const controller = new AbortController(); const signal = controller.signal;
    const cancel = () => controller.abort(call.signal?.reason);
    call.signal?.addEventListener('abort', cancel, { once: true });
    if (call.signal?.aborted) cancel();
    pending.add(controller);
    const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout);
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
    });
    const execute = async (): Promise<T> => {
      assertActive(signal);
      const token = typeof options.token === 'function' ? await options.token() : options.token;
      assertActive(signal);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetcher(endpoint + path, {
        method: body === undefined ? 'GET' : 'POST', headers, signal,
        credentials: 'same-origin', redirect: 'error',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assertActive(signal);
      const reader = response.body?.getReader();
      if (!reader) throw new PostgisError('INVALID_RESPONSE', 'Empty gateway response', 502);
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); assertActive(signal);
          if (done) break;
          size += value.byteLength;
          if (size > budget) throw new PostgisError('RESPONSE_TOO_LARGE', 'Gateway response exceeds byte budget', 413);
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let payload: any;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new PostgisError('INVALID_RESPONSE', 'Gateway did not return JSON', 502); }
      if (!response.ok) throw new PostgisError(payload?.error?.code ?? 'HTTP_ERROR', payload?.error?.message ?? 'PostGIS request failed', response.status);
      return payload as T;
    };
    try { return await Promise.race([execute(), aborted]); }
    finally {
      clearTimeout(timer); pending.delete(controller);
      call.signal?.removeEventListener('abort', cancel); signal.removeEventListener('abort', onAbort);
    }
  }
  return {
    connections: (call) => request('/connections', undefined, call),
    testConnection: (connectionId, call) => request('/test', { connectionId }, call),
    tables: (connectionId, call) => request(`/tables?connectionId=${encodeURIComponent(connectionId)}`, undefined, call),
    query: (input, call) => request('/query', input, call),
    queryWkb: (input, call) => request('/wkb', input, call),
    async queryDataset(input, call) {
      const result = await request<WkbQueryResult>('/wkb', input, call);
      if (disposed) throw new PostgisError('DISPOSED', 'PostGIS client is disposed');
      return converter.convert(result, call);
    },
    async queryDatasetStream(input, call = {}) {
      if (disposed) throw new PostgisError('DISPOSED', 'PostGIS client is disposed');
      const task = new AbortController(); pending.add(task);
      const signal = call.signal ? AbortSignal.any([task.signal,call.signal]) : task.signal;
      try {
        return await converter.convertPages(readWkbStream({ ...options, endpoint },input,{ signal }),{ ...call,signal });
      } finally { task.abort(); pending.delete(task); }
    },
    dispose() {
      disposed = true; converter.dispose();
      for (const controller of pending) controller.abort(new DOMException('Plugin unloaded', 'AbortError'));
      pending.clear();
    },
  };
}
