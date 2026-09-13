import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthMode, requestBoundary } from "@/lib/auth/request-boundary";
import { isAuthBypassEnabled } from "@/lib/auth/dev-auth";
import { passwordResponses, takePasswordRequest } from "@/lib/ai/native-password-state";
import { NextRequest } from "next/server";

afterEach(() => { vi.unstubAllEnvs(); passwordResponses.clear(); });
const request = (headers: Record<string, string> = {}, method = "POST") => new Request("http://127.0.0.1:3515/api/test", { method, headers: { host: "127.0.0.1:3515", ...headers } });
describe("identity boundary", () => {
  it("requires explicit local owner mode and never falls back on invalid configuration", () => {
    vi.stubEnv("AUTH_MODE", ""); expect(getAuthMode()).toBe("authenticated"); expect(isAuthBypassEnabled()).toBe(false);
    vi.stubEnv("AUTH_MODE", "local_owner"); expect(isAuthBypassEnabled()).toBe(true);
    expect(() => getAuthMode("typo")).toThrow();
  });
  it("preserves local reads and same-origin writes", () => {
    expect(requestBoundary(request({}, "GET"), "local_owner")).toBeNull();
    expect(requestBoundary(request({ origin: "http://127.0.0.1:3515" }), "local_owner")).toBeNull();
  });
  it("handles NextURL loopback normalization while comparing Origin to the actual Host", () => {
    const nextRequest = new NextRequest("http://127.0.0.1:3515/api/test", {method: "POST", headers: {host: "127.0.0.1:3515", origin: "http://127.0.0.1:3515"}});
    expect(requestBoundary(nextRequest, "local_owner")).toBeNull();
    nextRequest.headers.set("origin", "http://localhost:3515");
    expect(requestBoundary(nextRequest, "local_owner")).toBe("same_origin_required");
  });
  it("allows internal public-image reads but never bypasses API or write boundaries", () => {
    expect(requestBoundary(new Request("http://localhost/images/app-logo.png"), "local_owner")).toBeNull();
    expect(requestBoundary(new Request("http://localhost/api/secret.png"), "local_owner")).toBe("untrusted_host");
    expect(requestBoundary(new Request("http://localhost/images/app-logo.png", {method: "POST"}), "local_owner")).toBe("untrusted_host");
  });
  it("rejects cross-site, missing origin, spoofed host and forwarded-header shortcuts", () => {
    expect(requestBoundary(request({ origin: "https://evil.example" }), "local_owner")).toBe("same_origin_required");
    expect(requestBoundary(request(), "local_owner")).toBe("same_origin_required");
    expect(requestBoundary(request({ host: "evil.example", origin: "http://127.0.0.1:3515" }), "local_owner")).toBe("untrusted_host");
    expect(requestBoundary(request({ origin: "http://127.0.0.1:3515", "sec-fetch-site": "cross-site" }), "local_owner")).toBe("cross_site_write");
    expect(requestBoundary(new Request("http://evil.example/api", { headers: { host: "evil.example", "x-forwarded-host": "localhost" } }), "local_owner")).toBe("local_owner_requires_loopback");
  });
  it("only consumes a live server-owned password request once", () => {
    passwordResponses.set("tool", { ownerId: "alice", command: "sudo safe", expiresAt: Date.now() + 1000 });
    expect(takePasswordRequest("tool", "bob")).toBeNull();
    expect(takePasswordRequest("tool", "alice")?.command).toBe("sudo safe");
    expect(takePasswordRequest("tool", "alice")).toBeNull();
    passwordResponses.set("expired", { ownerId: "alice", command: "sudo safe", expiresAt: 0 });
    expect(takePasswordRequest("expired", "alice")).toBeNull();
  });
});
