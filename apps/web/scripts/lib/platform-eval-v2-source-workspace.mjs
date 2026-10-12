// Isolated evaluation workspace; no production source or credential writes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

export const EVAL_WORKSPACE_VERSION = 'platform-eval-source-workspace.v1';
export const REQUIRED_EVAL_WORKSPACE_SOURCE_PATHS = [
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'apps/web/package.json', 'apps/web/tsconfig.json',
  'apps/web/next.config.js', 'apps/web/scripts/start-local-development.mjs', 'apps/web/scripts/auth-bind-policy.mjs',
  'apps/web/scripts/serialize-dev-type-writes.mjs', 'apps/web/scripts/hidden-next-workers.mjs',
  'apps/web/app/(auth)/auth.ts', 'apps/web/lib/auth/request-boundary.ts', 'apps/web/app/api/identity/route.ts',
  'apps/web/app/api/workshops/[id]/workspace/route.ts', 'apps/web/lib/db/schema.ts',
  'apps/web/lib/db/client.ts', 'apps/web/lib/db/adapters/postgres.ts', 'apps/web/lib/db/migrations/meta/_journal.json',
];
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const fingerprint = value => digest(JSON.stringify(canonical(value)));
const fileHash = filename => digest(fs.readFileSync(filename));
const excluded = new Set(['node_modules', '.git', '.next', '.tmp', '.runtime', '.runtime-eval', '.data', '.cache', '.turbo', '.ux-smoke', 'coverage', 'test-results', 'playwright-report', '.venv', 'venv', '__pycache__']);
const inside = (folder, filename) => path.resolve(filename).startsWith(path.resolve(folder) + path.sep);
const cDrive = folder => /^c:[\\/]/iu.test(path.resolve(folder));
function safeSourcePath(root, relative) {
  if (typeof relative !== 'string' || relative.split(/[\\/]/u).some(part => !part || part === '..' || part.startsWith('.env') || excluded.has(part))
    || /(?:^|[\\/])(?:gold|cases|rubric|corpus|questions|results-template)\.(?:json|jsonl)$/iu.test(relative)) throw Error('evaluation_workspace_source_scope_invalid');
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute) || !fs.statSync(absolute).isFile() || !inside(fs.realpathSync(root), fs.realpathSync(absolute))) throw Error('evaluation_workspace_source_scope_invalid');
  return absolute;
}
function validateSourceHashes(sourceHashes) {
  if (!sourceHashes || REQUIRED_EVAL_WORKSPACE_SOURCE_PATHS.some(name => !Object.hasOwn(sourceHashes, name))
    || Object.values(sourceHashes).some(value => !/^[a-f0-9]{64}$/u.test(value))) throw Error('evaluation_workspace_source_pins_incomplete');
}
function normalizedTsconfig(filename) {
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (value.compilerOptions.tsBuildInfoFile && (!inside(path.dirname(filename),path.resolve(path.dirname(filename),value.compilerOptions.tsBuildInfoFile))
    || path.isAbsolute(value.compilerOptions.tsBuildInfoFile))) throw Error('evaluation_workspace_tsbuildinfo_outside_workspace');
  // These are generated representation fields only; all other compiler flags
  // and aliases must remain identical to the formal configuration.
  delete value.compilerOptions.tsBuildInfoFile;
  value.include = (value.include ?? []).filter(item => !/^\.tmp\/next-review-\d{2}\/(?:dev\/)?types\/\*\*\/\*\.ts$/u.test(item));
  return value;
}
function nextDependency(webDir, requireC = true) {
  const require = createRequire(path.join(webDir, 'package.json'));
  const packageFile = fs.realpathSync(require.resolve('next/package.json'));
  const nextRoot = path.dirname(packageFile), files = [];
  if (requireC && !cDrive(nextRoot)) throw Error('evaluation_workspace_requires_physical_C_next');
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw Error('evaluation_workspace_next_tree_symlink');
      if (item.isDirectory()) visit(filename);
      else if (item.isFile()) files.push({ path: path.relative(nextRoot, filename).replaceAll('\\','/'), sha256: fileHash(filename) });
    }
  }
  visit(nextRoot);
  const cli = fs.realpathSync(require.resolve('next/dist/bin/next'));
  if (!inside(nextRoot, cli)) throw Error('evaluation_workspace_next_cli_resolution_invalid');
  return { packageRoot: nextRoot, cliRealPath: cli, packageVersion: JSON.parse(fs.readFileSync(packageFile,'utf8')).version,
    packageJsonHash: fileHash(packageFile), nextPackageHash: fingerprint(files), fileCount: files.length,
    scope: 'complete physical Next package tree; other installed dependency entries retain their recorded junction topology' };
}
function assertNoEnvironmentFiles(root) {
  function visit(directory) {
    for (const item of fs.readdirSync(directory,{withFileTypes:true})) {
      if (item.name === 'node_modules' || item.name === '.tmp' || item.name === '.runtime-eval') continue;
      if (item.name.startsWith('.env')) throw Error('evaluation_workspace_contains_environment_file');
      if (item.isDirectory() && !item.isSymbolicLink()) visit(path.join(directory,item.name));
    }
  }
  visit(root);
}

/** No fixture launch or DB access. The provenance file is pinned by the run. */
export function verifyEvalSourceWorkspace({ provenanceFile, expectedWorkspaceHash, sourceHashes, formalRoot }) {
  const provenance = JSON.parse(fs.readFileSync(provenanceFile,'utf8')), {workspaceHash,...body} = provenance;
  if (!expectedWorkspaceHash || workspaceHash !== expectedWorkspaceHash || workspaceHash !== fingerprint(body)
    || body.schemaVersion !== EVAL_WORKSPACE_VERSION || body.purpose !== 'isolated_eval_source' || path.resolve(body.formalRoot) !== path.resolve(formalRoot)
    || !cDrive(body.repositoryRoot) || path.resolve(body.repositoryRoot) === path.resolve(formalRoot)
    || fingerprint(body.sourceHashes) !== fingerprint(sourceHashes)) throw Error('evaluation_workspace_provenance_invalid');
  validateSourceHashes(sourceHashes);
  const repositoryRoot = fs.realpathSync(body.repositoryRoot), webDir = path.join(repositoryRoot,'apps/web');
  if (!cDrive(repositoryRoot) || !inside(path.dirname(repositoryRoot), fs.realpathSync(provenanceFile))) throw Error('evaluation_workspace_realpath_invalid');
  for (const [relative, expected] of Object.entries(sourceHashes)) {
    const formal = safeSourcePath(formalRoot,relative), copy = safeSourcePath(repositoryRoot,relative);
    if (fileHash(formal) !== expected) throw Error('evaluation_workspace_formal_source_drift');
    if (relative === 'apps/web/tsconfig.json') {
      if (fingerprint(normalizedTsconfig(formal)) !== fingerprint(normalizedTsconfig(copy))) throw Error('evaluation_workspace_tsconfig_drift');
    } else if (fileHash(copy) !== expected) throw Error('evaluation_workspace_copy_source_drift');
  }
  assertNoEnvironmentFiles(repositoryRoot);
  if (fs.realpathSync(path.join(repositoryRoot,'node_modules'))!==body.dependencies.rootRealPath
    || fs.realpathSync(path.join(webDir,'node_modules'))!==body.dependencies.webRealPath) throw Error('evaluation_workspace_dependency_topology_drift');
  const dependency = nextDependency(webDir);
  if (fingerprint(dependency) !== fingerprint(body.nextDependency)) throw Error('evaluation_workspace_dependency_drift');
  const formalNext = nextDependency(path.join(formalRoot,'apps/web'),false);
  if (fingerprint(formalNext)!==fingerprint(body.formalNextDependency) || formalNext.nextPackageHash!==dependency.nextPackageHash) throw Error('evaluation_workspace_formal_next_dependency_drift');
  return { repositoryRoot,webDir,workspaceHash,expectedWorkspaceHash:workspaceHash,provenanceFile:path.resolve(provenanceFile),sourceFileCount:Object.keys(sourceHashes).length,
    nextDependency:dependency,formalRoot:path.resolve(formalRoot),sourceHashes,verificationScope:'source/Next pins only; database identity and runtime readiness are checked separately' };
}

/** Creates a NEW C evaluation copy. Never edits the recovery source/artifact. */
export function prepareEvalSourceWorkspace({templateRoot,targetRoot,sourceHashes,formalRoot,dependencyRoot,webDependencyRoot}) {
  validateSourceHashes(sourceHashes);
  if (!cDrive(templateRoot) || !cDrive(fs.realpathSync(templateRoot)) || fs.lstatSync(templateRoot).isSymbolicLink()
    || !cDrive(targetRoot) || fs.existsSync(targetRoot) || inside(templateRoot,targetRoot)) throw Error('evaluation_workspace_new_C_target_required');
  fs.mkdirSync(path.dirname(targetRoot),{recursive:true});
  if (!cDrive(fs.realpathSync(path.dirname(targetRoot)))) throw Error('evaluation_workspace_new_C_target_required');
  const rootDependencies=fs.realpathSync(dependencyRoot??path.join(templateRoot,'node_modules'));
  const webDependencies=fs.realpathSync(webDependencyRoot??path.join(templateRoot,'apps/web/node_modules'));
  if (!cDrive(rootDependencies) || !cDrive(webDependencies)) throw Error('evaluation_workspace_dependency_root_must_stay_C');
  for (const [relative,expected] of Object.entries(sourceHashes)) if (fileHash(safeSourcePath(formalRoot,relative))!==expected) throw Error('evaluation_workspace_formal_source_drift');
  fs.cpSync(templateRoot,targetRoot,{recursive:true,dereference:false,filter:candidate=>!path.relative(templateRoot,candidate).split(path.sep).some(part=>excluded.has(part)||part.startsWith('.env')||part.endsWith('.tsbuildinfo'))});
  const canonicalTarget=fs.realpathSync(targetRoot);
  if (!cDrive(canonicalTarget)||fs.lstatSync(targetRoot).isSymbolicLink()) throw Error('evaluation_workspace_target_realpath_invalid');
  for (const [relative,expected] of Object.entries(sourceHashes)) {
    const target=path.resolve(targetRoot,relative);
    if (!inside(targetRoot,target)) throw Error('evaluation_workspace_source_scope_invalid');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    if (!inside(canonicalTarget,fs.realpathSync(path.dirname(target))) && fs.realpathSync(path.dirname(target))!==canonicalTarget
      || fs.existsSync(target) && !inside(canonicalTarget,fs.realpathSync(target))) throw Error('evaluation_workspace_target_source_symlink');
    fs.copyFileSync(safeSourcePath(formalRoot,relative),target);
    if (fileHash(target)!==expected) throw Error('evaluation_workspace_source_copy_failed');
  }
  fs.symlinkSync(rootDependencies,path.join(targetRoot,'node_modules'),'junction');
  fs.symlinkSync(webDependencies,path.join(targetRoot,'apps/web/node_modules'),'junction');
  const next=nextDependency(path.join(targetRoot,'apps/web'));
  const formalNext=nextDependency(path.join(formalRoot,'apps/web'),false);
  if (formalNext.nextPackageHash!==next.nextPackageHash) throw Error('evaluation_workspace_formal_next_dependency_drift');
  const body={schemaVersion:EVAL_WORKSPACE_VERSION,purpose:'isolated_eval_source',createdAt:new Date().toISOString(),templateRoot:path.resolve(templateRoot),repositoryRoot:path.resolve(targetRoot),formalRoot:path.resolve(formalRoot),
    sourceHashes,nextDependency:next,formalNextDependency:formalNext,dependencies:{rootRealPath:rootDependencies,webRealPath:webDependencies,retainedUntilEvaluationCleanup:true},environmentFilesCopied:false,productionRecoveryCopyModified:false,
    generatedRepresentationExceptions:['tsconfig tsBuildInfoFile','Next generated review types include','next-env.d.ts'],protectedFormalSourceUnmodified:true};
  const provenance={...body,workspaceHash:fingerprint(body)},provenanceFile=path.join(path.dirname(targetRoot),'eval-source-workspace.json');
  fs.writeFileSync(provenanceFile,JSON.stringify(provenance,null,2)+'\n',{flag:'wx',encoding:'utf8'});
  return verifyEvalSourceWorkspace({provenanceFile,expectedWorkspaceHash:provenance.workspaceHash,sourceHashes,formalRoot});
}

export function validateIsolatedHttpDatabaseUrl(databaseUrl) {
  const target=new URL(databaseUrl);
  if (!['postgres:','postgresql:'].includes(target.protocol) || !['127.0.0.1','localhost','[::1]'].includes(target.hostname)
    || target.search || target.hash || !target.username || !/^\/zhiyu_test_[a-f0-9]{32}$/u.test(target.pathname)) throw Error('http_fixture_database_scope_invalid');
  return {url:target.toString(),databaseName:target.pathname.slice(1)};
}
