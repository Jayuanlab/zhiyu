import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import { aStockResourceDirectory, quantPythonArguments, quantPythonBinary, quantPythonEnvironment, quantServiceDirectory, validateQuantInstallation } from "@/lib/quant/install-paths";
import { EmbeddedQuantTransport } from "@/lib/quant/embedded-transport";
import { runAStockDataAction } from "@/lib/workshops/a-stock-data-client";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zhiyu-quant-unit-")); roots.push(root);
  const install = join(root, "install"), data = join(root, "data"), quant = join(install, "components", "quant"), astock = join(install, "components", "a-stock-data"), python = join(install, "vendor", "python", "python.exe");
  for (const path of [data, quant, astock, join(install, "vendor", "python")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(data, ".zhiyu-install-data"), "zhiyu-private-install-data-v1\n");
  writeFileSync(join(quant, "embedded_worker.py"), ""); writeFileSync(join(astock, "cli.py"), ""); writeFileSync(python, "");
  return { root, quant, astock, python, env: { NODE_ENV: "test" as const, ZHIYU_QUANT_INSTALL_MODE: "1", ZHIYU_INSTALL_ROOT: install, ZHIYU_INSTALL_DATA_DIR: data, QUANT_DATA_DIR: join(data, "quant"), ZHIYU_QUANT_RESOURCE_DIR: quant, ZHIYU_ASTOCK_RESOURCE_DIR: astock, QUANT_PYTHON_BIN: python } };
}
function child() {
  const value = new EventEmitter() as any;
  value.pid = 12345; value.exitCode = null; value.signalCode = null;
  value.stdin = new PassThrough(); value.stdout = new PassThrough(); value.stderr = new PassThrough(); value.kill = vi.fn(() => true);
  return value;
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); spawnMock.mockReset(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("installed quant boundaries", () => {
  it("uses explicit resources from an unrelated working directory and isolated Python flags", () => {
    const f = fixture();
    expect(quantServiceDirectory(f.root, f.env)).toBe(f.quant);
    expect(aStockResourceDirectory(f.root, f.env)).toBe(f.astock);
    expect(quantPythonBinary(undefined, f.env)).toBe(f.python);
    expect(quantPythonArguments("script.py", f.env)).toEqual(["-I", "-B", "-X", "utf8", "-u", "script.py"]);
    const env = quantPythonEnvironment({ ...f.env, PYTHONPATH: "daily-site", PYTHONHOME: "global", QUANT_TDX_LOCAL_ENABLED: "true" });
    expect(env.PYTHONPATH).toBeUndefined(); expect(env.PYTHONHOME).toBeUndefined(); expect(env.QUANT_TDX_LOCAL_ENABLED).toBe("false");
  });
  it("rejects missing ownership, relative resources, install/data overlap and a global Python", () => {
    const f = fixture();
    expect(() => quantServiceDirectory(f.root, { ...f.env, ZHIYU_QUANT_RESOURCE_DIR: "relative" })).toThrow("must_be_absolute");
    expect(() => validateQuantInstallation({ ...f.env, QUANT_DATA_DIR: f.quant })).toThrow("data_boundary_invalid");
    expect(() => quantPythonBinary(undefined, { ...f.env, QUANT_PYTHON_BIN: process.execPath })).toThrow("python_invalid");
    rmSync(join(f.env.ZHIYU_INSTALL_DATA_DIR, ".zhiyu-install-data"));
    expect(() => validateQuantInstallation(f.env)).toThrow("data_not_owned");
  });
  it("never gives Python main database, model, manager or bootstrap credentials", () => {
    const f = fixture();
    const secrets = { DATABASE_URL: "main", POSTGRES_URL: "main", ZHIYU_BOOTSTRAP_DB_URL: "admin", ZHIYU_BOOTSTRAP_OWNER_ID: "main-owner", LLM_API_KEY: "model", AUTH_SECRET: "auth", ENCRYPTION_KEY: "encryption", QUANT_INSTALL_ADMIN_DATABASE_URL: "admin", QUANT_INSTALL_DATABASE_PASSWORD: "admin-password", QUANT_UNKNOWN_SECRET: "unknown", WECHAT_DESKTOP_TOKEN: "sender", HOME: "daily-home", PYTHONPATH: "global" };
    const env = { ...f.env, ...secrets, QUANT_PAPER_DATABASE_URL: "dedicated", QUANT_PAPER_SIGNING_KEY: "quant-key", QUANT_INTERNAL_TOKEN: "quant-token" };
    const quant = quantPythonEnvironment(env), astock = quantPythonEnvironment(env, true);
    for (const key of Object.keys(secrets)) { expect(quant[key]).toBeUndefined(); expect(astock[key]).toBeUndefined(); }
    expect(quant.QUANT_PAPER_DATABASE_URL).toBe("dedicated"); expect(quant.QUANT_PAPER_SIGNING_KEY).toBe("quant-key");
    for (const key of ["QUANT_PAPER_DATABASE_URL", "QUANT_PAPER_SIGNING_KEY", "QUANT_INTERNAL_TOKEN"]) expect(astock[key]).toBeUndefined();
  });
  it("returns a visible configuration failure without spawning ASTOCK outside the installation", async () => {
    vi.stubEnv("ZHIYU_QUANT_INSTALL_MODE", "1"); vi.stubEnv("ZHIYU_INSTALL_ROOT", "relative");
    expect(await runAStockDataAction({ action: "quote" })).toMatchObject({ ok: false, errorType: "Configuration" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it("does not confirm Python stopped before the same child exits and blocks restart", async () => {
    const f = fixture(); Object.entries(f.env).forEach(([key, value]) => vi.stubEnv(key, value));
    const process_ = child(); spawnMock.mockReturnValue(process_);
    const transport = new EmbeddedQuantTransport();
    const request = transport.request("http://127.0.0.1/health").catch(error => error.message);
    let stopped = false; const stop = transport.closeAndWait().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); expect(transport.status().pid).toBe(12345); expect(process_.kill).not.toHaveBeenCalled();
    await expect(transport.request("http://127.0.0.1/health")).rejects.toThrow("stopping");
    process_.exitCode = 0; process_.emit("exit", 0); await stop;
    expect(stopped).toBe(true); expect(transport.status().pid).toBeNull(); expect(await request).toBe("quant_embedded_closed");
  });
  it("keeps the PID and refuses stop confirmation when termination is unconfirmed", async () => {
    vi.useFakeTimers(); const f = fixture(); Object.entries(f.env).forEach(([key, value]) => vi.stubEnv(key, value));
    const process_ = child(); spawnMock.mockReturnValue(process_);
    const transport = new EmbeddedQuantTransport(); void transport.request("http://127.0.0.1/health").catch(() => undefined);
    const stop = transport.closeAndWait().catch(error => error.message);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await stop).toBe("quant_stop_unconfirmed"); expect(transport.status()).toMatchObject({ pid: 12345, running: true, detail: "quant_stop_unconfirmed" });
    await expect(transport.request("http://127.0.0.1/health")).rejects.toThrow("quant_stop_unconfirmed");
    process_.exitCode = 0; process_.emit("exit", 0);
  });
  it("retains a live child on kill error until exit rather than treating the error as stopped", async () => {
    const f = fixture(); Object.entries(f.env).forEach(([key, value]) => vi.stubEnv(key, value));
    const process_ = child(); spawnMock.mockReturnValue(process_);
    const transport = new EmbeddedQuantTransport(); const request = transport.request("http://127.0.0.1/health").catch(() => undefined);
    const stop = transport.closeAndWait(); process_.emit("error", new Error("EPERM"));
    expect(transport.status().pid).toBe(12345);
    process_.exitCode = 0; process_.emit("exit", 0); await stop; await request;
    expect(transport.status().pid).toBeNull();
  });
});
