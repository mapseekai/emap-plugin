import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const operation = process.argv[2];
if (!['install', 'build', 'test', 'verify'].includes(operation)) throw new Error('Unknown operation');
const { repositories } = JSON.parse(readFileSync(resolve(root, 'repositories.json'), 'utf8'));
for (const repo of repositories) {
  const cwd = resolve(root, repo.path);
  if (!cwd.startsWith(root + '/') || !existsSync(resolve(cwd, 'package.json'))) {
    throw new Error(`Missing plugin package: ${repo.path}. Restore it from this monorepo checkout.`);
  }
  console.log(`\n=== ${repo.name}: ${operation} ===`);
  const args = operation === 'install'
    ? [existsSync(resolve(cwd, 'package-lock.json')) ? 'ci' : 'install']
    : ['run', operation];
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
