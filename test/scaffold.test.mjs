import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('creates independent plugin and rejects unsafe or duplicate names', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'emap-plugin-scaffold-'));
  try {
    mkdirSync(resolve(temporary, 'scripts'));
    cpSync(resolve(root, 'scripts/new-plugin.mjs'), resolve(temporary, 'scripts/new-plugin.mjs'));
    cpSync(resolve(root, 'templates'), resolve(temporary, 'templates'), { recursive: true });
    writeFileSync(resolve(temporary, 'repositories.json'), '{"schemaVersion":1,"repositories":[]}');
    const run = (...args) => spawnSync(process.execPath, ['scripts/new-plugin.mjs', ...args], { cwd: temporary, encoding: 'utf8' });
    assert.notEqual(run('../escape').status, 0);
    assert.equal(run('terrain', '--dry-run').status, 0);
    assert.equal(existsSync(resolve(temporary, 'repos')), false);
    const result = run('terrain'); assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(resolve(temporary, 'repos/emap-terrain-plugin/.git')), true);
    const registry = JSON.parse(readFileSync(resolve(temporary, 'repositories.json'), 'utf8'));
    assert.equal(registry.repositories[0].package, '@mapseekai/emap-terrain-plugin');
    assert.match(readFileSync(resolve(temporary, 'repos/emap-terrain-plugin/src/index.ts'), 'utf8'), /terrainPlugin/);
    assert.notEqual(run('terrain').status, 0);
    const pluginRoot = resolve(temporary, 'repos/emap-terrain-plugin');
    symlinkSync(resolve(root, 'repos/emap-gdal-plugin/node_modules'), resolve(pluginRoot, 'node_modules'), 'dir');
    const verified = spawnSync('npm', ['run', 'verify'], { cwd: pluginRoot, encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
