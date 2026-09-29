import { PostgisError } from './errors.js';

export type ConnectorState = 'starting' | 'waiting-for-approval' | 'connected' | 'denied' | 'cancelled' | 'error';
export interface ConnectorOptions {
  /** Numeric loopback only. Default: http://127.0.0.1:18787. No network scanning. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Must synchronously open the URL from the user's click. Never launches a shell. */
  launch?: (url: string) => void;
  onState?: (state: ConnectorState, detail?: string) => void;
}
export interface ConnectorConnectOptions {
  signal?: AbortSignal; preferredConnectionId?: string;
  /** Requested authorization lifetime: 1 minute–24 hours. Default: 1 hour. */
  sessionDurationMs?: number;
}
export interface ConnectorSession {
  readonly endpoint: string;
  readonly connectionId: string;
  readonly expiresAt: number;
  /** Short-lived origin/database-scoped token, not a database password. Never persist. */
  readonly token: string;
  close(): Promise<void>;
}
export interface ConnectorHandle {
  /** Call directly in a user click handler, before any await. */
  connect(options?: ConnectorConnectOptions): Promise<ConnectorSession>;
  dispose(): Promise<void>;
}
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
function random(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64(bytes);
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
async function digest(value: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  });
}
/** Browser-only pairing helper; keeps the existing PostGIS provider and WKB conversion unchanged. */
export function createConnector(options: ConnectorOptions = {}): ConnectorHandle {
  const url = new URL(options.baseUrl ?? 'http://127.0.0.1:18787');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new PostgisError('INVALID_ENDPOINT', 'Connector must use an HTTP numeric loopback origin');
  const base = url.origin;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new PostgisError('INVALID_ARGUMENT', 'Invalid connector timeout');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const launch = options.launch ?? ((uri: string) => { window.location.assign(uri); });
  const sessions = new Set<ConnectorSession>();
  let pending: AbortController | undefined; let disposed = false;
  const notify = (state: ConnectorState, detail?: string) => { try { options.onState?.(state, detail); } catch { /* UI callbacks must not interrupt security cleanup. */ } };
  async function request(path: string, body: unknown, signal: AbortSignal, token?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetcher(base + path, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal,
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    });
    const reader = response.body?.getReader(); if (!reader) throw new PostgisError('INVALID_RESPONSE', 'Empty connector response');
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
        if (size > 65536) throw new PostgisError('INVALID_RESPONSE', 'Connector response exceeds 64 KiB'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const joined = new Uint8Array(size); let offset = 0; for (const part of chunks) { joined.set(part, offset); offset += part.byteLength; }
    let payload: Record<string, unknown>;
    try { const parsed = JSON.parse(new TextDecoder().decode(joined)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); payload = parsed; }
    catch { throw new PostgisError('INVALID_RESPONSE', 'Connector did not return a JSON object'); }
    if (!response.ok) {
      const error = payload.error as { code?: string; message?: string } | undefined;
      throw new PostgisError(error?.code ?? 'CONNECTOR_ERROR', error?.message ?? 'Connector request failed', response.status);
    }
    return payload;
  }
  return {
    async connect(call = {}) {
      if (disposed) throw new PostgisError('DISPOSED', 'Connector handle is disposed');
      if (pending) throw new PostgisError('BUSY', 'A connector request is already pending');
      if (call.signal?.aborted) throw call.signal.reason;
      if (call.preferredConnectionId !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(call.preferredConnectionId))
        throw new PostgisError('INVALID_ARGUMENT', 'Invalid preferred connection ID');
      const duration = call.sessionDurationMs ?? 3_600_000;
      if (!Number.isSafeInteger(duration) || duration < 60_000 || duration > 86_400_000)
        throw new PostgisError('INVALID_SESSION_DURATION', '授权时长须为 1 分钟至 24 小时。');
      const controller = new AbortController(); pending = controller;
      const cancel = () => controller.abort(call.signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
      call.signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(new PostgisError('CONNECTOR_TIMEOUT', '连接器未响应：请检查是否安装、是否允许打开应用，以及浏览器的本地网络访问权限。')), timeoutMs);
      const signal = controller.signal;
      let requestId = '', verifier = '', paired = false, supportsDuration = false;
      try {
        requestId = random(); verifier = random();
        notify('starting', requestId.slice(-6));
        // Deliberately BEFORE the first await: external-protocol launch needs user activation.
        launch(`emap-connect://start?request_id=${encodeURIComponent(requestId)}`);
        const challenge = await digest(verifier); signal.throwIfAborted();
        for (;;) {
          try {
            const health = await request('/connector/health', undefined, AbortSignal.any([signal, AbortSignal.timeout(3000)]));
            if (health.app !== 'emap-connector' || health.protocolVersion !== 1)
              throw new PostgisError('PROTOCOL_MISMATCH', '本地端口不是兼容的 postgis-connector，请检查冲突或更新连接器。');
            supportsDuration = !!(health.capabilities as { sessionDuration?: unknown } | undefined)?.sessionDuration;
            if (!supportsDuration && duration !== 3_600_000)
              throw new PostgisError('CONNECTOR_UPDATE_REQUIRED', '当前连接器只支持 1 小时授权，请更新连接器后设置其他时长。');
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof PostgisError) throw error;
            await sleep(500, signal); // failure does NOT prove the connector is uninstalled
          }
        }
        for (;;) {
          try {
            await request('/connector/pair', { requestId, challenge, ...(supportsDuration ? { sessionDurationMs: duration } : {}), ...(call.preferredConnectionId ? { preferredConnectionId: call.preferredConnectionId } : {}) }, signal);
            paired = true; break;
          } catch (error) {
            if (!(error instanceof PostgisError) || error.code !== 'LAUNCH_REQUIRED') throw error;
            await sleep(300, signal); // native initialization/deep-link handover can arrive just after health
          }
        }
        notify('waiting-for-approval', requestId.slice(-6));
        for (;;) {
          signal.throwIfAborted();
          const result = await request('/connector/pair/status', { requestId, verifier }, signal);
          if (result.state === 'pending') { await sleep(650, signal); continue; }
          if (result.state !== 'approved' || typeof result.token !== 'string' || !RANDOM.test(result.token) ||
              typeof result.connectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(result.connectionId) ||
              typeof result.expiresAt !== 'number' || result.expiresAt <= Date.now()) throw new PostgisError('INVALID_RESPONSE', 'Invalid connector authorization');
          let token: string | undefined = result.token;
          const session: ConnectorSession = {
            endpoint: base + '/postgis', connectionId: result.connectionId, expiresAt: result.expiresAt,
            get token() { if (!token) throw new PostgisError('SESSION_CLOSED', 'Connector session is closed'); return token; },
            async close() {
              const old = token; token = undefined; sessions.delete(session);
              if (old) await request('/connector/session/close', {}, AbortSignal.timeout(2000), old).catch(() => {});
            },
          };
          if (signal.aborted || disposed) { await session.close(); signal.throwIfAborted(); throw new PostgisError('DISPOSED', 'Connector handle is disposed'); }
          sessions.add(session); notify('connected'); return session;
        }
      } catch (error) {
        if (paired) await request('/connector/pair/cancel', { requestId, verifier }, AbortSignal.timeout(1000)).catch(() => {});
        notify(error instanceof PostgisError && error.code === 'PAIR_DENIED' ? 'denied' : signal.aborted ? 'cancelled' : 'error');
        throw error;
      } finally {
        verifier = ''; clearTimeout(timer); call.signal?.removeEventListener('abort', cancel);
        if (pending === controller) pending = undefined;
      }
    },
    async dispose() {
      disposed = true; pending?.abort(new DOMException('Connector unloaded', 'AbortError'));
      await Promise.all([...sessions].map(session => session.close()));
    },
  };
}
