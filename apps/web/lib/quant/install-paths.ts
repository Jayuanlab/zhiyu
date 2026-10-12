import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function quantInstallationMode(env: NodeJS.ProcessEnv = process.env) {
  return env.ZHIYU_QUANT_INSTALL_MODE === "1";
}

function absoluteEnvironmentPath(name: string, env: NodeJS.ProcessEnv) {
  const value = env[name]?.trim();
  if (!value || !isAbsolute(value)) throw new Error(`${name.toLowerCase()}_must_be_absolute`);
  return resolve(value);
}

function physicalPath(path: string) {
  let ancestor = path;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}

function within(root: string, target: string) {
  const part = relative(root, target);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

export function validateQuantInstallation(env: NodeJS.ProcessEnv = process.env) {
  const installRoot = physicalPath(absoluteEnvironmentPath("ZHIYU_INSTALL_ROOT", env));
  const dataRoot = physicalPath(absoluteEnvironmentPath("ZHIYU_INSTALL_DATA_DIR", env));
  const dataDir = physicalPath(absoluteEnvironmentPath("QUANT_DATA_DIR", env));
  if (within(installRoot, dataRoot) || within(dataRoot, installRoot) || dataDir === dataRoot || !within(dataRoot, dataDir)) {
    throw new Error("quant_installation_data_boundary_invalid");
  }
  const marker = join(dataRoot, ".zhiyu-install-data");
  if (!existsSync(marker) || realpathSync(marker) !== marker || readFileSync(marker, "utf8").trim() !== "zhiyu-private-install-data-v1") {
    throw new Error("quant_installation_data_not_owned");
  }
  return { installRoot, dataRoot, dataDir };
}

function resourceDirectory(name: string, entry: string, env: NodeJS.ProcessEnv) {
  const root = physicalPath(absoluteEnvironmentPath(name, env));
  if (quantInstallationMode(env)) {
    const { installRoot, dataRoot } = validateQuantInstallation(env);
    if (!within(installRoot, root) || within(dataRoot, root) || within(root, dataRoot)) throw new Error("quant_resource_boundary_invalid");
  }
  const file = join(root, entry);
  if (!existsSync(file) || !statSync(file).isFile() || !within(root, realpathSync(file))) throw new Error("quant_resource_entry_missing");
  return root;
}

export function quantServiceDirectory(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  if (env.ZHIYU_QUANT_RESOURCE_DIR?.trim()) return resourceDirectory("ZHIYU_QUANT_RESOURCE_DIR", "embedded_worker.py", env);
  if (quantInstallationMode(env)) throw new Error("quant_installation_resource_required");
  const root = [cwd, resolve(cwd, "../..")].find(candidate => existsSync(resolve(candidate, "tools/quant-service/embedded_worker.py")));
  if (!root) throw new Error("quant_embedded_worker_missing");
  return resolve(root, "tools/quant-service");
}

export function aStockResourceDirectory(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  if (env.ZHIYU_ASTOCK_RESOURCE_DIR?.trim()) return resourceDirectory("ZHIYU_ASTOCK_RESOURCE_DIR", "cli.py", env);
  if (quantInstallationMode(env)) throw new Error("astock_installation_resource_required");
  return join(cwd, "tools", "a-stock-data");
}

export function quantPythonBinary(quantDir?: string, env: NodeJS.ProcessEnv = process.env, aStock = false) {
  const explicit = aStock ? env.ASTOCK_PYTHON_BIN || env.QUANT_PYTHON_BIN : env.QUANT_PYTHON_BIN;
  if (quantInstallationMode(env)) {
    validateQuantInstallation(env);
    if (!explicit || !isAbsolute(explicit)) throw new Error("quant_installation_python_required");
    const python = physicalPath(resolve(explicit));
    const installRoot = physicalPath(absoluteEnvironmentPath("ZHIYU_INSTALL_ROOT", env));
    if (!within(installRoot, python) || !existsSync(python) || !statSync(python).isFile()) throw new Error("quant_installation_python_invalid");
    return python;
  }
  if (explicit) return explicit;
  if (aStock) return env.PYTHON || "python";
  const venv = quantDir && resolve(quantDir, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  return venv && existsSync(venv) ? venv : "python";
}

const installedPythonOsNames = ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATH", "USERNAME", "USERDOMAIN", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "TZ"];
const installedPythonPathNames = ["ZHIYU_QUANT_INSTALL_MODE", "ZHIYU_INSTALL_ROOT", "ZHIYU_INSTALL_DATA_DIR", "ZHIYU_QUANT_RESOURCE_DIR", "ZHIYU_ASTOCK_RESOURCE_DIR", "QUANT_PYTHON_BIN", "ASTOCK_PYTHON_BIN", "QUANT_DATA_DIR", "QUANT_TIMING_LOG_PATH"];
const installedQuantNames = ["ZHIYU_RUNTIME_OWNER_ID", "QUANT_TRANSPORT", "QUANT_INTERNAL_TOKEN", "QUANT_PAPER_SIGNING_KEY", "QUANT_PAPER_OWNER_ID", "QUANT_PAPER_ACCOUNT_ID", "QUANT_PAPER_DATABASE_URL", "QUANT_PAPER_TRADING_ENABLED", "QUANT_DATA_PROVIDER", "QUANT_TUSHARE_TOKEN", "QUANT_WATCHLIST", "QUANT_AKSHARE_SOURCE", "QUANT_CACHE_TTL_SECONDS", "QUANT_CANDIDATE_PROVIDER", "QUANT_CANDIDATE_TIMEOUT_SECONDS", "QUANT_DYNAMIC_CANDIDATE_CACHE_TTL_SECONDS", "QUANT_DYNAMIC_CANDIDATE_MODE", "QUANT_DYNAMIC_CANDIDATE_QUOTE_LIMIT", "QUANT_DYNAMIC_CANDIDATE_TIMEOUT_SECONDS", "QUANT_DYNAMIC_CANDIDATES", "QUANT_FUNDAMENTAL_CACHE_TTL_SECONDS", "QUANT_LOCAL_CANDIDATE_EXPAND_THRESHOLD", "QUANT_LOCAL_CANDIDATE_UNIVERSE", "QUANT_MARKET_AUXILIARY_TIMEOUT_SECONDS", "QUANT_MARKET_OVERVIEW_CACHE_TTL_SECONDS", "QUANT_MARKET_OVERVIEW_TIMEOUT_SECONDS", "QUANT_MARKET_SECTOR_TIMEOUT_SECONDS", "QUANT_MARKET_UNIVERSE_REFRESH_TIMEOUT_SECONDS", "QUANT_TENCENT_QUOTE_TIMEOUT_SECONDS", "QUANT_WENCAI_UNIVERSE_EXPANSION"];

export function quantPythonEnvironment(env: NodeJS.ProcessEnv = process.env, aStock = false): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = quantInstallationMode(env) ? { NODE_ENV: env.NODE_ENV || "production" } : { ...env };
  if (quantInstallationMode(env)) {
    validateQuantInstallation(env);
    // The Node hosts need the main database and model credentials. Python only
    // receives its dedicated paper role; bootstrap/admin secrets never cross.
    for (const name of [...installedPythonOsNames, ...installedPythonPathNames, ...(aStock ? [] : installedQuantNames)]) {
      if (env[name] !== undefined) values[name] = env[name];
    }
    values.PYTHONNOUSERSITE = "1";
    values.PYTHONDONTWRITEBYTECODE = "1";
    values.QUANT_TDX_LOCAL_ENABLED = "false";
  }
  values.PYTHONUTF8 = "1";
  values.PYTHONIOENCODING = "utf-8";
  return values;
}

export function quantPythonArguments(script: string, env: NodeJS.ProcessEnv = process.env, aStock = false) {
  return quantInstallationMode(env) ? ["-I", "-B", "-X", "utf8", "-u", script] : aStock ? [script] : ["-u", script];
}
