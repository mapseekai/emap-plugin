#!/usr/bin/env node
import { createRequire } from 'node:module';
import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('@mapseekai/gdal3.js/package.json'));
const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (metadata.version !== '2.8.2') throw new Error('Worker protocol requires @mapseekai/gdal3.js 2.8.2');
const target = resolve(process.argv[2] ?? 'public/emap-gdal');
await mkdir(target, { recursive: true });
for (const name of ['gdal3.js', 'gdal3WebAssembly.wasm', 'gdal3WebAssembly.data']) {
  await copyFile(resolve(root, 'dist/package', name), resolve(target, name));
}
await copyFile(resolve(root, 'LICENSE'), resolve(target, 'GDAL3-LICENSE.txt'));
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await copyFile(resolve(pluginRoot, 'THIRD_PARTY_NOTICES.md'), resolve(target, 'THIRD_PARTY_NOTICES.md'));
await cp(resolve(pluginRoot, 'third-party'), resolve(target, 'third-party'), { recursive: true });
console.log(`GDAL ${metadata.version} assets copied to ${target}`);
