import { describe, expect, it, vi } from "vitest";
import { runBoundedRecall } from "@/lib/brain/query-retry";
import { sanitizeBrainRecallPlan } from "@/lib/brain/recall-planner";
import type { BrainRecallPlan } from "@/lib/brain/recall-planner";
import type { BrainContextPack } from "@/lib/brain/context";

const plan: BrainRecallPlan = {
  interfaceVersion: "brain-recall-plan.v1", mode: "llm",
  statuses: ["verified"], scopes: [{ type: "work", workId: "alpha" }],
  minConfidence: 80, updatedAfter: "2026-09-01T00:00:00Z",
  searchTerms: ["alpha", "delay"], includeCandidates: false,
  maxItems: 5, memoryLimit: 40, routes: [], rationale: [], warnings: [],
  queryRetry: { query: "alpha delivery postponement", searchTerms: ["postponement"], reason: "Equivalent delivery wording" },
};
function empty(): BrainContextPack & { routeResults: Array<{ status: string; count: number }> } {
  return { interfaceVersion: "brain-context.v1", contextLogId: "first",
    selection: { selectedCount: 0, deniedCount: 0, omittedCount: 0, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} },
    items: [], denied: [], omitted: [], routeResults: [] };
}
const request = { requester: { type: "work" as const, userId: "u", workId: "alpha" }, taskIntent: "alpha delivery delay" };

describe("bounded recall query rewriting", () => {
  it('uses a missing-information query once and keeps both evidence sets without an LLM checker', async () => {
    const first = { ...empty(), items: [{ id: 'a', ownerType: 'work' as const, ownerId: 'alpha', memoryType: 'task' as const, subject: 'task', content: 'task', evidenceRefs: [], score: 1, reasons: [] }] };
    const second = { ...first, contextLogId: 'second', items: first.items.map(item => ({ ...item, id: 'b' })) };
    const run = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const result = await runBoundedRecall({ originalQuery: 'task and receipt', plan: { ...plan, queryRetry: undefined }, enabled: true, run,
      selectMissingInformationRetry: () => ({ query: 'receipt', searchTerms: ['receipt'], reason: 'required_information_missing:tools' }),
      checkEvidence: async () => ({ provider: 'typesafe', mode: 'off', status: 'disabled', elapsedMs: 0, truncated: false }),
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.result.items.map(item => item.id)).toEqual(['a', 'b']);
    expect(run.mock.calls[1][0]).toMatchObject({ scopes: plan.scopes, minConfidence: plan.minConfidence, updatedAfter: plan.updatedAfter, statuses: plan.statuses });
  });
  it.each(['denied', 'unavailable', 'disabled'])('does not run a gap planner when %s', async condition => {
    const first = empty();
    if (condition === 'denied') first.denied = [{ id: 'secret', reason: 'no_grant' }];
    if (condition === 'unavailable') first.routeResults = [{ status: 'failed', count: 0 }];
    const selectMissingInformationRetry = vi.fn(() => plan.queryRetry);
    const run = vi.fn().mockResolvedValue(first);
    await runBoundedRecall({ originalQuery: 'task', plan, enabled: condition !== 'disabled', run, selectMissingInformationRetry });
    expect(run).toHaveBeenCalledTimes(1);
    expect(selectMissingInformationRetry).not.toHaveBeenCalled();
  });
  const insufficientCheck = vi.fn(async () => ({ provider: "typesafe" as const, mode: "active" as const, status: "ok" as const, elapsedMs: 1, truncated: false, coverage: [{ question: "recovered?", support: 0.1 }] }));
  function partial(id: string) {
    return { ...empty(), items: [{ id, ownerType: "work" as const, ownerId: "alpha", memoryType: "fact" as const, subject: id, content: id, evidenceRefs: [], score: 1, reasons: [] }] };
  }
  it("keeps time uncertainty observable when the semantic checker is off", async () => {
    const run = vi.fn().mockResolvedValue(partial("old-memory"));
    const { trace } = await runBoundedRecall({ originalQuery: "当前状态是什么？", plan, enabled: false, run });
    expect(trace.answerRequirements?.requirements).toEqual(["当前状态是什么"]);
    expect(trace.evidenceTime).toMatchObject({ policy: { mode: "current" }, checks: [{ evidenceId: "old-memory", state: "unknown" }] });
    expect(trace.evidenceCheck?.status).toBe("disabled");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("supplements partial evidence once without losing the first result", async () => {
    const run = vi.fn().mockResolvedValueOnce(partial("first")).mockResolvedValueOnce(partial("second"));
    const result = await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run, checkEvidence: insufficientCheck });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.result.items.map(item => item.id)).toEqual(["first", "second"]);
    expect(result.result.selection.selectedCount).toBe(2);
    expect(result.trace.stopReason).toBe("coverage_retry_complete");
    expect(run.mock.calls[1][0].scopes).toEqual(plan.scopes);
  });
  it("never bypasses denied evidence even when the checker requests more", async () => {
    const first = { ...partial("first"), denied: [{ id: "private", reason: "no_grant" }] };
    const run = vi.fn().mockResolvedValue(first);
    await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run, checkEvidence: insufficientCheck });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("shadow judgments cannot cause a supplemental query", async () => {
    const run = vi.fn().mockResolvedValue(partial("first"));
    await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run,
      checkEvidence: async () => ({ ...(await insufficientCheck()), mode: "shadow" }) });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("treats uncertain coverage as eligible for one bounded supplement", async () => {
    const run = vi.fn().mockResolvedValueOnce(partial("first")).mockResolvedValueOnce(partial("second"));
    await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run,
      checkEvidence: async () => ({ ...(await insufficientCheck()), coverage: [{ question: "detail", support: 0.5 }] }) });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("removes first-attempt evidence denied by the second permission check", async () => {
    const run = vi.fn().mockResolvedValueOnce(partial("first")).mockResolvedValueOnce({ ...partial("second"), denied: [{ id: "first", reason: "revoked" }] });
    const result = await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run, checkEvidence: insufficientCheck });
    expect(result.result.items.map(item => item.id)).toEqual(["second"]);
  });
  it("retries once, preserving every non-query constraint and the original terms", async () => {
    const second = { ...empty(), contextLogId: "second", routeResults: [{ status: "executed", count: 1 }] };
    const run = vi.fn().mockResolvedValueOnce(empty()).mockResolvedValueOnce(second);
    const result = await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]).toEqual([{ ...plan, searchTerms: ["alpha", "delay", "postponement"], queryRetry: undefined }, plan.queryRetry!.query]);
    expect(result.result).toBe(second);
    expect(result.trace).toMatchObject({ attempts: 2, stopReason: "results_available", contextLogIds: ["first", "second"] });
  });
  it.each([
    { patch: { denied: [{ id: "private", reason: "no_grant" }] }, stop: "access_denied" },
    { patch: { omitted: [{ id: "old", reason: "expired" }] }, stop: "candidates_filtered" },
    { patch: { routeResults: [{ status: "failed", count: 0 }] }, stop: "source_unavailable" },
    { patch: { routeResults: [{ status: "executed", count: 1 }] }, stop: "results_available" },
  ])("does not reinterpret $stop as missing evidence", async ({ patch, stop }) => {
    const run = vi.fn().mockResolvedValue({ ...empty(), ...patch });
    const { trace } = await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(trace.stopReason).toBe(stop);
  });
  it("keeps a boundary-only result without initiating a second search", async () => {
    const first = empty();
    first.items.push({ id: "boundary", ownerId: "alpha", ownerType: "work", memoryType: "boundary", subject: "Rule", content: "Do not send", evidenceRefs: [], score: 100, reasons: [] });
    const run = vi.fn().mockResolvedValue(first);
    expect((await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run })).result).toBe(first);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("stops after the second empty result", async () => {
    const run = vi.fn().mockResolvedValue(empty());
    const { trace } = await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run });
    expect(run).toHaveBeenCalledTimes(2);
    expect(trace.stopReason).toBe("empty_after_retry");
  });
  it("retains first result on retry failure without leaking provider errors", async () => {
    const first = empty();
    const run = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("secret provider detail"));
    const result = await runBoundedRecall({ originalQuery: request.taskIntent, plan, enabled: true, run });
    expect(result.result).toBe(first);
    expect(result.trace.stopReason).toBe("retry_failed");
    expect(JSON.stringify(result)).not.toContain("secret provider");
  });
  it.each([false, true])("avoids repeated identical searches (enabled=%s)", async enabled => {
    const run = vi.fn().mockResolvedValue(empty());
    const duplicate = { ...plan, queryRetry: { ...plan.queryRetry!, searchTerms: ["alpha"] } };
    const { trace } = await runBoundedRecall({ originalQuery: request.taskIntent, plan: duplicate, enabled, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(trace.stopReason).toBe(enabled ? "unchanged_terms" : "disabled");
  });
  it("rejects malformed rewrites and strips attempts to mutate constraints", () => {
    const raw = { query: "alpha postponed", searchTerms: ["postponed", 3], reason: "alias", scopes: [{ type: "global" }], includeCandidates: true };
    const sanitized = sanitizeBrainRecallPlan(request, { queryRetry: raw as any });
    expect(sanitized.queryRetry).toEqual({ query: "alpha postponed", searchTerms: ["postponed"], reason: "alias" });
    expect(sanitized.scopes).toEqual([{ type: "work", workId: "alpha" }]);
    expect(sanitized.includeCandidates).toBe(false);
    expect(sanitizeBrainRecallPlan(request, { queryRetry: { ...raw, query: request.taskIntent } as any }).queryRetry).toBeUndefined();
    expect(sanitizeBrainRecallPlan(request, { queryRetry: { ...raw, searchTerms: "bad" } as any }).queryRetry).toBeUndefined();
  });
});
