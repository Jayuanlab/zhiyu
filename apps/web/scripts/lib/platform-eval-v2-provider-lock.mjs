import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PROVIDER_LOCK_VERSION = "platform-eval-provider-lock.v1";
export class EvalConfigurationLockError extends Error {
  constructor(code) { super(code); this.name = "EvalConfigurationLockError"; this.code = code; }
}
export function configurationHash(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function normalizeEvalEndpoint(baseUrl, protocol) {
  let url;
  try { url = new URL(baseUrl.trim()); } catch { throw new EvalConfigurationLockError("provider_endpoint_invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(name => /key|token|secret|password|credential/i.test(name))) throw new EvalConfigurationLockError("provider_endpoint_invalid");
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  url.searchParams.sort();
  let normalized = url.toString().replace(/\/$/u, "");
  if (protocol === "openai-completions" && /^https:\/\/opencode\.ai\/zen\/go$/iu.test(normalized)) normalized += "/v1";
  return normalized;
}

/** The stored fingerprint excludes key/ciphertext values and never returns the endpoint. */
export function snapshotSavedEvalProvider(setting, ownerId) {
  if (!setting || setting.userId !== ownerId || !setting.enabled || typeof setting.apiKey !== "string" || !setting.apiKey.trim()
    || typeof setting.model !== "string" || !setting.model.trim() || typeof setting.baseUrl !== "string" || !setting.baseUrl.trim()
    || !["openai_compatible", "anthropic_compatible"].includes(setting.providerType)) throw new EvalConfigurationLockError("saved_provider_unavailable");
  const protocol = setting.providerType === "openai_compatible" ? "openai-completions" : "anthropic-messages";
  const endpoint = normalizeEvalEndpoint(setting.baseUrl, protocol);
  const date = new Date(setting.updatedAt);
  if (!setting.id || !setting.updatedAt || !Number.isFinite(date.valueOf())) throw new EvalConfigurationLockError("provider_settings_version_missing");
  const safe = { schemaVersion: PROVIDER_LOCK_VERSION, ownerId, settingsId: setting.id, providerType: setting.providerType,
    protocol, model: setting.model.trim(), endpointHash: configurationHash(endpoint), providerHost: new URL(endpoint).host,
    updatedAt: date.toISOString(), enabled: true, hasEffectiveApiKey: true };
  return { ...safe, fingerprint: configurationHash(safe) };
}

export function assertExpectedEvalProvider(actual, expected) {
  const { fingerprint, ...safe } = expected ?? {};
  if (safe.schemaVersion !== PROVIDER_LOCK_VERSION || fingerprint !== configurationHash(safe)) throw new EvalConfigurationLockError("provider_lock_invalid");
  if (actual.fingerprint !== fingerprint) throw new EvalConfigurationLockError("provider_configuration_drift");
  return actual;
}

/** Production settings queries are read-only. Keep the adapter open until the
 * caller has finished all rechecks; the application DB proxy caches its pool. */
export async function readSavedEvalProvider({ ownerId, role = "agent", readSetting }) {
  const read = readSetting ?? (await import("../../lib/db/llm-api-settings-queries.ts")).getUserLlmApiSettingWithApiKey;
  const providerTypes = role === "judge" ? ["anthropic_compatible"] : ["openai_compatible", "anthropic_compatible"];
  let rows;
  try { rows = await Promise.all(providerTypes.map(providerType => read({ userId: ownerId, providerType }))); }
  catch { throw new EvalConfigurationLockError("provider_settings_read_failed"); }
  for (const setting of rows) {
    if (!setting?.enabled || !setting.apiKey?.trim() || !setting.model?.trim() || !setting.baseUrl?.trim()) continue;
    const snapshot = snapshotSavedEvalProvider(setting, ownerId);
    return { snapshot, config: { apiKey: setting.apiKey, baseUrl: setting.baseUrl.trim(), model: snapshot.model, protocol: snapshot.protocol } };
  }
  throw new EvalConfigurationLockError("saved_provider_unavailable");
}

export async function closeEvalProviderDatabase() { await (await import("../../lib/db/adapters/index.ts")).closeDb(); }

export function readEvalProviderLock(filename, runFolder) {
  if (!filename || path.resolve(filename) !== path.join(path.resolve(runFolder), "provider-lock.json")) throw new EvalConfigurationLockError("provider_lock_scope_invalid");
  let lock;
  try { lock = JSON.parse(fs.readFileSync(filename, "utf8")); } catch { throw new EvalConfigurationLockError("provider_lock_invalid"); }
  const { lockHash, ...body } = lock;
  if (body.schemaVersion !== PROVIDER_LOCK_VERSION || body.runFolder !== path.resolve(runFolder) || lockHash !== configurationHash(body)
    || !body.ownerId || !body.providers?.agent || !body.providers?.judge) throw new EvalConfigurationLockError("provider_lock_invalid");
  return lock;
}

export function evalProviderLockPath(explicit, runFolder) {
  const local = path.join(path.resolve(runFolder), "provider-lock.json");
  return explicit ?? (fs.existsSync(local) ? local : undefined);
}

export function verifyEvalVersionLock(lock, repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")) {
  if (!lock.sourceHashes || !Object.keys(lock.sourceHashes).length || !lock.packageHashes || !Object.keys(lock.packageHashes).length
    || !lock.folder || !lock.fixedEnvironment || !Object.keys(lock.fixedEnvironment).length) throw new EvalConfigurationLockError("provider_lock_invalid");
  for (const [relative, expected] of Object.entries(lock.sourceHashes ?? {})) {
    const absolute = path.resolve(repositoryRoot, relative);
    if (!absolute.startsWith(path.resolve(repositoryRoot) + path.sep) || relative.split(/[\\/]/u).some(part => part === ".." || part.startsWith(".env"))
      || !/^[a-f0-9]{64}$/u.test(expected) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") !== expected) {
      throw new EvalConfigurationLockError("evaluation_source_version_drift");
    }
  }
  for (const [name, expected] of Object.entries(lock.packageHashes ?? {})) {
    const filename = path.join(lock.folder, name);
    if (!/^[a-z0-9][a-z0-9.-]*$/iu.test(name) || !/^[a-f0-9]{64}$/u.test(expected) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()
      || createHash("sha256").update(fs.readFileSync(filename)).digest("hex") !== expected) throw new EvalConfigurationLockError("evaluation_package_drift");
  }
  for (const [name, expected] of Object.entries(lock.fixedEnvironment ?? {})) if (process.env[name] !== expected) throw new EvalConfigurationLockError("evaluation_environment_drift");
  if (lock.sourceWorkspace) {
    const workspace = lock.sourceWorkspace;
    if (!workspace.provenanceFile || !/^[a-f0-9]{64}$/u.test(workspace.provenanceFileHash ?? "") || !/^[a-f0-9]{64}$/u.test(workspace.workspaceHash ?? "")
      || lock.fixedEnvironment.PLATFORM_EVAL_SOURCE_WORKSPACE !== workspace.provenanceFile || lock.fixedEnvironment.PLATFORM_EVAL_SOURCE_WORKSPACE_HASH !== workspace.workspaceHash
      || !fs.existsSync(workspace.provenanceFile) || createHash("sha256").update(fs.readFileSync(workspace.provenanceFile)).digest("hex") !== workspace.provenanceFileHash) throw new EvalConfigurationLockError("evaluation_workspace_provenance_drift");
  }
  return { sourceFileCount: Object.keys(lock.sourceHashes).length, packageFileCount: Object.keys(lock.packageHashes).length, lockHash: lock.lockHash };
}

export async function readLockedEvalProvider({ lock, role = "agent", readSetting }) {
  const selected = await readSavedEvalProvider({ ownerId: lock.ownerId, role, readSetting });
  assertExpectedEvalProvider(selected.snapshot, lock.providers[role]);
  return selected;
}
