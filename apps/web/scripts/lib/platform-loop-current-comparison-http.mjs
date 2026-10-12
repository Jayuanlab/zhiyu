import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyEvalSourceWorkspace } from './platform-eval-v2-source-workspace.mjs';

const formalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const permittedOsEnvironment = ['SystemRoot', 'WINDIR', 'windir', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP',
  'LOCALAPPDATA', 'APPDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'LANG'];
const permittedJevEnvironment = new Set(['BRAIN_JEV_ROUTING', 'BRAIN_JEV_MODE', 'BRAIN_JEV_TARGETED_RETRY', 'TYPESAFE_API_KEY']);
/** Reject URL startup parameters before spawning anything. postgres query
 * parameters can override the pathname/hostname after URL parsing. */
export function parseLoopCurrentDatabaseUrl(databaseUrl, expectedDatabase) {
  let db; try { db = new URL(databaseUrl); } catch { throw Error('Invalid isolated database URL'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.search || db.hash
    || !['localhost', '127.0.0.1', '[::1]'].includes(db.hostname)) throw Error('Explicit isolated PostgreSQL target required');
  const name = db.pathname.slice(1);
  if (!/^zhiyu_test_[a-f0-9]{32}$/.test(name) || (expectedDatabase && name !== expectedDatabase)) throw Error('Explicit isolated test DB required');
  return db;
}
export function parseLoopCurrentAdminUrl(databaseUrl) {
  let db; try { db = new URL(databaseUrl); } catch { throw Error('Invalid isolated administration URL'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.search || db.hash
    || !['localhost', '127.0.0.1', '[::1]'].includes(db.hostname)) throw Error('Explicit loopback PostgreSQL administration required');
  db.pathname = '/postgres'; return db;
}
/** @param {{databaseUrl:string,ownerId:string,appHome:string,mode:string,provider:any,reviewBuild:string,sourceWorkspace?:any,jevEnvironment?:Record<string,string>,observerProxyBaseUrl?:string}} input */
export async function startLoopCurrentHttp({ databaseUrl, ownerId, appHome, mode, provider, reviewBuild, sourceWorkspace = undefined, jevEnvironment = {}, observerProxyBaseUrl = undefined }) {
  parseLoopCurrentDatabaseUrl(databaseUrl);
  if (!['off', 'enforce_critical'].includes(mode) || !/^\d{2}$/.test(reviewBuild) || !path.isAbsolute(appHome)) throw Error('Invalid isolated native mode/profile');
  if (!provider?.apiKey || !provider.baseUrl || !provider.model || !['anthropic-messages', 'openai-completions', 'openai-responses'].includes(provider.protocol)) throw Error('A locked real provider config is required');
  if (!sourceWorkspace?.provenanceFile || !sourceWorkspace.workspaceHash || !sourceWorkspace.sourceHashes) throw Error('Verified C source-copy workspace required');
  const workspace = verifyEvalSourceWorkspace({ provenanceFile: sourceWorkspace.provenanceFile,
    expectedWorkspaceHash: sourceWorkspace.workspaceHash, sourceHashes: sourceWorkspace.sourceHashes, formalRoot });
  if (workspace.repositoryRoot !== sourceWorkspace.repositoryRoot || workspace.webDir !== sourceWorkspace.webDir) throw Error('Workspace descriptor drift');
  const homeRelative = path.relative(workspace.repositoryRoot, appHome);
  if (!homeRelative.startsWith('.runtime-eval' + path.sep) || homeRelative.split(path.sep).includes('..')) throw Error('Synthetic C workspace profile required');
  if (Object.keys(jevEnvironment).some(key => !permittedJevEnvironment.has(key))) throw Error('Unsupported model environment key');
  const childEnvironment = Object.fromEntries(permittedOsEnvironment.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
  const observerModule = path.join(workspace.webDir, 'scripts/lib/platform-loop-current-comparison-fetch-observer.mjs');
  const observerArguments = observerProxyBaseUrl ? ['--import', pathToFileURL(observerModule).href] : [];
  const observerEnvironment = observerProxyBaseUrl ? { ZHIYU_EVAL_MAIN_FETCH_UPSTREAM: provider.baseUrl,
    ZHIYU_EVAL_MAIN_FETCH_PROXY: observerProxyBaseUrl, ZHIYU_EVAL_MAIN_FETCH_MODEL: provider.model,
    ZHIYU_EVAL_MAIN_FETCH_PROTOCOL: provider.protocol } : {};
  const child = spawn(process.execPath, [...observerArguments, 'scripts/start-local-development.mjs', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: workspace.webDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...childEnvironment, ...jevEnvironment, NODE_ENV: 'development', AUTH_MODE: 'local_owner', DEV_USER_ID: ownerId,
      POSTGRES_URL: databaseUrl, DATABASE_URL: databaseUrl, ZHIYU_TEST_DATABASE_URL: databaseUrl,
      ZHIYU_TEST_MODE: 'integration', USERPROFILE: appHome, TAURI_MODE: 'false', IS_TAURI: 'false',
      ENABLE_LOCAL_SCHEDULER: 'false', ENABLE_STARTUP_LISTENERS: 'false',
      ZHIYU_REVIEW_BUILD: reviewBuild, ANSWER_EVIDENCE_MODE: mode,
      LLM_API_KEY: provider.apiKey, LLM_BASE_URL: provider.baseUrl, LLM_MODEL: provider.model,
      PI_AGENT_PROTOCOL: provider.protocol, PI_AGENT_API_KEY: provider.apiKey,
      PI_AGENT_BASE_URL: provider.baseUrl, PI_AGENT_MODEL: provider.model, ...observerEnvironment },
  });
  let exited = false; child.once('exit', () => { exited = true; });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const stop = async () => { if (!exited) child.kill('SIGTERM'); const until = Date.now() + 10000; while (!exited && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100)); if (!exited) throw Error('Isolated native HTTP process did not stop'); };
  try {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      if (exited) throw Error('Isolated native HTTP exited before startup');
      const ready = await new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); socket.setTimeout(500); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); }); });
      if (ready) return { origin: `http://127.0.0.1:${port}`, mode, reviewBuild, workspaceHash: workspace.workspaceHash, repositoryRoot: workspace.repositoryRoot, stop };
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error('Isolated native HTTP startup timeout');
  } catch (error) { await stop(); throw error; }
}
