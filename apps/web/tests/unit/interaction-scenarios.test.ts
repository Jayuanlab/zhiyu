import { describe, expect, it } from "vitest";
import { buildInteractionScenarioSnapshots } from "@/lib/interactions/scenarios";

describe("interaction scenario snapshots", () => {
  it("groups interaction candidates into L2 scenario state drafts", () => {
    const drafts = buildInteractionScenarioSnapshots({
      observedAt: new Date("2026-09-03T08:00:00.000Z"),
      items: [
        {
          id: "note-1",
          kind: "note",
          title: "项目背景",
          content: "Alice 提到合同仍按上次报价推进。",
          sourceEventIds: ["event-1"],
          metadata: {
            scenarioHints: [
              { type: "project", key: "contract-alpha", title: "合同 Alpha" },
            ],
          },
        },
        {
          id: "task-1",
          kind: "task",
          title: "确认合同条款",
          content: "明天前确认合同条款。",
          status: "candidate",
          sourceEventIds: ["event-2"],
          metadata: {
            scenarioHints: [
              { type: "project", key: "contract-alpha", title: "合同 Alpha" },
            ],
          },
        },
        {
          id: "memory-1",
          kind: "memory",
          subject: "Alice",
          content: "Alice 偏好先看结构化报价。",
          confidence: 90,
          sourceEventIds: ["event-3"],
          metadata: {
            scenarioHints: [
              { type: "project", key: "contract-alpha", title: "合同 Alpha" },
            ],
          },
        },
      ],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.scenarioType).toBe("project");
    expect(drafts[0]?.scenarioKey).toBe("contract-alpha");
    expect(drafts[0]?.content.openLoops).toEqual([
      {
        id: "task-1",
        title: "确认合同条款",
        status: "candidate",
        sourceEventIds: ["event-2"],
      },
    ]);
    expect(drafts[0]?.sourceEventIds).toEqual([
      "event-1",
      "event-2",
      "event-3",
    ]);
    expect(drafts[0]?.metadata.layer).toBe("L2");
    expect(drafts[0]?.metadata.scenarioApplicability).toBe("scoped");
    expect(drafts[0]?.metadata.scenarioKeys).toEqual(["project:contract-alpha"]);
  });

  it("ignores invalid or missing scenario hints", () => {
    const drafts = buildInteractionScenarioSnapshots({
      items: [
        {
          id: "note-1",
          kind: "note",
          content: "无场景线索。",
          sourceEventIds: ["event-1"],
          metadata: {},
        },
      ],
    });

    expect(drafts).toEqual([]);
  });
});
