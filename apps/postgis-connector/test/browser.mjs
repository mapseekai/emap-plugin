import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { testDatabase } from '../../../repos/emap-postgis-plugin/test/integration/database.mjs';
import { startRuntime } from './runtime-helper.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = resolve(root, '../../repos/emap-postgis-plugin');
const req = createRequire(resolve(plugin, 'package.json')); const { chromium } = req('@playwright/test');
const output = resolve(root, 'test-results/browser'); await mkdir(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['test/browser-entry.mjs'], outfile: resolve(output, 'entry.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', nodePaths: [resolve(plugin, 'node_modules')] });
const assets = new Map([
  ['/entry.js', resolve(output, 'entry.js')], ['/dataset-worker.js', resolve(plugin, 'dist/dataset-worker.js')],
  ...['emap-worker.js', 'mapshaper-vendor.js', 'mapshaper-vendor.mjs', 'emap.css'].map(name => ['/' + name, resolve(plugin, 'node_modules/@mapseekai/emap/dist', name)]),
]);
const web = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/emap.css"></head><body><button id="connect">连接本地 PostGIS</button><div id="map" style="width:1100px;height:700px"></div></body></html>'); return; }
    const file = assets.get(path); if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(await readFile(file));
  } catch { response.writeHead(500); response.end(); }
});
let runtime, browser, database;
try {
  await new Promise(done => web.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${web.address().port}`;
  database = await testDatabase(); runtime = await startRuntime();
  await runtime.rpc('initialize', { profiles: [{ id: 'main', label: 'Browser fixture', ...database.config, tls: 'local' }], grants: [] });
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || (existsSync(chrome) ? chrome : undefined) });
  const page = await browser.newPage({ viewport: { width: 1140, height: 790 } }); const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.exposeFunction('nativeLaunch', url => runtime.rpc('open', { url }));
  await page.goto(origin); await page.evaluate(async base => (await import('/entry.js')).install(base), runtime.base);
  await page.click('#connect');
  let pending;
  for (let i = 0; i < 150; i++) {
    pending = (await runtime.rpc('snapshot')).pending[0]; if (pending) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert(pending, 'Native process receives browser pairing'); assert.equal(pending.origin, origin);
  await runtime.rpc('approve', { requestId: pending.requestId, connectionId: 'main', remember: true });
  const result = await page.evaluate(() => window.connectionResult);
  assert.equal(result.nativeCordis, true); assert.equal(result.layerCount, 3); assert(result.tables.includes('shapes'));
  assert.deepEqual(new Set(result.types), new Set(['circle', 'line', 'fill'])); assert.equal(result.sourceCrs, 'EPSG:3857');
  assert(result.coloredPixels > 100); assert.equal(result.persistedToken, false);
  assert.deepEqual(result.states, ['starting', 'waiting-for-approval', 'connected']);
  await page.screenshot({ path: resolve(output, 'map.png') });
  await runtime.rpc('revoke', { origin, connectionId: 'main' });
  result.afterRevoke = await page.evaluate(async () => (await import('/entry.js')).tryQueryAfterRevoke());
  assert.equal(result.afterRevoke, 'UNAUTHORIZED');
  await page.evaluate(async () => (await import('/entry.js')).cleanup());
  assert.equal((await runtime.rpc('snapshot')).sessions.length, 0); assert.deepEqual(pageErrors, []);
  result.scope = 'Real Chrome -> browser pairing SDK -> isolated packaged CLI -> disposable PostGIS -> Dataset Worker -> actual emap Canvas. OS URI dispatch and native approval are driven through private test IPC, not installer/UI automation.';
  await writeFile(resolve(output, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close(); await runtime?.close(); await database?.dispose();
  web.closeAllConnections(); await new Promise(done => web.close(done));
}
