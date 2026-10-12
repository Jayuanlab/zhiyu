import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { verifyEvalSourceWorkspace, validateIsolatedHttpDatabaseUrl } from './platform-eval-v2-source-workspace.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A real Next HTTP process, with its own loopback-only test database and home. */
export async function startIsolatedPlatformHttpServer({ databaseUrl, ownerId, appHome, reviewBuild = '97', sourceWorkspace }) {
  if (!sourceWorkspace) throw Error('Explicit verified C source workspace is required');
  const verifiedWorkspace = verifyEvalSourceWorkspace(sourceWorkspace);
  const db = validateIsolatedHttpDatabaseUrl(databaseUrl);
  if (!/^[0-9a-f-]{36}$/i.test(ownerId) || !path.isAbsolute(appHome)) throw Error('Invalid HTTP fixture owner or home');
  if (!path.resolve(appHome).startsWith(verifiedWorkspace.repositoryRoot + path.sep)) throw Error('HTTP fixture home must stay in C evaluation workspace');
  if (!/^\d{2}$/.test(reviewBuild)) throw Error('Invalid isolated review build identity');
  const connection = postgres(db.url,{max:1,connect_timeout:5,idle_timeout:2,onnotice:()=>{}});
  try { const [actual] = await connection`SELECT current_database() AS database`; if (actual.database !== db.databaseName) throw Error('HTTP fixture actual database does not match target'); }
  finally { await connection.end({timeout:5}); }
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const address = socket.address(); socket.close(() => resolve(address.port)); });
  });
  const fixtureEnvironment = { ...process.env };
  for (const key of Object.keys(fixtureEnvironment)) if (/(?:OPENAI|ANTHROPIC|TYPESAFE|PI_AGENT|GEMINI|OPENROUTER|AI_GATEWAY|LLM).*(?:KEY|TOKEN)$/iu.test(key)) fixtureEnvironment[key] = '';
  const child = spawn(process.execPath, ['scripts/start-local-development.mjs', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: verifiedWorkspace.webDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...fixtureEnvironment, NODE_ENV: 'development', AUTH_MODE: 'local_owner', DEV_USER_ID: ownerId,
      POSTGRES_URL: databaseUrl, DATABASE_URL: databaseUrl, ZHIYU_TEST_DATABASE_URL: databaseUrl,
      ZHIYU_TEST_MODE: 'integration', USERPROFILE: appHome, TAURI_MODE: 'false', IS_TAURI: 'false',
      ZHIYU_REVIEW_BUILD: reviewBuild, ANSWER_EVIDENCE_MODE: 'off',
      ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',ZHIYU_RUNTIME_MODE:'disabled',
      BRAIN_JEV_ROUTING:'off',BRAIN_JEV_MODE:'off',BRAIN_JEV_TARGETED_RETRY:'false' },
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  // Drain pipes without emitting credentials or making logs an authority source.
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const stop = async () => {
    if (!exited) child.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (!exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!exited) throw Error('Isolated HTTP process did not stop');
    verifyEvalSourceWorkspace(sourceWorkspace);
  };
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (exited) throw Error('Isolated Next HTTP server exited before startup');
      const listening = await new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.setTimeout(500);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
      });
      if (listening) return { origin: `http://127.0.0.1:${port}`, stop, sourceWorkspace: verifiedWorkspace,
        databaseIdentity: { expected:db.databaseName,actual:db.databaseName,checkedBeforeStartup:true },
        generationScope: {webDir:verifiedWorkspace.webDir,reviewBuild,appHome,originalDWorkspaceUsed:false} };
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error('Isolated Next HTTP startup timed out');
  } catch (error) { await stop(); throw error; }
}
