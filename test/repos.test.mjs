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

test('batch CLI selects full gates, falls back, installs locks and propagates failures', () => {
  const calls = [];
  const packages = {
    '/fixture/repos/full/package.json': { scripts: { 'verify:all': 'full' } },
    '/fixture/repos/basic/package.json': { scripts: { verify: 'basic' } },
  };
  const context = {
    ...posix, fileURLToPath: () => '/fixture/scripts/repos.mjs',
    readFileSync: file => JSON.stringify(file === '/fixture/repositories.json'
      ? { repositories: [{ name: 'full', path: 'repos/full' }, { name: 'basic', path: 'repos/basic' }] }
      : packages[file]),
    existsSync: file => !file.endsWith('basic/package-lock.json'),
    console: { log() {} },
    process: { argv: ['node', 'repos.mjs', 'verify:all'], execPath: '/node',
      env: { npm_execpath: '/npm-cli.js' }, exit: code => { throw new Error(`exit ${code}`); } },
    spawnSync: (...args) => { calls.push(args); return { status: 0 }; },
  };
  const run = operation => runInNewContext(script, {
    ...context, process: { ...context.process, argv: ['node', 'repos.mjs', operation] },
  });
  run('verify:all');
  assert.deepEqual(calls.map(call => Array.from(call[1])), [
    ['/npm-cli.js', 'run', 'verify:all'], ['/npm-cli.js', 'run', 'verify'],
  ]);
  calls.length = 0;
  run('install');
  assert.deepEqual(calls.map(call => Array.from(call[1])), [
    ['/npm-cli.js', 'ci'], ['/npm-cli.js', 'install'],
  ]);
  for (const operation of ['build', 'test', 'verify']) {
    calls.length = 0;
    run(operation);
    assert.deepEqual(calls.map(call => Array.from(call[1])), [
      ['/npm-cli.js', 'run', operation], ['/npm-cli.js', 'run', operation],
    ]);
  }
  assert.throws(() => run('unknown'), /Unknown operation/);
  assert.throws(() => runInNewContext(script, {
    ...context, process: { ...context.process, env: {} },
  }), /through npm/);
  assert.throws(() => runInNewContext(script, {
    ...context, spawnSync: () => ({ status: 7 }),
  }), /exit 7/);
});

test('root command scopes remain explicit', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts['management:test'], 'node --test test/*.test.mjs');
  assert.equal(scripts['management:verify'], 'npm run management:test');
  assert.equal(scripts.verify, 'npm run management:verify && node scripts/repos.mjs verify');
  assert.equal(scripts['verify:all'], 'npm run management:verify && node scripts/repos.mjs verify:all && npm --prefix apps/postgis-connector run verify:all');
  const connector = JSON.parse(readFileSync(new URL('../apps/postgis-connector/package.json', import.meta.url), 'utf8'));
  assert.equal(typeof connector.scripts?.['verify:all'], 'string', 'Connector needs its complete validation entry');
});

test('registered plugins have unique safe paths and matching package gates', () => {
  const registry = JSON.parse(readFileSync(new URL('../repositories.json', import.meta.url), 'utf8'));
  assert.equal(registry.schemaVersion, 1);
  assert.ok(Array.isArray(registry.repositories));
  const names = new Set(), paths = new Set(), packages = new Set();
  for (const repo of registry.repositories) {
    assert.match(repo.path, /^repos\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
    for (const [seen, value] of [[names, repo.name], [paths, repo.path], [packages, repo.package]]) {
      assert.equal(typeof value, 'string');
      assert.ok(value.length > 0 && !seen.has(value), `Invalid or duplicate registry value: ${value}`);
      seen.add(value);
    }
    const pkg = JSON.parse(readFileSync(new URL(`../${repo.path}/package.json`, import.meta.url), 'utf8'));
    assert.equal(pkg.name, repo.package);
    for (const command of ['build', 'test', 'verify']) {
      assert.equal(typeof pkg.scripts?.[command], 'string', `${repo.path} needs ${command}`);
    }
  }
});
