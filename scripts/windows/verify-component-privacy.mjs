import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesUnder, sha256 } from './release-lib.mjs';
import { collectPrivateDeveloperValues } from './verify-release.mjs';

const workspace = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const payload = resolve(process.argv[2] || 'output/windows-installer/payload-0.5.0-components');
const require = createRequire(join(workspace, 'apps/web/package.json'));
const manifestPath = join(payload, 'release-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.optionalComponents?.python, true);
assert.equal(manifest.optionalComponents?.wechat, true);
assert.equal(manifest.optionalComponents?.quant, true);
const values = await collectPrivateDeveloperValues(workspace, require('dotenv').parse);
const paths = (await filesUnder(payload)).filter(path => /\.(?:py|ps1|cfg|ini|pth|toml|sql|bat|cmd)$/i.test(path));
assert.ok(paths.length > 0);
let scanned = 0;
for (let offset = 0; offset < paths.length; offset += 12) {
  const batch = await Promise.allSettled(paths.slice(offset, offset + 12).map(async path => {
    const content = await readFile(path, 'utf8');
    for (const value of values) assert.equal(content.includes(value), false, 'private_developer_value_in_component_release');
    scanned += 1;
  }));
  for (const result of batch) if (result.status === 'rejected') throw result.reason;
}
const report = {
  kind: 'windows-component-private-values-supplement', passed: true,
  sourceManifestSha256: await sha256(manifestPath), completedAt: new Date().toISOString(),
  extensions: ['py', 'ps1', 'cfg', 'ini', 'pth', 'toml', 'sql', 'bat', 'cmd'],
  filesScanned: scanned, privateValueCount: values.size,
  scope: 'Known local development credentials; no credential values or contents are emitted. Complements the main release text scan.',
};
const directory = join(workspace, 'output/windows-installer-check', `component-privacy-${Date.now()}`);
await mkdir(directory, { recursive: true });
const reportPath = join(directory, 'verification.json');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ report: reportPath, ...report }));
