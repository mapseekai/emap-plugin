import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PostgisError } from '../errors.js';
import type { FeatureQueryRequest, WkbStreamRequest } from '../types.js';
import type { PostgisGateway } from './gateway.js';
export interface ServerOptions {
  gateway: PostgisGateway;
  /** Trusted application users only; this token permits all configured connections. */
  token: string;
  allowedOrigins?: string[];
  prefix?: string;
}
function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const fail = (error: Error) => { cleanup(); request.resume(); reject(error); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65536) fail(new PostgisError('BODY_TOO_LARGE', 'JSON body must not exceed 64 KiB', 413));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(new PostgisError('INVALID_JSON', 'A JSON object is required')); }
    };
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', fail); };
    request.on('data', data); request.once('end', end); request.once('error', fail);
  });
}
export function createPostgisServer(options: ServerOptions): Server {
  if (typeof options.token !== 'string' || options.token.length < 24)
    throw new Error('A server-side API token of at least 24 characters is required');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${options.token}`);
  const origins = new Set(options.allowedOrigins ?? []);
  for (const origin of origins) if (new URL(origin).origin !== origin) throw new Error('Use exact HTTP(S) origins');
  const prefix = options.prefix ?? '/postgis';
  if (!/^\/[a-zA-Z0-9/_-]*[a-zA-Z0-9_-]$/.test(prefix)) throw new Error('Invalid API prefix');
  let activeRequests = 0;
  const server = createServer(async (request, response) => {
    const task = new AbortController();
    const aborted = () => { if (!response.writableEnded) task.abort(new DOMException('Client disconnected', 'AbortError')); };
    request.once('aborted', aborted); response.once('close', aborted);
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    let counted = false;
    try {
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) throw new PostgisError('ORIGIN_DENIED', 'Origin is not allowed', 403);
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.writeHead(204); response.end(); return;
      }
      if (!timingSafeEqual(digest(request.headers.authorization ?? ''), expected))
        throw new PostgisError('UNAUTHORIZED', 'A valid application API token is required', 401);
      if (activeRequests >= 16) throw new PostgisError('BUSY', 'Too many requests', 429);
      activeRequests++; counted = true;
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith(prefix + '/')) throw new PostgisError('NOT_FOUND', 'Unknown endpoint', 404);
      const path = url.pathname.slice(prefix.length); let result: unknown;
      if (request.method === 'GET' && path === '/connections') result = options.gateway.connections();
      else if (request.method === 'GET' && path === '/tables') result = await options.gateway.tables(url.searchParams.get('connectionId') ?? '', task.signal);
      else if (request.method === 'POST' && ['/query', '/wkb', '/test', '/wkb/stream'].includes(path)) {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
          throw new PostgisError('CONTENT_TYPE', 'Use application/json', 415);
        const body = await readBody(request);
        const allowed = new Set(['connectionId', 'sql', 'parameters', 'limit', 'offset', 'geometryColumn', 'idColumn', 'sourceSrid', 'targetSrid', 'format', ...(path === '/wkb/stream' ? ['batchSize', 'maxRows'] : [])]);
        if (Object.keys(body).some((key) => !allowed.has(key)) || typeof body.connectionId !== 'string')
          throw new PostgisError('INVALID_ARGUMENT', 'Use a configured connectionId and documented query fields only');
        if (path === '/wkb/stream') {
          if (body.limit !== undefined || body.offset !== undefined) throw new PostgisError('INVALID_ARGUMENT','Streaming uses maxRows rather than limit/offset');
          response.setHeader('Content-Type','application/x-ndjson');
          await options.gateway.streamWkb(body as unknown as WkbStreamRequest, async frame => {
            task.signal.throwIfAborted();
            if (!response.write(JSON.stringify(frame) + '\n')) await once(response,'drain',{ signal: task.signal });
          },task.signal);
          response.end(); return;
        }
        if (path === '/test') result = await options.gateway.testConnection(body.connectionId, task.signal);
        else if (path === '/query') result = await options.gateway.query(body as unknown as FeatureQueryRequest, task.signal);
        else result = await options.gateway.queryWkb(body as unknown as FeatureQueryRequest, task.signal);
      } else throw new PostgisError('NOT_FOUND', 'Unknown endpoint or method', 404);
      const json = JSON.stringify(result);
      if (Buffer.byteLength(json) > options.gateway.maxResponseBytes)
        throw new PostgisError('RESULT_TOO_LARGE', 'Result exceeds byte budget; request a smaller page', 413);
      response.writeHead(200); response.end(json);
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        const safe = error instanceof PostgisError ? error : new PostgisError('INTERNAL_ERROR', 'Request failed', 500);
        if (response.headersSent) {
          response.end(JSON.stringify({ type:'error', error:{ code:safe.code, message:safe.message } }) + '\n');
          return;
        }
        response.setHeader('Content-Type','application/json; charset=utf-8');
        response.writeHead(safe.status, { Connection: 'close' });
        response.end(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
        request.resume();
      }
    } finally {
      if (counted) activeRequests--;
      request.off('aborted', aborted); response.off('close', aborted);
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return server;
}
