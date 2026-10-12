import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { inspectAnswerBodyMirror } from "@/lib/ai/runtime/answer-body-mirror";
const mocks = vi.hoisted(() => ({ select: vi.fn(), from: vi.fn(), join: vi.fn(), where: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select }, withDatabaseTransaction: vi.fn() }));
import { getAgentAnswerBodyMirror } from "@/lib/db/agent-answer-audits";
const id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const input = { turnId: id, assistantMessageId: id, chatId: id, finalText: "正文\n完整。", status: "completed", observedAt: "2026-10-04T00:00:00Z" };
const parts = [{ type: "text", text: "正文\n" }, { type: "text", content: "完整。" }, { type: "data-answerEvidence", data: { turnId: id } }];
const stored = { id, chatId: id, role: "assistant", parts };

describe("answer body mirror read-time observation", () => {
  it("confirms only the entire saved text and exactly one matching turn reference", () => {
    expect(inspectAnswerBodyMirror({ ...input, stored })).toEqual({ schemaVersion: "answer-body-mirror.v1", state: "stored_matching", reason: "exact_body_and_turn_reference", observedAt: input.observedAt });
    for (const changed of [parts.slice(0, 2), [...parts, parts[2]], [...parts, { type: "text", text: "additional" }],
      [parts[0], { type: "text", text: "完整。 " }, parts[2]], [parts[0], parts[1], { type: "data-answerEvidence", data: { turnId: owner } }]]) {
      expect(inspectAnswerBodyMirror({ ...input, stored: { ...stored, parts: changed } }).state).toBe("not_confirmed");
    }
  });
  it("keeps pending saves, absent messages and wrong identities unconfirmed", () => {
    expect(inspectAnswerBodyMirror(input).reason).toBe("message_not_found");
    expect(inspectAnswerBodyMirror({ ...input, status: "running", stored }).reason).toBe("awaiting_final");
    expect(inspectAnswerBodyMirror({ ...input, finalText: undefined, stored }).reason).toBe("awaiting_final");
    for (const changed of [{ ...stored, id: owner }, { ...stored, chatId: owner }, { ...stored, role: "user" }]) {
      expect(inspectAnswerBodyMirror({ ...input, stored: changed }).state).toBe("not_confirmed");
    }
  });
  it("does not truncate oversized or malformed parts or fabricate storage success", () => {
    for (const value of [null, {}, [null], [{ type: "text", text: 1 }], Array(1025).fill({ type: "text", text: "" }), [{ type: "text", text: "x".repeat(64001) }]]) {
      expect(inspectAnswerBodyMirror({ ...input, stored: { ...stored, parts: value } })).toMatchObject({ state: "unavailable", reason: "stored_parts_invalid" });
    }
    expect(inspectAnswerBodyMirror({ ...input, stored, unavailable: true })).toMatchObject({ state: "unavailable", reason: "storage_read_unavailable" });
  });
});

describe("owner-scoped mirror database read", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.select.mockReturnValue({ from: mocks.from }); mocks.from.mockReturnValue({ innerJoin: mocks.join });
    mocks.join.mockReturnValue({ where: mocks.where }); mocks.where.mockReturnValue({ limit: mocks.limit });
    mocks.limit.mockResolvedValue([stored]);
  });
  const summary = { ...input, status: "completed" as const };
  it("uses current owner, exact chat, message and assistant role predicates", async () => {
    expect(await getAgentAnswerBodyMirror({ ownerId: owner, summary })).toMatchObject({ state: "stored_matching" });
    const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]);
    expect(query.params).toEqual([owner, id, id, id, "assistant"]);
    expect(query.sql).toContain('"Chat"."userId"');
    expect(query.sql).toContain('"Message_v2"."id"');
    expect(mocks.limit).toHaveBeenCalledWith(1);
  });
  it("skips storage before a final body and sanitizes unavailable reads", async () => {
    expect(await getAgentAnswerBodyMirror({ ownerId: owner, summary: { ...summary, status: "running" } })).toMatchObject({ state: "not_confirmed", reason: "awaiting_final" });
    expect(mocks.select).not.toHaveBeenCalled();
    mocks.limit.mockRejectedValue(new Error("postgres://secret"));
    const result = await getAgentAnswerBodyMirror({ ownerId: owner, summary });
    expect(result.state).toBe("unavailable"); expect(JSON.stringify(result)).not.toContain("secret");
    expect(await getAgentAnswerBodyMirror({ ownerId: "invalid", summary })).toMatchObject({ state: "unavailable" });
  });
});
