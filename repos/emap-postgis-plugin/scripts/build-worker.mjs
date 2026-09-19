import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { rollup } from 'rollup';
import { writeFile, mkdir } from 'node:fs/promises';
const result = await build({
  entryPoints: ['src/dataset-worker.ts'], outfile: 'dist/dataset-worker.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cordis'], minify: true, legalComments: 'eof', metafile: true,
});
// The public host entry leaves unused Cordis side-effect imports in esbuild's
// output. Remove those imports, never bundle or substitute the host's Context.
const bundle = await rollup({
  input: 'dist/dataset-worker.js', external: ['cordis'],
  treeshake: { moduleSideEffects: (id) => id !== 'cordis' },
  onwarn(warning, warn) { if (warning.code !== 'UNUSED_EXTERNAL_IMPORT') warn(warning); },
});
try {
  const { output } = await bundle.generate({ format: 'es' });
  const worker = output[0];
  assert.equal(worker.type, 'chunk');
  assert.deepEqual(worker.imports, [], 'Worker must be independently loadable');
  assert.deepEqual(worker.dynamicImports, [], 'Worker must not load optional dependencies');
  await writeFile('dist/dataset-worker.js', worker.code);
  await mkdir('test-results/build', { recursive: true });
  await writeFile('test-results/build/worker-meta.json', JSON.stringify(result.metafile));
  console.log(`Built standalone Dataset Worker (${worker.code.length} bytes; no Cordis bundled)`);
} finally { await bundle.close(); }
