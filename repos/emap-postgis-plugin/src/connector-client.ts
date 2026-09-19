import { createConnector } from './connector.js';
import type { ConnectorOptions, ConnectorConnectOptions, ConnectorSession } from './connector.js';
import { createPostgisClient } from './client.js';
import type { ConversionOptions, PostgisContract } from './types.js';
import { PostgisError } from './errors.js';

export interface PostgisConnectorOptions extends ConnectorOptions {
  conversion?: ConversionOptions;
  queryTimeoutMs?: number;
  maxResponseBytes?: number;
  maxStreamBytes?: number;
}
/** Public metadata and an authenticated client; credentials stay inside the adapter. */
export interface PostgisConnectorConnection {
  readonly endpoint: string;
  readonly connectionId: string;
  readonly expiresAt: number;
  readonly client: PostgisContract;
  close(): Promise<void>;
}
export interface PostgisConnectorHandle {
  /** Invoke directly in a user click handler, before any await. */
  connect(options?: ConnectorConnectOptions): Promise<PostgisConnectorConnection>;
  dispose(): Promise<void>;
}

/** Owns pairing, the HTTP client and Dataset Workers as one disposable resource. */
export function createPostgisConnector(options: PostgisConnectorOptions = {}): PostgisConnectorHandle {
  const pairing = createConnector(options);
  const connections = new Set<PostgisConnectorConnection>();
  let disposed = false;
  function attach(session: ConnectorSession): PostgisConnectorConnection {
    const raw = createPostgisClient({
      endpoint: session.endpoint,
      token: () => {
        if (Date.now() >= session.expiresAt)
          throw new PostgisError('SESSION_EXPIRED', '本机授权已过期，请重新连接 Connector。', 401);
        return session.token;
      },
      fetch: options.fetch, conversion: options.conversion,
      timeoutMs: options.queryTimeoutMs, maxResponseBytes: options.maxResponseBytes, maxStreamBytes: options.maxStreamBytes,
    });
    let closing: Promise<void> | undefined;
    const connection: PostgisConnectorConnection = {
      endpoint: session.endpoint, connectionId: session.connectionId, expiresAt: session.expiresAt,
      client: { ...raw, dispose() { void connection.close(); } },
      close() {
        if (!closing) {
          raw.dispose();
          connections.delete(connection);
          closing = session.close();
        }
        return closing;
      },
    };
    connections.add(connection);
    return connection;
  }
  return {
    async connect(call = {}) {
      if (disposed) throw new PostgisError('DISPOSED', 'Connector client is disposed');
      if (globalThis.isSecureContext === false || !globalThis.crypto?.subtle)
        throw new PostgisError('INSECURE_CONTEXT', '请使用 HTTPS 或 localhost 打开网页。');
      // This call reaches the protocol launcher synchronously, before the first await.
      const session = await pairing.connect(call);
      try {
        call.signal?.throwIfAborted();
        if (disposed) throw new PostgisError('DISPOSED', 'Connector client is disposed');
        return attach(session);
      } catch (error) {
        await session.close();
        throw error;
      }
    },
    async dispose() {
      disposed = true;
      const closing = [...connections].map(connection => connection.close());
      await Promise.all([pairing.dispose(), ...closing]);
    },
  };
}
