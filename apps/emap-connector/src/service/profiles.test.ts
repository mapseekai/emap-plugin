import { it, expect } from 'vitest';
import { validateProfile, gatewayOptions } from './profiles.js';
const base = { id: 'roads', label: 'Roads', host: 'db.example', port: 5432, database: 'gis', user: 'reader', password: 'secret', tls: 'verify' };
it('uses validated TLS without environment-selected connection defaults', () => {
  const config = gatewayOptions(validateProfile(base)).connections.roads.config;
  expect(config.ssl).toEqual({ rejectUnauthorized: true }); expect(config.host).toBe('db.example');
});
it('allows plaintext only for an explicit numeric loopback address', () => {
  expect(() => validateProfile({ ...base, tls: 'local' })).toThrow();
  expect(() => validateProfile({ ...base, host: 'localhost', tls: 'local' })).toThrow();
  expect(validateProfile({ ...base, host: '127.0.0.1', tls: 'local' }).tls).toBe('local');
});
it('rejects URL/socket injection, extra fields, invalid ports and oversized passwords', () => {
  for (const change of [{ host: '/tmp' }, { host: 'postgres://a:b@host/db' }, { host: 'foo@bar' }, { connectionString: 'evil' }, { port: 0 }, { port: 1.5 }, { password: 'x'.repeat(2000) }]) expect(() => validateProfile({ ...base, ...change })).toThrow();
});
