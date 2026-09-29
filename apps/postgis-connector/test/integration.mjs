import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from '../../../repos/emap-postgis-plugin/test/integration/database.mjs';
import { wkbToDataset } from '@mapseekai/emap-postgis-plugin/dataset';
import { startRuntime } from './runtime-helper.mjs';
const database = await testDatabase(); let runtime; const checks = [];
const origin = 'https://emap.example';
try {
  runtime = await startRuntime();
  const profile = { id: 'main', label: 'Isolated test database', ...database.config, tls: 'local' };
  await runtime.rpc('initialize', { profiles: [profile], grants: [] });
  const req = async (path, body, token, site = origin) => {
    const result = await fetch(runtime.base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: site, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  };
  const pair = async () => {
    const requestId = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    await runtime.rpc('open', { url: `emap-connect://start?request_id=${requestId}` });
    assert.equal((await req('/connector/pair', { requestId, challenge: createHash('sha256').update(verifier).digest('base64url') })).status, 200);
    return { requestId, verifier };
  };
  const first = await pair(); assert.equal((await req('/connector/pair/status', first)).body.state, 'pending');
  await runtime.rpc('approve', { requestId: first.requestId, connectionId: 'main', remember: true });
  const session = (await req('/connector/pair/status', first)).body; assert.equal(session.state, 'approved');
  checks.push('real packaged CLI: native IPC approval -> origin-scoped browser session');
  assert.equal((await req('/postgis/test', { connectionId: 'main' }, session.token)).body.ok, true);
  assert((await req('/postgis/tables?connectionId=main', undefined, session.token)).body.some(t => t.table === 'shapes'));
  checks.push('PostGIS connection and spatial table discovery');
  const result = await req('/postgis/wkb', { connectionId: 'main', sql: 'SELECT id,name,precise,geom FROM shapes ORDER BY id', idColumn: 'id' }, session.token);
  assert.equal(result.status, 200); assert.equal(result.body.rows[0].properties.precise, '9007199254740993');
  assert.deepEqual(new Set(wkbToDataset(result.body).dataset.layers.map(l => l.geometry_type)), new Set(['point', 'polyline', 'polygon']));
  checks.push('EWKB -> actual emap Dataset, point/line/polygon and int8 precision');
  assert.equal((await req('/postgis/query', { connectionId: 'main', sql: 'DELETE FROM shapes' }, session.token)).status, 400);
  checks.push('Native PostgreSQL AST parser packaged correctly; write statements rejected');
  assert.equal((await req('/postgis/query', { connectionId: 'other', sql: 'SELECT 1' }, session.token)).status, 403);
  assert.equal((await req('/postgis/connections', undefined, session.token, 'https://evil.example')).status, 401);
  checks.push('cross-database and cross-origin token reuse denied');
  await runtime.rpc('revoke', { origin, connectionId: 'main' });
  assert.equal((await req('/postgis/connections', undefined, session.token)).status, 401);
  const next = await pair(); assert.equal((await req('/connector/pair/status', next)).body.state, 'pending');
  await runtime.rpc('deny', { requestId: next.requestId });
  checks.push('revocation invalidates old tokens and remembered authorization');
  const snapshot = JSON.stringify(await runtime.rpc('snapshot'));
  assert(!snapshot.includes(database.config.password)); assert(!snapshot.includes(session.token));
  checks.push('native snapshot contains neither database password nor session token');
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/integration.json', JSON.stringify({ checks, count: checks.length }, null, 2));
  console.log(JSON.stringify({ checks, count: checks.length }, null, 2));
} finally { await runtime?.close(); await database.dispose(); }
