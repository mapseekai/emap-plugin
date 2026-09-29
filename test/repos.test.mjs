import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { runInNewContext } from 'node:vm';

// Execute the CLI's actual logic with platform paths and a stub process runner.
const script = readFileSync(new URL('../scripts/repos.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('import.meta.url', '"file:///fixture/scripts/repos.mjs"');
for (const [platform, path, root] of [
  ['linux', posix, '/workspace with spaces/emap-plugin'],
  ['win32', win32, 'C:\\workspace with spaces\\emap-plugin'],
]) {
  test(`batch CLI accepts plugin paths and launches npm through Node on ${platform}`, () => {
    const calls = [];
    let repo = 'repos/emap-postgis-plugin';
    const context = {
      ...path, fileURLToPath: () => path.join(root, 'scripts/repos.mjs'),
      readFileSync: () => JSON.stringify({ repositories: [{ name: 'postgis', path: repo }] }),
      existsSync: () => true, console: { log() {} },
      process: { argv: ['node', 'repos.mjs', 'verify'], platform,
        execPath: path.join(root, 'node'), env: { npm_execpath: path.join(root, 'npm-cli.js') },
        exit: code => { throw new Error(`Unexpected exit ${code}`); } },
      spawnSync: (...args) => { calls.push(args); return { status: 0 }; },
    };
    runInNewContext(script, context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], context.process.execPath);
    assert.equal(JSON.stringify(calls[0][1]), JSON.stringify([context.process.env.npm_execpath, 'run', 'verify']));
    assert.equal(calls[0][2].cwd, path.resolve(root, repo));
    for (repo of ['../outside', '.', '../emap-plugin-other/plugin']) {
      assert.throws(() => runInNewContext(script, { ...context }), /Missing plugin package/);
    }
  });
}
