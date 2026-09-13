import net from "node:net";
import tls from "node:tls";
import childProcess, { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTestDatabaseConnection } from "@/lib/db/test-connection-guard";

afterEach(() => vi.unstubAllEnvs());

describe("test I/O isolation", () => {
  it("blocks fetch, sockets, TLS and external executors before I/O", async () => {
    await expect(fetch("https://example.invalid")).rejects.toThrow("TEST_IO_BLOCKED");
    expect(() => net.connect(5432, "127.0.0.1")).toThrow("TEST_IO_BLOCKED");
    expect(() => tls.connect(443, "example.invalid")).toThrow("TEST_IO_BLOCKED");
    expect(() => childProcess.spawn("external-executor")).toThrow("TEST_IO_BLOCKED");
    expect(() => execFile("external-executor")).toThrow("TEST_IO_BLOCKED");
    vi.restoreAllMocks();
    await expect(fetch("http://localhost:3515")).rejects.toThrow("TEST_IO_BLOCKED");
  });

  it("rejects ambient credentials without exposing them in errors", () => {
    const url = "postgres://owner:do-not-log@localhost:5432/zhiyu";
    expect(() => assertTestDatabaseConnection("postgres", url)).toThrow("TEST_DATABASE_BLOCKED");
    try { assertTestDatabaseConnection("postgres", url); } catch (error) {
      expect(String(error)).not.toContain("do-not-log");
    }
    expect(() => assertTestDatabaseConnection("sqlite", "daily.sqlite")).toThrow("TEST_DATABASE_BLOCKED");
    expect(() => assertTestDatabaseConnection("sqlite", ":memory:")).not.toThrow();
  });

  it("requires an exact loopback integration database with a test namespace", () => {
    vi.stubEnv("ZHIYU_TEST_MODE", "integration");
    const url = "postgres://fixture:fixture@127.0.0.1:5432/zhiyu_test_fixture";
    vi.stubEnv("ZHIYU_TEST_DATABASE_URL", url);
    expect(() => assertTestDatabaseConnection("postgres", url)).not.toThrow();
    expect(() => assertTestDatabaseConnection("postgres", `${url}_other`)).toThrow();
    vi.stubEnv("ZHIYU_TEST_DATABASE_URL", "postgres://fixture:fixture@remote/zhiyu_test_fixture");
    expect(() => assertTestDatabaseConnection("postgres", process.env.ZHIYU_TEST_DATABASE_URL!)).toThrow();
  });

  it("guards direct database adapter initialization before opening connections", async () => {
    const { initPostgresDb } = await import("@/lib/db/adapters/postgres");
    const { initSqliteDb } = await import("@/lib/db/adapters/sqlite");
    expect(() => initPostgresDb("postgres://owner:secret@localhost/daily")).toThrow("TEST_DATABASE_BLOCKED");
    expect(() => initSqliteDb("daily.sqlite")).toThrow("TEST_DATABASE_BLOCKED");
  });

  it("does not alter production connection selection", () => {
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertTestDatabaseConnection("postgres", "configured-production-url")).not.toThrow();
  });
});
