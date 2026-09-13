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
