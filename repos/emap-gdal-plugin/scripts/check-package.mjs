import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
assert.equal(manifest.peerDependencies.cordis, '4.0.0-rc.10');
assert.equal(manifest.dependencies['@mapseekai/gdal3.js'], '2.8.2');
for (const [key, value] of Object.entries(manifest.exports)) {
  assert(key.startsWith('.'), `Invalid package export: ${key}`);
  if (key.includes('*')) continue;
  for (const path of typeof value === 'string' ? [value] : Object.values(value))
    assert(existsSync(resolve(root, path)), `Missing exported file: ${path}`);
}
const core = await import('@mapseekai/emap-gdal-plugin');
const feature = await import('@mapseekai/emap-gdal-plugin/geotiff');
assert.equal(typeof core.gdalPlugin, 'function');
assert.equal(typeof feature.gdalGeoTIFFPlugin, 'function');
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
const files = new Set(packed.files.map((file) => file.path));
for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/geotiff.d.ts', 'README.md', 'LICENSE',
  'dist/assets/gdal/gdal3.js', 'dist/assets/gdal/gdal3WebAssembly.wasm',
  'dist/assets/gdal/gdal3WebAssembly.data', 'dist/assets/gdal/GDAL3-LICENSE.txt',
  'scripts/copy-assets.mjs', 'THIRD_PARTY_NOTICES.md',
  'dist/assets/gdal/THIRD_PARTY_NOTICES.md', 'third-party/gdal-3.8.4/LICENSE.TXT',
  'dist/assets/gdal/third-party/gdal-3.8.4/LICENSE.TXT'])
  assert(files.has(path), `Missing package artifact: ${path}`);
assert(![...files].some((path) => path.startsWith('node_modules/') || path.endsWith('.test.ts')));
for (const file of packed.files) {
  assert(!/(^|\/)(\.env(?:\.|$)|\.npmrc$|id_rsa|id_ed25519|test-results|\.git)(\/|$)/.test(file.path), `Private file in package: ${file.path}`);
}
console.log(`Package checks passed: ${files.size} artifacts, ${packed.size} compressed bytes`);
