import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
  productionBuildEnvironment,
  productionBuildGuardSource,
  productionStartEnvironment,
  rewriteProductionEnvironment,
  validateProductionPending,
  validateProductionReview,
} from "../../scripts/restart-platform-evidence-production.mjs";

function fakeGuard() {
  const connect = vi.fn((..._args: unknown[]) => "connected"), listen = vi.fn(), appendFileSync = vi.fn();
  class Socket { connect(...args: unknown[]) { return connect(...args); } }
  class Server { listen(...args: unknown[]) { return listen(...args); } }
  const net = { Socket, Server, _normalizeArgs: (args: unknown[]) => [args[0]] };
  const context = { process: { env: { ZHIYU_BUILD_GUARD_PG_PORT: "5432", ZHIYU_BUILD_GUARD_LOG: "fake-log" } },
    require: (name: string) => name === "node:net" ? net : name === "node:tls" ? { connect: vi.fn() } : { appendFileSync },
    fetch: vi.fn(), Date, Error };
  runInNewContext(productionBuildGuardSource(), context);
  return { socket: new Socket(), server: new Server(), fetch: context.fetch, connect, listen, appendFileSync };
}

describe("production evidence deployment safety", () => {
  it("preserves UTF-8 BOM, Chinese comments, CRLF, secrets and unrelated formatting", () => {
    const original = Buffer.from('\uFEFF# 主人配置\r\nAUTH_SECRET="keep  exactly" # 保留\r\n ZHIYU_REVIEW_BUILD = "32"\r\nOTHER = abc\r\n', "utf8");
    const result = rewriteProductionEnvironment(original, "37");
    expect(result.updated.toString("utf8")).toBe('\uFEFF# 主人配置\r\nAUTH_SECRET="keep  exactly" # 保留\r\n ZHIYU_REVIEW_BUILD=37\r\nOTHER = abc\r\nANSWER_EVIDENCE_MODE=enforce_critical\r\n');
    expect(result.unrelatedFieldsUnchanged).toBe(true);
    expect(result.updated.includes(Buffer.from("主人配置", "utf8"))).toBe(true);
  });

  it("adds only a required separator when the final unrelated line lacks a newline", () => {
    const result = rewriteProductionEnvironment(Buffer.from("PRIVATE_KEY=unchanged"), "37");
    expect(result.updated.toString()).toBe("PRIVATE_KEY=unchanged\nZHIYU_REVIEW_BUILD=37\nANSWER_EVIDENCE_MODE=enforce_critical\n");
  });

  it("refuses ambiguous duplicate assignments and invalid UTF-8", () => {
    expect(() => rewriteProductionEnvironment(Buffer.from("ZHIYU_REVIEW_BUILD=32\nexport ZHIYU_REVIEW_BUILD=34\n"), "37")).toThrow("duplicate");
    expect(() => rewriteProductionEnvironment(Buffer.from([0xff]), "37")).toThrow("valid_utf8");
  });

  it("requires a completely new two digit artifact and exactly the intended migration", () => {
    expect(() => validateProductionReview("100", false)).toThrow("two_digits");
    expect(() => validateProductionReview("37", true)).toThrow("already_exists");
    expect(() => validateProductionPending([])).toThrow("unexpected");
    expect(() => validateProductionPending(["0159_add_agent_answer_audits", "0160_unreviewed"])).toThrow("unexpected");
    expect(validateProductionPending(["0159_add_agent_answer_audits"])).toBe(true);
  });

  it("limits compilation while restoring original production credentials, worker and public URL on start", () => {
    const original = { POSTGRES_URL: "postgres://role:password@127.0.0.1:5432/real_app", OPENAI_API_KEY: "private-key",
      TYPESAFE_API_KEY: "jev-private", AUTH_SECRET: "original-auth", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3515",
      SENTRY_AUTH_TOKEN: "private-upload-token",
      ZHIYU_RUNTIME_MODE: "worker", ENABLE_LOCAL_SCHEDULER: "true", ENABLE_STARTUP_LISTENERS: "true",
      BRAIN_JEV_MODE: "off", BRAIN_JEV_ROUTING: "replace", BRAIN_JEV_TARGETED_RETRY: "false", NODE_OPTIONS: "--trace-warnings" };
    const build = productionBuildEnvironment(original, "37", "C:/private/build-guard.cjs", "C:/private/denied.jsonl");
    expect(build.OPENAI_API_KEY).toBe("");
    expect(build.TYPESAFE_API_KEY).toBe("");
    expect(build.SENTRY_AUTH_TOKEN).toBe("");
    expect(build.ENABLE_LOCAL_SCHEDULER).toBe("false");
    expect(build.ENABLE_STARTUP_LISTENERS).toBe("false");
    expect(build.SKIP_TYPE_CHECK).toBe("false");
    expect(new URL(build.POSTGRES_URL).searchParams.get("options")).toContain("default_transaction_read_only=on");
    const start = productionStartEnvironment(original, "37");
    expect(start.OPENAI_API_KEY).toBe("private-key");
    expect(start.TYPESAFE_API_KEY).toBe("jev-private");
    expect(start.SENTRY_AUTH_TOKEN).toBe("private-upload-token");
    expect(start.POSTGRES_URL).toBe(original.POSTGRES_URL);
    expect(start.ZHIYU_RUNTIME_MODE).toBe("worker");
    expect(start.ENABLE_STARTUP_LISTENERS).toBe("true");
    expect(start.NEXT_PUBLIC_APP_URL).toBe(original.NEXT_PUBLIC_APP_URL);
    expect(start.NODE_OPTIONS).toBe("--trace-warnings");
    expect(start.ANSWER_EVIDENCE_MODE).toBe("enforce_critical");
    expect(start).not.toHaveProperty("ZHIYU_BUILD_GUARD_LOG");
    expect(original.OPENAI_API_KEY).toBe("private-key");
  });

  it("allows both raw and Node normalized connect arguments only to the validated local port", () => {
    const guarded = fakeGuard();
    expect(guarded.socket.connect({ host: "127.0.0.1", port: 5432 })).toBe("connected");
    expect(guarded.socket.connect([{ host: "127.0.0.1", port: 5432 }, null])).toBe("connected");
    expect(guarded.connect).toHaveBeenCalledTimes(2);
    expect(() => guarded.socket.connect({ host: "127.0.0.1", port: 3515 })).toThrow("tcp");
  });

  it("blocks model HTTP, remote sockets and TCP listeners before IO", () => {
    const guarded = fakeGuard();
    expect(() => guarded.fetch("https://example.invalid")).toThrow("fetch");
    expect(() => guarded.socket.connect({ host: "203.0.113.1", port: 5432 })).toThrow("tcp");
    expect(() => guarded.server.listen(0)).toThrow("server_listen");
    expect(guarded.connect).not.toHaveBeenCalled();
    expect(guarded.listen).not.toHaveBeenCalled();
    const events = guarded.appendFileSync.mock.calls.map(call => JSON.parse(call[1] as string));
    expect(events.map(event => event.kind)).toEqual(["fetch", "tcp", "server_listen"]);
    expect(JSON.stringify(events)).not.toContain("203.0.113.1");
  });

  it("does not create an arbitrary named-pipe or socket-path bypass", () => {
    const guarded = fakeGuard();
    expect(() => guarded.socket.connect({ path: "\\\\.\\pipe\\pretend-next-private" })).toThrow("socket_path");
    expect(() => guarded.socket.connect({ path: "/tmp/pretend-socket" })).toThrow("socket_path");
    expect(guarded.connect).not.toHaveBeenCalled();
  });
});
