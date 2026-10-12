import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => {
  const inArray = vi.fn((column: unknown, values: unknown[]) => ({ op: "inArray", column, values }));
  const where = vi.fn();
  const returning = vi.fn(async () => []);
  const limit = vi.fn(async () => []);
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn((value: unknown) => { where(value); return { returning }; }) })) }));
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn((value: unknown) => { where(value); return { orderBy: vi.fn(() => ({ limit })) }; }) })) }));
  return { inArray, where, returning, limit, update, select };
});
vi.mock("drizzle-orm", () => ({
  inArray: query.inArray,
  and: (...args: unknown[]) => ({ op: "and", args }), or: (...args: unknown[]) => ({ op: "or", args }),
  eq: (left: unknown, right: unknown) => ({ op: "eq", left, right }), lt: (left: unknown, right: unknown) => ({ op: "lt", left, right }),
  lte: (left: unknown, right: unknown) => ({ op: "lte", left, right }), asc: (column: unknown) => ({ op: "asc", column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@/lib/db/client", () => {
  const db = { update: query.update, select: query.select, transaction: async (work: (tx: unknown) => unknown) => work(db) };
  return { db, withDatabaseTransaction: vi.fn() };
});
vi.mock("@/lib/db/schema", () => ({ interactionProcessingJobs: {
  id: "jobs.id", userId: "jobs.user_id", status: "jobs.status", attempts: "jobs.attempts", scheduledAt: "jobs.scheduled_at", priority: "jobs.priority",
}, interactionEvents: {} }));
vi.mock("@/lib/db/serialization", () => ({ deserializeJson: (value: unknown) => value, serializeJson: (value: unknown) => value }));
vi.mock("@/lib/knowledge-pipeline/source-policies", () => ({ lockInteractionSourcePolicies: vi.fn() }));

import { claimInteractionProcessingJob, listRunnableInteractionProcessingJobs } from "@/lib/interactions/processing-jobs";
import { INTERACTION_PROCESSING_JOB_CLAIM_POLICY_VERSION, INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES } from "@/lib/interactions/processing-job-policy";

describe("shared current processing-job candidate policy", () => {
  beforeEach(() => vi.clearAllMocks());
  it("exports an immutable necessary-state tuple and a distinct version", () => {
    expect(INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES).toEqual(["pending", "failed", "resume_pending"]);
    expect(Object.isFrozen(INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES)).toBe(true);
    expect(INTERACTION_PROCESSING_JOB_CLAIM_POLICY_VERSION).toBe("interaction-processing-claim-policy.v1");
  });
  it("executes both actual service builders with the shared necessary states and unchanged owner, schedule and attempts predicates", async () => {
    const now = new Date("2026-10-04T00:00:00.000Z");
    await claimInteractionProcessingJob({ userId: "owner", jobId: "job", now });
    await listRunnableInteractionProcessingJobs({ userId: "owner", now });
    expect(query.inArray.mock.calls.filter(([column]) => column === "jobs.status").map(([, values]) => values))
      .toEqual([INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES, INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES]);
    for (const [where] of query.where.mock.calls) {
      expect(where.args).toEqual(expect.arrayContaining([
        { op: "eq", left: "jobs.user_id", right: "owner" },
        { op: "lte", left: "jobs.scheduled_at", right: now },
        { op: "or", args: [{ op: "eq", left: "jobs.status", right: "resume_pending" }, { op: "lt", left: "jobs.attempts", right: 3 }] },
      ]));
    }
    expect(query.limit).toHaveBeenCalledWith(20);
    expect(query.returning).toHaveBeenCalledTimes(1);
  });
});
