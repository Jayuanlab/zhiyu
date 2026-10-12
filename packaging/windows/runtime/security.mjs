import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createServer } from 'node:net';

export const freshToken = () => randomBytes(32).toString('base64url');
export const isoNow = () => new Date().toISOString();

export function constantEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('invalid_saved_configuration');
  }
}

export function within(root, target) {
  const part = relative(resolve(root), resolve(target));
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !/^[A-Za-z]:/.test(part));
}

/** Only the current user and SYSTEM can read credentials or the private database. */
export function secureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { chmodSync(path, 0o700); return; }
  const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
  const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
  if (!sid) throw new Error('credential_acl_identity_failed');
  execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
}

export function prepareDataDirectory(dataDir, installRoot) {
  const target = resolve(dataDir), root = resolve(installRoot);
  if (within(root, target) || within(target, root) || target === resolve(homedir())) throw new Error('unsafe_data_directory');
  // Resolve existing ancestors too: junctions must not point into the installed app.
  let ancestor = target;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const physicalTarget = resolve(realpathSync(ancestor), relative(ancestor, target));
  const physicalRoot = existsSync(root) ? realpathSync(root) : root;
  if (within(physicalRoot, physicalTarget) || within(physicalTarget, physicalRoot)) throw new Error('unsafe_data_directory');
  const marker = join(target, '.zhiyu-install-data');
  if (existsSync(target) && !existsSync(marker) && readdirSync(target).length) throw new Error('data_directory_not_owned');
  secureDirectory(target);
  if (!existsSync(marker)) writeFileSync(marker, 'zhiyu-private-install-data-v1\n', { mode: 0o600 });
  for (const name of ['runtime', 'private', 'logs', 'app', 'app-data', 'backups']) mkdirSync(join(target, name), { recursive: true, mode: 0o700 });
  return target;
}

export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(v => typeof v === 'string' && v.length >= 4).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/(postgres(?:ql)?:\/\/[^\s:@]+:)[^\s@]+(@)/gi, '$1[redacted]$2')
    .replace(/(Bearer\s+)[\w.\-/+=]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|auth[_-]?secret|encryption[_-]?key|password)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}

export async function availablePort(preferred = 0, attempts = 30) {
  for (let n = 0; n < attempts; n++) {
    const port = preferred ? preferred + n : 0;
    const found = await new Promise(resolvePort => {
      const probe = createServer();
      probe.once('error', () => resolvePort(null));
      probe.listen(port, '127.0.0.1', () => { const chosen = probe.address().port; probe.close(() => resolvePort(chosen)); });
    });
    if (found !== null) return found;
  }
  throw new Error('local_port_unavailable');
}

export function validateModel(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('model_configuration_required');
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const sameService = typeof previous.baseUrl === 'string' && baseUrl.replace(/\/$/, '') === previous.baseUrl.replace(/\/$/, '');
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : sameService ? previous.apiKey : undefined;
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error('invalid_model_url'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('model_url_requires_https');
  if (!model || model.length > 200 || /[\r\n\x00-\x1f]/.test(model)) throw new Error('invalid_model_name');
  if (!apiKey || apiKey.length > 4096 || /[\r\n\x00]/.test(apiKey)) throw new Error('invalid_model_key');
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, apiKey };
}

export function requestAllowed(request, port, token, mutation = false) {
  const origin = `http://127.0.0.1:${port}`;
  if (request.headers.host !== `127.0.0.1:${port}`) return 'untrusted_host';
  if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return 'loopback_required';
  if (request.headers['sec-fetch-site'] === 'cross-site') return 'cross_site_request';
  if (mutation && request.headers.origin !== origin) return 'same_origin_required';
  const header = request.headers['x-zhiyu-token'];
  const cookie = request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('zhiyu-control='))?.slice('zhiyu-control='.length);
  if (!constantEqual(header, token) && !constantEqual(cookie, token)) return 'control_token_required';
  // An explicit secret header is itself CSRF proof. Cookie callers also send a per-session token.
  if (mutation && !constantEqual(header, token) && !constantEqual(request.headers['x-zhiyu-csrf'], token)) return 'csrf_required';
  return null;
}

export function childEnvironment(dataDir, config, postgresPort, webPort, osEnv = process.env) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'PROCESSOR_ARCHITECTURE']) if (osEnv[name]) env[name] = osEnv[name];
  const appData = join(dataDir, 'app-data');
  const database = new URL(`postgres://zhiyu@127.0.0.1:${postgresPort}/zhiyu`);
  database.password = config.databasePassword;
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']) if (osEnv[name]) env[name] = osEnv[name];
  Object.assign(env, {
    NODE_ENV: 'production', NODE_OPTIONS: '', TZ: 'Asia/Shanghai', LANG: 'C.UTF-8',
    ZHIYU_APP_DATA_DIR: appData,
    AUTH_MODE: 'local_owner', AUTH_SECRET: config.authSecret, ENCRYPTION_KEY: config.encryptionKey,
    DEV_USER_ID: config.ownerId, ZHIYU_RUNTIME_OWNER_ID: config.ownerId, ZHIYU_RUNTIME_MODE: 'worker', ENABLE_LOCAL_SCHEDULER: 'true',
    POSTGRES_URL: database.href, DATABASE_URL: database.href, ZHIYU_BOOTSTRAP_DB_URL: database.href.replace(/\/zhiyu$/, '/postgres'), ZHIYU_BOOTSTRAP_OWNER_ID: config.ownerId,
    HOSTNAME: '127.0.0.1', PORT: String(webPort), APP_URL: `http://127.0.0.1:${webPort}`, APPLICATION_URL: `http://127.0.0.1:${webPort}`, NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${webPort}`, NEXTAUTH_URL: `http://127.0.0.1:${webPort}`,
    LLM_BASE_URL: config.model?.baseUrl || '', LLM_API_KEY: config.model?.apiKey || '', LLM_MODEL: config.model?.model || '',
    WORK_HARNESS_EVOLUTION_ENABLED: 'false', ZHIYU_OPTIONAL_QUANT_ENABLED: 'false', ZHIYU_RUNTIME_START_PAUSED: config.desiredStatus === 'paused' ? '1' : '0',
    WORKSHOP_AGENT_RUNTIME: 'pi', LOOP_AGENT_RUNTIME: 'pi', PI_AGENT_PROTOCOL: 'openai-completions', WORKSHOP_PI_MODEL_PROTOCOL: 'openai-completions', LOOP_PI_MODEL_PROTOCOL: 'openai-completions',
    OPENZHIYU_SKIP_QUANT: '1', OPENZHIYU_SKIP_WECHAT: '1',
    QUANT_TRANSPORT: 'http', QUANT_SERVICE_URL: 'http://127.0.0.1:1', QUANT_INTERNAL_TOKEN: '',
    WECHAT_DESKTOP_SERVICE_URL: 'http://127.0.0.1:1', WECHAT_DESKTOP_TOKEN: '',
    TAURI_DATA_DIR: join(appData, 'data'), TAURI_STORAGE_PATH: join(appData, 'storage'), TAURI_LOGS_PATH: join(dataDir, 'logs'),
    WEB_READ_EVIDENCE_DIR: join(appData, 'web-read-evidence'), RAG_INDEX_QUEUE_DIR: join(appData, 'rag-index-queue'),
    EMBEDDING_PROVIDER: 'cloud', VECTOR_STORE_BACKEND: 'sqlite-vec',
  });
  return env;
}
