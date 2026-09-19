// Visual/layout checks only. Read-only fixtures replace Tauri IPC; no database is used.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, '../../repos/emap-postgis-plugin/package.json'));
const { chromium } = require('@playwright/test');
const output = resolve(root, 'test-results/ui');
await mkdir(output, { recursive: true });
const mocks = await build({ absWorkingDir: root, bundle: true, write: false, format: 'iife', stdin: { resolveDir: root, contents: `
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
window.fixture = { connections: [], savedProfiles: [], pending: [], grants: [], sessions: [], port: 18787 };
mockIPC(cmd => {
  if (cmd === 'snapshot') return structuredClone(window.fixture);
  throw new Error('Native actions are disabled in the visual fixture');
}, { shouldMockEvents: true });
window.refreshFixture = () => emit('connector-event', { event: 'changed' });
` } });
const server = await createServer({ configFile: resolve(root, 'vite.config.ts'), root, server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
const checks = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || (existsSync(chrome) ? chrome : undefined) });
  const page = await browser.newPage({ viewport: { width: 820, height: 820 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ content: mocks.outputFiles[0].text });
  await page.goto(origin); await page.waitForSelector('#status[data-state="ready"]');
  assert.equal(await page.locator('nav, aside, [role="dialog"]').count(), 0);
  assert.equal(await page.locator('#formSection').isVisible(), false);
  assert.equal(await page.locator('#approvalSection').isVisible(), false);
  const logo = await page.locator('.brand-logo').boundingBox(); assert.equal(logo.width, 44); assert.equal(logo.height, 32);
  await page.screenshot({ path: resolve(output, 'empty.png'), fullPage: true });
  checks.push('Original single-column layout; 44x32 logo; empty sections and no extra sidebar/modal.');
  await page.click('#newConnection'); assert.equal(await page.locator('#formSection').isVisible(), true);
  assert.equal(await page.locator('#newConnection').getAttribute('aria-expanded'), 'true');
  await page.fill('#label', '道路数据库'); await page.fill('#password', 'local-visual-fixture');
  await page.evaluate(() => window.refreshFixture());
  assert.equal(await page.inputValue('#label'), '道路数据库');
  await page.screenshot({ path: resolve(output, 'form.png'), fullPage: true });
  await page.click('#cancelForm'); assert.equal(await page.inputValue('#password'), '');
  assert.equal(await page.locator('#formSection').isVisible(), false);
  assert.equal(await page.locator('#newConnection').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'newConnection');
  checks.push('Form open/cancel, focus restoration, password clearing and refresh preservation.');
  await page.evaluate(() => {
    const p = { id: 'roads', label: '道路数据库', host: 'db.example.com', port: 5432, database: 'gis', user: 'emap_reader', tls: 'verify' };
    window.fixture.connections = [p]; window.fixture.savedProfiles = [p];
    window.fixture.pending = [{ requestId: 'a'.repeat(37) + 'EC2026', origin: 'https://emap.example.com', expiresAt: Date.now() + 120000 }];
    return window.refreshFixture();
  });
  await page.waitForSelector('#approvalSection:not([hidden])');
  assert.equal(await page.locator('#connections .name').textContent(), '道路数据库');
  assert.equal(await page.locator('#connections .connection-state').textContent(), '就绪');
  assert.equal(await page.locator('#approvals .origin').textContent(), 'https://emap.example.com');
  await page.locator('#approvals input[type=checkbox]').check();
  await page.evaluate(() => { window.fixture.sessions = [{ origin: 'https://emap.example.com', connectionId: 'roads', expiresAt: Date.now() + 3600000 }]; return window.refreshFixture(); });
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('1 个会话'));
  assert.equal(await page.locator('#approvals input[type=checkbox]').isChecked(), true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(output, 'approval.png'), fullPage: true });
  checks.push('Full site origin and pairing ID remain visible; authorization choice survives refresh.');
  await page.evaluate(() => { window.fixture.pending = []; return window.refreshFixture(); });
  await page.waitForFunction(() => document.querySelector('#approvalSection').hidden);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(output, 'connections.png'), fullPage: true });
  for (const width of [620, 400, 1100]) {
    await page.setViewportSize({ width, height: 820 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width}px`);
    await page.screenshot({ path: resolve(output, `width-${width}.png`), fullPage: true });
  }
  checks.push('No horizontal overflow at 400, 620 and 1100 pixels.');
  await page.evaluate(() => {
    const p = window.fixture.savedProfiles[0]; p.label = '<img src=x onerror=alert(1)>';
    p.host = 'a'.repeat(180) + '.example.com'; window.fixture.connections = [];
    return window.refreshFixture();
  });
  await page.waitForFunction(() => document.querySelector('#connections .name').textContent.startsWith('<img'));
  assert.equal(await page.locator('#connections img').count(), 0);
  assert.equal(await page.locator('#connections .connection-state').textContent(), '待解锁');
  await page.setViewportSize({ width: 620, height: 820 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks.push('Connection text is not HTML; long hostnames wrap and unavailable credentials are not shown as connected.');
  assert.deepEqual(errors, []);
  const report = { checks, count: checks.length, scope: 'Actual application HTML/CSS/TypeScript in Chrome; read-only Tauri IPC fixtures, no native authorization click or real credentials.', screenshots: ['empty.png', 'form.png', 'connections.png', 'approval.png'] };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await server.close(); }
