import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
if (!slug || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 50)
  throw new Error('Usage: npm run new:plugin -- <lowercase-slug> [--dry-run]');
const name = `emap-${slug}-plugin`;
const service = slug.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
const relativePath = `repos/${name}`;
const target = resolve(root, relativePath);
const registryFile = resolve(root, 'repositories.json');
const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
if (existsSync(target) || registry.repositories.some((repo) => repo.name === name))
  throw new Error(`Plugin already exists: ${name}`);
if (process.argv.includes('--dry-run')) {
  console.log(`Would create independent repository: ${target}`);
  process.exit(0);
}
mkdirSync(resolve(root, 'repos'), { recursive: true });
mkdirSync(target);
cpSync(resolve(root, 'templates/plugin'), target, { recursive: true, force: false, errorOnExist: true });
for (const filename of ['package.json', 'src/index.ts', 'test/plugin.test.mjs', 'README.md']) {
  const path = resolve(target, filename);
  const contents = readFileSync(path, 'utf8').replaceAll('__SLUG__', slug).replaceAll('__SERVICE__', service);
  writeFileSync(path, contents);
}
const result = spawnSync('git', ['init', '-b', 'main', target], { stdio: 'inherit' });
if (result.error || result.status !== 0) throw result.error ?? new Error('Git initialization failed');
registry.repositories.push({ name, path: relativePath, package: `@mapseekai/${name}`, remote: null });
writeFileSync(registryFile, JSON.stringify(registry, null, 2) + '\n');
console.log(`Created ${relativePath}. Run npm install and npm run verify inside that repository.`);
