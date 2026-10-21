import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { withHostBuildRetention } from '../../../scripts/build-retention.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '../..');
const directory = process.env.ZHIYU_WINDOWS_DISTRIBUTION === '1' ? '.tmp/next-windows-distribution'
  : /^\d{2}$/.test(process.env.ZHIYU_REVIEW_BUILD ?? '') ? `.tmp/next-review-${process.env.ZHIYU_REVIEW_BUILD}` : '.next';
await withHostBuildRetention({ workspaceRoot: root, outputPath: path.join(web, directory), label: 'formal-web-build' }, async lease => {
  console.log(JSON.stringify({ event: 'build_retention_reserved', receipt: lease.receipt.receiptPath, directory }));
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack', ...process.argv.slice(2)], {
    cwd: web, windowsHide: true, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=12288' },
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', value => resolve(value ?? 1)); });
  if (code !== 0) { process.exitCode = code; throw new Error(`Next build failed with exit code ${code}`); }
});
