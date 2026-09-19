import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
export async function checkDemo(browser, root) {
  execFileSync(process.execPath, ['scripts/copy-assets.mjs', 'examples/public/gdal'], { cwd: root });
  const server = await createServer({ configFile: false, root: resolve(root, 'examples'),
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } } });
  let page;
  try {
    await server.listen();
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.setInputFiles('#file', resolve(root, 'test/fixtures/overview-uint16.tif'));
    await page.fill('#levels', '2,4,8');
    await page.click('#build');
    const output = page.locator('#outputs a').first();
    await output.waitFor({ timeout: 60000 });
    assert.equal(await output.getAttribute('download'), 'overview-uint16.tif.ovr');
    const status = JSON.parse(await page.locator('#status').textContent());
    assert.deepEqual(status.levels.map((value) => value.factor), [2, 4, 8]);
    console.log('PASS Vite example: uploaded fixture, generated overview, download link verified');
    return { status: 'passed', overviewBytes: status.files[0].bytes };
  } finally { if (page) await page.close(); await server.close(); }
}
