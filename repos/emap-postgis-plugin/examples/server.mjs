import { PostgisGateway, createPostgisServer } from '../dist/server/index.js';

const connectionString = process.env.POSTGIS_DATABASE_URL;
const token = process.env.POSTGIS_API_TOKEN;
if (!connectionString || !token) throw new Error('Set POSTGIS_DATABASE_URL and POSTGIS_API_TOKEN in a server-only .env file');
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const gateway = new PostgisGateway({
  connections: { main: { label: process.env.POSTGIS_CONNECTION_LABEL ?? 'PostGIS', config: { connectionString } } },
  maxRows: 10000, maxResponseBytes: 10485760, timeoutMs: 15000,
  onError(error) { console.error('PostGIS query failed:', typeof error?.code === 'string' ? error.code : 'unknown'); },
});
const server = createPostgisServer({ gateway, token,
  allowedOrigins: (process.env.POSTGIS_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
});
server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`PostGIS gateway listening on port ${port}; API prefix /postgis`);
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  server.closeAllConnections();
  await Promise.all([new Promise((resolve) => server.close(resolve)), gateway.dispose()]);
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
server.once('error', (error) => { console.error('Gateway listen error:', error.code); void close(); process.exitCode = 1; });
