import { describe, expect, it } from "vitest";
import { executePlanSchema, legacyRebaseSchema, planVersionSchema, planDigest, planPayloadSchema } from "@/lib/memory/plans/contracts";
import { persistedExactSchema } from "@/lib/memory/context/persisted-exact-contracts";
import { nativeAgentPlanToPart } from "@/lib/ai/native-agent-plan-part";
const userId = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333";
describe("durable plan approval boundary", () => {
  it("binds actual database timestamps in legacy CAS tokens", () => {
    expect(planDigest({ updatedAt: new Date("2026-10-20T00:00:00Z") })).not.toBe(planDigest({ updatedAt: new Date("2026-10-20T01:00:00Z") }));
  });
  it("preserves plan identity across the real optional-field JSON storage boundary", () => {
    const plan = planPayloadSchema.parse({ id: "actual-sdk-plan", goal: "Read controlled sources", notes: undefined,
      steps: [{ id: "read", description: "Read", status: "pending" }], createdAt: new Date("2026-10-20T00:00:00Z") });
    const stored = JSON.parse(JSON.stringify(plan));
    expect(planDigest(plan)).toBe(planDigest(stored));
    expect(planDigest({ evidence: [undefined] })).toBe(planDigest({ evidence: [null] }));
    expect(planDigest({ evidence: Array(1) })).toBe(planDigest({ evidence: [null] }));
  });
  it("normalizes UUID identity casing without altering plan identifiers or private text", () => {
    const input = executePlanSchema.parse({ planId: "PlanCaseSensitive", expectedVersion: "mplan1:" + "a".repeat(64),
      commandId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", taskId: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" });
    expect(input.commandId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(input.taskId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(input.planId).toBe("PlanCaseSensitive"); expect(planDigest({ text: "PrivateABC" })).not.toBe(planDigest({ text: "Privateabc" }));
  });
  it("requires both the displayed version and an idempotency command", () => {
    expect(executePlanSchema.safeParse({ planId: "old-plan" }).success).toBe(false);
    expect(executePlanSchema.safeParse({ planId: "p", expectedVersion: "mplan1:" + "a".repeat(64), commandId: id, userId }).success).toBe(false);
    expect(planVersionSchema.safeParse("legacyplan1:" + "a".repeat(64)).success).toBe(false);
  });
  it("does not accept a legacy prompt as retrospective source verification", () => {
    const input = { commandId: id, expectedLegacyVersion: "legacyplan1:" + "a".repeat(64), inputPrompt: "Current reviewed objective", sourceReceiptIds: [] };
    expect(legacyRebaseSchema.safeParse(input).success).toBe(false);
    expect(legacyRebaseSchema.safeParse({ ...input, confirmed: true }).success).toBe(true);
    expect(legacyRebaseSchema.safeParse({ ...input, confirmed: true, originalPrompt: "unknown legacy cache" }).success).toBe(false);
  });
  it("requires a complete owner policy in persisted receipts and rejects Work capability borrowing", () => {
    const row = { schemaVersion: "memory-exact-use.v1", refs: [{ kind: "memory", id, revision: "bmrv1:actual" }] };
    expect(persistedExactSchema.safeParse(row).success).toBe(false);
    const policy = { requester: { type: "chat", userId }, accessMode: "owner_override", purpose: "source_read" };
    expect(persistedExactSchema.safeParse({ ...row, policy }).success).toBe(true);
    expect(persistedExactSchema.safeParse({ ...row, policy: { ...policy, sourceCapability: "wechatListRecordedMessages" } }).success).toBe(false);
    expect(persistedExactSchema.safeParse({ ...row, policy: { ...policy, requester: { type: "work", userId, id } } }).success).toBe(false);
    expect(persistedExactSchema.safeParse({ ...row, policy, refs: [{ kind: "plan", id, revision: "mplan1:old" }] }).success).toBe(false);
  });
  it("preserves the actual server lineage alongside the proposal for the approval button", () => {
    const lineage = { version: "mplan1:" + "a".repeat(64), revision: 1, state: "ready", origin: "generated", sourceCount: 2, expiresAt: "2026-10-20T20:00:00.000Z" };
    const part = nativeAgentPlanToPart({ id: "p", goal: "Review", steps: [], createdAt: new Date() }, lineage);
    expect(part.data.sourceLineage).toEqual(lineage);
    expect(part.data.approvalStatus).toBe("pending_approval");
  });
});
