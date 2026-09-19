import { request as rawRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsentBroker } from './broker.js';
import { startHttp, type Gateway } from './http.js';
import { secret, sha256 } from './security.js';
const origin = 'https://emap.example';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(f => f())); });
async function fixture() {
  const broker = new ConsentBroker({ hasConnection: id => id === 'roads', onPairing() {} });
  const gateway: Gateway = {
    connections: () => [{ id: 'roads', label: 'Roads' }], maxResponseBytes: 10000,
    testConnection: async () => ({ ok: true, postgisVersion: 'fixture' }), tables: async () => [],
    query: async () => ({ rows: [{ ok: true }], fields: [], rowCount: 1, hasMore: false, limit: 1, offset: 0 }),
    queryWkb: async () => { throw new Error('not used'); }, dispose: async () => {},
  };
  const http = await startHttp({ broker, getGateway: () => gateway, port: 0 }); cleanups.push(() => http.close());
  const base = `http://127.0.0.1:${http.port}`;
  const request = (path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const authorize = () => {
    const requestId = secret(), verifier = secret(); broker.open(requestId); broker.pair(origin, requestId, sha256(verifier)); broker.approve(requestId, 'roads', true);
    const s = broker.redeem(origin, requestId, verifier); if (s.state !== 'approved') throw new Error(); return s.token;
  };
  return { broker, gateway, http, base, request, authorize };
}
describe('loopback HTTP boundary', () => {
  it('rejects missing/null/remote-insecure origins and DNS-rebinding Host values', async () => {
    const f = await fixture();
    expect((await fetch(f.base + '/connector/health')).status).toBe(403);
    for (const bad of ['null', 'http://evil.example', 'https://emap.example/path']) expect((await f.request('/connector/health', undefined, undefined, { Origin: bad })).status).toBe(403);
    // Fetch rewrites forbidden Host headers. Use raw HTTP to actually send the hostile value.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = rawRequest(f.base + '/connector/health', { headers: { Host: 'evil.example', Origin: origin } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(403);
  });
  it('answers CORS/local-network preflight without granting database access', async () => {
    const f = await fixture(); const r = await fetch(f.base + '/postgis/query', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Private-Network': 'true' } });
    expect(r.status).toBe(204); expect(r.headers.get('Access-Control-Allow-Origin')).toBe(origin); expect(r.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
    expect((await f.request('/postgis/connections')).status).toBe(401);
  });
  it('does not expose management/configuration/approval routes', async () => {
    const f = await fixture(); const token = f.authorize();
    for (const path of ['/connector/approve', '/connector/config', '/connector/initialize', '/connector/upsert']) expect((await f.request(path, {}, token)).status).toBe(404);
  });
  it('requires proof and only returns the authorized connection', async () => {
    const f = await fixture(), id = secret(), verifier = secret();
    expect((await f.request('/connector/pair', { requestId: id, challenge: sha256(verifier) })).status).toBe(409);
    f.broker.open(id);
    expect((await f.request('/connector/pair', { requestId: id, challenge: sha256(verifier) })).status).toBe(200);
    const pending = await f.request('/connector/pair/status', { requestId: id, verifier }); expect((await pending.json()).state).toBe('pending');
    f.broker.approve(id, 'roads', false);
    const result = await (await f.request('/connector/pair/status', { requestId: id, verifier })).json();
    expect((await f.request('/postgis/connections', undefined, result.token)).status).toBe(200);
    expect((await f.request('/postgis/query', { connectionId: 'other', sql: 'SELECT 1' }, result.token)).status).toBe(403);
    expect((await f.request('/postgis/connections', undefined, result.token, { Origin: 'https://evil.example' })).status).toBe(401);
    expect((await f.request('/connector/pair/status', { requestId: id, verifier })).status).toBe(403);
  });
  it('revocation blocks results from an already-running operation', async () => {
    const f = await fixture(), token = f.authorize(); let started!: () => void;
    const began = new Promise<void>(done => { started = done; });
    f.gateway.query = async (_request, signal) => { started(); await new Promise<void>(done => signal?.addEventListener('abort', () => done(), { once: true })); return { rows: [], fields: [], rowCount: 0, hasMore: false, limit: 1, offset: 0 }; };
    const running = f.request('/postgis/query', { connectionId: 'roads', sql: 'SELECT 1' }, token);
    await began; f.broker.revoke(origin, 'roads'); expect((await running).status).toBe(403);
  });
  it('requires JSON and rejects configuration smuggling through query fields', async () => {
    const f = await fixture(), token = f.authorize();
    expect((await f.request('/postgis/query', { connectionId: 'roads', sql: 'SELECT 1', host: 'evil' }, token)).status).toBe(400);
    expect((await f.request('/postgis/query', { connectionId: 'roads', sql: 'SELECT 1' }, token, { 'Content-Type': 'text/plain' })).status).toBe(415);
  });
});
