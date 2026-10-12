import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

export function within(root, target) {
  const delta = relative(resolve(root), resolve(target));
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}
export function assertWithin(root, target) {
  if (!within(root, target)) throw new Error('release_path_outside_workspace');
}
export function safeReleaseFile(path) {
  // This is the immutable, wheel-hash-verified public CA bundle, not a user's key.
  if (path.replaceAll('\\', '/') === 'vendor/python/Lib/site-packages/certifi/cacert.pem') return true;
  const parts = path.replaceAll('\\', '/').split('/');
  return !parts.some(part => /^\.env(?:\.|$)/.test(part) ||
    ['.git', '.runtime', '.openzhiyu', '.codex', '.data', '.venv', '__pycache__', 'coverage'].includes(part) ||
    /\.(?:log|sqlite|sqlite3|db|pem|key)$/i.test(part));
}
export async function sha256(path, knownSize) {
  const hash = createHash('sha256');
  const size = knownSize ?? (await stat(path)).size;
  if (size <= 4 * 1024 * 1024) return hash.update(await readFile(path)).digest('hex');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function filesUnder(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`release_symlink_not_portable:${relative(root, path)}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files.sort();
}
export async function copyReleaseTree(source, target, { omitModules = false } = {}) {
  await cp(source, target, { recursive: true, dereference: false,
    filter: path => safeReleaseFile(relative(source, path)) &&
      (!omitModules || !relative(source, path).split(sep).includes('node_modules')),
  });
}
export async function adaptStandaloneEntrypoint(serverPath, packagePath) {
  const manifest=JSON.parse(await readFile(packagePath,'utf8'));
  const server=await readFile(serverPath,'utf8');
  if (manifest.type !== 'module' || server.includes('module.createRequire(import.meta.url)')) return false;
  const header="const path = require('path')";
  if (!server.startsWith(header)) throw new Error('standalone_module_adapter_requires_review');
  // Next resolves moduleType from distDir/../package.json; an isolated .tmp
  // dist has no such manifest. Keep the application's ESM package scope.
  const esm="import path from 'node:path'\nimport { fileURLToPath } from 'node:url'\nimport module from 'node:module'\nconst require = module.createRequire(import.meta.url)\nconst __dirname = fileURLToPath(new URL('.', import.meta.url))";
  await writeFile(serverPath,esm+server.slice(header.length),'utf8');
  return true;
}
export function cleanBuildEnvironment(workspaceRoot) {
  const env = {};
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|PROCESSOR_.*|NUMBER_OF_PROCESSORS|OS|LANG|LC_.*)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
  // Prevent dotenv and Next from substituting private developer values into this build.
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const file = join(workspaceRoot, 'apps', 'web', name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=/);
      if (match) env[match[1]] = '';
    }
  }
  return Object.assign(env, {
    NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=12288',
    NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true',
    ZHIYU_WINDOWS_DISTRIBUTION: '1', ZHIYU_RUNTIME_MODE: 'disabled', ENABLE_LOCAL_SCHEDULER: 'false',
    AUTH_MODE: 'local_owner', AUTH_SECRET: 'distribution-build-placeholder-not-a-runtime-secret',
    ENCRYPTION_KEY: 'distribution-build-placeholder-not-a-runtime-secret',
    POSTGRES_URL: 'postgres://distribution_build:placeholder@127.0.0.1:1/zhiyu_build',
    DATABASE_URL: 'postgres://distribution_build:placeholder@127.0.0.1:1/zhiyu_build',
    ZHIYU_APP_DATA_DIR: join(workspaceRoot, 'output', 'windows-build-data'),
    OPENZHIYU_SKIP_POSTGRES: '1', OPENZHIYU_SKIP_QUANT: '1', OPENZHIYU_SKIP_WECHAT: '1',
    SKIP_TYPE_CHECK: 'false', IS_TAURI: 'false', TAURI_MODE: 'false',
  });
}
export async function run(command, args, { cwd, env = process.env, logFile } = {}) {
  if (logFile) await mkdir(dirname(logFile), { recursive: true });
  const { createWriteStream } = await import('node:fs');
  const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const output = chunk => { if (log) log.write(chunk); tail = (tail + chunk.toString()).slice(-8000); };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('error', error => { log?.end(); reject(error); });
    child.once('exit', code => { log?.end(); if (code === 0) accept(tail); else reject(new Error(`command_failed:${basename(command)}:${code}\n${tail}`)); });
  });
}

function packageFromResolved(file) {
  let candidate = dirname(file);
  while (candidate !== dirname(candidate)) {
    const manifest = join(candidate, 'package.json');
    if (existsSync(manifest)) {
      const data = JSON.parse(readFileSync(manifest, 'utf8'));
      if (data.name) return { root: candidate, data };
    }
    candidate = dirname(candidate);
  }
  throw new Error('release_package_manifest_missing');
}
export function resolvePackage(name, origin) {
  const req = createRequire(origin);
  try { return packageFromResolved(req.resolve(`${name}/package.json`)); }
  catch {
    // ESM-only packages can hide both their manifest and entry under require conditions.
    // Walk the same node_modules ancestry used by Node instead of choosing another version.
    let candidate = dirname(resolve(origin));
    while (true) {
      const root = join(candidate, 'node_modules', ...name.split('/'));
      const manifest = join(root, 'package.json');
      if (existsSync(manifest)) return { root: realpathSync(root), data: JSON.parse(readFileSync(manifest, 'utf8')) };
      if (candidate === dirname(candidate)) break;
      candidate = dirname(candidate);
    }
    return packageFromResolved(req.resolve(name));
  }
}
export async function collectTracedPackages(buildRoot) {
  const result = new Map();
  const visited = new Set();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'standalone' && entry.name !== 'cache') await walk(path);
      if (!entry.isFile() || !entry.name.endsWith('.nft.json')) continue;
      const trace = JSON.parse(await readFile(path, 'utf8'));
      for (const item of trace.files ?? []) {
        const dependency = resolve(dirname(path), item);
        if (visited.has(dependency)) continue;
        visited.add(dependency);
        if (!dependency.replaceAll('\\', '/').includes('/node_modules/') || !existsSync(dependency)) continue;
        try {
          const pkg = packageFromResolved(dependency);
          pkg.root = await realpath(pkg.root);
          // Directory-only trace entries must not walk up to the repository's
          // package.json and accidentally classify the whole checkout as npm.
          if (pkg.data.name.startsWith('@openzhiyu/') || !pkg.root.replaceAll('\\','/').includes('/node_modules/')) continue;
          result.set(pkg.root, pkg);
        } catch { /* directory-only trace entries are not packages */ }
      }
    }
  }
  await walk(buildRoot);
  return [...result.values()];
}

/** Flatten the common graph; nest only conflicting versions. No symlink escapes survive. */
export async function copyDependencyClosure(packages, destination) {
  const aliases = [...new Map(packages.filter(pkg => pkg.releasePackageName && pkg.releasePackageName !== pkg.data.name)
    .map(pkg => [pkg.releasePackageName, pkg])).values()];
  const roots = new Map(), all = new Map(), queue = [...packages];
  while (queue.length) {
    const pkg = queue.shift();
    pkg.root = await realpath(pkg.root);
    if (!pkg.root.replaceAll('\\','/').includes('/node_modules/')) throw new Error('release_npm_package_root_required');
    if (all.has(pkg.root)) continue;
    all.set(pkg.root, pkg);
    if (!roots.has(pkg.data.name)) roots.set(pkg.data.name, pkg);
    const dependencies = { ...pkg.data.dependencies, ...pkg.data.optionalDependencies, ...pkg.data.peerDependencies };
    pkg.resolvedDependencies = new Map();
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith('@openzhiyu/')) continue;
      try {
        const dep = resolvePackage(name, join(pkg.root, 'package.json'));
        dep.root = await realpath(dep.root);
        pkg.resolvedDependencies.set(name, dep.root);
        queue.push(dep);
      } catch {
        if (pkg.data.dependencies?.[name] && !pkg.data.optionalDependencies?.[name]) throw new Error(`release_dependency_missing:${pkg.data.name}:${name}`);
      }
    }
  }
  let copied = 0;
  async function materialize(pkg, target, environment) {
    await mkdir(target, { recursive: true });
    await copyReleaseTree(pkg.root, target, { omitModules: true });
    copied++;
    const lookup = new Map(environment); lookup.set(pkg.data.name, pkg.root);
    for (const [name, source] of all.get(pkg.root).resolvedDependencies) {
      if (lookup.get(name) === source) continue;
      const dep = all.get(source);
      await materialize(dep, join(target, 'node_modules', ...name.split('/')), lookup);
    }
  }
  const environment = new Map([...roots].map(([name, pkg]) => [name, pkg.root]));
  for (const [name, pkg] of roots) await materialize(pkg, join(destination, ...name.split('/')), environment);
  for (const pkg of aliases) await materialize(pkg, join(destination, ...pkg.releasePackageName.split('/')), environment);
  return { packageCount: all.size, copiedDirectories: copied, packages: [...all.values()].map(pkg => ({ name: pkg.data.name, version: pkg.data.version, license: pkg.data.license ?? 'SEE PACKAGE LICENSE' })).sort((a,b) => a.name.localeCompare(b.name)) };
}
export async function writeReleaseManifest(stageRoot, metadata, { onProgress } = {}) {
  const files = [];
  const paths = (await filesUnder(stageRoot)).filter(path => relative(stageRoot, path) !== 'release-manifest.json');
  // Bound open handles while avoiding a serial filesystem round trip per file.
  for (let offset = 0; offset < paths.length; offset += 32) {
    files.push(...await Promise.all(paths.slice(offset, offset + 32).map(async path => {
      const name = relative(stageRoot, path).replaceAll('\\', '/');
      if (!safeReleaseFile(name)) throw new Error(`release_private_file:${name}`);
      const size = (await stat(path)).size;
      return { path: name, size, sha256: await sha256(path, size) };
    })));
    if(onProgress&&(offset%8192===0||offset+32>=paths.length))onProgress(Math.min(offset+32,paths.length),paths.length);
  }
  const manifest = { schemaVersion: 1, ...metadata, files };
  await writeFile(join(stageRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
