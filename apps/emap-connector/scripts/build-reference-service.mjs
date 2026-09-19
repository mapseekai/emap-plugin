import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'test-results/reference-service');
await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
// Keep libpg-query's original layout: its WASM resolves relative to __dirname.
// All other JS is bundled; no native addon or user-installed Node is needed.
const bundled = await build({ metafile: true, absWorkingDir: root, entryPoints: ['src/service/cli.ts'], outfile: resolve(out, 'service.cjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['libpg-query', 'pg-native'], legalComments: 'eof' });
const req = createRequire(resolve(root, 'package.json'));
const fromGateway = createRequire(import.meta.resolve('@mapseekai/emap-postgis-plugin/server'));
const parser = createRequire(fromGateway.resolve('pgsql-parser'));
const copied = new Set(); const notices = [];
async function copyPackage(name, parent) {
  const entry = parent.resolve(name); let dir = dirname(entry); let manifest;
  for (;;) {
    try { const p = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8')); if (p.name === name) { manifest = p; break; } } catch {}
    const next = dirname(dir); if (next === dir) throw new Error(`Cannot find manifest for ${name}`); dir = next;
  }
  if (copied.has(name)) return; copied.add(name);
  await cp(dir, resolve(out, 'node_modules', name), { recursive: true, filter: path => !path.includes('/node_modules/', dir.length) });
  notices.push({ name, version: manifest.version, license: manifest.license });
  const local = createRequire(resolve(dir, 'package.json'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await copyPackage(dependency, local);
}
await copyPackage('libpg-query', parser);
await writeFile(resolve(out, 'runtime-dependencies.json'), JSON.stringify(notices, null, 2) + '\n');
console.log('Built isolated service runtime:', out);

// Preserve notices for every source package included in the bundled JS.
const licenseDirs = new Set();
for (const input of Object.keys(bundled.metafile.inputs)) {
  let directory = dirname(resolve(root, input));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
      if (manifest.name) { licenseDirs.add(directory); break; }
    } catch {}
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
}
const noticeDir = resolve(out, 'licenses'); await mkdir(noticeDir, { recursive: true });
const bundledNotices = [];
for (const directory of licenseDirs) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const safe = manifest.name.replaceAll('/', '__').replaceAll('@', '');
  const copiedFiles = [];
  for (const name of await readdir(directory)) {
    if (/^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(name)) {
      const destination = `${safe}-${name}`;
      try { await cp(resolve(directory, name), resolve(noticeDir, destination)); copiedFiles.push(destination); } catch {}
    }
  }
  bundledNotices.push({ name: manifest.name, version: manifest.version, license: manifest.license, files: copiedFiles });
}
await writeFile(resolve(out, 'bundled-dependencies.json'), JSON.stringify(bundledNotices, null, 2) + '\n');
