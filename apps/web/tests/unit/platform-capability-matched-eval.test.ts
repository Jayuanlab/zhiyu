import fs from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { appendAdvisory, createPaidCallBudget, createReplayTools, extractNativeReadonlyNames, gradeMain, gradeRouting,
  readProviderPayload, validateFixture, verifyProviderOutputLimit, type MatchedFixture } from "../../scripts/lib/platform-capability-matched-eval.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("../../scripts/fixtures/platform-capability-matched-v1.json", import.meta.url), "utf8")) as MatchedFixture;
const routing = { provider: "rules" as const, status: "ok" as const, capabilityIds: ["queryContacts"], elapsedMs: 0, policyVersion: "test" };

describe("frozen matched capability evaluation", () => {
  it("freezes 16 questions, six main pairs, explicit labels and genuinely ambiguous requests", () => {
    expect(() => validateFixture(fixture)).not.toThrow();
    expect(fixture.cases).toHaveLength(16);
    expect(fixture.cases.filter(item => item.main)).toHaveLength(6);
    expect(fixture.cases.filter(item => item.expectJevAttempt)).toHaveLength(4);
    expect(fixture.sourcePolicy).toContain("synthetic");
  });

  it("extracts the formal complete readonly contract, including discovery and memory delegation", () => {
    const source = fs.readFileSync(new URL("../../app/api/native/agent/route.ts", import.meta.url), "utf8");
    const names = extractNativeReadonlyNames(source);
    expect(names).toContain("askMemory");
    expect(names).toContain("listPlatformCapabilities");
    expect(names).toContain("platformRecall");
    expect(names).not.toContain("setLoopTaskStatus");
    expect(() => extractNativeReadonlyNames("invalid")).toThrow("readonly_contract_not_found");
  });

  it("uses objective IDs and treats abstention and degradation separately without a model judge", () => {
    const item = fixture.cases.find(item => item.id === "CAP-04")!;
    expect(gradeRouting(item, routing, 0)).toMatchObject({ accepted: true, acceptable: true, wrongSelection: false, objectiveMatch: true });
    expect(gradeRouting(item, { ...routing, capabilityIds: ["platformRecall"] }, 0)).toMatchObject({ accepted: true, wrongSelection: true, objectiveMatch: false });
    expect(gradeRouting(item, { ...routing, status: "unresolved", capabilityIds: [] }, 0)).toMatchObject({ abstained: true, unresolvedPositive: true, objectiveMatch: false });
    const noMatch = fixture.cases.find(item => item.id === "CAP-16")!;
    expect(gradeRouting(noMatch, { ...routing, status: "degraded", capabilityIds: [] }, 1)).toMatchObject({ degraded: true, correctEmpty: false, objectiveMatch: false });
  });

  it("counts an unwanted external request as a failure even with an empty suggestion", () => {
    const item = fixture.cases.find(item => item.id === "CAP-09")!;
    expect(gradeRouting(item, { ...routing, capabilityIds: [] }, 1)).toMatchObject({ unexpectedNetwork: true, objectiveMatch: false });
  });

  it("preserves the exact host advisory boundary and injects no expected labels", () => {
    expect(appendAdvisory("raw question", { ...routing, status: "unresolved" })).toBe("raw question");
    const prompt = appendAdvisory("raw question", routing);
    expect(prompt).toContain("Advisory platform capability matches: [\"queryContacts\"]");
    expect(prompt).toContain("does not execute any action");
    expect(prompt).not.toContain("expectedIds");
  });

  it("uses copied real schemas and formal guards while never executing business handlers", async () => {
    const business = vi.fn();
    const actual: AgentTool<any> = { name: "queryContacts", label: "Contacts", description: "Actual contract",
      parameters: Type.Object({ pageSize: Type.Optional(Type.Number()) }), execute: business };
    const replay = createReplayTools({ actualTools: [actual], item: fixture.cases[3], snapshot: fixture.snapshot,
      policy: { allowedTools: ["queryContacts"], defaultDecision: "deny" } });
    expect(replay[0].parameters).toBe(actual.parameters);
    const result = await replay[0].execute("call-1", { pageSize: 1 });
    expect(result.details).toMatchObject({ result: { provider: "frozen_synthetic_replay", total: 1 }, trace: { status: "completed", metadata: { decision: "allow" } } });
    expect(business).not.toHaveBeenCalled();
    const blocked = createReplayTools({ actualTools: [actual], item: fixture.cases[3], snapshot: fixture.snapshot,
      policy: { allowedTools: ["queryContacts"], deniedTools: ["queryContacts"] } });
    await expect(blocked[0].execute("call-2", {})).rejects.toThrow();
  });

  it("never converts an unsupported replay reader or tool receipt into business success", async () => {
    const actual: AgentTool<any> = { name: "askMemory", label: "Ask", description: "Actual contract", parameters: Type.Object({}), execute: vi.fn() };
    const tools = createReplayTools({ actualTools: [actual], item: fixture.cases[0], snapshot: fixture.snapshot,
      policy: { allowedTools: ["askMemory"] } });
    expect((await tools[0].execute("call", {})).details).toMatchObject({ result: { ok: false, status: "unavailable", warning: "reader_not_bound_in_this_frozen_replay" } });
    expect(gradeMain(fixture.cases[0], "先观测，再建模。先稳定，再智能。", ["searchKnowledgeBase"], true, 1).checkedFactsSupported).toBe(false);
  });

  it("enforces the paid request ceiling before a 41st dispatch", () => {
    const budget = createPaidCallBudget();
    for (let i = 0; i < 40; i++) budget.reserve(i % 2 ? "main" : "jev", "CAP-01", "rules");
    expect(() => budget.reserve("main", "CAP-01", "rules")).toThrow("paid_call_limit");
    expect(budget.snapshot()).toMatchObject({ calls: 40, remaining: 0 });
  });

  it("a supplement uses only the first run's remaining allowance", () => {
    const priorCalls = 34;
    const budget = createPaidCallBudget(40 - priorCalls);
    for (let i = 0; i < 6; i++) budget.reserve("main", "CAP-13", "jev");
    expect(priorCalls + budget.snapshot().calls).toBe(40);
    expect(() => budget.reserve("main", "CAP-13", "jev")).toThrow("paid_call_limit");
  });

  it("checks the actual provider payload rather than assuming an SDK option constrained output", async () => {
    const payload = await readProviderPayload(new Request("https://provider.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ max_tokens: 2048 }) }));
    expect(verifyProviderOutputLimit(payload)).toBe(2048);
    expect(() => verifyProviderOutputLimit({ max_tokens: 2049 })).toThrow("provider_output_limit_invalid");
    expect(() => verifyProviderOutputLimit({})).toThrow("provider_output_limit_invalid");
  });
});
