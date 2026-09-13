const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { health, launchService } = require('./local-service-process.cjs');

const rootDir = path.resolve(__dirname, "..");
const wechatDir = path.join(rootDir, "tools", "wechat-desktop-service");
const quantDir = path.join(rootDir, "tools", "quant-service");
loadEnvFile(path.join(rootDir, "apps", "web", ".env.local"));
loadEnvFile(path.join(rootDir, "apps", "web", ".env"));
loadEnvFile(path.join(quantDir, ".env"));
const wechatHost = process.env.WECHAT_DESKTOP_HOST || "127.0.0.1";
const wechatPort = Number(process.env.WECHAT_DESKTOP_PORT || "8765");
const quantServiceUrl =
  process.env.QUANT_SERVICE_URL || "http://127.0.0.1:8766";
const quantUrl = new URL(quantServiceUrl);
const quantHost = quantUrl.hostname || "127.0.0.1";
const quantPort = Number(
  quantUrl.port || (quantUrl.protocol === "https:" ? 443 : 80),
);
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(quantHost) || !["127.0.0.1", "localhost", "::1"].includes(wechatHost)) {
  throw new Error("Internal services must bind to loopback");
}
const pgHost = process.env.OPENZHIYU_PG_HOST || "127.0.0.1";
const pgPort = Number(process.env.OPENZHIYU_PG_PORT || "5432");
const pgContainer = process.env.OPENZHIYU_PG_CONTAINER || "openzhiyu-postgres";
const pgImage = process.env.OPENZHIYU_PG_IMAGE || "postgres:16";
const logDirectory = path.join(rootDir, '.runtime', 'dependencies');
if (![wechatPort, quantPort, pgPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) {
  throw new Error('Invalid local dependency port');
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function firstExistingPath(candidates) {
  return (
    unique(candidates).find((candidate) => fs.existsSync(candidate)) || null
  );
}

function findOnPath(command) {
  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return null;
  }
}

function findDockerCli() {
  return (
    process.env.DOCKER_CLI_PATH ||
    findOnPath("docker.exe") ||
    firstExistingPath([
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Program Files\\Docker\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Windows\\System32\\docker.exe",
      path.join(
        process.env.PROGRAMFILES || "",
        "Docker",
        "Docker",
        "resources",
        "bin",
        "docker.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] || "",
        "Docker",
        "Docker",
        "resources",
        "bin",
        "docker.exe",
      ),
      path.join(
        process.env.LOCALAPPDATA || "",
        "Docker",
        "resources",
        "bin",
        "docker.exe",
      ),
    ]) ||
    "docker"
  );
}

function findDockerDesktopPath() {
  return firstExistingPath([
    process.env.DOCKER_DESKTOP_PATH,
    "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
    "C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe",
    path.join(
      process.env.PROGRAMFILES || "",
      "Docker",
      "Docker",
      "Docker Desktop.exe",
    ),
    path.join(
      process.env["PROGRAMFILES(X86)"] || "",
      "Docker",
      "Docker",
      "Docker Desktop.exe",
    ),
    path.join(process.env.LOCALAPPDATA || "", "Docker", "Docker Desktop.exe"),
    "D:\\Docker\\Docker\\Docker Desktop.exe",
    "D:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
  ]);
}

const dockerCommand = findDockerCli();
const dockerDesktopPath = findDockerDesktopPath();

function log(message) {
  console.log(`[deps] ${message}`);
}

function warn(message) {
  console.warn(`[deps] ${message}`);
}

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: options.cwd || rootDir,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return typeof output === "string" ? output.trim() : "";
}

function tryRun(command, args) {
  try {
    return run(command, args);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForPort(label, host, port, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canConnect(host, port)) {
      log(`${label} is reachable at ${host}:${port}`);
      return true;
    }
    await sleep(1000);
  }
  throw new Error(`${label} did not become reachable at ${host}:${port}`);
}

function dockerInfo() {
  return tryRun(dockerCommand, ["info", "--format", "{{.ServerVersion}}"]);
}

async function waitForDocker(timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const version = dockerInfo();
    if (version) {
      log(`Docker Engine is ready (${version})`);
      return;
    }
    await sleep(2000);
  }
  throw new Error(
    "Docker Desktop started, but Docker Engine was not ready in time.",
  );
}

async function ensureDockerReady() {
  const version = dockerInfo();
  if (version) {
    log(`Docker Engine already ready (${version})`);
    return;
  }

  if (process.env.OPENZHIYU_SKIP_DOCKER_DESKTOP_START === "1") {
    throw new Error(
      "Docker is not running or docker CLI is unavailable. Start Docker Desktop, then run pnpm dev again.",
    );
  }

  if (!dockerDesktopPath) {
    throw new Error(
      `Docker is not running. docker CLI tried: ${dockerCommand}. Docker Desktop was not found in common locations. Set DOCKER_DESKTOP_PATH to your Docker Desktop.exe path, set DOCKER_CLI_PATH to docker.exe, or start Postgres yourself and set OPENZHIYU_SKIP_POSTGRES=1.`,
    );
  }

  log(
    `Docker Engine is not ready. Starting Docker Desktop from ${dockerDesktopPath}`,
  );
  const child = spawn(dockerDesktopPath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();

  log("Waiting for Docker Engine to become ready...");
  await waitForDocker();
}

async function ensurePostgres() {
  if (process.env.OPENZHIYU_SKIP_POSTGRES === "1") {
    log("Postgres startup skipped by OPENZHIYU_SKIP_POSTGRES=1");
    return;
  }

  if (await canConnect(pgHost, pgPort)) {
    log(`Postgres already listening at ${pgHost}:${pgPort}`);
    return;
  }

  await ensureDockerReady();

  const exists = tryRun(dockerCommand, [
    "inspect",
    "-f",
    "{{.Name}}",
    pgContainer,
  ]);
  if (exists) {
    const running = tryRun(dockerCommand, [
      "inspect",
      "-f",
      "{{.State.Running}}",
      pgContainer,
    ]);
    if (running !== "true") {
      log(`Starting Docker container ${pgContainer}`);
      run(dockerCommand, ["start", pgContainer], { stdio: "inherit" });
    } else {
      log(`Docker container ${pgContainer} is already running`);
    }
  } else {
    log(`Creating Docker container ${pgContainer}`);
    run(
      dockerCommand,
      [
        "run",
        "-d",
        "--name",
        pgContainer,
        "-e",
        "POSTGRES_USER=Zhiyu",
        "-e",
        "POSTGRES_PASSWORD=Zhiyu",
        "-e",
        "POSTGRES_DB=Zhiyu",
        "-p",
        `127.0.0.1:${pgPort}:5432`,
        "-v",
        "openzhiyu-postgres-data:/var/lib/postgresql/data",
        pgImage,
      ],
      { stdio: "inherit" },
    );
  }

  await waitForPort("Postgres", pgHost, pgPort, 45000);
}

function ensurePythonVenv(serviceName, serviceDir) {
  const venvPython = path.join(serviceDir, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }

  log(`Creating ${serviceName} Python virtual environment`);
  try {
    run("py", ["-3.12", "-m", "venv", ".venv"], {
      cwd: serviceDir,
      stdio: "inherit",
    });
  } catch {
    run("python", ["-m", "venv", ".venv"], {
      cwd: serviceDir,
      stdio: "inherit",
    });
  }

  return venvPython;
}

const checkWechatHealth = () => health(`http://${wechatHost}:${wechatPort}/health`, body => body.ok === true && typeof body.uptimeSeconds === 'number' && typeof body.requiresAuth === 'boolean');
const checkQuantHealth = () => health(new URL('/health', quantServiceUrl), body => body.service === 'quant-service' && body.ok === true);

async function assertPortAvailable(name, host, port) {
  if (await canConnect(host, port)) throw Error(`${name}: port ${port} is occupied but service health is invalid; inspect the existing service before retrying.`);
}

async function ensureWechatService() {
  if (process.env.OPENZHIYU_SKIP_WECHAT === "1") {
    log("WeChat desktop service startup skipped by OPENZHIYU_SKIP_WECHAT=1");
    return;
  }

  if (await checkWechatHealth()) {
    log(
      `WeChat desktop service already healthy at ${wechatHost}:${wechatPort}`,
    );
    return;
  }

  await assertPortAvailable('WeChat', wechatHost, wechatPort);

  const python = ensurePythonVenv("WeChat service", wechatDir);
  log("Installing WeChat service Python dependencies");
  run(python, ["-m", "pip", "install", "-r", "requirements.txt"], {
    cwd: wechatDir,
    stdio: "inherit",
  });

  log(`Starting WeChat desktop service at ${wechatHost}:${wechatPort}`);
  const launched = await launchService({
    name: 'wechat', command: python, args: [
      "server.py",
      "--host",
      wechatHost,
      "--port",
      String(wechatPort),
      "--backend",
      process.env.WECHAT_DESKTOP_BACKEND || "window",
    ], cwd: wechatDir, logDirectory, checkHealth: checkWechatHealth, timeoutMs: 15000,
  });
  log(`WeChat ready; pid=${launched.pid}; log=${launched.logPath}`);
}

async function ensureQuantService() {
  if (process.env.OPENZHIYU_SKIP_QUANT === "1") {
    log("Quant service startup skipped by OPENZHIYU_SKIP_QUANT=1");
    return;
  }

  if (!fs.existsSync(quantDir)) {
    throw new Error(`Quant service directory not found at ${quantDir}`);
  }

  if (await checkQuantHealth()) {
    log(`Quant service already healthy at ${quantServiceUrl}`);
    return;
  }

  await assertPortAvailable('Quant', quantHost, quantPort);

  const python = ensurePythonVenv("quant service", quantDir);
  log("Installing quant service Python dependencies");
  run(python, ["-m", "pip", "install", "-r", "requirements.txt"], {
    cwd: quantDir,
    stdio: "inherit",
  });

  log(`Starting quant service at ${quantServiceUrl}`);
  const launched = await launchService({
    name: 'quant', command: python, args: [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      quantHost,
      "--port",
      String(quantPort),
    ], cwd: quantDir, logDirectory, checkHealth: checkQuantHealth, timeoutMs: 20000,
      env: {
        ...process.env,
        QUANT_SERVICE_URL: quantServiceUrl,
        QUANT_DATA_PROVIDER: process.env.QUANT_DATA_PROVIDER || "auto",
        QUANT_AKSHARE_SOURCE: process.env.QUANT_AKSHARE_SOURCE || "sina",
        QUANT_CANDIDATE_PROVIDER:
          process.env.QUANT_CANDIDATE_PROVIDER || "tencent",
      },
  });
  log(`Quant ready; pid=${launched.pid}; log=${launched.logPath}`);
}

async function main() {
  await ensurePostgres();
  await ensureQuantService();
  try { await ensureWechatService(); }
  catch (error) {
    if (error.code === 'startup_interrupted' || error.phase === 'stop_unconfirmed') throw error;
    warn(`WeChat unavailable; sending is degraded. ${error.message}`);
  }
  log('Dependency checks finished. Database schema changes require the explicit migration command.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[deps] ${message}`);
  process.exit(1);
});
