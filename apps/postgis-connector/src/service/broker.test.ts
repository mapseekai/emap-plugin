import { describe, it, expect } from 'vitest';
import { ConsentBroker } from './broker.js';
import { secret, sha256, exactOrigin, launchRequest } from './security.js';
const origin = 'https://emap.example';
function fixture() {
  let now = 1000; let prompts = 0;
  const broker = new ConsentBroker({ hasConnection: id => ['roads', 'parcels'].includes(id), onPairing: () => prompts++, now: () => now, pairTtlMs: 100, sessionTtlMs: 60000 });
  const requestId = secret(), verifier = secret();
  const pair = () => { broker.open(requestId); broker.pair(origin, requestId, sha256(verifier)); };
  return { broker, requestId, verifier, pair, advance: (n: number) => { now += n; }, prompts: () => prompts };
}
describe('native consent authority', () => {
  it('does not pair without a native launch ticket', () => { const f = fixture(); expect(() => f.broker.pair(origin, f.requestId, sha256(f.verifier))).toThrow('Open the connector'); });
  it('requires explicit consent and consumes the proof once', () => {
    const f = fixture(); f.pair(); expect(f.prompts()).toBe(1);
    expect(f.broker.redeem(origin, f.requestId, f.verifier).state).toBe('pending');
    f.broker.approve(f.requestId, 'roads', false);
    const s = f.broker.redeem(origin, f.requestId, f.verifier); expect(s.state).toBe('approved');
    if (s.state !== 'approved') throw new Error();
    expect(f.broker.authorize(origin, s.token).connectionId).toBe('roads');
    expect(() => f.broker.authorize('https://evil.example', s.token)).toThrow();
    expect(() => f.broker.redeem(origin, f.requestId, f.verifier)).toThrow();
  });
  it('denies stolen request IDs, wrong proofs and origin substitution', () => {
    const f = fixture(); f.pair();
    expect(() => f.broker.pair('https://evil.example', f.requestId, sha256(f.verifier))).toThrow();
    expect(() => f.broker.redeem(origin, f.requestId, secret())).toThrow();
    expect(() => f.broker.redeem('https://evil.example', f.requestId, f.verifier)).toThrow();
  });
  it('allows retry only for the exact original pairing', () => {
    const f = fixture(); f.pair(); f.broker.pair(origin, f.requestId, sha256(f.verifier)); expect(f.prompts()).toBe(1);
    expect(() => f.broker.pair(origin, f.requestId, sha256(secret()))).toThrow();
  });
  it('expires launch tickets and pending approvals', () => { const f = fixture(); f.pair(); f.advance(101); expect(() => f.broker.approve(f.requestId, 'roads', true)).toThrow(); });
  it('denial never issues a token', () => { const f = fixture(); f.pair(); f.broker.deny(f.requestId); expect(() => f.broker.redeem(origin, f.requestId, f.verifier)).toThrow('denied'); });
  it('remembers only a specific origin/database relationship', () => {
    const f = fixture(); f.broker.restore([{ origin, connectionId: 'roads' }]); f.pair(); expect(f.prompts()).toBe(0);
    const s = f.broker.redeem(origin, f.requestId, f.verifier); expect(s.state).toBe('approved');
  });
  it('asks instead of choosing arbitrarily when multiple grants exist', () => {
    const f = fixture(); f.broker.restore([{ origin, connectionId: 'roads' }, { origin, connectionId: 'parcels' }]); f.pair(); expect(f.prompts()).toBe(1);
  });
  it('revocation and expiry abort in-flight work', () => {
    for (const expire of [false, true]) {
      const f = fixture(); f.pair(); f.broker.approve(f.requestId, 'roads', true);
      const s = f.broker.redeem(origin, f.requestId, f.verifier); if (s.state !== 'approved') throw new Error();
      const active = f.broker.authorize(origin, s.token);
      if (expire) { f.advance(60001); f.broker.sweep(); } else f.broker.revoke(origin, 'roads');
      expect(active.controller.signal.aborted).toBe(true); expect(() => f.broker.authorize(origin, s.token)).toThrow();
    }
  });
  it('does not disclose verifier hashes or bearer tokens in snapshots', () => {
    const f = fixture(); f.pair(); expect(JSON.stringify(f.broker.snapshot())).not.toContain(sha256(f.verifier));
  });
  it('caps remembered grants before issuing new authorization', () => {
    const f = fixture(); f.broker.restore(Array.from({ length: 128 }, (_, i) => ({ origin: `https://site${i}.example`, connectionId: 'roads' })));
    f.pair(); expect(() => f.broker.approve(f.requestId, 'roads', true)).toThrow('Revoke an unused');
    expect(f.broker.redeem(origin, f.requestId, f.verifier).state).toBe('pending');
  });
  it('caps native launch and pending state', () => {
    const f = fixture(); for (let i = 0; i < 16; i++) f.broker.open(secret()); expect(() => f.broker.open(secret())).toThrow('Too many');
  });
});
describe('protocol validation', () => {
  it.each(['null', 'http://evil.example', 'file:///', 'https://good.example/path', 'https://good.example/', 'https://user:pass@good.example', 'data:text/plain,test'])('rejects origin %s', value => expect(() => exactOrigin(value)).toThrow());
  it.each(['https://example.com', 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173'])('accepts %s', value => expect(exactOrigin(value)).toBe(value));
  it('allows only the narrow start command', () => {
    const id = secret(); expect(launchRequest(`emap-connect://start?request_id=${id}`)).toBe(id);
    for (const url of [`emap-connect://start?request_id=${id}&sql=SELECT`, `emap-connect://start?request_id=${id}&request_id=${id}`, `emap-connect://evil?request_id=${id}`, `emap-connect://start:99?request_id=${id}`, `emap-connect://start?request_id=${id}#token`]) expect(() => launchRequest(url)).toThrow();
  });
});
