import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePackage } from './release-lib.mjs';

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`worker_release_transform_missing:${label}`);
  return source.replace(pattern, replacement);
}

export function transformWorkerSource(source, kind) {
  if (kind === 'entry') {
    source = replaceRequired(source, /import\s*\{\s*config\s*\}\s*from\s*['"]dotenv['"];?\s*/, '', 'entry_dotenv_import');
    source = replaceRequired(source, /config\(\{path:'\.env\.local',quiet:true\}\);/, '', 'entry_local_env');
    source = replaceRequired(source, /config\(\{path:'\.env',quiet:true\}\);/, '', 'entry_base_env');
    source = replaceRequired(source,
      /modules:\[\.\.\.createWorkModules\(configuration\.ownerId,instanceId\),createPaperMatchingModule\(configuration\.ownerId,new PaperTickStore\(sql\)\)\]/,
      "modules:[...createWorkModules(configuration.ownerId,instanceId),...(process.env.ZHIYU_OPTIONAL_QUANT_ENABLED === 'false' ? [] : [createPaperMatchingModule(configuration.ownerId,new PaperTickStore(sql))])]",
      'optional_paper_module');
    source = replaceRequired(source, /  let stopping=false,lastState='',timer;/,
      "  if(process.env.ZHIYU_RUNTIME_START_PAUSED==='1')host.pause();\n  let stopping=false,lastState='',timer;",
      'initial_pause_before_tick');
    source = replaceRequired(source, /if\(host\.snapshot\(\)\.phase==='running'&&process\.connected\)/,
      "if(['running','paused'].includes(host.snapshot().phase)&&process.connected)",
      'paused_runtime_ready');
    return source;
  }
  if (kind === 'database') {
    source = replaceRequired(source, /import\s*\{\s*config\s*\}\s*from\s*['"]dotenv['"];?\s*/, '', 'database_dotenv_import');
    return replaceRequired(source, /config\(\{\s*path:\s*['"]\.env['"],?\s*\}\);/, '', 'database_env');
  }
  throw new Error('worker_release_transform_unknown');
}

function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

export function resolveReleaseExternal(specifier, resolveOrigin) {
  const originalName = packageName(specifier);
  const resolvedPackage = resolvePackage(originalName, resolveOrigin);
  const packageRoot = realpathSync(resolvedPackage.root);
  const rootHash = createHash('sha256').update(packageRoot).digest('hex').slice(0, 12);
  const safeName = originalName.replace(/^@/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
  const releasePackageName = `@zhiyu-release/${safeName}-${rootHash}`;
  let releaseSubpath = specifier.slice(originalName.length);
  if (releaseSubpath && !Object.hasOwn(resolvedPackage.data, 'exports')) {
    // ESM does not add extensions or resolve directory indexes for legacy
    // package subpaths. Preserve the actual source file selected by Node.
    // Export maps retain their original subpath so runtime conditions still
    // select import/react-server rather than the build host's require branch.
    const sourceFile = realpathSync(createRequire(resolveOrigin).resolve(specifier));
    const packageRelative = relative(packageRoot, sourceFile);
    if (!packageRelative || isAbsolute(packageRelative) || packageRelative === '..' || packageRelative.startsWith(`..${sep}`)) {
      throw new Error('worker_release_subpath_outside_package');
    }
    releaseSubpath = `/${packageRelative.replaceAll('\\', '/')}`;
  }
  const record = {
    specifier, packageName: originalName, resolveOrigin, releasePackageName,
    packageRoot, version: resolvedPackage.data.version,
  };
  return { path: `${releasePackageName}${releaseSubpath}`, external: true, record };
}

export async function buildWorkerBundle({ workspaceRoot, stageRoot }) {
  workspaceRoot = resolve(workspaceRoot);
  stageRoot = resolve(stageRoot);
  const sourceRoot = join(workspaceRoot, 'apps', 'web');
  const require = createRequire(join(workspaceRoot, 'package.json'));
  const { build } = require('esbuild');
  const externalDependencies = new Map();
  const entryPath = join(sourceRoot, 'scripts', 'start-runtime-worker.mjs');
  const clientPath = join(sourceRoot, 'lib', 'db', 'client.ts');
  const plugin = {
    name: 'zhiyu-release-worker',
    setup(api) {
      api.onResolve({ filter: /.*/ }, args => {
        const specifier = args.path;
        if (builtins.has(specifier) || specifier.startsWith('node:')) return { path: specifier, external: true };
        if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('@/') || specifier.startsWith('@openzhiyu/')) return;
        const resolveOrigin = args.importer || join(sourceRoot, 'package.json');
        const resolvedExternal = resolveReleaseExternal(specifier, resolveOrigin);
        const record = resolvedExternal.record;
        externalDependencies.set(`${specifier}\0${resolveOrigin}`, record);
        return { path: resolvedExternal.path, external: true };
      });
      api.onLoad({ filter: /(?:start-runtime-worker\.mjs|client\.ts)$/ }, async args => {
        const kind = resolve(args.path) === entryPath ? 'entry' : resolve(args.path) === clientPath ? 'database' : null;
        if (!kind) return;
        return { contents: transformWorkerSource(await readFile(args.path, 'utf8'), kind), loader: kind === 'entry' ? 'js' : 'ts' };
      });
    },
  };
  const common = {
    absWorkingDir: sourceRoot, bundle: true, platform: 'node', target: 'node22', format: 'esm',
    splitting: true, conditions: ['react-server'], tsconfig: join(sourceRoot, 'tsconfig.json'),
    sourcemap: false, metafile: true, write: false, logLevel: 'warning', plugins: [plugin],
    banner: { js: "import { createRequire as __zhiyuCreateRequire } from 'node:module'; const require = __zhiyuCreateRequire(import.meta.url);" },
  };
  const workerRoot = join(stageRoot, 'worker');
  const migrationsRoot = join(stageRoot, 'migrations');
  const workerResult = await build({ ...common,
    entryPoints: { 'start-runtime-worker': join(workspaceRoot, 'scripts', 'windows', 'worker-entry.mjs') },
    outdir: workerRoot, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]',
  });
  const migrationResult = await build({ ...common,
    entryPoints: { migrate: join(workspaceRoot, 'scripts', 'windows', 'migrate-entry.mjs') },
    outdir: migrationsRoot, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]',
  });
  for (const output of [...workerResult.outputFiles, ...migrationResult.outputFiles]) {
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, output.contents);
  }
  const migrationSource = join(sourceRoot, 'lib', 'db', 'migrations');
  const journal = JSON.parse(await readFile(join(migrationSource, 'meta', '_journal.json'), 'utf8'));
  if (!Array.isArray(journal.entries) || !journal.entries.length) throw new Error('migration_journal_invalid');
  const sqlRoot = join(migrationsRoot, 'sql');
  await mkdir(join(sqlRoot, 'meta'), { recursive: true });
  await copyFile(join(migrationSource, 'meta', '_journal.json'), join(sqlRoot, 'meta', '_journal.json'));
  for (const entry of journal.entries) {
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.tag)) throw new Error('migration_journal_invalid');
    await copyFile(join(migrationSource, `${entry.tag}.sql`), join(sqlRoot, `${entry.tag}.sql`));
  }
  const externals = [...externalDependencies.values()].sort((a, b) => a.specifier.localeCompare(b.specifier) || a.resolveOrigin.localeCompare(b.resolveOrigin));
  const metadata = {
    schemaVersion: 1, nodeConditions: ['react-server'], externalDependencies: externals,
    worker: { entry: relative(stageRoot, join(workerRoot, 'start-runtime-worker.mjs')), outputs: Object.keys(workerResult.metafile.outputs) },
    migrations: { entry: relative(stageRoot, join(migrationsRoot, 'migrate.mjs')), migrationCount: journal.entries.length },
  };
  await writeFile(join(workerRoot, 'bundle-meta.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { ...metadata, workerEntry: join(workerRoot, 'start-runtime-worker.mjs'), migrationEntry: join(migrationsRoot, 'migrate.mjs'), externalDependencies: externals };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const workspaceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const stageRoot = process.argv[2];
  if (!stageRoot) throw new Error('Usage: node scripts/windows/build-worker.mjs <stage-root>');
  const result = await buildWorkerBundle({ workspaceRoot, stageRoot });
  console.log(JSON.stringify({ workerEntry: result.workerEntry, migrationEntry: result.migrationEntry, externalDependencyCount: result.externalDependencies.length }));
}
