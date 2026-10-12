import { copyFile, lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './release-lib.mjs';

const workspace = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const base = await realpath(join(workspace, 'output/windows-installer/payload-0.5.0'));
const reference = JSON.parse(await readFile(join(base, 'release-manifest.json'), 'utf8'));
if (reference.platform !== 'win32-x64' || reference.version !== '0.5.0') throw new Error('component_stage_base_invalid');
const link = join(workspace, 'output/windows-installer/payload-0.5.0-components');
if (existsSync(link)) throw new Error('component_stage_already_exists_use_refresh_app');
const id = randomUUID();
const ownedRoot = join(homedir(), 'ZhiyuBuild', `components-${id}`);
if (existsSync(ownedRoot)) throw new Error('component_stage_unique_path_exists');
await mkdir(ownedRoot, { recursive: true });
if (await realpath(ownedRoot) !== ownedRoot) throw new Error('component_stage_root_redirected');
await writeFile(join(ownedRoot, '.zhiyu-build-owned'), id + '\n');
const payload = join(ownedRoot, 'payload');
await mkdir(payload);
await symlink(payload, link, 'junction');
if (await realpath(link) !== payload) throw new Error('component_stage_junction_mismatch');
const archive = join(ownedRoot, 'baseline-installer');
await mkdir(archive);
for (const name of ['Zhiyu-Setup-0.5.0-x64.exe', 'Zhiyu-Setup-0.5.0-x64.exe.sha256', 'delivery.json']) {
  const source = join(workspace, 'output/windows-release/0.5.0', name);
  await copyFile(source, join(archive, name));
  if (await sha256(source) !== await sha256(join(archive, name))) throw new Error('baseline_installer_archive_mismatch');
}
const logFile = join(ownedRoot, 'copy.log');
const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'robocopy.exe'),
  [base, payload, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:0', '/W:0', '/MT:16', '/XJ', '/NP', '/NFL', '/NDL', '/NJH', '/NJS', `/LOG:${logFile}`],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
if (!Number.isInteger(code) || code < 0 || code >= 8) throw new Error(`component_stage_copy_failed:${code}`);
if (await sha256(join(base, 'release-manifest.json')) !== await sha256(join(payload, 'release-manifest.json'))) throw new Error('component_stage_manifest_copy_mismatch');
const receipt = { schemaVersion: 1, kind: 'owned-component-build-stage', id, source: base, stageRoot: link, physicalStageRoot: payload,
  baselineArchive: archive, referenceManifestSha256: await sha256(join(base, 'release-manifest.json')), robocopyExitCode: code, copiedAt: new Date().toISOString() };
await writeFile(join(ownedRoot, 'prepare.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
