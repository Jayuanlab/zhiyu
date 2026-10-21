import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
const { TraceEntryPointsPlugin, TRACE_IGNORES } = require('next/dist/build/webpack/plugins/next-trace-entrypoints-plugin');
const picomatch = require('next/dist/compiled/picomatch');
const { transformSync } = require('esbuild');
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), root = path.resolve(web, '../..');
const records = path.join(root, '.runtime/memory-technical-plan/t7-webpack-probe');
fs.mkdirSync(records, { recursive: true });

// Native node:test deliberately loads the actual ESM config outside Vite. This
// checks ordinary review builds, not the previously guarded Windows installer.
delete process.env.ZHIYU_WINDOWS_DISTRIBUTION;
process.env.NODE_ENV = 'production';
process.env.ZHIYU_REVIEW_BUILD = '15';
const { default: configure } = await import('../next.config.js');
const actualConfig = configure('phase-production-build');
const plugin = new TraceEntryPointsPlugin({ rootDir: web, appDir: path.join(web, 'app'), pagesDir: undefined,
  compilerType: 'server', appDirEnabled: true, traceIgnores: [], esmExternals: true, outputFileTracingRoot: actualConfig.outputFileTracingRoot });
const webpackConfig = actualConfig.webpack({ plugins: [plugin], externals: [], module: { rules: [] }, resolve: {} }, { isServer: true });
assert.equal(webpackConfig.plugins[0], plugin, 'The actual Next source-tracing plugin must receive the webpack configuration');
// Exactly the matcher used at next-trace-entrypoints-plugin.js:317-342.
const ignores = [...TRACE_IGNORES, ...plugin.traceIgnores, '**/node_modules/**'];
const ignore = picomatch(ignores, { contains: true, dot: true });

async function traceGuarded(entry, source, ignoreMatcher = ignore) {
  const nativeReaddir = fs.readdir, outsideReaddir = [], start = Date.now();
  fs.readdir = function(target, ...args) {
    const resolved = path.resolve(String(target));
    if (!resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      outsideReaddir.push({ path: resolved, stack: new Error('NFT external scan attempt').stack.split('\n').slice(1, 7) });
      // Do not enumerate the Windows profile, C drive or any unrelated folder.
      const error = Object.assign(new Error('EPERM: tracing regression guard refused external scandir'), { code: 'EPERM', syscall: 'scandir', path: resolved });
      const callback = args.at(-1); if (typeof callback === 'function') return callback(error); throw error;
    }
    return nativeReaddir.call(this, target, ...args);
  };
  try {
    const result = await nodeFileTrace([entry], { base: plugin.tracingRoot, processCwd: plugin.rootDir, ignore: ignoreMatcher, mixedModules: true,
      readFile: async filename => {
        const content = filename === entry && source !== undefined ? source : await fs.promises.readFile(filename, 'utf8');
        return /\.[cm]?tsx?$/.test(filename) ? transformSync(content, { loader: 'ts', format: 'esm', target: 'node20' }).code : content;
      } });
    return { status: 'completed', elapsedMs: Date.now() - start, outsideReaddir, files: [...result.fileList].map(file => file.replaceAll('\\', '/')), warnings: [...result.warnings].map(error => error.message.split('\n')[0]) };
  } catch (error) {
    return { status: 'failed', elapsedMs: Date.now() - start, outsideReaddir, error: { code: error.code, path: error.path, message: error.message } };
  } finally { fs.readdir = nativeReaddir; }
}

test('actual server trace plugin never globs private runtime temp state from the controlled SDK', { concurrency: false, skip: process.platform !== 'win32' && 'Windows AppData regression; another OS needs its own runtime-state policy' }, async () => {
  const entry = path.join(web, 'lib/ai/extensions/agent/claude/controlled-sdk.ts');
  const result = await traceGuarded(entry);
  const record = path.join(records, `config-regression-${Date.now()}.json`);
  fs.writeFileSync(record, JSON.stringify({ entry, traceIgnores: plugin.traceIgnores, result }, null, 2));
  assert.deepEqual(result.outsideReaddir, [], 'Actual Next config let source-asset NFT scan private runtime state before its late output exclusions');
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.ok(result.files.includes(path.relative(root, entry).replaceAll('\\', '/')), 'The real runtime entry was skipped rather than traced');
  assert.ok(!result.files.some(file => /(?:^|[/\\])AppData(?:[/\\]|$)/i.test(file)));
});

test('the same early matcher still traces a legitimate workspace asset', { concurrency: false }, async () => {
  const entry = path.join(web, 'lib/ai/extensions/agent/claude/controlled-sdk.ts'), asset = path.join(web, 'package.json');
  const source = `const fs=require('node:fs');module.exports=()=>fs.readFileSync(${JSON.stringify(asset)},'utf8');`;
  const result = await traceGuarded(entry, source);
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.deepEqual(result.outsideReaddir, []);
  assert.ok(result.files.includes(path.relative(root, entry).replaceAll('\\', '/')));
  assert.ok(result.files.includes(path.relative(root, asset).replaceAll('\\', '/')), 'Private-runtime exclusions disabled legitimate source assets');
  assert.ok(!result.files.some(file => /(?:^|[/\\])AppData(?:[/\\]|$)/i.test(file)));
});

test('without AppData alone the same actual runtime still demonstrates the outside scan', { concurrency: false, skip: process.platform !== 'win32' && 'Windows AppData negative control' }, async () => {
  const entry = path.join(web, 'lib/ai/extensions/agent/claude/controlled-sdk.ts');
  const withoutAppData = picomatch(ignores.filter(pattern => !pattern.includes('AppData')), { contains: true, dot: true });
  const result = await traceGuarded(entry, undefined, withoutAppData);
  fs.writeFileSync(path.join(records, `config-negative-control-${Date.now()}.json`), JSON.stringify({ entry, result }, null, 2));
  assert.equal(result.status, 'failed');
  assert.ok(result.outsideReaddir.some(row => /(?:^|[/\\])AppData(?:[/\\]|$)/i.test(row.path)), 'Negative control no longer exercises the actual private-temp tracing bug');
});
