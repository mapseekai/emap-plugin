import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const operation = process.argv[2];
if (!['install', 'build', 'test', 'verify', 'verify:all'].includes(operation)) throw new Error('Unknown operation');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run repository commands through npm run bootstrap/build/test/verify/verify:all');
const { repositories } = JSON.parse(readFileSync(resolve(root, 'repositories.json'), 'utf8'));
for (const repo of repositories) {
  const cwd = resolve(root, repo.path);
  if (!cwd.startsWith(root + sep) || !existsSync(resolve(cwd, 'package.json'))) {
    throw new Error(`Missing plugin package: ${repo.path}. Restore it from this monorepo checkout.`);
  }
  console.log(`\n=== ${repo.name}: ${operation} ===`);
  const command = operation === 'verify:all'
    ? (JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')).scripts?.['verify:all'] ? 'verify:all' : 'verify')
    : operation;
  const args = operation === 'install'
    ? [existsSync(resolve(cwd, 'package-lock.json')) ? 'ci' : 'install']
    : ['run', command];
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
