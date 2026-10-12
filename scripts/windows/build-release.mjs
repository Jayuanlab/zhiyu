import { copyFile, mkdir, readFile, readdir, rename, writeFile, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkerBundle } from './build-worker.mjs';
import { adaptStandaloneEntrypoint, assertWithin, cleanBuildEnvironment, collectTracedPackages, copyDependencyClosure, copyReleaseTree, resolvePackage, run, safeReleaseFile, sha256, writeReleaseManifest } from './release-lib.mjs';

const workspaceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = new Set(process.argv.slice(2));
const webRoot = join(workspaceRoot, 'apps', 'web');
const outputRoot = join(workspaceRoot, 'output', 'windows-installer');
const toolchain = join(workspaceRoot, 'output', 'windows-toolchain');
const version = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')).version;
const withComponents = args.has('--with-components');
const stageRoot = join(outputRoot, `payload-${version}${withComponents ? '-components' : ''}`);
const buildRoot = join(webRoot, '.tmp', 'next-windows-distribution');
const require = createRequire(join(webRoot, 'package.json'));
const env = cleanBuildEnvironment(workspaceRoot);
// Build-time only: a relocated dist directory has no source-tree ancestors.
// Application processes use a separate allowlisted runtime environment.
env.NODE_PATH = [join(webRoot,'node_modules'),join(workspaceRoot,'node_modules')].join(delimiter);
for (const target of [outputRoot, toolchain, stageRoot, buildRoot]) assertWithin(workspaceRoot, target);
await mkdir(outputRoot, { recursive: true }); await mkdir(toolchain, { recursive: true });
const logFile = join(outputRoot, 'build.log');
function announce(event, details = {}) { console.log(JSON.stringify({ event, ...details })); }

async function download(url, file) {
  if (existsSync(file)) return;
  announce('download', { file: file.split(/[\\/]/).at(-1) });
  await run('curl.exe', ['--fail','--location','--retry','3','--silent','--show-error','--output',`${file}.partial`,url], { logFile });
  const { rename } = await import('node:fs/promises'); await rename(`${file}.partial`, file);
}
async function vendors() {
  const nodeArchive = join(toolchain, 'node-v24.14.1-win-x64.zip');
  const pgArchive = join(toolchain, 'postgresql-16.14-1-windows-x64-binaries.zip');
  const sums = join(toolchain, 'node-SHASUMS256.txt');
  await download('https://nodejs.org/dist/v24.14.1/node-v24.14.1-win-x64.zip', nodeArchive);
  await download('https://nodejs.org/dist/v24.14.1/SHASUMS256.txt', sums);
  const expected = (await readFile(sums, 'utf8')).split(/\r?\n/).find(line => line.endsWith('  node-v24.14.1-win-x64.zip'))?.split(/\s+/)[0];
  if (!expected || expected !== await sha256(nodeArchive)) throw new Error('node_vendor_checksum_mismatch');
  await download('https://get.enterprisedb.com/postgresql/postgresql-16.14-1-windows-x64-binaries.zip', pgArchive);
  const pgExpected = '98af1417ba6a8dc30543e560e5407833a3b9e7cc7ed20e73b2006f3aa2f04663';
  if (await sha256(pgArchive) !== pgExpected) throw new Error('postgres_vendor_checksum_mismatch');
  const extraction = join(toolchain, 'extracted'); await mkdir(extraction, { recursive: true });
  if (!existsSync(join(extraction,'node-v24.14.1-win-x64','node.exe'))) await run('tar.exe',['-xf',nodeArchive,'-C',extraction,'node-v24.14.1-win-x64/node.exe','node-v24.14.1-win-x64/LICENSE'],{logFile});
  if (!existsSync(join(extraction,'pgsql','bin','pg_ctl.exe'))) await run('tar.exe',['-xf',pgArchive,'-C',extraction,'pgsql/bin','pgsql/share','pgsql/lib'],{logFile});
  const pgRoot = join(extraction,'pgsql');
  const vectorFiles = ['lib/vector.dll','share/extension/vector.control','share/extension/vector--0.8.7.sql','share/doc/pgvector/LICENSE','share/doc/pgvector/zhiyu-build.json'];
  if (vectorFiles.some(file => !existsSync(join(pgRoot,file)))) {
    await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(workspaceRoot,'scripts','windows','build-pgvector.ps1'),'-PgRoot',pgRoot,'-PostgresArchive',pgArchive,'-ToolchainDirectory',toolchain],{logFile});
  }
  for (const file of vectorFiles) if (!existsSync(join(pgRoot,file))) throw new Error(`pgvector_vendor_missing:${file}`);
  await mkdir(join(stageRoot,'vendor','node'), {recursive:true});
  await copyFile(join(extraction,'node-v24.14.1-win-x64','node.exe'),join(stageRoot,'vendor','node','node.exe'));
  await copyFile(join(extraction,'node-v24.14.1-win-x64','LICENSE'),join(stageRoot,'vendor','node','LICENSE'));
  await copyReleaseTree(pgRoot,join(stageRoot,'vendor','postgres'));
  return { node: {version:'24.14.1',sha256:expected,source:'https://nodejs.org/dist/v24.14.1/'},postgres:{version:'16.14-1',sha256:pgExpected,source:'https://www.enterprisedb.com/download-postgresql-binaries',verification:'official HTTPS archive; pinned SHA-256'},pgvector:{version:'0.8.7',source:'https://github.com/pgvector/pgvector',receipt:JSON.parse(await readFile(join(pgRoot,'share/doc/pgvector/zhiyu-build.json'),'utf8'))} };
}

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('windows_x64_build_host_required');
if (!args.has('--compile-only')) {
let reusedDependencies;
if(args.has('--refresh-app')||args.has('--refresh-worker')){
  const previous=JSON.parse(await readFile(join(stageRoot,'release-manifest.json'),'utf8'));
  const receipt=JSON.parse(await readFile(join(stageRoot,'THIRD-PARTY-PACKAGES.json'),'utf8'));
  if(previous.version!==version||previous.platform!=='win32-x64'||!receipt.packages?.length)throw new Error('refresh_app_existing_payload_required');
  reusedDependencies=receipt;
  for(const directory of args.has('--refresh-worker')?['worker','migrations']:['app','worker','migrations']){
    const source=join(stageRoot,directory),target=join(outputRoot,`previous-${directory}-${Date.now()}`);
    assertWithin(outputRoot,source);assertWithin(outputRoot,target);
    if(existsSync(source))await rename(source,target);
  }
  announce(args.has('--refresh-worker')?'worker_refresh_started':'application_refresh_started',{preservedNpmPackages:receipt.packages.length});
}
if (existsSync(stageRoot) && !args.has('--reuse-stage') && !reusedDependencies) {
  const { rename } = await import('node:fs/promises');
  await rename(stageRoot, `${stageRoot}-previous-${Date.now()}`);
}
await mkdir(stageRoot,{recursive:true});
if (!args.has('--reuse-web')&&!args.has('--refresh-worker')) {
  announce('web_build_started', { isolatedOutput: buildRoot });
  // The distribution has its own tsconfig; restore the shared Next hint only if
  // it is exactly Next's generated replacement for our isolated build directory.
  const hintPath = join(webRoot,'next-env.d.ts');
  const hint = await readFile(hintPath);
  const generatedHint = hint.toString('utf8').replace(/import "\.\/[^"\r\n]*\/types\/routes\.d\.ts";/, 'import "./.tmp/next-windows-distribution/types/routes.d.ts";');
  try { await run(process.execPath,['--require',join(workspaceRoot,'scripts','windows','next-trace-boundary.cjs'),require.resolve('next/dist/bin/next'),'build','--webpack'],{cwd:webRoot,env,logFile}); }
  finally {
    const current=await readFile(hintPath);
    if (current.toString('utf8') === generatedHint && !current.equals(hint)) await writeFile(hintPath,hint);
    else if (!current.equals(hint)) announce('shared_next_hint_changed_preserved',{path:hintPath});
  }
  announce('web_build_completed');
}
if (!existsSync(join(buildRoot,'standalone','apps','web','server.js'))) throw new Error('standalone_web_build_missing');
const nextBuildId = (await readFile(join(buildRoot,'BUILD_ID'),'utf8')).trim();
if(args.has('--refresh-worker')){
  const packagedId=(await readFile(join(stageRoot,'app','apps','web','.tmp','next-windows-distribution','BUILD_ID'),'utf8')).trim();
  if(packagedId!==nextBuildId)throw new Error('refresh_worker_web_build_id_mismatch');
}else{
announce('web_payload_copy_started');
await copyReleaseTree(join(buildRoot,'standalone'),join(stageRoot,'app'),{omitModules:true});
await writeFile(join(stageRoot,'app','apps','web','package.json'),JSON.stringify({name:'zhiyu-web-distribution',version,type:'module',private:true},null,2)+'\n');
await adaptStandaloneEntrypoint(join(stageRoot,'app','apps','web','server.js'),join(stageRoot,'app','apps','web','package.json'));
await copyReleaseTree(join(buildRoot,'static'),join(stageRoot,'app','apps','web','.tmp','next-windows-distribution','static'));
await copyReleaseTree(join(webRoot,'public'),join(stageRoot,'app','apps','web','public'));
await copyReleaseTree(join(workspaceRoot,'manifests'),join(stageRoot,'app','manifests'));
await copyReleaseTree(join(workspaceRoot,'skills'),join(stageRoot,'app','skills'));
const sourceReader=await readFile(join(webRoot,'lib','ai','platform-source-reader.ts'),'utf8');
const catalog=sourceReader.match(/export const PLATFORM_SOURCE_FILES = \{([\s\S]*?)\} as const;/)?.[1];
const resourceFiles=[...(catalog||'').matchAll(/:\s*"([^"\r\n]+)"/g)].map(match=>match[1]);
const reviewedResourceFiles = new Set([
  'docs/architecture/zhiyu-control-architecture-contract.md', 'docs/adr/0001-scope-memory-recall-policy.md',
  'apps/web/lib/brain/policy.ts', 'apps/web/lib/brain/types.ts', 'apps/web/lib/brain/context.ts',
  'apps/web/lib/brain/recall-planner.ts', 'apps/web/lib/brain/service.ts', 'apps/web/lib/brain/evidence-reader.ts',
  'apps/web/lib/ai/runtime/tool-executor.ts', 'docs/architecture/workshop-workspace-model.md',
  'apps/web/lib/workshops/runtime-run-snapshot.ts',
  'docs/architecture/engineering-cybernetics-guiding-principles.md', 'skills/agent-evolution/SKILL.md',
  'apps/web/lib/brain/query-retry.ts', 'apps/web/lib/loops/document-artifact-verifier.ts',
  'apps/web/lib/workshops/codebase-read.ts', 'manifests/workshops/paper-trader.workshop.yaml',
  'manifests/workshops/watchlist-hunter.workshop.yaml', 'apps/web/lib/quant/control-guards.ts',
]);
if(resourceFiles.length!==reviewedResourceFiles.size || new Set(resourceFiles).size!==resourceFiles.length
  || resourceFiles.some(file=>!reviewedResourceFiles.has(file)))throw new Error('platform_source_catalog_requires_review');
for(const file of resourceFiles){
  const source=join(workspaceRoot,file),target=join(stageRoot,'app',file);
  assertWithin(workspaceRoot,source);assertWithin(join(stageRoot,'app'),target);
  if(file.startsWith('.')||file.includes('..')||!safeReleaseFile(file))throw new Error('platform_source_catalog_path_invalid');
  await mkdir(dirname(target),{recursive:true});await copyFile(source,target);
}
}
// Webpack emitted this subtree as CommonJS because the isolated dist has no
// source package manifest. The ESM standalone wrapper remains in the app scope.
await writeFile(join(stageRoot,'app','apps','web','.tmp','next-windows-distribution','server','package.json'),JSON.stringify({type:'commonjs',private:true})+'\n');
announce('worker_build_started');
const worker = await buildWorkerBundle({workspaceRoot,stageRoot});
const externals = new Map();
for (const name of ['next','react','react-dom']) { const pkg=resolvePackage(name,join(webRoot,'package.json')); externals.set(pkg.root,pkg); }
for (const pkg of await collectTracedPackages(buildRoot)) externals.set(pkg.root,pkg);
const workerAliases=[];
for (const record of worker.externalDependencies) {
  const pkg=resolvePackage(record.packageName,record.resolveOrigin);
  if(!externals.has(pkg.root))externals.set(pkg.root,pkg);
  if(record.releasePackageName)workerAliases.push({...pkg,releasePackageName:record.releasePackageName});
}
let dependencies;
if(reusedDependencies){
  const known=new Set(reusedDependencies.packages.map(pkg=>`${pkg.name}@${pkg.version}`));
  for(const pkg of [...externals.values(),...workerAliases]){
    if(!known.has(`${pkg.data.name}@${pkg.data.version}`))throw new Error(`refresh_app_dependency_changed:${pkg.data.name}`);
  }
  for(const pkg of workerAliases){
    const installed=JSON.parse(await readFile(join(stageRoot,'node_modules',...pkg.releasePackageName.split('/'),'package.json'),'utf8'));
    if(installed.name!==pkg.data.name||installed.version!==pkg.data.version)throw new Error('refresh_app_worker_alias_mismatch');
  }
  dependencies={packages:reusedDependencies.packages,packageCount:reusedDependencies.packages.length,copiedDirectories:null};
  announce('dependencies_reused',{packageCount:dependencies.packageCount});
}else{
  announce('dependencies_copy_started',{entryPackages:externals.size});
  dependencies=await copyDependencyClosure([...externals.values(),...workerAliases],join(stageRoot,'node_modules'));
}
await writeFile(join(stageRoot,'worker','bundle-meta.json'),JSON.stringify({schemaVersion:1,nodeConditions:['react-server'],externalPackages:[...new Set(worker.externalDependencies.map(x=>x.packageName))],migrationCount:worker.migrations.migrationCount},null,2)+'\n');
announce('dependencies_copy_completed',{packageCount:dependencies.packageCount,copiedDirectories:dependencies.copiedDirectories});
const vendorReceipt=reusedDependencies?.vendors||await vendors();
await mkdir(join(stageRoot,'runtime'),{recursive:true});
for (const file of ['manager.mjs','security.mjs','web-host.mjs','setup.html','setup.js','components.mjs']) {
  await copyFile(join(workspaceRoot,'packaging','windows','runtime',file),join(stageRoot,'runtime',file));
}
await copyFile(join(workspaceRoot,'LICENSE'),join(stageRoot,'LICENSE'));
if (args.has('--prepare-app-only')) {
  announce('application_payload_prepared', { stageRoot, nextBuildId, componentsPending: withComponents });
  process.exit(0);
}
if (withComponents) {
  announce('private_python_build_started');
  const { buildPythonRuntime, copyPythonRuntime } = await import('./build-python-runtime.mjs');
  const { verifyPythonRuntime } = await import('./verify-python-runtime.mjs');
  const pythonReceipt = await buildPythonRuntime({ toolchain, logFile });
  await verifyPythonRuntime({ runtimeRoot: pythonReceipt.buildRuntimeRoot });
  const pythonTarget = join(await realpath(stageRoot), 'vendor', 'python');
  if (existsSync(pythonTarget)) {
    if (await sha256(join(pythonTarget, 'zhiyu-python-receipt.json')) !== await sha256(join(pythonReceipt.buildRuntimeRoot, 'zhiyu-python-receipt.json'))) throw new Error('existing_python_runtime_receipt_mismatch');
  } else await copyPythonRuntime({ runtimeRoot: pythonReceipt.buildRuntimeRoot, stageRoot: await realpath(stageRoot), logFile });
  await verifyPythonRuntime({ runtimeRoot: pythonTarget });
  announce('wechat_reader_build_started');
  const { buildWechatReader } = await import('./build-wechat-reader.mjs');
  const readerReceipt = await buildWechatReader({ toolchain, stageRoot: await realpath(stageRoot), logFile });
  const withoutHostPaths = value => Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:buildRuntimeRoot|buildRoot|runtimeRoot|cacheRoot|sourceRoot|toolchainRoot|physicalRoot)$/.test(key)));
  vendorReceipt.python = withoutHostPaths(pythonReceipt);
  vendorReceipt.wechatReader = withoutHostPaths(readerReceipt);
  const quantRoot = join(stageRoot, 'components', 'quant');
  await mkdir(join(quantRoot, 'scripts'), { recursive: true });
  await copyReleaseTree(join(workspaceRoot, 'tools', 'quant-service', 'app'), join(quantRoot, 'app'));
  for (const file of ['embedded_worker.py', 'requirements.txt', 'README.md']) await copyFile(join(workspaceRoot, 'tools', 'quant-service', file), join(quantRoot, file));
  await copyFile(join(workspaceRoot, 'tools', 'quant-service', 'scripts', 'install_bootstrap.py'), join(quantRoot, 'scripts', 'install_bootstrap.py'));
  await mkdir(join(quantRoot, 'config'), { recursive: true });
  for (const file of ['paper-calendar-2026.json', 'paper-market-policy.json']) await copyFile(join(workspaceRoot, 'tools', 'quant-service', 'config', file), join(quantRoot, 'config', file));
  const astockRoot = join(stageRoot, 'components', 'a-stock-data'); await mkdir(astockRoot, { recursive: true });
  for (const file of ['a_stock_data.py', 'cli.py', 'NOTICE.md']) await copyFile(join(workspaceRoot, 'apps', 'web', 'tools', 'a-stock-data', file), join(astockRoot, file));
  const wechatRoot = join(stageRoot, 'components', 'wechat'); await mkdir(wechatRoot, { recursive: true });
  for (const file of ['server.py', 'send_ledger.py', 'dispatch_lock.py', 'bootstrap-reader.ps1', 'README.md', 'SECURITY.md', 'DISCLAIMER.md', 'requirements.txt']) await copyFile(join(workspaceRoot, 'tools', 'wechat-desktop-service', file), join(wechatRoot, file));
}
await writeFile(join(stageRoot,'component-manifest.json'), JSON.stringify({schemaVersion:1,quant:withComponents,wechat:withComponents,python:withComponents})+'\n');
await writeFile(join(stageRoot,'THIRD-PARTY-PACKAGES.json'),JSON.stringify({schemaVersion:1,packages:dependencies.packages,vendors:vendorReceipt},null,2)+'\n');
await writeFile(join(stageRoot,'package.json'),JSON.stringify({name:'zhiyu-windows-distribution',version,type:'module',private:true},null,2)+'\n');
announce('launcher_build_started');
await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(workspaceRoot,'scripts','windows','build-launcher.ps1'),'-OutputDirectory',stageRoot,'-ReleaseVersion',version],{logFile});
  await writeReleaseManifest(await realpath(stageRoot),{product:'Zhiyu',version,platform:'win32-x64',builtAt:new Date().toISOString(),nextBuildId,vendors:vendorReceipt,optionalComponents:{wechat:withComponents,quant:withComponents,python:withComponents},note:withComponents?'Desktop Web, private Python quant module, private WeChat reader and reviewed desktop sender. WeChat data access requires explicit user initialization.':'Base desktop Web and single-owner worker. Optional Python services are not bundled in this release.'},{onProgress:(completed,total)=>announce('manifest_progress',{completed,total})});
} else {
  const manifest=JSON.parse(await readFile(join(stageRoot,'release-manifest.json'),'utf8'));
  const packaged=JSON.parse(await readFile(join(stageRoot,'package.json'),'utf8'));
  if (manifest.version!==version||packaged.version!==version||manifest.platform!=='win32-x64'||!manifest.files?.length) throw new Error('existing_payload_manifest_mismatch');
  if ((manifest.optionalComponents?.quant === true) !== withComponents || (manifest.optionalComponents?.wechat === true) !== withComponents) throw new Error('existing_payload_component_flags_mismatch');
  if ((await readFile(join(stageRoot,'app','apps','web','.tmp','next-windows-distribution','BUILD_ID'),'utf8')).trim() !== manifest.nextBuildId) throw new Error('existing_payload_web_build_id_mismatch');
  for (const file of ['Zhiyu.exe','vendor/node/node.exe','vendor/postgres/bin/pg_ctl.exe','vendor/postgres/lib/vector.dll','runtime/manager.mjs','worker/start-runtime-worker.mjs','migrations/migrate.mjs','app/apps/web/server.js']) {
    if (!existsSync(join(stageRoot,file))) throw new Error(`existing_payload_required_file_missing:${file}`);
  }
  announce('existing_payload_compile',{stageRoot,fileCount:manifest.files.length,nextBuildId:manifest.nextBuildId});
}
const iscc=process.env.ZHIYU_ISCC_PATH||join(toolchain,'inno7','ISCC.exe');
if (!existsSync(iscc)) throw new Error('inno_compiler_missing_set_ZHIYU_ISCC_PATH');
const compilerVersion=(await run(iscc,['--version'],{logFile})).trim();
if (!/^7\.\d+\.\d+\s*$/.test(compilerVersion)) throw new Error('inno_7_required_for_portable_long_paths');
announce('installer_compile_started');
await run(iscc,[`/DPayloadDir=${await realpath(stageRoot)}`,`/DReleaseVersion=${version}`,`/DOutputDir=${await realpath(outputRoot)}`,join(workspaceRoot,'packaging','windows','installer.iss')],{logFile});
const installer=join(outputRoot,`Zhiyu-Setup-${version}-x64.exe`);
if (!existsSync(installer)) throw new Error('installer_output_missing');
const installerSha256=await sha256(installer);
await writeFile(`${installer}.sha256`,`${installerSha256}  ${installer.split(/[\\/]/).at(-1)}\n`);
announce('installer_completed',{installer,sha256:installerSha256,bytes:(await stat(installer)).size,stageRoot});
