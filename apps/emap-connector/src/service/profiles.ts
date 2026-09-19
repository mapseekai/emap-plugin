import { isIP } from 'node:net';
import type { GatewayOptions } from '@mapseekai/emap-postgis-plugin/server';
import { ConnectorError, CONNECTION_ID, object, requireString } from './security.js';

export interface Profile {
  id: string; label: string; host: string; port: number; database: string; user: string;
  password: string; tls: 'verify' | 'local'; ca?: string;
}
export function validateProfile(value: unknown): Profile {
  const p = object(value, ['id', 'label', 'host', 'port', 'database', 'user', 'password', 'tls', 'ca']);
  requireString(p.id, CONNECTION_ID, 'id');
  for (const key of ['label', 'database', 'user', 'password']) {
    if (typeof p[key] !== 'string' || !(p[key] as string).length || (p[key] as string).length > 1024 || (p[key] as string).includes('\0'))
      throw new ConnectorError('INVALID_PROFILE', `Invalid ${key}`);
  }
  if (typeof p.host !== 'string' || p.host.length > 253 ||
      !(isIP(p.host) || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(p.host)))
    throw new ConnectorError('INVALID_PROFILE', 'Use a database hostname or IP, not a URL or socket path');
  if (!Number.isInteger(p.port) || Number(p.port) < 1 || Number(p.port) > 65535) throw new ConnectorError('INVALID_PROFILE', 'Invalid database port');
  if (p.tls !== 'verify' && p.tls !== 'local') throw new ConnectorError('INVALID_PROFILE', 'Choose verified TLS or local-only plaintext');
  if (p.tls === 'local' && !['127.0.0.1', '::1'].includes(p.host))
    throw new ConnectorError('TLS_REQUIRED', 'Remote database connections require certificate-verified TLS. Use a loopback IP for a local tunnel.');
  if (p.ca !== undefined && (typeof p.ca !== 'string' || p.ca.length > 65536)) throw new ConnectorError('INVALID_PROFILE', 'CA certificate is too large');
  return p as unknown as Profile;
}
export function gatewayOptions(profile: Profile): GatewayOptions {
  return { connections: { [profile.id]: { label: profile.label, config: {
    host: profile.host, port: profile.port, database: profile.database, user: profile.user, password: profile.password,
    ssl: profile.tls === 'verify' ? { rejectUnauthorized: true, ...(profile.ca ? { ca: profile.ca } : {}) } : false,
  } } }, maxConcurrent: 4 };
}
