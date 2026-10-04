import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const argument = process.argv[2] ?? `${manifest.name}@${manifest.version}`;
const spec = argument.endsWith('.tgz') ? resolve(argument) : argument;
const workspace = await mkdtemp(resolve(tmpdir(), 'emap-gdal-installed-'));
const publicDir = resolve(workspace, 'public');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const output = resolve(root, 'test-results/installed');
let browser, server;
try {
  await writeFile(resolve(workspace, 'package.json'), JSON.stringify({
    name: 'emap-gdal-installed-check', version: '1.0.0', private: true, type: 'module',
  }));
  execFileSync(npm, ['install', '--save-exact', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', spec,
    '@mapseekai/emap@0.14.1', 'cordis@4.0.0-rc.10'],
    { cwd: workspace, stdio: 'inherit', timeout: 240000 });
  const require = createRequire(resolve(workspace, 'package.json'));
  const installed = require.resolve('@mapseekai/emap-gdal-plugin/package.json');
  assert(realpathSync(installed).startsWith(realpathSync(workspace) + sep));
  assert.equal(require('@mapseekai/emap-gdal-plugin/package.json').version, manifest.version);
  const cli = resolve(workspace, 'node_modules/.bin/emap-gdal-copy-assets');
  assert(existsSync(cli), 'Published npm bin must exist');
  execFileSync(npm, ['exec', '--offline', '--', 'emap-gdal-copy-assets', 'public/gdal'],
    { cwd: workspace, stdio: 'inherit', timeout: 30000 });
  assert(existsSync(resolve(publicDir, 'gdal/THIRD_PARTY_NOTICES.md')));
  assert(existsSync(resolve(publicDir, 'gdal/third-party/gdal-3.8.4/LICENSE.TXT')));
  await mkdir(resolve(publicDir, 'emap-assets'), { recursive: true });
  await copyFile(require.resolve('@mapseekai/emap/dist/emap-geotiff-worker.js'),
    resolve(publicDir, 'emap-assets/emap-geotiff-worker.js'));
  await mkdir(resolve(publicDir, 'test/fixtures'), { recursive: true });
  await copyFile(resolve(root, 'test/fixtures/overview-uint16.tif'),
    resolve(publicDir, 'test/fixtures/overview-uint16.tif'));
  const entry = (await readFile(resolve(root, 'test/browser/entry.ts'), 'utf8'))
    .replaceAll('../../dist/index.js', '@mapseekai/emap-gdal-plugin')
    .replaceAll('../../dist/geotiff.js', '@mapseekai/emap-gdal-plugin/geotiff');
  await writeFile(resolve(workspace, 'entry.ts'), entry);
  await build({ absWorkingDir: workspace, entryPoints: ['entry.ts'], bundle: true,
    platform: 'browser', format: 'esm', target: 'es2022', outfile: resolve(publicDir, 'entry.js') });
  const mime = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.tif': 'image/tiff' };
  server = createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end(); return; }
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><div id="map" style="width:640px;height:480px"></div>');
      return;
    }
    const target = resolve(publicDir, `.${pathname}`);
    if (!target.startsWith(publicDir + sep) || !existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end(); return;
    }
    res.setHeader('Content-Type', mime[extname(target)] ?? 'application/octet-stream');
    createReadStream(target).pipe(res);
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_BIN || (existsSync(chrome) ? chrome : undefined) });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  page.on('console', (msg) => { if (msg.type() === 'log') console.log('[installed]', msg.text()); });
  page.on('pageerror', (error) => console.error('[installed pageerror]', error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => (await import('/entry.js')).run());
  const lock = JSON.parse(await readFile(resolve(workspace, 'package-lock.json'), 'utf8'));
  const installedPackage = lock.packages['node_modules/@mapseekai/emap-gdal-plugin'];
  const report = { ...result, package: manifest.name, version: manifest.version,
    resolved: installedPackage.resolved, integrity: installedPackage.integrity,
    installation: spec.endsWith('.tgz') ? 'local-tarball' : 'npm-registry',
    copiedLicenses: true, status: 'passed' };
  if (report.installation === 'npm-registry') {
    assert(report.resolved.startsWith('https://registry.npmjs.org/'), 'Must install from npm registry');
  }
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, `${report.installation}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log('INSTALLED PACKAGE BROWSER CHECK PASSED\n' + JSON.stringify(report, null, 2));
} finally {
  try { if (browser) await browser.close(); }
  finally {
    if (server?.listening) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
    await rm(workspace, { recursive: true, force: true });
  }
}
