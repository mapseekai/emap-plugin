import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const app = fileURLToPath(new URL('../', import.meta.url));
const bundle = resolve(app, 'src-tauri/target/release/bundle');
export const targets = {
  'windows-x64': { directory: 'nsis', extension: '.exe', checks: ['signature', 'webview2'] },
  'macos-arm64': { directory: 'dmg', extension: '.dmg', checks: ['signature', 'notarization'] },
  'macos-x64': { directory: 'dmg', extension: '.dmg', checks: ['signature', 'notarization'] },
  'linux-x64': { directory: 'deb', extension: '.deb', checks: ['package-integrity', 'gnome-kde'] },
};
const common = [
  'automated-suite', 'install-uninstall', 'cold-warm-start', 'browser-permissions',
  'pairing', 'revocation', 'process-cleanup', 'port-conflict', 'credential-store',
  'tls-network', 'large-results', 'geometry', 'licenses', 'download',
];
export function requiredChecks(target) {
  if (!Object.hasOwn(targets, target)) throw new Error(`Unsupported release target: ${target}`);
  return [...common, ...targets[target].checks];
}
async function artifact(file) {
  const bytes = await readFile(file);
  return { file: basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export async function prepareEvidence(target, file, source) {
  const checks = requiredChecks(target);
  if (!file.toLowerCase().endsWith(targets[target].extension)) throw new Error('Wrong installer format for target');
  return {
    schemaVersion: 1, target, ...source, createdAt: new Date().toISOString(),
    artifact: await artifact(file),
    checks: Object.fromEntries(checks.map(id => [id, { status: 'pending', reviewer: '', evidence: '' }])),
  };
}
export async function verifyEvidence(report, file, source) {
  if (report?.schemaVersion !== 1) throw new Error('Unsupported release evidence schema');
  const checks = requiredChecks(report.target);
  if (report.version !== source.version || report.revision !== source.revision ||
      !/^[a-f0-9]{40}$/.test(report.revision) || report.workingTreeClean !== true || source.workingTreeClean !== true)
    throw new Error('Evidence must match the current version and clean source revision');
  if (!file.toLowerCase().endsWith(targets[report.target].extension)) throw new Error('Wrong installer format for target');
  const actual = await artifact(file);
  if (actual.bytes === 0 || actual.bytes >= 10_000_000) throw new Error('Installer must be nonempty and < 10,000,000 bytes');
  if (Object.keys(actual).some(key => report.artifact?.[key] !== actual[key]))
    throw new Error('Installer name, size or SHA-256 does not match the evidence');
  for (const id of checks) {
    const check = report.checks?.[id];
    if (check?.status !== 'passed' || typeof check.reviewer !== 'string' || !check.reviewer.trim() ||
        typeof check.evidence !== 'string' || !check.evidence.trim())
      throw new Error(`Release acceptance incomplete: ${id} requires passed, reviewer and evidence`);
  }
  return actual;
}
async function installer(target) {
  requiredChecks(target);
  const { directory, extension } = targets[target];
  const folder = resolve(bundle, directory);
  const names = (await readdir(folder)).filter(name => name.toLowerCase().endsWith(extension));
  if (names.length !== 1) throw new Error(`Expected exactly one ${target} installer in ${folder}; use an explicit installer path`);
  return resolve(folder, names[0]);
}
async function main() {
  const [operation, first, second, third, ...extra] = process.argv.slice(2);
  if (!['prepare', 'check'].includes(operation) || !first || (operation === 'prepare' && !second) ||
      extra.length || (operation === 'check' && third))
    throw new Error('Usage: release:prepare -- <target> <report.json> [installer] OR release:check -- <report.json> [installer]');
  const { version } = JSON.parse(await readFile(resolve(app, 'package.json'), 'utf8'));
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: app, encoding: 'utf8' }).trim();
  const workingTreeClean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: app, encoding: 'utf8' }).trim();
  const source = { version, revision, workingTreeClean };
  if (operation === 'prepare') {
    const report = await prepareEvidence(first, third ? resolve(third) : await installer(first), source);
    await mkdir(dirname(resolve(second)), { recursive: true });
    await writeFile(second, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`Prepared ${second}; all acceptance checks remain pending. This is not release approval.`);
  } else {
    const report = JSON.parse(await readFile(first, 'utf8'));
    const result = await verifyEvidence(report, second ? resolve(second) : await installer(report.target), source);
    console.log(`Acceptance evidence matches ${result.file} (${result.sha256}). No signing, installation or publishing performed.`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
