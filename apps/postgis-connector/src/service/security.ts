import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export const DEFAULT_PORT = 18787;
export const PROTOCOL_VERSION = 1;
export const REQUEST_ID = /^[A-Za-z0-9_-]{43}$/;
export const CONNECTION_ID = /^[a-zA-Z0-9_-]{1,64}$/;
export class ConnectorError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function requireString(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new ConnectorError('INVALID_ARGUMENT', `Invalid ${name}`);
  return value;
}
export function exactOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new ConnectorError('ORIGIN_DENIED', 'A secure, exact Origin is required', 403);
  try {
    const u = new URL(value);
    if (u.origin !== value || u.username || u.password ||
        !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error();
    return value;
  } catch { throw new ConnectorError('ORIGIN_DENIED', 'Only HTTPS sites or loopback development sites are allowed', 403); }
}
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url');
export const secret = (): string => randomBytes(32).toString('base64url');
export function equal(a: string, b: string): boolean {
  const aa = Buffer.from(sha256(a)); const bb = Buffer.from(sha256(b));
  return timingSafeEqual(aa, bb);
}
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    throw new ConnectorError('INVALID_ARGUMENT', 'Use documented fields only');
  return value as Record<string, unknown>;
}
export function launchRequest(input: string): string {
  try {
    const u = new URL(input);
    if (u.protocol !== 'emap-connect:' || u.hostname !== 'start' || u.username || u.password || u.port ||
        (u.pathname !== '' && u.pathname !== '/') || u.hash || [...u.searchParams].length !== 1 || !u.searchParams.has('request_id')) throw new Error();
    return requireString(u.searchParams.get('request_id'), REQUEST_ID, 'request_id');
  } catch { throw new ConnectorError('INVALID_LAUNCH', 'Invalid connector launch URL'); }
}
