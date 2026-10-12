import { describe, expect, it, vi } from "vitest";
import type { ToolConstruction } from "@/lib/ai/runtime/answer-evidence-contract";
import { answerTextHash } from "@/lib/ai/runtime/answer-evidence-core";
import { canonicalPlatformAnswerSource, selectPlatformAnswerContract, type PlatformAnswerSessionOptions } from "@/lib/ai/runtime/platform-answer-contract";
import { createPlatformAnswerSession } from "@/lib/ai/runtime/platform-answer-session";
import { platformPublishedRecordFacts } from "@/lib/ai/platform-published-record-facts";
import { PlatformReadHandleRegistry, platformWholeFieldKeys } from "@/lib/ai/platform-read-handle-registry";
import { createPlatformFieldPager, commitPlatformFieldPageDelivery, formatPlatformFieldPageResult, type PlatformFieldPageResult } from "@/lib/ai/platform-field-pages";

// Synthetic source identities intentionally collide across independently named tables.
const id = "7f222222-2222-4222-8222-222222222222";
const workshopId = "8f333333-3333-4333-8333-333333333333";
const at = "2026-09-15T04:32:10.000Z";
const identity = { ownerId: "synthetic-owner", requester: { kind: "chat" as const, id: "synthetic-chat" }, turnId: "synthetic-workshop-turn" };
const parent = "a".repeat(64);
const terminal = { schemaVersion: "agent-runtime-terminal.v1" as const, status: "completed" as const, cleanupStatus: "completed" as const };
const question = `workshop_runs ${id} 的运行结果和错误原记录是什么？`;

function construction(result: unknown, toolCallId = "synthetic-read", modelText = JSON.stringify(result)): ToolConstruction {
  return { toolName: "platformRecall", toolCallId, params: { question: "stored fields" }, result, modelText,
    trace: { type: "tool_result", title: "completed", detail: null, toolName: "platformRecall", toolUseId: toolCallId,
      status: "completed", timestamp: at, durationMs: 1,
      metadata: { decision: "allow", reason: "allowed", matchedRule: "platformRecall", deniedBeforeHandler: false } } };
}
function session(overrides: Partial<PlatformAnswerSessionOptions> = {}) {
  return createPlatformAnswerSession({ mode: "enforce_supported", ...identity, runtimeHash: "synthetic-runtime", policyHash: "synthetic-policy", question,
    timePolicy: { mode: "unconstrained" }, auditSink: async () => undefined, now: () => new Date(at), authorizeFinal: async () => true, ...overrides });
}
async function admit(s: ReturnType<typeof session>, c: ToolConstruction, mode: "complete" | "constructed" | "emitted" | "context" | "changed" = "complete") {
  await s.observeToolConstruction(c);
  if (mode === "complete" || mode === "emitted" || mode === "changed") await s.observeToolResult({ type: "tool_result", toolUseId: c.toolCallId,
    output: c.modelText, isError: false, toolResultDetails: { result: c.result, trace: c.trace } });
  if (mode === "complete" || mode === "context" || mode === "changed") await s.observeContextCommitted({ toolCallId: c.toolCallId, entryId: `entry-${c.toolCallId}`,
    modelText: mode === "changed" ? c.modelText + "changed" : c.modelText! });
}
function recordPage(source: string, fields: Record<string, unknown>, readHandles?: unknown[]) {
  return { recordRead: { status: "read", source, id, offset: 0, truncated: true, nextOffset: 100,
    content: "{partial raw source remains unread", contentHash: parent, observedAt: at,
    publishedFacts: platformPublishedRecordFacts({ source, id, parentContentHash: parent, fields: { id, ...fields } }), ...(readHandles ? { readHandles } : {}) } };
}
async function finish(s: ReturnType<typeof session>) { return s.finalize({ terminal, rawDraft: "MODEL_UNSUPPORTED_SUCCESS_AND_NO_FAILURE" }); }

describe("distinct workshop stored outcome contract", () => {
  it.each(["workshopRuns", "workshop_runs"])("binds the fixed %s source without a Loop substitute", source => {
    expect(canonicalPlatformAnswerSource(source)).toBe("workshopRuns");
    const plan = selectPlatformAnswerContract(`${source} ${id} 的运行结果和失败原因是什么？`)!;
    expect(plan).toMatchObject({ kind: "workshop_run_outcome", subject: { source: "workshopRuns", id }, readOnly: true });
    expect(plan.requirements.map(r => r.id)).toEqual(["workshopRuns.status", "workshopRuns.outputSummary", "workshopRuns.error"]);
  });
  it("preserves the original snapshot question while consuming only canonical fixed metadata", () => {
    const original = `请根据时间为 ${at} 的随题只读快照，查看 workshop_runs 中记录 ${id}：这次车间运行的结果是什么？记录是否说明了失败原因，具体怎样写的？`;
    const plan = selectPlatformAnswerContract(original)!;
    expect(plan.question).toBe(original); expect(plan.requestedSnapshotAt).toBe(at);
    expect(plan.requirements.map(r => r.id)).toEqual(["workshopRuns.status", "workshopRuns.outputSummary", "workshopRuns.error"]);
    expect(selectPlatformAnswerContract(original.replace(at, "2026-02-30T04:32:10.000Z"))).toBeNull();
    expect(selectPlatformAnswerContract(original.replace(at, "2026-09-15T04:32:10Z"))).toBeNull();
  });
  it("requires the association only when asked and does not promise workshop names", () => {
    expect(selectPlatformAnswerContract(question)?.requirements.some(r => r.id === "workshopRuns.workshopId")).toBe(false);
    const plan = selectPlatformAnswerContract(`workshopRuns ${id} 的结果和关联车间 ID 是什么？`)!;
    expect(plan.requirements.map(r => r.id)).toEqual(["workshopRuns.status", "workshopRuns.outputSummary", "workshopRuns.workshopId"]);
    expect(selectPlatformAnswerContract(`workshopRuns ${id} 的结果和关联车间名称是什么？`)?.requirements.some(r => r.id === "unassessed_clause")).toBe(true);
  });
  it("keeps explicit Loop, unknown objects, mutations and causal claims bounded", () => {
    expect(selectPlatformAnswerContract(`loopRuns ${id} 的结果是什么？`)?.subject?.source).toBe("loopRuns");
    expect(selectPlatformAnswerContract(`查看 workshop_runs ${id}，然后重跑`)).toBeNull();
    expect(selectPlatformAnswerContract(`结果是什么？\n对象：workshop_other（记录 ${id}）`)).toBeNull();
    expect(selectPlatformAnswerContract(`workshopRuns ${id} 的结果和真实根因是什么？`)?.requirements.some(r => r.id === "unassessed_causal_claim")).toBe(true);
  });
});

describe("workshop source-bound facts and deterministic result", () => {
  it("projects independent workshop identity, status, output and null error", () => {
    const projected = platformPublishedRecordFacts({ source: "workshop_runs", id, parentContentHash: parent,
      fields: { id, workshop_id: workshopId, status: "completed", output_summary: "Stored report, review remains pending.", error: null } })!;
    expect(projected.source).toBe("workshop_runs");
    expect(projected.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldKey: "workshopId", value: workshopId, complete: true }),
      expect.objectContaining({ fieldKey: "status", value: "completed", complete: true }),
      expect.objectContaining({ fieldKey: "outputSummary", value: "Stored report, review remains pending.", complete: true }),
      expect.objectContaining({ fieldKey: "error", value: null, status: "not_recorded", complete: true }),
    ]));
  });
  it.each([
    { status: "completed", error: null, expected: "未记录错误" },
    { status: "failed", error: "SYNTHETIC_DEPENDENCY_UNAVAILABLE", expected: "SYNTHETIC_DEPENDENCY_UNAVAILABLE" },
  ])("renders only recorded status and error for $status", async ({ status, error, expected }) => {
    const s = session(), output = "The worker produced a review proposal; no business acceptance was recorded.";
    await admit(s, construction(recordPage("workshopRuns", { workshopId, status, outputSummary: output, error })));
    const result = await finish(s);
    expect(result.questionComplete).toBe(true); expect(result.contractKind).toBe("workshop_run_outcome");
    expect(result.renderedText).toContain(output); expect(result.renderedText).toContain(expected);
    expect(result.renderedText).toContain("不证明业务验收");
    expect(result.renderedText).not.toContain("MODEL_UNSUPPORTED"); expect(result.renderedText).not.toContain("没有失败");
    expect(result.resolutions.find(r => r.requirementId === "workshopRuns.error")?.state).toBe(error === null ? "not_recorded" : "supported");
  });
  it("does not borrow an identically named Loop result under the same UUID", async () => {
    const s = session(); await admit(s, construction(recordPage("loopRuns", { status: "completed", outputSummary: "LOOP_SOURCE_DECOY", error: null })));
    const result = await finish(s); expect(result.questionComplete).toBe(false); expect(result.evidenceCoverage.supported).toBe(0);
    expect(result.renderedText).not.toContain("LOOP_SOURCE_DECOY");
  });
  it("does not convert an absent error into a null error", async () => {
    const s = session(); await admit(s, construction(recordPage("workshopRuns", { status: "completed", outputSummary: "Recorded proposal" })));
    const result = await finish(s); expect(result.questionComplete).toBe(false);
    expect(result.resolutions.find(r => r.requirementId === "workshopRuns.error")?.state).toBe("unknown");
    expect(result.renderedText).not.toContain("未记录错误");
  });
  it("rechecks the exact workshop source at closure and lets denial dominate", async () => {
    const authorize = vi.fn(async (_plan: Parameters<NonNullable<PlatformAnswerSessionOptions["authorizeFinal"]>>[0]) => false), s = session({ authorizeFinal: authorize });
    await admit(s, construction(recordPage("workshopRuns", { status: "completed", outputSummary: "NO_DISPLAY_AFTER_DENIAL", error: null })));
    const result = await finish(s); expect(authorize.mock.calls[0][0].finalAuthorizationSubjects).toEqual([{ source: "workshopRuns", id }]);
    expect(result.questionComplete).toBe(false); expect(result.evidenceCoverage.denied).toBe(3);
    expect(result.renderedText).not.toContain("NO_DISPLAY_AFTER_DENIAL");
  });
  it("keeps requested snapshot mismatches unknown", async () => {
    const s = session({ question: `请根据时间为 ${at} 的随题只读快照，${question}`, snapshotAt: "2026-09-15T04:33:10.000Z" });
    await admit(s, construction(recordPage("workshopRuns", { status: "completed", outputSummary: "OTHER_SNAPSHOT_REPORT", error: null })));
    const result = await finish(s); expect(result.questionComplete).toBe(false);
    expect(result.resolutions.every(r => r.reason === "requested_snapshot_not_matched")).toBe(true);
    expect(result.renderedText).not.toContain("OTHER_SNAPSHOT_REPORT");
  });
});

function pagingFixture() {
  const registry = new PlatformReadHandleRegistry(identity);
  const output = "SYNTHETIC_REPORT_START\n" + "q\\\"🙂".repeat(2000) + "\nSYNTHETIC_REPORT_END";
  const row = { source: "workshopRuns", id, fields: { id, workshopId, status: "completed", error: null, outputSummary: output } };
  const handle = registry.register({ source: row.source, id, fieldKey: "outputSummary", contentHash: parent });
  let allowed = true, version = parent;
  const readRecord = vi.fn(async () => row), authorize = vi.fn(async () => allowed);
  const pager = createPlatformFieldPager({ registry, identity, recordHash: () => version, authorize,
    observation: { kind: "live_read", observedAt: at } });
  const s = session({ resolveFieldPageReadHandle: h => registry.resolve(h, identity), authorizeFieldPageFinal: async b => allowed && b.source === "workshopRuns" && b.parentContentHash === version });
  return { registry, output, row, handle, readRecord, authorize, pager, s, setAllowed(value: boolean) { allowed = value; }, setVersion(value: string) { version = value; } };
}
async function readAll(f: ReturnType<typeof pagingFixture>, mode: "complete" | "constructed" | "emitted" | "context" | "changed" | "omit-middle") {
  await admit(f.s, construction(recordPage("workshopRuns", { workshopId, status: "completed", error: null, outputSummary: f.output }, [f.handle]), "discovery"));
  const pages: PlatformFieldPageResult[] = []; let cursor: string | undefined;
  do {
    const p = await f.pager.read({ readHandle: f.handle.readHandle, ...(cursor ? { cursor } : {}) }, f.readRecord); pages.push(p);
    expect(p.fieldPage.status).toBe("read_window");
    expect(formatPlatformFieldPageResult(p).length).toBeLessThanOrEqual(8000);
    const c = construction(p, `page-${pages.length}`, formatPlatformFieldPageResult(p));
    await admit(f.s, c, mode === "omit-middle" ? pages.length === 2 ? "emitted" : "complete" : mode);
    commitPlatformFieldPageDelivery(p);
    cursor = "nextCursor" in p.fieldPage ? p.fieldPage.nextCursor ?? undefined : undefined;
  } while (cursor);
  return pages;
}
describe("existing owner pager with distinct workshop source", () => {
  it("extends only the finite output field and preserves Loop verification scope", () => {
    expect(platformWholeFieldKeys("workshop_runs")).toEqual(["outputSummary"]);
    expect(platformWholeFieldKeys("loopRuns")).toContain("verificationResult");
    const registry = new PlatformReadHandleRegistry(identity);
    expect(() => registry.register({ source: "workshopRuns", id, fieldKey: "verificationResult", contentHash: parent })).toThrow();
    expect(registry.register({ source: "workshopRuns", id, fieldKey: "outputSummary", contentHash: parent }).nextRead).toBeDefined();
    registry.close();
  });
  it("requires contiguous exact emitted and core context commits before showing a long output", async () => {
    const f = pagingFixture();
    try {
      const pages = await readAll(f, "complete"), result = await finish(f.s);
      expect(pages.length).toBeGreaterThan(1); expect(result.questionComplete).toBe(true);
      expect(result.renderedText).toContain(f.output);
      expect(result.resolutions.find(r => r.requirementId === "workshopRuns.outputSummary")?.evidenceIds).toEqual(pages.map((_, i) => `${identity.turnId}:page-${i + 1}`));
      expect(f.readRecord).toHaveBeenCalledTimes(pages.length * 2); expect(f.authorize).toHaveBeenCalledTimes(pages.length * 3);
      expect(pages.every(p => p.hostFieldManifest?.binding.source === "workshopRuns")).toBe(true);
    } finally { f.pager.close(); f.registry.close(); }
  });
  it.each(["constructed", "emitted", "context", "changed", "omit-middle"] as const)("keeps long output partial under missing delivery: %s", async mode => {
    const f = pagingFixture();
    try { await readAll(f, mode); const result = await finish(f.s);
      expect(result.questionComplete).toBe(false); expect(result.renderedText).not.toContain(f.output);
      expect(result.resolutions.find(r => r.requirementId === "workshopRuns.outputSummary")?.state).toBe("unknown");
    } finally { f.pager.close(); f.registry.close(); }
  });
  it.each(["denied", "version", "wrong-source"] as const)("exposes %s gaps without consuming the valid continuation", async mode => {
    const f = pagingFixture();
    try {
      const first = await f.pager.read({ readHandle: f.handle.readHandle }, f.readRecord); commitPlatformFieldPageDelivery(first);
      if (!("nextCursor" in first.fieldPage) || !first.fieldPage.nextCursor) throw Error("synthetic_continuation_required");
      const cursor = first.fieldPage.nextCursor, sourceCalls = f.readRecord.mock.calls.length;
      if (mode === "denied") f.setAllowed(false);
      if (mode === "version") f.setVersion("b".repeat(64));
      const p = await f.pager.read({ readHandle: f.handle.readHandle, cursor }, mode === "wrong-source" ? async () => ({ ...f.row, source: "loopRuns" }) : f.readRecord);
      expect(p.fieldPage).toMatchObject({ status: mode === "denied" ? "permission_denied" : mode === "version" ? "version_changed" : "invalid_source_identity", content: "" });
      if (mode === "denied") expect(f.readRecord.mock.calls.length).toBe(sourceCalls);
      f.setAllowed(true); f.setVersion(parent);
      const recovered = await f.pager.read({ readHandle: f.handle.readHandle, cursor }, f.readRecord);
      expect(recovered.fieldPage).toMatchObject({ status: "read_window", offset: "end" in first.fieldPage ? first.fieldPage.end : -1 });
    } finally { f.pager.close(); f.registry.close(); }
  });
});
