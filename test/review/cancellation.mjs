// Manual review reproducer. Uses a disposable Docker database; no saved connections.
// Build repos/emap-postgis-plugin first, then: node test/review/cancellation.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createPostgisClient } from '../../repos/emap-postgis-plugin/dist/client.js';
import { PostgisGateway } from '../../repos/emap-postgis-plugin/dist/server/index.js';
import { testDatabase } from '../../repos/emap-postgis-plugin/test/integration/database.mjs';

const require = createRequire(new URL('../../repos/emap-postgis-plugin/package.json', import.meta.url));
const { Pool } = require('pg');
const report = {};
let releaseToken;
const token = new Promise(resolve => { releaseToken = resolve; });
const client = createPostgisClient({
  endpoint: 'http://127.0.0.1:18787/postgis', token: () => token,
  timeoutMs: 10, conversion: { worker: false },
});
let tokenState = 'pending';
const stream = client.queryDatasetStream({ connectionId: 'review', sql: 'SELECT geom' })
  .then(() => { tokenState = 'resolved'; }, error => { tokenState = error.name; });
try {
  await delay(30);
  const afterTimeout = tokenState;
  client.dispose();
  await delay(30);
  report.token = { afterTimeout, afterDispose: tokenState };
} finally { client.dispose(); releaseToken('review'); await stream; }

const database = await testDatabase();
const admin = new Pool(database.adminConfig);
const gateway = new PostgisGateway({
  connections: { review: { config: database.config } }, maxConcurrent: 1, timeoutMs: 6000,
});
try {
  await admin.query(`CREATE FUNCTION review_pause() RETURNS int LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(4); RETURN 1; END $$`);
  const abort = new AbortController();
  const query = gateway.query({ connectionId: 'review', sql: 'SELECT review_pause()' }, abort.signal)
    .then(() => 'resolved', error => error.name);
  const active = () => admin.query(`SELECT state, query FROM pg_stat_activity
    WHERE application_name='emap-postgis' AND state='active'`);
  let started = false;
  for (let i = 0; i < 100; i++) {
    started = (await active()).rows.some(row => row.query.includes('review_pause()') && !row.query.includes('LIMIT 0'));
    if (started) break;
    await delay(20);
  }
  assert(started, 'Fixture must be executing before cancellation');
  abort.abort();
  const afterAbort = await Promise.race([query, delay(500, 'pending')]);
  const databaseStillActive = (await active()).rows.length;
  await delay(6500);
  const afterServerTimeout = await Promise.race([query, delay(100, 'pending')]);
  const nextRequest = await gateway.testConnection('review').then(() => 'ok', error => error.code);
  report.cursor = { afterAbort, databaseStillActive, afterServerTimeout, nextRequest };
} finally { await gateway.dispose(); await admin.end(); await database.dispose(); }

console.log(JSON.stringify(report, null, 2));
if (report.token.afterTimeout === 'pending' || report.token.afterDispose === 'pending'
    || report.cursor.afterServerTimeout === 'pending' || report.cursor.nextRequest !== 'ok') {
  console.error('Cancellation review FAILED: unresolved work or unreleased admission slot.');
  process.exitCode = 1;
}
