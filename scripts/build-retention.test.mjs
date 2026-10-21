import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBuildRetention, reserveBuildOutput, withBuildRetention, BuildRetentionError } from './build-retention.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repo, '.runtime/build-retention/test-workspaces');
function workspace() {
  const root = path.join(fixtureRoot, randomUUID());
  mkdirSync(path.join(root, 'apps/web/.tmp'), { recursive: true });
  mkdirSync(path.join(root, '.runtime'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}
function output(root, stage, age = 0) {
  const target = path.join(root, `apps/web/.tmp/next-review-${stage}`);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'BUILD_ID'), `fixture-${stage}`);
  writeFileSync(path.join(target, 'build.log'), `log-${stage}`);
  writeFileSync(path.join(target, 'generated.bin'), 'fixture output');
  const time = new Date(Date.now() - age * 60_000); utimesSync(target, time, time);
  return target;
}
function cleanup(root) {
  const child = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'scripts/windows/build-retention-test-cleanup.ps1'), '-Path', root, '-FixtureRoot', fixtureRoot], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
}
const windows = { skip: process.platform !== 'win32' };

test('retention retires the oldest output, preserves evidence, and leaves two', windows, () => {
  const root = workspace();
  try {
    const old = output(root, '01', 3); output(root, '02', 2); output(root, '03', 1);
    const record = applyBuildRetention({ workspaceRoot: root });
    assert.equal(record.existingCount, 2); assert.equal(record.retired.length, 1);
    assert.equal(existsSync(old), false);
    const saved = record.retired[0].preserved.find(item => item.original.endsWith('build.log'));
    assert.equal(readFileSync(saved.archived, 'utf8'), 'log-01');
  } finally { cleanup(root); }
});
test('reservation frees a slot before work and failure is recorded without losing its lease', windows, async () => {
  const root = workspace();
  try {
    const old = output(root, '01', 3); output(root, '02', 2);
    await assert.rejects(withBuildRetention({ workspaceRoot: root, outputPath: 'apps/web/.tmp/next-review-03' }, async lease => {
      assert.equal(existsSync(old), false); assert.ok(lease.receipt.leaseId);
      output(root, '03'); throw new Error('synthetic build failure');
    }), /synthetic build failure/);
    const record = applyBuildRetention({ workspaceRoot: root, action: 'inventory' });
    assert.equal(record.existingCount, 2); assert.equal(record.active.length, 0);
  } finally { cleanup(root); }
});
test('two live reservations block a third without deleting active output', windows, () => {
  const root = workspace(); let a; let b;
  try {
    a = reserveBuildOutput({ workspaceRoot: root, outputPath: 'apps/web/.tmp/next-review-01' }); output(root, '01');
    b = reserveBuildOutput({ workspaceRoot: root, outputPath: 'apps/web/.tmp/next-review-02' }); output(root, '02');
    assert.throws(() => reserveBuildOutput({ workspaceRoot: root, outputPath: 'apps/web/.tmp/next-review-03' }), error => error instanceof BuildRetentionError && /Two build slots/.test(error.message));
    assert.equal(existsSync(path.join(root, 'apps/web/.tmp/next-review-01/BUILD_ID')), true);
  } finally { b?.finish(); a?.finish(); cleanup(root); }
});
test('unapproved external junctions and database markers fail closed', windows, () => {
  const root = workspace();
  try {
    const outside = path.join(root, '.runtime/not-an-output'); mkdirSync(outside); writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const linked = path.join(root, 'apps/web/.tmp/next-review-01'); symlinkSync(outside, linked, 'junction');
    assert.throws(() => applyBuildRetention({ workspaceRoot: root }), /External link target/);
    assert.equal(readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { cleanup(root); }
  const second = workspace();
  try {
    const old = output(second, '01', 3); output(second, '02', 2); output(second, '03', 1); writeFileSync(path.join(old, 'PG_VERSION'), '16');
    utimesSync(old, new Date(0), new Date(0));
    assert.throws(() => applyBuildRetention({ workspaceRoot: second }), /Database data marker/);
    assert.equal(existsSync(path.join(old, 'PG_VERSION')), true);
  } finally { cleanup(second); }
});
test('retiring an output unlinks child junctions and preserves the external target', windows, () => {
  const root = workspace();
  try {
    const old = output(root, '01', 3); output(root, '02', 2); output(root, '03', 1);
    const outside = path.join(root, '.runtime/keep'); mkdirSync(outside); writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, path.join(old, 'linked-cache'), 'junction');
    const record = applyBuildRetention({ workspaceRoot: root });
    assert.equal(record.passed, true); assert.equal(readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { cleanup(root); }
});
test('distribution Next and packaged copies occupy one registered artifact slot', windows, () => {
  const root = workspace(); let lease;
  try {
    output(root, '01', 1);
    lease = reserveBuildOutput({ workspaceRoot: root, outputPaths: ['apps/web/.tmp/next-windows-distribution', 'output/windows-installer'] });
    for (const value of ['apps/web/.tmp/next-windows-distribution', 'output/windows-installer']) {
      const target = path.join(root, value); mkdirSync(target, { recursive: true }); writeFileSync(path.join(target, 'BUILD_ID'), 'same-build');
    }
    const record = applyBuildRetention({ workspaceRoot: root, action: 'inventory' });
    assert.equal(record.existingCount, 2); assert.equal(record.physicalOutputCount, 3);
  } finally { lease?.finish(); cleanup(root); }
});
test('path escapes and stale lock files are not silently deleted', windows, () => {
  const root = workspace();
  try {
    assert.throws(() => reserveBuildOutput({ workspaceRoot: root, outputPath: '../arbitrary' }), /Unregistered build output/);
    const a = output(root, '01', 3); const b = output(root, '02', 2);
    writeFileSync(path.join(a, 'lock'), ''); writeFileSync(path.join(b, 'lock'), '');
    assert.throws(() => reserveBuildOutput({ workspaceRoot: root, outputPath: 'apps/web/.tmp/next-review-03' }), /Two build slots/);
  } finally { cleanup(root); }
});
test('a release history payload is retired separately from its registered current bundle', windows, () => {
  const root = workspace(); let active; let release;
  try {
    active = reserveBuildOutput({ workspaceRoot: root, outputPath: 'apps/web/.tmp/next-review-01' }); output(root, '01');
    release = reserveBuildOutput({ workspaceRoot: root, outputPaths: ['apps/web/.tmp/next-windows-distribution', 'output/windows-installer'] });
    const installer = path.join(root, 'output/windows-installer'); mkdirSync(installer, { recursive: true });
    writeFileSync(path.join(installer, 'build-retention-owner.json'), JSON.stringify({ schemaVersion: 'build-artifact-owner.v1', workspaceRoot: root, currentPayload: path.join(installer, 'payload-0.6.0') }));
    writeFileSync(path.join(installer, 'Zhiyu-Setup-0.5.0.exe'), 'synthetic');
    const backup = path.join(installer, 'previous-worker-1790972859545'); mkdirSync(backup); writeFileSync(path.join(backup, 'generated.js'), 'old');
    const previousVersion = path.join(installer, 'payload-0.5.0'); mkdirSync(previousVersion); writeFileSync(path.join(previousVersion, 'generated.js'), 'old');
    const record = release.finish(); release = undefined;
    assert.equal(record.existingCount, 2); assert.equal(existsSync(backup), false); assert.equal(existsSync(previousVersion), false); assert.equal(existsSync(path.join(installer, 'Zhiyu-Setup-0.5.0.exe')), true);
  } finally { release?.finish(); active?.finish(); cleanup(root); }
});
test('a later individual reservation breaks the previous multi-output association', windows, () => {
  const root = workspace(); let active; let bundle; let individual;
  const distribution = path.join(root, 'apps/web/.tmp/next-windows-distribution'), installer = path.join(root, 'output/windows-installer');
  try {
    active = reserveBuildOutput({ workspaceRoot: root, outputPath: 'apps/web/.tmp/next-review-01' }); output(root, '01');
    bundle = reserveBuildOutput({ workspaceRoot: root, outputPaths: [distribution, installer] });
    for (const target of [distribution, installer]) { mkdirSync(target, { recursive: true }); writeFileSync(path.join(target, 'BUILD_ID'), 'previous-bundle'); }
    bundle.finish(); bundle = undefined;
    individual = reserveBuildOutput({ workspaceRoot: root, outputPath: distribution });
    expectTwo(individual.receipt);
    assert.equal(existsSync(installer), false, 'An old installer must not hide behind a previous bundle lease');
    assert.equal(existsSync(path.join(distribution, 'BUILD_ID')), true); writeFileSync(path.join(distribution, 'BUILD_ID'), 'new-individual-build');
    individual.finish(); individual = undefined;
    const inventory = applyBuildRetention({ workspaceRoot: root, action: 'inventory' }); expectTwo(inventory); assert.equal(inventory.physicalOutputCount, 2);
  } finally { individual?.finish(); bundle?.finish(); active?.finish(); cleanup(root); }
});
function expectTwo(record) { assert.equal(record.existingCount, 2); }
test('a prepared new release payload is protected before stale owner metadata is replaced', windows, () => {
  const root = workspace(); let active; let first; let next;
  const distribution = path.join(root, 'apps/web/.tmp/next-windows-distribution'), installer = path.join(root, 'output/windows-installer');
  const base = path.join(installer, 'payload-0.5.0'), prepared = path.join(installer, 'payload-0.5.0-components');
  const manifest = { product: 'Zhiyu', platform: 'win32-x64', version: '0.5.0' };
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.5.0' }));
    active = reserveBuildOutput({ workspaceRoot: root, outputPath: 'apps/web/.tmp/next-review-01' }); output(root, '01');
    for (const target of [distribution, base]) { mkdirSync(target, { recursive: true }); writeFileSync(path.join(target, 'BUILD_ID'), 'prepared-bundle'); }
    writeFileSync(path.join(base, 'release-manifest.json'), JSON.stringify(manifest));
    writeFileSync(path.join(installer, 'build-retention-owner.json'), JSON.stringify({ schemaVersion: 'build-artifact-owner.v1', workspaceRoot: root, currentPayload: base, producer: 'scripts/windows/build-release.mjs' }));
    first = reserveBuildOutput({ workspaceRoot: root, outputPaths: [distribution, installer], currentPayload: base }); first.finish(); first = undefined;
    mkdirSync(prepared); writeFileSync(path.join(prepared, 'release-manifest.json'), JSON.stringify(manifest)); writeFileSync(path.join(prepared, 'prepared.bin'), 'prepared-copy');
    next = reserveBuildOutput({ workspaceRoot: root, outputPaths: [distribution, installer], currentPayload: prepared });
    assert.equal(existsSync(path.join(prepared, 'prepared.bin')), true); assert.equal(next.receipt.preparation.currentPayload, prepared); expectTwo(next.receipt);
    // The explicit lease, not the stale parent metadata, keeps the staged copy.
    const during = applyBuildRetention({ workspaceRoot: root }); assert.equal(existsSync(path.join(prepared, 'prepared.bin')), true); expectTwo(during);
    assert.equal(existsSync(base), false);
    assert.throws(() => reserveBuildOutput({ workspaceRoot: root, outputPaths: [distribution, installer], currentPayload: path.join(installer, 'payload-0.5.0-previous-123') }), /Current release payload/);
    next.finish(); next = undefined;
  } finally { next?.finish(); first?.finish(); active?.finish(); cleanup(root); }
});
