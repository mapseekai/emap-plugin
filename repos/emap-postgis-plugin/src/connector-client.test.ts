import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostgisConnector } from './connector-client.js';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(extra: Partial<Parameters<typeof createPostgisConnector>[0]> = {}) {
  const calls: { path: string; authorization: string | null }[] = [];
  const launch = vi.fn();
  const expiresAt = Date.now() + 60_000;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url); calls.push({ path, authorization: new Headers(init?.headers).get('Authorization') });
    if (path.endsWith('/health')) return json({ app: 'emap-connector', protocolVersion: 1 });
    if (path.endsWith('/pair/status')) return json({ state: 'approved', token: 't'.repeat(43), connectionId: 'roads', expiresAt });
    if (path.endsWith('/connections')) return json([{ id: 'roads', label: 'Roads' }]);
    return json({ ok: true });
  });
  const connector = createPostgisConnector({ launch, fetch: fetcher as typeof fetch, conversion: { worker: false }, ...extra });
  return { connector, launch, calls, expiresAt, fetcher };
}
describe('owned PostGIS connector client', () => {
  it('launches in the click stack and authenticates without exposing a token on its public result', async () => {
    const f = fixture(); const pending = f.connector.connect();
    expect(f.launch).toHaveBeenCalledOnce();
    const connection = await pending;
    expect(connection.connectionId).toBe('roads');
    expect(await connection.client.connections()).toEqual([{ id: 'roads', label: 'Roads' }]);
    expect(f.calls.at(-1)?.authorization).toBe('Bearer ' + 't'.repeat(43));
    expect(JSON.stringify(connection)).not.toContain('t'.repeat(43));
    expect('token' in connection).toBe(false);
    await f.connector.dispose();
  });
  it('closes the session and disposes the client exactly once', async () => {
    const f = fixture(); const connection = await f.connector.connect();
    connection.client.dispose(); await connection.close(); await f.connector.dispose();
    expect(f.calls.filter(c => c.path.endsWith('/session/close'))).toHaveLength(1);
    await expect(connection.client.connections()).rejects.toMatchObject({ code: 'DISPOSED' });
    await expect(f.connector.connect()).rejects.toMatchObject({ code: 'DISPOSED' });
  });
  it('refuses expired credentials before sending a query', async () => {
    const f = fixture(); const connection = await f.connector.connect();
    vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt + 1);
    await expect(connection.client.connections()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(f.calls.some(c => c.path.endsWith('/connections'))).toBe(false);
    await f.connector.dispose();
  });
  it('releases approval when client construction fails', async () => {
    const f = fixture({ queryTimeoutMs: 0 });
    await expect(f.connector.connect()).rejects.toThrow();
    expect(f.calls.filter(c => c.path.endsWith('/session/close'))).toHaveLength(1);
    await f.connector.dispose();
  });
  it('does not launch on an insecure page or after caller cancellation', async () => {
    const f = fixture(); vi.stubGlobal('isSecureContext', false);
    await expect(f.connector.connect()).rejects.toMatchObject({ code: 'INSECURE_CONTEXT' });
    expect(f.launch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
    const controller = new AbortController(); controller.abort();
    await expect(f.connector.connect({ signal: controller.signal })).rejects.toThrow();
    expect(f.launch).not.toHaveBeenCalled(); await f.connector.dispose();
  });
  it('cancels a pending database HTTP request when the owner is disposed', async () => {
    const f = fixture(); const connection = await f.connector.connect();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const fallback = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/query')) return fallback(url, init);
      entered();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal?.aborted) reject(signal.reason);
      });
    });
    const pending = connection.client.query({ connectionId: 'roads', sql: 'SELECT 1' });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started; await f.connector.dispose(); await rejected;
  });
});
