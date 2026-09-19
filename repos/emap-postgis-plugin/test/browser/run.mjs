import { testDatabase } from '../integration/database.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { PostgisGateway, createPostgisServer } from '../../dist/server/index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'test-results/browser'); await mkdir(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['test/browser/entry.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: resolve(output, 'entry.js') });
const entry = await readFile(resolve(output, 'entry.js'));
const web = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/emap.css"></head><body style="margin:0"><div id="map" style="width:1100px;height:720px"></div></body></html>'); return; }
  if (path === '/dataset-worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(resolve(root, 'dist/dataset-worker.js'))); return; }
  if (path === '/entry.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(entry); return; }
  const assets = new Set(['emap-worker.js', 'mapshaper-vendor.js', 'mapshaper-vendor.mjs', 'emap.css']);
  const name = path.slice(1);
  if (assets.has(name)) {
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(root, 'node_modules/@mapseekai/emap/dist', name))); return;
  }
  response.writeHead(404); response.end();
});
await new Promise((done) => web.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${web.address().port}`;
const database = await testDatabase();
const gateway = new PostgisGateway({ connections: { main: { config: database.config } }, onError: (error) => console.error(error.message) });
const queryWkb = gateway.queryWkb.bind(gateway);
gateway.queryWkb = async (request, signal) => {
  // Deterministic transport delay only for the cancellation test.
  if (request.sql.includes('slow')) await new Promise((done, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); done(); }, 1000);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  });
  return queryWkb(request, signal);
};
const token = randomUUID();
const api = createPostgisServer({ gateway, token, allowedOrigins: [origin] });
await new Promise((done) => api.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${api.address().port}/postgis`;
let browser;
try {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || (existsSync(chrome) ? chrome : undefined) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  page.on('pageerror', (error) => console.error('[browser]', error.message));
  await page.goto(origin);
  const report = await page.evaluate(async (options) => (await import('/entry.js')).run(options), { endpoint, token });
  await page.screenshot({ path: resolve(output, 'screenshot.png') });
  report.diagnostics = await page.evaluate(async () => (await import('/entry.js')).diagnostics());
  console.log(JSON.stringify(report, null, 2));
  report.lifecycle = await page.evaluate(async () => (await import('/entry.js')).dispose());
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); api.closeAllConnections(); web.closeAllConnections();
  await gateway.dispose(); await database.dispose();
  await Promise.all([new Promise((done) => api.close(done)), new Promise((done) => web.close(done))]);
}
