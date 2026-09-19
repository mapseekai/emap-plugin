import { describe, expect, it } from 'vitest';
import { createConnector } from './connector.js';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
describe('browser connector', () => {
  it.each(['https://evil.example', 'http://localhost:18787', 'http://127.0.0.1:18787/a', 'http://user:pass@127.0.0.1:18787', 'http://127.0.0.1:18787?token=secret'])('rejects unsafe endpoint %s', baseUrl => expect(() => createConnector({ baseUrl })).toThrow());
  it('launches synchronously, pairs, scopes its session and clears credentials on dispose', async () => {
    const calls: { url: string; body?: string; authorization?: string | null }[] = []; let launched = '';
    const connector = createConnector({ launch: uri => { launched = uri; }, fetch: (async (url, init) => {
      calls.push({ url: String(url), body: init?.body as string, authorization: new Headers(init?.headers).get('Authorization') });
      if (String(url).endsWith('/health')) return json({ app: 'emap-connector', protocolVersion: 1 });
      if (String(url).endsWith('/pair/status')) return json({ state: 'approved', token: 't'.repeat(43), connectionId: 'roads', expiresAt: Date.now() + 100000 });
      return json({ ok: true });
    }) as typeof fetch });
    const connecting = connector.connect(); expect(launched).toMatch(/^emap-connect:\/\/start\?request_id=/);
    expect(launched).not.toMatch(/token|password|sql|verifier/);
    const session = await connecting; expect(session.connectionId).toBe('roads'); expect(session.token).toHaveLength(43);
    const payload = JSON.parse(calls.find(c => c.url.endsWith('/pair'))!.body!);
    expect(payload.challenge).toHaveLength(43); expect(payload.verifier).toBeUndefined();
    await connector.dispose(); expect(() => session.token).toThrow();
    expect(calls.at(-1)?.authorization).toBe('Bearer ' + 't'.repeat(43));
    await expect(connector.connect()).rejects.toThrow('disposed');
  });
  it('does not launch after caller cancellation', async () => {
    let launches = 0; const connector = createConnector({ launch: () => launches++ });
    const controller = new AbortController(); controller.abort();
    await expect(connector.connect({ signal: controller.signal })).rejects.toThrow(); expect(launches).toBe(0);
  });
  it('rejects incompatible services before transmitting a pairing proof', async () => {
    let requests = 0;
    const c = createConnector({ launch: () => {}, fetch: (async () => { requests++; return json({ app: 'other', protocolVersion: 1 }); }) as typeof fetch });
    await expect(c.connect()).rejects.toThrow('不是兼容'); expect(requests).toBe(1);
  });
  it('surfaces denial and cancels the pending pairing', async () => {
    const calls: string[] = [];
    const c = createConnector({ launch: () => {}, fetch: (async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/health')) return json({ app: 'emap-connector', protocolVersion: 1 });
      if (String(url).endsWith('/status')) return json({ error: { code: 'PAIR_DENIED', message: 'Denied' } }, 403);
      return json({ ok: true });
    }) as typeof fetch });
    await expect(c.connect()).rejects.toThrow('Denied'); expect(calls.at(-1)).toContain('/cancel');
  });
  it('unload cancels pending network work and concurrent attempts are bounded', async () => {
    const c = createConnector({ launch: () => {}, fetch: (async (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      if (init?.signal?.aborted) reject(init.signal.reason);
    })) as typeof fetch });
    const pending = c.connect(); await expect(c.connect()).rejects.toThrow('already pending');
    const rejected = expect(pending).rejects.toThrow(); await c.dispose(); await rejected;
  });
});

describe('requested authorization duration', () => {
  it('includes the negotiated duration in the pending proof, not the launch URL', async () => {
    const bodies: Record<string,unknown>[] = []; let uri='';
    const c=createConnector({launch:u=>{uri=u;},fetch:(async(url,init)=>{
      if(String(url).endsWith('/health'))return json({app:'emap-connector',protocolVersion:1,capabilities:{sessionDuration:{maxMs:86400000}}});
      if(String(url).endsWith('/pair'))bodies.push(JSON.parse(String(init?.body)));
      if(String(url).endsWith('/pair/status'))return json({state:'approved',token:'t'.repeat(43),connectionId:'db',expiresAt:Date.now()+14400000});
      return json({ok:true});
    }) as typeof fetch});
    await c.connect({sessionDurationMs:14400000});expect(bodies[0].sessionDurationMs).toBe(14400000);expect(uri).not.toContain('Duration');await c.dispose();
  });
  it('does not silently reduce a requested duration on old connectors', async () => {
    const c=createConnector({launch:()=>{},fetch:(async()=>json({app:'emap-connector',protocolVersion:1})) as typeof fetch});
    await expect(c.connect({sessionDurationMs:14400000})).rejects.toMatchObject({code:'CONNECTOR_UPDATE_REQUIRED'});await c.dispose();
  });
  it.each([0,-1,NaN,Infinity,59999,86400001,60000.5])('rejects duration %s before launching',async duration=>{
    let launched=false;const c=createConnector({launch:()=>{launched=true;}});
    await expect(c.connect({sessionDurationMs:duration})).rejects.toMatchObject({code:'INVALID_SESSION_DURATION'});expect(launched).toBe(false);
  });
});
