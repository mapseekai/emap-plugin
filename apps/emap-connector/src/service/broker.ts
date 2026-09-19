import { ConnectorError, CONNECTION_ID, REQUEST_ID, equal, exactOrigin, requireString, secret, sha256 } from './security.js';

export interface Grant { origin: string; connectionId: string; maxSessionMs?: number; }
export interface Pairing {
  requestId: string; origin: string; challenge: string; expiresAt: number;
  sessionDurationMs: number; preferredConnectionId?: string; state: 'pending' | 'approved' | 'denied'; connectionId?: string;
}
export interface Session { origin: string; connectionId: string; expiresAt: number; controller: AbortController; }
export interface BrokerOptions {
  hasConnection(id: string): boolean;
  onPairing(): void;
  now?: () => number;
  pairTtlMs?: number;
  sessionTtlMs?: number;
}
/** Consent authority. Native IPC alone may add launch tickets, approve, restore grants or revoke. */
export class ConsentBroker {
  private readonly tickets = new Map<string, number>();
  private readonly pairs = new Map<string, Pairing>();
  private readonly sessions = new Map<string, Session>();
  private readonly grants = new Map<string, Grant>();
  private readonly now: () => number;
  constructor(private readonly options: BrokerOptions) { this.now = options.now ?? Date.now; }
  private key(origin: string, id: string): string { return JSON.stringify([origin, id]); }
  private get pairTtl(): number { return this.options.pairTtlMs ?? 120_000; }
  private get sessionTtl(): number { return this.options.sessionTtlMs ?? 3_600_000; }
  sweep(): void {
    const now = this.now();
    for (const [id, expiry] of this.tickets) if (expiry <= now) this.tickets.delete(id);
    for (const [id, pair] of this.pairs) if (pair.expiresAt <= now) this.pairs.delete(id);
    for (const [hash, session] of this.sessions) if (session.expiresAt <= now) {
      session.controller.abort(new ConnectorError('SESSION_EXPIRED', 'Reconnect to renew your session', 401));
      this.sessions.delete(hash);
    }
  }
  open(requestId: string): void {
    requireString(requestId, REQUEST_ID, 'requestId'); this.sweep();
    if (this.pairs.has(requestId) || this.tickets.has(requestId)) return;
    if (this.tickets.size >= 16) throw new ConnectorError('BUSY', 'Too many launch requests', 429);
    this.tickets.set(requestId, this.now() + this.pairTtl);
  }
  pair(origin: string, requestId: string, challenge: string, preferredConnectionId?: string, sessionDurationMs?: number): void {
    exactOrigin(origin); requireString(requestId, REQUEST_ID, 'requestId'); requireString(challenge, REQUEST_ID, 'challenge');
    if (preferredConnectionId !== undefined) requireString(preferredConnectionId, CONNECTION_ID, 'preferredConnectionId');
    const duration = sessionDurationMs ?? this.sessionTtl;
    if (sessionDurationMs !== undefined && (!Number.isSafeInteger(duration) || duration < 60000 || duration > 86400000))
      throw new ConnectorError('INVALID_SESSION_DURATION', 'Session duration must be between 1 minute and 24 hours');
    this.sweep();
    const existing = this.pairs.get(requestId);
    if (existing) {
      if (existing.origin !== origin || !equal(existing.challenge, challenge) || existing.preferredConnectionId !== preferredConnectionId || existing.sessionDurationMs !== duration)
        throw new ConnectorError('PAIR_CONFLICT', 'Pairing belongs to another request', 409);
      return; // safe retry after a lost response
    }
    if (!this.tickets.has(requestId)) throw new ConnectorError('LAUNCH_REQUIRED', 'Open the connector using the web button first', 409);
    if (this.pairs.size >= 16) throw new ConnectorError('BUSY', 'Too many pending approvals', 429);
    this.tickets.delete(requestId);
    const pair: Pairing = { origin, requestId, challenge, preferredConnectionId, sessionDurationMs: duration, expiresAt: this.now() + this.pairTtl, state: 'pending' };
    this.pairs.set(requestId, pair);
    const remembered = [...this.grants.values()].filter(g => g.origin === origin && duration <= (g.maxSessionMs ?? this.sessionTtl) && this.options.hasConnection(g.connectionId) &&
      (!preferredConnectionId || g.connectionId === preferredConnectionId));
    if (remembered.length === 1) { pair.state = 'approved'; pair.connectionId = remembered[0].connectionId; }
    else this.options.onPairing();
  }
  approve(requestId: string, connectionId: string, remember: boolean): Grant | null {
    this.sweep();
    const pair = this.pairs.get(requestId);
    if (!pair || pair.state !== 'pending') throw new ConnectorError('PAIR_EXPIRED', 'This pairing is no longer pending', 410);
    requireString(connectionId, CONNECTION_ID, 'connectionId');
    if (!this.options.hasConnection(connectionId)) throw new ConnectorError('UNKNOWN_CONNECTION', 'Unlock or configure this connection first', 404);
    if (remember && this.grants.size >= 128 && !this.grants.has(this.key(pair.origin, connectionId)))
      throw new ConnectorError('GRANT_LIMIT', 'Revoke an unused saved authorization before adding another', 429);
    pair.state = 'approved'; pair.connectionId = connectionId;
    const grant = { origin: pair.origin, connectionId, maxSessionMs: pair.sessionDurationMs };
    if (remember) this.grants.set(this.key(grant.origin, connectionId), grant);
    return remember ? grant : null;
  }
  deny(requestId: string): void { const pair = this.pairs.get(requestId); if (pair) pair.state = 'denied'; }
  redeem(origin: string, requestId: string, verifier: string): { state: 'pending' } | { state: 'approved'; token: string; connectionId: string; expiresAt: number } {
    this.sweep(); requireString(verifier, REQUEST_ID, 'verifier');
    const pair = this.pairs.get(requestId);
    if (!pair || pair.origin !== origin || !equal(sha256(verifier), pair.challenge)) throw new ConnectorError('PAIR_INVALID', 'Pairing not found or proof invalid', 403);
    if (pair.state === 'denied') { this.pairs.delete(requestId); throw new ConnectorError('PAIR_DENIED', 'The user denied this request', 403); }
    if (pair.state === 'pending') return { state: 'pending' };
    if (!pair.connectionId || !this.options.hasConnection(pair.connectionId)) throw new ConnectorError('UNKNOWN_CONNECTION', 'Connection is no longer available', 404);
    if (this.sessions.size >= 64) throw new ConnectorError('BUSY', 'Too many active sessions', 429);
    const token = secret(); const expiresAt = this.now() + pair.sessionDurationMs;
    this.sessions.set(sha256(token), { origin, connectionId: pair.connectionId, expiresAt, controller: new AbortController() });
    this.pairs.delete(requestId); // authorization proof may be redeemed exactly once
    return { state: 'approved', token, connectionId: pair.connectionId, expiresAt };
  }
  authorize(origin: string, token: string): Session {
    this.sweep();
    const session = REQUEST_ID.test(token) ? this.sessions.get(sha256(token)) : undefined;
    if (!session || session.origin !== origin) throw new ConnectorError('UNAUTHORIZED', 'A valid origin-bound session is required', 401);
    return session;
  }
  release(origin: string, token: string): void {
    const session = this.authorize(origin, token);
    session.controller.abort(new ConnectorError('SESSION_CLOSED', 'Session closed', 401));
    this.sessions.delete(sha256(token));
  }
  cancel(origin: string, requestId: string, verifier: string): void {
    const pair = this.pairs.get(requestId);
    if (pair && pair.origin === origin && equal(sha256(verifier), pair.challenge)) { this.pairs.delete(requestId); this.options.onPairing(); }
  }
  restore(grants: Grant[]): void {
    for (const grant of grants.slice(0, 128)) {
      if (grant.maxSessionMs !== undefined && (!Number.isSafeInteger(grant.maxSessionMs) || grant.maxSessionMs < 60000 || grant.maxSessionMs > 86400000))
        throw new ConnectorError('INVALID_SESSION_DURATION', 'Invalid remembered authorization duration');
      exactOrigin(grant.origin); requireString(grant.connectionId, CONNECTION_ID, 'connectionId');
      this.grants.set(this.key(grant.origin, grant.connectionId), { ...grant });
    }
  }
  revoke(origin?: string, connectionId?: string): void {
    const matches = (item: Grant) => (!origin || item.origin === origin) && (!connectionId || item.connectionId === connectionId);
    for (const [key, grant] of this.grants) if (matches(grant)) this.grants.delete(key);
    for (const [hash, session] of this.sessions) if (matches(session)) {
      session.controller.abort(new ConnectorError('REVOKED', 'Database authorization was revoked', 403)); this.sessions.delete(hash);
    }
    for (const [id, pair] of this.pairs) if ((!origin || pair.origin === origin) && (!connectionId || pair.connectionId === connectionId)) this.pairs.delete(id);
  }
  snapshot() {
    this.sweep();
    return { pending: [...this.pairs.values()].filter(p => p.state === 'pending').map(({ challenge, ...p }) => p),
      grants: [...this.grants.values()], sessions: [...this.sessions.values()].map(({ controller, ...s }) => s) };
  }
  dispose(): void { this.revoke(); this.tickets.clear(); this.pairs.clear(); }
}
