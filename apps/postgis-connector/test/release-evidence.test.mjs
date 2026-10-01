import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareEvidence, verifyEvidence, requiredChecks, targets } from '../scripts/release-evidence.mjs';

const source = { version: '0.2.0', revision: 'a'.repeat(40), workingTreeClean: true };
for (const [target, { extension }] of Object.entries(targets)) {
  test(`${target}: pending evidence blocks release; completed evidence binds the installer`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'connector-release-'));
    try {
      const file = resolve(root, `fixture${extension}`);
      await writeFile(file, 'fixture installer; never executed');
      const report = await prepareEvidence(target, file, source);
      await assert.rejects(verifyEvidence(report, file, source), /acceptance incomplete/);
      for (const id of requiredChecks(target))
        report.checks[id] = { status: 'passed', reviewer: 'fixture reviewer', evidence: 'fixture evidence only' };
      assert.equal((await verifyEvidence(report, file, source)).sha256, report.artifact.sha256);
      for (const id of requiredChecks(target)) {
        const saved = report.checks[id];
        report.checks[id] = { ...saved, reviewer: '' };
        await assert.rejects(verifyEvidence(report, file, source), /requires passed/);
        report.checks[id] = { ...saved, evidence: ' ' };
        await assert.rejects(verifyEvidence(report, file, source), /requires passed/);
        report.checks[id] = saved;
      }
      await assert.rejects(verifyEvidence(report, file, { ...source, version: '0.3.0' }), /source revision/);
      await assert.rejects(verifyEvidence(report, file, { ...source, revision: 'b'.repeat(40) }), /source revision/);
      await assert.rejects(verifyEvidence(report, file, { ...source, workingTreeClean: false }), /source revision/);
      await assert.rejects(verifyEvidence({ ...report, workingTreeClean: false }, file, source), /source revision/);
      await assert.rejects(verifyEvidence({ ...report, schemaVersion: 2 }, file, source), /schema/);
      await assert.rejects(verifyEvidence({ ...report, target: 'unknown' }, file, source), /Unsupported release target/);
      await writeFile(file, 'tampered installer');
      await assert.rejects(verifyEvidence(report, file, source), /SHA-256/);
      await writeFile(file, Buffer.alloc(10_000_000));
      await assert.rejects(verifyEvidence(report, file, source), /10,000,000/);
      await writeFile(file, '');
      await assert.rejects(verifyEvidence(report, file, source), /nonempty/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('release CLI prepares pending evidence without overwriting and checks the exact clean checkout', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'connector-release-cli-'));
  try {
    await mkdir(resolve(root, 'scripts'));
    await copyFile(new URL('../scripts/release-evidence.mjs', import.meta.url), resolve(root, 'scripts/release-evidence.mjs'));
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ version: '0.2.0', type: 'module' }));
    await writeFile(resolve(root, '.gitignore'), 'test-results/\n');
    const git = (...args) => execFileSync('git', args, {
      cwd: root, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' },
    });
    git('init');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
    await mkdir(resolve(root, 'test-results'));
    await writeFile(resolve(root, 'test-results/final.dmg'), 'fixture installer; never executed');
    const run = (...args) => spawnSync(process.execPath, ['scripts/release-evidence.mjs', ...args], {
      cwd: root, encoding: 'utf8',
    });
    const prepared = run('prepare', 'macos-arm64', 'test-results/report.json', 'test-results/final.dmg');
    assert.equal(prepared.status, 0, prepared.stderr);
    const reportPath = resolve(root, 'test-results/report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.workingTreeClean, true);
    assert.equal(report.revision, git('rev-parse', 'HEAD').trim());
    assert.notEqual(run('prepare', 'macos-arm64', 'test-results/report.json', 'test-results/final.dmg').status, 0);
    assert.match(run('check', 'test-results/report.json', 'test-results/final.dmg').stderr, /acceptance incomplete/);
    for (const id of requiredChecks(report.target))
      report.checks[id] = { status: 'passed', reviewer: 'fixture reviewer', evidence: 'fixture evidence only' };
    await writeFile(reportPath, JSON.stringify(report));
    const checked = run('check', 'test-results/report.json', 'test-results/final.dmg');
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /No signing, installation or publishing performed/);
    await writeFile(resolve(root, 'untracked-source.txt'), 'not reviewed');
    assert.match(run('check', 'test-results/report.json', 'test-results/final.dmg').stderr, /clean source revision/);
    assert.notEqual(run('prepare', 'unknown', 'test-results/unknown.json', 'test-results/final.dmg').status, 0);
    assert.notEqual(run('check').status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
