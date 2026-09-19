import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { checkDemo } from './demo.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'test-results/browser');
await mkdir(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['test/browser/entry.ts'], bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022', outfile: resolve(output, 'entry.js') });
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.html': 'text/html', '.tif': 'image/tiff' };
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body><div id="map" style="width:640px;height:480px"></div></body></html>');
    return;
  }
  let target;
  if (pathname.startsWith('/gdal/')) target = resolve(root, 'dist/assets/gdal', pathname.slice(6));
  else if (pathname.startsWith('/emap-assets/'))
    target = resolve(root, 'node_modules/@mapseekai/emap/dist', pathname.slice(13));
  else target = resolve(root, `.${pathname}`);
  if (!target.startsWith(root + sep) || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', types[extname(target)] ?? 'application/octet-stream');
  createReadStream(target).pipe(res);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_BIN || (existsSync(chrome) ? chrome : undefined) });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  page.on('console', (msg) => { if (msg.type() === 'log') console.log('[browser]', msg.text()); });
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const report = await page.evaluate(async () => {
    const suite = await import('/test-results/browser/entry.js');
    return suite.run();
  });
  report.demo = await checkDemo(browser, root);
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('REAL GDAL + EMAP BROWSER TESTS PASSED\n' + JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
}
