import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock("@/lib/brain/jev-fetch", () => ({ fetchTypesafe: transport }));
import { routeRecallWithJev } from "@/lib/brain/jev-recall-router";
import { checkRecallEvidence } from "@/lib/brain/jev-evidence-check";
import { evaluateReviewAssistantWithJev } from "@/lib/workshops/review-assistant-model";

function scoredResponse(_url: unknown, options: RequestInit = {}) {
  const request = JSON.parse(options.body as string);
  const answers = Object.fromEntries(Object.keys(request.questions).map(key => [key,
    { type: "noul", noul: key.startsWith("contradiction_") ? 0 : 1 }]));
  return Promise.resolve(new Response(JSON.stringify({ answers, model: request.model }), { status: 200 }));
}

describe("Jev proxy callers", () => {
  beforeEach(() => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "optimized");
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace");
    transport.mockReset().mockImplementation(scoredResponse);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps ordinary router and evidence defaults off in agent mode despite old flags", async () => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "agent");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "jev"); vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "jev");
    vi.stubEnv("BRAIN_JEV_MODE", "active"); vi.stubEnv("BRAIN_JEV_TARGETED_RETRY", "true");
    expect((await routeRecallWithJev("Explain the software architecture.")).status).toBe("disabled");
    expect(await checkRecallEvidence({ question: "Which database is used?", evidence: [{ id: "public", content: "PostgreSQL", observation: { kind: "static" } }] })).toMatchObject({ mode: "off", status: "disabled" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves explicit low-level router and evidence requests through the Typesafe transport in agent mode", async () => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "agent");
    expect((await routeRecallWithJev("Explain the software architecture.", undefined, { enabled: true })).status).toBe("ok");
    expect((await checkRecallEvidence({ question: "Which database is used?", evidence: [{ id: "public", content: "PostgreSQL", observation: { kind: "static" } }] }, { mode: "active" })).status).toBe("ok");
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [url] of transport.mock.calls) expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it("uses the Typesafe transport for source selection", async () => {
    const result = await routeRecallWithJev("Explain the software architecture.");
    expect(result.status).toBe("ok");
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(transport.mock.calls[0][1].body).model).toBe("jev-1.13.0");
  });

  it("uses the Typesafe transport for evidence checking", async () => {
    const result = await checkRecallEvidence({ question: "Which database is used?",
      evidence: [{ id: "public", content: "The public example uses PostgreSQL.", observation: { kind: "static" } }] }, { mode: "active" });
    expect(result.status).toBe("ok");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("uses the Typesafe transport for review advice", async () => {
    const result = await evaluateReviewAssistantWithJev([{ id: "public", facts: "A public example suggests improving a report.", truncated: false }]);
    expect(result.status).toBe("ok");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("preserves the evidence-check injected transport", async () => {
    const injected = vi.fn(scoredResponse);
    const result = await checkRecallEvidence({ question: "Which database is used?",
      evidence: [{ id: "public", content: "The public example uses PostgreSQL.", observation: { kind: "static" } }] }, { mode: "active", fetch: injected });
    expect(result.status).toBe("ok");
    expect(injected).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves the review-advice injected transport", async () => {
    const injected = vi.fn(scoredResponse);
    const result = await evaluateReviewAssistantWithJev([{ id: "public", facts: "Public advice.", truncated: false }], { fetch: injected });
    expect(result.status).toBe("ok");
    expect(injected).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps provider denial as a degraded routing result", async () => {
    transport.mockResolvedValueOnce(new Response("", { status: 451 }));
    const result = await routeRecallWithJev("Explain the software architecture.");
    expect(result).toMatchObject({ status: "degraded", detail: "http_451" });
    expect(transport).toHaveBeenCalledOnce();
  });
});
