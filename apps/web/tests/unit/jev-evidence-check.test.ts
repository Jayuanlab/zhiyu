import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRecallEvidence } from "@/lib/brain/jev-evidence-check";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const input = { question: "Why did it fail? Has it recovered?", evidence: [{ id: "run-1", content: "Run failed. Current status unknown." }] };
function setup() { vi.stubEnv("TYPESAFE_API_KEY", "test-secret"); }
const response = (body: string) => {
  const request = JSON.parse(body);
  return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: key === "coverage_1" || key.startsWith("contradiction_") ? 0.1 : 0.9 }])), usage: { input_tokens: 400, output_tokens: 20 } }));
};
describe("Jev evidence boundary", () => {
  it("cannot accept stale evidence even when the provider reports high support", async () => {
    setup();
    const result = await checkRecallEvidence({ question: "当前状态是什么？", evidence: [{ id: "r", content: "active", observation: { kind: "live", observedAt: "2026-09-20T00:00:00Z" } }],
      timePolicy: { mode: "current", now: "2026-09-23T00:00:00Z", maxAgeMs: 300000 } }, {
      mode: "active", fetch: vi.fn(async (_url, options) => response(String(options?.body))) as unknown as typeof globalThis.fetch,
    });
    expect(result.coverage![0].modelSupport).toBe(0.9);
    expect(result.coverage![0].support).toBe(0.34);
    expect(result.temporal![0].checks[0].state).toBe("stale");
  });
  it("marks omitted requirements instead of silently reporting complete coverage", async () => {
    setup();
    const result = await checkRecallEvidence({ ...input, requirements: Array.from({ length: 17 }, (_, i) => `fact ${i}`) }, {
      mode: "active", fetch: vi.fn(async (_url, options) => response(String(options?.body))) as unknown as typeof globalThis.fetch,
    });
    expect(result.truncated).toBe(true);
    expect(result.coverage).toHaveLength(16);
    expect(result.coverage![0].support).toBeLessThan(0.65);
  });
  it("uses explicit requirements and keeps semantic contradictions separate from raw support", async () => {
    setup();
    const result = await checkRecallEvidence({ ...input, requirements: ["Has it recovered?", "What caused the failure?"] }, {
      mode: "active", fetch: vi.fn(async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        expect(body.questions.coverage_0.instructions.question).toBe("Has it recovered?");
        expect(Object.keys(body.questions).filter(k => k.startsWith("coverage_"))).toHaveLength(2);
        const data = await response(String(options?.body)).json();
        data.answers.contradiction_0.noul = 0.95;
        return Response.json(data);
      }) as unknown as typeof globalThis.fetch,
    });
    expect(result.coverage?.[0].modelSupport).toBe(0.9);
    expect(result.coverage?.[0].contradiction).toBe(0.95);
    expect(result.coverage?.[0].support).toBeCloseTo(0.05);
  });
  it("overrides high model confidence when a required timestamp is absent", async () => {
    setup();
    const result = await checkRecallEvidence({ question: "何时生成？", evidence: [{ id: "db:snapshots:r1", content: '{"capturedAt":"today","fields":{"source_memory_ids":[]}}' }] }, {
      mode: "shadow", fetch: vi.fn(async (_url, options) => response(String(options?.body))) as unknown as typeof globalThis.fetch,
    });
    expect(result.coverage?.[0]).toMatchObject({ support: 0.34, modelSupport: 0.9 });
    expect(result.fieldChecks).toContainEqual({ evidenceId: "db:snapshots:r1", field: "created_at", state: "missing" });
  });
  it("does not call provider when disabled or permission blocked", async () => {
    setup();
    const fetch = vi.fn();
    expect((await checkRecallEvidence(input, { mode: "off", fetch })).status).toBe("disabled");
    expect((await checkRecallEvidence({ ...input, blocked: "access_denied" }, { mode: "active", fetch })).detail).toBe("access_denied");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks each explicit question and relevance, retaining evidence references", async () => {
    setup();
    const fetch = vi.fn(async (_url, options) => response(String(options?.body))) as unknown as typeof globalThis.fetch;
    const result = await checkRecallEvidence(input, { mode: "shadow", fetch });
    expect(result).toMatchObject({ status: "ok", mode: "shadow", truncated: false, relevance: [{ id: "run-1", score: 0.9 }] });
    expect(result.coverage).toHaveLength(2);
    expect(result.coverage?.[1].support).toBe(0.1);
    expect(JSON.stringify(result)).not.toContain("test-secret");
  });
  it("bounds a non-responsive transport and preserves safe degradation", async () => {
    setup(); vi.useFakeTimers();
    const pending = checkRecallEvidence(input, { mode: "shadow", timeoutMs: 100, fetch: vi.fn(() => new Promise<Response>(() => {})) });
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ status: "degraded", detail: "timeout" });
  });
  it.each([401, 429, 500])("reports HTTP %s without echoing provider body", async status => {
    setup();
    const result = await checkRecallEvidence(input, { mode: "shadow", fetch: vi.fn(async () => new Response("test-secret", { status })) });
    expect(result.detail).toBe(`http_${status}`);
    expect(JSON.stringify(result)).not.toContain("test-secret");
  });
  it("rejects missing or out-of-range answers", async () => {
    setup();
    const result = await checkRecallEvidence(input, { mode: "active", fetch: vi.fn(async () => new Response(JSON.stringify({ answers: { coverage_0: { type: "noul", noul: 2 } } }))) });
    expect(result).toMatchObject({ status: "degraded", detail: "invalid_response" });
  });
  it("marks truncated evidence and redacts credential patterns", async () => {
    setup();
    const fetch = vi.fn(async (_url, options) => {
      const body = String(options?.body);
      expect(body).not.toContain("apikey_sensitive_value");
      return response(body);
    }) as unknown as typeof globalThis.fetch;
    const result = await checkRecallEvidence({ ...input, evidence: [{ id: "large", content: "apikey_sensitive_value " + "x".repeat(2500) }] }, { mode: "shadow", fetch });
    expect(result.truncated).toBe(true);
  });
});
