import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesUnder, run, sha256, within } from './release-lib.mjs';

const workspaceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lockPath = join(workspaceRoot, 'packaging', 'windows', 'python-runtime-lock.json');
const helper = join(workspaceRoot, 'scripts', 'windows', 'python-runtime-pack.py');
const markerName = '.zhiyu-python-runtime-build';
const PYTHON = {
  version: '3.13.16', abi: 'cp313', platform: 'win_amd64',
  filename: 'python-3.13.16-embeddable-amd64.zip',
  url: 'https://www.python.org/ftp/python/3.13.16/python-3.13.16-embeddable-amd64.zip',
  sha256: '589dc1e9d02549ca5f680710307ff9b77f6e3ffc4aa3efccd7fa54eeeafac94b',
  officialManifest: 'https://www.python.org/ftp/python/3.13.16/windows-3.13.16.json',
};

function announce(event, value = {}) { console.log(JSON.stringify({ event, ...value })); }
function cleanEnvironment(runtime, temp) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE']) if (process.env[name]) env[name] = process.env[name];
  return Object.assign(env, {
    PATH: [runtime, join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    TEMP: temp, TMP: temp, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
  });
}
async function verifiedDownload(record, destination, logFile) {
  if (existsSync(destination)) {
    if (await sha256(destination) !== record.sha256) throw new Error(`python_cached_hash_mismatch:${record.filename}`);
    return;
  }
  const url = new URL(record.url);
  if (url.protocol !== 'https:' || !['www.python.org', 'files.pythonhosted.org'].includes(url.hostname)) throw new Error('python_untrusted_download_host');
  const partial = `${destination}.partial`;
  announce('python_vendor_download', { file: record.filename });
  await run('curl.exe', ['--fail', '--location', '--proto', '=https', '--retry', '3', '--silent', '--show-error', '--output', partial, record.url], { logFile });
  if (await sha256(partial) !== record.sha256) throw new Error(`python_download_hash_mismatch:${record.filename}`);
  await rename(partial, destination);
}
async function loadLock() {
  const data = await readFile(lockPath);
  const lock = JSON.parse(data);
  if (lock.schemaVersion !== 1 || lock.python.sha256 !== PYTHON.sha256 || lock.python.version !== PYTHON.version || !lock.packages?.length) throw new Error('python_lock_invalid');
  const requirement = await readFile(join(workspaceRoot, 'tools', 'quant-service', 'requirements.txt'));
  if (createHash('sha256').update(requirement).digest('hex') !== lock.quantRequirementsSha256) throw new Error('python_quant_requirements_changed_update_lock');
  for (const pkg of lock.packages) {
    if (!/^[a-z0-9][a-z0-9_.+-]*\.whl$/i.test(pkg.filename) || !/^[a-f0-9]{64}$/.test(pkg.sha256)) throw new Error('python_wheel_lock_invalid');
  }
  return { lock, lockSha256: createHash('sha256').update(data).digest('hex') };
}

async function compactBuildRoot(toolchain) {
  // MSIX AppData redirection can add over 100 characters. Some native wheel
  // loaders still reject DLL names above MAX_PATH even with long-path policy.
  const userRoot = toolchain.match(/^([A-Za-z]:\\Users\\[^\\]+)/i)?.[1];
  const target = resolve(process.env.ZHIYU_PYTHON_BUILD_ROOT || (userRoot && join(userRoot, 'ZhiyuPythonBuild')) || '');
  if (!userRoot && !process.env.ZHIYU_PYTHON_BUILD_ROOT) throw new Error('python_compact_build_root_required');
  const marker = join(target, '.zhiyu-private-python-builds');
  if (existsSync(target) && !existsSync(marker) && (await readdir(target)).length) throw new Error('python_compact_root_not_owned');
  await mkdir(target, { recursive: true });
  if (!existsSync(marker)) await writeFile(marker, 'zhiyu-private-python-builds-v1\n', 'utf8');
  const physical = await realpath(target);
  if (!/^[Cc]:\\/.test(physical) && !process.env.ZHIYU_PYTHON_BUILD_ROOT) throw new Error('python_default_build_requires_c_drive');
  const view = join(toolchain, 'python-private-work');
  if (!existsSync(view)) await symlink(physical, view, 'junction');
  if (await realpath(view) !== physical) throw new Error('python_compact_view_target_mismatch');
  return physical;
}

/** Produces a private verified cache first; an explicit stageRoot may then receive it. */
export async function buildPythonRuntime({ toolchain, stageRoot, logFile } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('python_windows_x64_builder_required');
  if (!toolchain) throw new Error('python_toolchain_directory_required');
  await mkdir(toolchain, { recursive: true });
  const physicalToolchain = await realpath(toolchain);
  const { lock, lockSha256 } = await loadLock();
  const recipeSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).update(await readFile(helper))
    .update(await readFile(join(workspaceRoot, 'packaging', 'windows', 'PYTHON-NOTICE.txt'))).digest('hex');
  const cacheKey = `${lockSha256.slice(0, 8)}-${recipeSha256.slice(0, 8)}`;
  const cache = join(await compactBuildRoot(physicalToolchain), `p313-${cacheKey}`);
  const runtime = join(cache, 'vendor', 'python');
  const receiptPath = join(runtime, 'zhiyu-python-receipt.json');
  if (existsSync(cache)) {
    if (!existsSync(join(cache, markerName)) || (await readFile(join(cache, markerName), 'utf8')).trim() !== lockSha256) throw new Error('python_cache_not_owned');
    if (!existsSync(receiptPath)) {
      await rename(cache, `${cache}-incomplete-${Date.now()}`);
    }
  }
  if (!existsSync(receiptPath)) {
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, markerName), `${lockSha256}\n`, 'utf8');
    const downloads = join(physicalToolchain, `python-${PYTHON.version}`);
    const wheels = join(downloads, 'wheels');
    const temp = join(cache, 'tmp');
    for (const path of [downloads, wheels, temp, runtime]) await mkdir(path, { recursive: true });
    await verifiedDownload(PYTHON, join(downloads, PYTHON.filename), logFile);
    await run('tar.exe', ['-xf', join(downloads, PYTHON.filename), '-C', runtime], { logFile });
    // A ._pth file excludes registry, PYTHONPATH, current directory and user
    // site. Only package hooks from the pinned private wheels are processed.
    const searchPath = ['python313.zip', '.', 'Lib/site-packages', 'Lib/site-packages/win32',
      'Lib/site-packages/win32/lib', 'Lib/site-packages/Pythonwin', 'Lib/site-packages/pywin32_system32',
      '../../components/quant', '../../components/wechat', 'import site'];
    await writeFile(join(runtime, 'python313._pth'), `${searchPath.join('\n')}\n`, 'utf8');
    const python = join(runtime, 'python.exe');
    const env = cleanEnvironment(runtime, temp);
    for (const pkg of lock.packages) {
      const destination = join(wheels, pkg.filename);
      if (pkg.vendoredWheel) {
        const source = resolve(workspaceRoot, pkg.vendoredWheel);
        if (!within(join(workspaceRoot, 'packaging', 'windows', 'python-source-wheels'), source) || await sha256(source) !== pkg.sha256) throw new Error('python_source_wheel_hash_mismatch');
        if (!existsSync(destination)) await copyFile(source, destination);
        else if (await sha256(destination) !== pkg.sha256) throw new Error('python_cached_source_wheel_hash_mismatch');
        const sourceArchive = join(downloads, pkg.sourceArchive.filename);
        await verifiedDownload(pkg.sourceArchive, sourceArchive, logFile);
        await run(python, ['-I', '-B', helper, 'source-audit', destination, sourceArchive], { cwd: cache, env, logFile });
      } else await verifiedDownload(pkg, destination, logFile);
    }
    await run(python, ['-I', '-B', helper, 'install', lockPath, wheels, runtime], { cwd: cache, env, logFile });
    await copyFile(lockPath, join(runtime, 'dependency-lock.json'));
    await copyFile(join(workspaceRoot, 'packaging', 'windows', 'PYTHON-NOTICE.txt'), join(runtime, 'PYTHON-NOTICE.txt'));
    const smokeOutput = await run(python, ['-I', '-B', helper, 'smoke', lockPath, runtime], { cwd: cache, env, logFile });
    const smoke = JSON.parse(smokeOutput.split(/\r?\n/).find(line => line.startsWith('{"event": "python_runtime_smoke"')) || 'null');
    if (!smoke?.ok || smoke.version !== PYTHON.version) throw new Error('python_runtime_smoke_not_confirmed');
    // Record paths relative to the published interpreter, without build user paths.
    smoke.sysPath = smoke.sysPath.map(path => path.replaceAll(runtime, '<python>').replaceAll(cache, '<payload>'));
    const wheelReceipt = JSON.parse(await readFile(join(runtime, 'wheel-install-receipt.json'), 'utf8'));
    const files = [];
    for (const path of await filesUnder(runtime)) {
      const name = path.slice(runtime.length + 1).replaceAll('\\', '/');
      if (name.split('/').includes('__pycache__') || /\.(?:pyc|pyo)$/.test(name)) throw new Error('python_publish_bytecode_file');
      const size = (await stat(path)).size;
      files.push({ path: name, size, sha256: await sha256(path, size) });
    }
    const receipt = { schemaVersion: 1, python: PYTHON, lockSha256, recipeSha256, builtAt: new Date().toISOString(),
      runtimeLayout: 'vendor/python', packages: wheelReceipt.packages, publicCertificateBundle: wheelReceipt.publicCertificateBundle,
      siteHooks: wheelReceipt.siteHooks, smoke, files,
      note: 'Private CPython embed and locked wheels; no pip, global Python, developer venv, services, market requests, database connections or WeChat actions used.' };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    announce('python_vendor_ready', { version: PYTHON.version, packages: receipt.packages.length, files: files.length, bytes: files.reduce((n, file) => n + file.size, 0) });
  }
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.lockSha256 !== lockSha256) throw new Error('python_cached_receipt_lock_mismatch');
  for (const file of receipt.files) if (await sha256(join(runtime, file.path), file.size) !== file.sha256) throw new Error(`python_cached_payload_mismatch:${file.path}`);
  if (stageRoot) await copyPythonRuntime({ runtimeRoot: runtime, stageRoot, logFile });
  return { ...receipt, buildRuntimeRoot: runtime };
}

export async function copyPythonRuntime({ runtimeRoot, stageRoot, logFile } = {}) {
  if (!runtimeRoot || !stageRoot) throw new Error('python_copy_paths_required');
  const source = await realpath(runtimeRoot);
  const receipt = JSON.parse(await readFile(join(source, 'zhiyu-python-receipt.json'), 'utf8'));
  const target = join(await realpath(stageRoot), 'vendor', 'python');
  if (existsSync(target)) throw new Error('python_stage_destination_already_exists');
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: false, errorOnExist: true });
  for (const file of receipt.files) if (await sha256(join(target, file.path), file.size) !== file.sha256) throw new Error(`python_stage_copy_mismatch:${file.path}`);
  const temp = join(dirname(source), 'copy-smoke-temp');
  await mkdir(temp, { recursive: true });
  const output = await run(join(target, 'python.exe'), ['-I', '-B', helper, 'smoke', join(target, 'dependency-lock.json'), target], { cwd: dirname(source), env: cleanEnvironment(target, temp), logFile });
  announce('python_stage_copy_verified', { packages: receipt.packages.length, smokeConfirmed: output.includes('"ok": true') });
  return receipt;
}

// Maintainer-only lock generation. Dependency resolution is a separate explicit
// step; normal release builds never select newer Python or package versions.
async function lockFromInventory(inventoryPath, wheelsPath) {
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const destination = join(workspaceRoot, 'packaging', 'windows', 'python-source-wheels');
  await mkdir(destination, { recursive: true });
  const packages = [];
  for (const pkg of inventory) {
    const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/json`);
    if (!response.ok) throw new Error('python_pypi_metadata_unavailable');
    const release = await response.json();
    const wheel = release.urls.find(file => file.filename === pkg.filename);
    if (wheel) {
      if (wheel.digests.sha256 !== pkg.sha256) throw new Error('python_pypi_wheel_hash_mismatch');
      packages.push({ ...pkg, url: wheel.url });
    } else {
      if (!['jsonpath', 'pyexecjs'].includes(pkg.name.toLowerCase())) throw new Error('python_unreviewed_source_build');
      const source = release.urls.find(file => file.packagetype === 'sdist');
      if (!source) throw new Error('python_source_archive_missing');
      await copyFile(join(wheelsPath, pkg.filename), join(destination, pkg.filename));
      packages.push({ ...pkg, vendoredWheel: `packaging/windows/python-source-wheels/${pkg.filename}`,
        sourceArchive: { filename: source.filename, url: source.url, sha256: source.digests.sha256 },
        buildProvenance: 'Pure Python wheel built with pip in an isolated temporary build environment. Every non-metadata wheel payload file is rechecked byte-for-byte against the official SHA-pinned source archive at release time.' });
    }
  }
  const quantRequirements = await readFile(join(workspaceRoot, 'tools', 'quant-service', 'requirements.txt'));
  const lock = { schemaVersion: 1, generatedAt: new Date().toISOString(), python: PYTHON,
    quantRequirementsSha256: createHash('sha256').update(quantRequirements).digest('hex'),
    directRequirements: quantRequirements.toString('utf8').trim().split(/\r?\n/).concat(['pywin32==312', 'psutil==7.2.2']),
    allowedSitePth: ['pywin32.pth'], packages };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  announce('python_dependency_lock_written', { packages: packages.length });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--lock-from') await lockFromInventory(process.argv[3], process.argv[4]);
  else {
    const receipt = await buildPythonRuntime({ toolchain: join(workspaceRoot, 'output', 'windows-toolchain'), logFile: join(workspaceRoot, 'output', 'windows-toolchain', 'python-runtime-build.log') });
    announce('python_runtime_build_complete', { runtimeRoot: receipt.buildRuntimeRoot, lockSha256: receipt.lockSha256 });
  }
}
