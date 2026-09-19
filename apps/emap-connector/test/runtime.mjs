import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { startRuntime } from './runtime-helper.mjs';
const runtime = await startRuntime(); const origin = 'https://emap.example';
const post = (path, body) => fetch(runtime.base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const verifier = randomBytes(32).toString('base64url'), requestId = randomBytes(32).toString('base64url');
try {
  // Cold launch ticket arrives before credentials/configuration have finished loading.
  await runtime.rpc('open', { url: `emap-connect://start?request_id=${requestId}` });
  await runtime.rpc('initialize', { profiles: [], grants: [] });
  const health = await fetch(runtime.base + '/connector/health', { headers: { Origin: origin } });
  assert.equal((await health.json()).protocolVersion, 1);
  assert.equal((await fetch(runtime.base + '/connector/health')).status, 403);
  await assert.rejects(runtime.rpc('open', { url: 'emap-connect://start?command=whoami' }));
  await runtime.rpc('open', { url: `emap-connect://start?request_id=${requestId}` });
  assert.equal((await post('/connector/pair', { requestId, challenge: createHash('sha256').update(verifier).digest('base64url') })).status, 200);
  const snapshot = await runtime.rpc('snapshot'); assert.equal(snapshot.pending.length, 1); assert.equal(snapshot.pending[0].origin, origin);
  assert(!JSON.stringify(snapshot).includes(verifier));
  await runtime.rpc('deny', { requestId });
  assert.equal((await post('/connector/pair/status', { requestId, verifier })).status, 403);
  console.log('Packaged runtime smoke passed: isolated resources, launch validation, Origin enforcement, pairing/denial, secret-free IPC snapshot.');
} finally { await runtime.close(); }
