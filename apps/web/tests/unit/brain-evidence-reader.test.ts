import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions) => ({ op: "and", conditions })),
  eq: vi.fn((left, right) => ({ op: "eq", left, right })),
  inArray: vi.fn((left, values) => ({ op: "inArray", left, values })),
  or: vi.fn((...conditions) => ({ op: "or", conditions })),
}));

vi.mock("@/lib/db/client", () => ({
  db: {
    select: mocks.dbSelect,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  brainObservations: { id: "observation.id", userId: "observation.userId" },
  interactionEvents: { id: "interaction.id", userId: "interaction.userId" },
  rawMessages: {
    id: "raw.id",
    messageId: "raw.messageId",
    userId: "raw.userId",
  },
  workshopEvents: { id: "workshop.id", workshopId: "workshop.workshopId" },
  workshops:{id:'workshops.id',userId:'workshops.userId'},
}));

import { resolveBrainEvidenceRefs } from "@/lib/brain/evidence-reader";

function selectRows(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(async () => rows),
    })),
  };
}

describe("brain evidence reader", () => {
  it("reads typed observations with an owner filter and leaves missing refs unresolved", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const missing = "22222222-2222-4222-8222-222222222222";
    const where = vi.fn(async (_condition: unknown) => [{ id, sourceId: "repo:architecture@hash", sourceType: "repository_snapshot", content: "Original contract", observedAt: new Date("2026-09-19Z"), contentHash: "hash", metadata: { path: "docs/architecture.md" } }]);
    mocks.dbSelect.mockReturnValue({ from: vi.fn(() => ({ where })) });
    const results = await resolveBrainEvidenceRefs({ userId: "user-1", evidenceRefs: [`brain-observation:${id}`, `brain-observation:${missing}`, "brain-observation:../../secret"] });
    expect(results[0]).toMatchObject({ status: "resolved", source: "brain_observation", content: "Original contract" });
    expect(results.slice(1).map(r => r.status)).toEqual(["unresolved", "unresolved"]);
    expect(where.mock.calls[0][0]).toMatchObject({ op: "and", conditions: expect.arrayContaining([{ op: "eq", left: "observation.userId", right: "user-1" }]) });
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves legacy raw message evidence refs from raw message storage", async () => {
    mocks.dbSelect.mockReturnValue(
      selectRows([
        {
          id: 42,
          messageId: "msg-42",
          userId: "user-1",
          platform: "wechat",
          botId: "bot-1",
          channel: "Dad",
          person: "Dad",
          timestamp: 1782000000000,
          content: "Send the trading plan before market open.",
          memoryStage: "long",
          metadata: { importedFrom: "raw_messages" },
        },
      ]),
    );

    const [resolved] = await resolveBrainEvidenceRefs({
      userId: "user-1",
      evidenceRefs: ["legacy-raw-message:42"],
    });

    expect(resolved).toMatchObject({
      id: "legacy-raw-message:42",
      status: "resolved",
      source: "raw_message",
      sourceSemantics: "evidence_source",
      title: "Dad",
      content: "Send the trading plan before market open.",
      metadata: {
        rawMessageId: "42",
        messageId: "msg-42",
        platform: "wechat",
        channel: "Dad",
        person: "Dad",
        memoryStage: "long",
        rawMetadata: { importedFrom: "raw_messages" },
      },
    });
    expect(resolved?.createdAt).toBe("2026-06-21T00:00:00.000Z");
  });
  it('keeps invalid timestamps unknown without throwing or inventing a time',async()=>{
    mocks.dbSelect.mockReturnValue(selectRows([{id:42,messageId:'msg-42',content:'original evidence',timestamp:1e30}]));
    const [result]=await resolveBrainEvidenceRefs({userId:'user-1',evidenceRefs:['raw-message:42']});
    expect(result.status).toBe('resolved');expect(result.createdAt).toBeNull();
  });
});
