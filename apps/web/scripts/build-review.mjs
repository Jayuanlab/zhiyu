import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import nextConfigModule from 'next/dist/server/config.js';
import {findPagesDir} from 'next/dist/lib/find-pages-dir.js';
import {writeAppTypeDeclarations} from 'next/dist/lib/typescript/writeAppTypeDeclarations.js';
import {captureReleaseSources} from '../../../scripts/release-source-snapshot.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '../..');
const stage = process.argv[2] ?? '02';
if (!/^\d{2}$/.test(stage)) throw new Error('Expected a two-digit review stage');
const files = ['tsconfig.json', 'next-env.d.ts'];
const previous = new Map(files.map(file => [file, fs.readFileSync(path.join(web, file))]));
const sourceBefore = captureReleaseSources(root);
let buildExitCode = null;
const log = fs.openSync(path.join(root, `docs/plans/2026-09-06-review-remediation/records/${stage}-build.log`), 'w');
try {
  // Generate the exact Next declaration before the expensive compilation. This
  // avoids a late rewrite (intermittent Windows UNKNOWN/open in the type worker)
  // without skipping any type checks. Both files are restored in finally.
  process.env.ZHIYU_REVIEW_BUILD = stage;
  process.env.NODE_ENV = 'production';
  process.env.ENABLE_LOCAL_SCHEDULER = 'false';
  const config = await (nextConfigModule.default ?? nextConfigModule)('phase-production-build', web);
  if (config.distDir !== `.tmp/next-review-${stage}`) throw Error('Unexpected review output directory');
  const {appDir,pagesDir} = findPagesDir(web);
  await writeAppTypeDeclarations({baseDir:web,distDir:config.distDir,imageImportsEnabled:!config.images.disableStaticImages,hasPagesDir:!!pagesDir,hasAppDir:!!appDir,strictRouteTypes:Boolean(config.experimental.strictRouteTypes),typedRoutes:Boolean(config.typedRoutes)});
  fs.writeSync(log, 'Review declaration preflight completed; full Next type checking remains enabled.\n');
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
    cwd: web, windowsHide: true, stdio: ['ignore', log, log],
    env: {...process.env, ZHIYU_REVIEW_BUILD: stage, NODE_ENV: 'production', ENABLE_LOCAL_SCHEDULER: 'false', NODE_OPTIONS: '--max-old-space-size=12288', NODE_PATH: [path.join(root,'node_modules'),process.env.NODE_PATH].filter(Boolean).join(path.delimiter)},
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  buildExitCode = code;
  process.exitCode = Number(code ?? 1);
  console.log(JSON.stringify({stage, buildExitCode: code, distDir: `.tmp/next-review-${stage}`}));
} finally {
  fs.closeSync(log);
  // Next generates type references for the review output; preserve the live workspace config.
  for (const [file, contents] of previous) fs.writeFileSync(path.join(web, file), contents);
  const sourceAfter = captureReleaseSources(root);
  const sourceStable = sourceBefore.sourceHash === sourceAfter.sourceHash && sourceBefore.revision === sourceAfter.revision;
  if (!sourceStable) process.exitCode = 1;
  const buildIdPath = path.join(web, `.tmp/next-review-${stage}/BUILD_ID`);
  fs.writeFileSync(path.join(root, `docs/plans/2026-09-06-review-remediation/records/${stage}-build-receipt.json`), JSON.stringify({
    stage, buildExitCode, sourceStable, passed:buildExitCode === 0 && sourceStable,
    buildId:buildExitCode === 0 && fs.existsSync(buildIdPath)?fs.readFileSync(buildIdPath,'utf8').trim():null,
    nodeVersion:process.version,
    workerPackageVersion:JSON.parse(fs.readFileSync(path.join(root,'packages/runtime-worker/package.json'),'utf8')).version,
    sourceBefore, sourceAfter,
    deploymentVerification:'pending: database version, runtime configuration, Python version and production behavior require separate acceptance evidence',
  },null,2));
}
