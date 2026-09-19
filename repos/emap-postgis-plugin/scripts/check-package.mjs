import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(pkg.peerDependencies.cordis, '4.0.0-rc.10');
for (const [key, entry] of Object.entries(pkg.exports)) {
  if (typeof entry === 'string') { await access(new URL('../' + entry, import.meta.url)); continue; }
  if (typeof entry === 'string') { await access(new URL('../' + entry, import.meta.url)); continue; }
  for (const field of ['types', 'import']) {
    assert.equal(typeof entry[field], 'string', `${key} has a ${field} entry`);
    await access(new URL('../' + entry[field], import.meta.url));
  }
}
const result = await build({ entryPoints: ['dist/index.js', 'dist/layers.js', 'dist/control.js'],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  outdir: 'test-results/package', metafile: true, external: ['cordis', '@mapseekai/emap', '@mapseekai/emap/*'],
});
for (const input of Object.keys(result.metafile.inputs))
  assert(!/node_modules\/(pg|pg-cursor|pgsql-parser|libpg-query)\//.test(input), `Server dependency leaked into browser: ${input}`);
const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
assert.equal(packed.status, 0, packed.stderr);
const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
assert(files.includes('dist/index.js') && files.includes('dist/server/index.js'));
assert(!files.some((file) => /(^|\/)\.env$/.test(file)), 'Never pack actual environment secrets');
console.log(`Package exports and browser/server boundary verified; ${files.length} packed files (dry run only)`);
