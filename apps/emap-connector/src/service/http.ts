import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PostgisGateway } from '@mapseekai/emap-postgis-plugin/server';
import { PostgisError } from '@mapseekai/emap-postgis-plugin/server';
import { ConsentBroker } from './broker.js';
import { ConnectorError, DEFAULT_PORT, PROTOCOL_VERSION, exactOrigin, object } from './security.js';

export type Gateway = Pick<PostgisGateway, 'connections' | 'testConnection' | 'tables' | 'query' | 'queryWkb' | 'maxResponseBytes' | 'dispose'>;
export interface HttpOptions { broker: ConsentBroker; getGateway(id: string): Gateway | undefined; port?: number; }
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new ConnectorError('CONTENT_TYPE', 'Use application/json', 415);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536) throw new ConnectorError('BODY_TOO_LARGE', 'Request exceeds 64 KiB', 413);
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); return object(value, Object.keys(value)); }
  catch { throw new ConnectorError('INVALID_JSON', 'A JSON object is required'); }
}
export async function startHttp(options: HttpOptions) {
  let active = 0; let port = options.port ?? DEFAULT_PORT;
  let windowStart = Date.now(); let requests = 0;
  const server = createServer(async (req, res) => {
    const task = new AbortController(); let counted = false;
    const disconnect = () => { if (!res.writableEnded) task.abort(new ConnectorError('CANCELLED', 'Browser disconnected', 499)); };
    req.once('aborted', disconnect); res.once('close', disconnect);
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (req.headers.host !== `127.0.0.1:${port}` || !req.url?.startsWith('/') || req.url.startsWith('//'))
        throw new ConnectorError('HOST_DENIED', 'Invalid loopback host', 403);
      const origin = exactOrigin(req.headers.origin);
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.writeHead(204); res.end(); return;
      }
      if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); requests = 0; }
      if (++requests > 600 || active >= 16) throw new ConnectorError('BUSY', 'Connector request budget exceeded', 429);
      active++; counted = true;
      const url = new URL(req.url, `http://127.0.0.1:${port}`); let value: unknown;
      let budget = 65536;
      if (req.method === 'GET' && url.pathname === '/connector/health') {
        value = { app: 'emap-connector', protocolVersion: PROTOCOL_VERSION, capabilities: { sessionDuration: { minMs: 60000, maxMs: 86400000, defaultMs: 3600000 } } };
      } else if (req.method === 'POST' && url.pathname === '/connector/pair') {
        const p = object(await body(req), ['requestId', 'challenge', 'preferredConnectionId', 'sessionDurationMs']);
        options.broker.pair(origin, p.requestId as string, p.challenge as string, p.preferredConnectionId as string | undefined, p.sessionDurationMs as number | undefined);
        value = { state: 'pending' };
      } else if (req.method === 'POST' && ['/connector/pair/status', '/connector/pair/cancel'].includes(url.pathname)) {
        const p = object(await body(req), ['requestId', 'verifier']);
        if (typeof p.requestId !== 'string' || typeof p.verifier !== 'string') throw new ConnectorError('INVALID_ARGUMENT', 'Pairing proof required');
        if (url.pathname.endsWith('/cancel')) { options.broker.cancel(origin, p.requestId, p.verifier); value = { ok: true }; }
        else value = options.broker.redeem(origin, p.requestId, p.verifier);
      } else {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        const session = options.broker.authorize(origin, token);
        const signal = AbortSignal.any([task.signal, session.controller.signal]);
        if (req.method === 'POST' && url.pathname === '/connector/session/close') {
          options.broker.release(origin, token); value = { ok: true };
        } else {
          const gateway = options.getGateway(session.connectionId);
          if (!gateway) throw new ConnectorError('UNKNOWN_CONNECTION', 'Connection is unavailable', 404);
          budget = gateway.maxResponseBytes;
          const assertScope = (id: unknown): void => {
            if (id !== session.connectionId) throw new ConnectorError('CONNECTION_DENIED', 'Session is not authorized for this database', 403);
          };
          if (req.method === 'GET' && url.pathname === '/postgis/connections') value = gateway.connections();
          else if (req.method === 'GET' && url.pathname === '/postgis/tables') {
            const id = url.searchParams.get('connectionId'); assertScope(id); value = await gateway.tables(id!, signal);
          } else if (req.method === 'POST' && ['/postgis/query', '/postgis/wkb', '/postgis/test'].includes(url.pathname)) {
            const p = object(await body(req), ['connectionId', 'sql', 'parameters', 'limit', 'offset', 'geometryColumn', 'idColumn', 'sourceSrid', 'targetSrid', 'format']);
            assertScope(p.connectionId);
            if (url.pathname === '/postgis/test') value = await gateway.testConnection(session.connectionId, signal);
            else if (url.pathname === '/postgis/query') value = await gateway.query(p as unknown as Parameters<Gateway['query']>[0], signal);
            else value = await gateway.queryWkb(p as unknown as Parameters<Gateway['queryWkb']>[0], signal);
          } else throw new ConnectorError('NOT_FOUND', 'Unknown endpoint', 404);
          signal.throwIfAborted(); // revocation must not let an in-flight result escape
        }
      }
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > budget) throw new ConnectorError('RESULT_TOO_LARGE', 'Response exceeds byte budget', 413);
      if (!res.destroyed) { res.writeHead(200); res.end(encoded); }
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        const safe = error instanceof ConnectorError || error instanceof PostgisError ? error : new ConnectorError('INTERNAL_ERROR', 'Connector request failed', 500);
        res.writeHead(safe.status, { Connection: 'close' }); res.end(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
      }
      req.resume();
    } finally { if (counted) active--; req.off('aborted', disconnect); res.off('close', disconnect); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  const sweep = setInterval(() => options.broker.sweep(), 1000); sweep.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    port = (server.address() as AddressInfo).port;
  } catch (error) { clearInterval(sweep); throw error; }
  return { server, port, async close() { clearInterval(sweep); options.broker.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}
