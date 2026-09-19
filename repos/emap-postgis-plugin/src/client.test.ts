import { it, expect, vi } from 'vitest';
import { createPostgisClient } from './client.js';
const endpoint = 'https://gateway.example/postgis';
it('sends SQL and parameters as JSON with application authentication', async () => {
  const fetcher = vi.fn(async () => Response.json({ rows: [], rowCount: 0 }));
  const service = createPostgisClient({ endpoint, token: 'application-test-token', fetch: fetcher });
  await service.query({ connectionId: 'main', sql: 'SELECT $1', parameters: ["O\'Brien"] });
  const call = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
  expect(call[0]).toBe(endpoint + '/query');
  expect(JSON.parse(String(call[1].body)).parameters).toEqual(["O'Brien"]);
  expect((call[1].headers as Record<string, string>).Authorization).toBe('Bearer application-test-token');
  expect(call[1].redirect).toBe('error'); service.dispose();
});
it('propagates safe HTTP errors and rejects oversized responses', async () => {
  const denied = createPostgisClient({ endpoint, fetch: async () => Response.json({ error: { code: 'SELECT_ONLY', message: 'SELECT only' } }, { status: 400 }) });
  await expect(denied.query({ connectionId: 'main', sql: 'DELETE FROM x' })).rejects.toMatchObject({ code: 'SELECT_ONLY' }); denied.dispose();
  const large = createPostgisClient({ endpoint, maxResponseBytes: 1024, fetch: async () => new Response('x'.repeat(2048)) });
  await expect(large.connections()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' }); large.dispose();
});
it('cancels even while waiting for a token and makes disposal terminal', async () => {
  const service = createPostgisClient({ endpoint, token: () => new Promise(() => {}) });
  const call = service.connections(); service.dispose();
  await expect(call).rejects.toMatchObject({ name: 'AbortError' });
  await expect(service.connections()).rejects.toMatchObject({ code: 'DISPOSED' });
});
it('rejects database URLs and embedded credentials', () => {
  expect(() => createPostgisClient({ endpoint: 'postgres://localhost/gis' })).toThrow();
  expect(() => createPostgisClient({ endpoint: 'https://user:password@example.com' })).toThrow();
});
