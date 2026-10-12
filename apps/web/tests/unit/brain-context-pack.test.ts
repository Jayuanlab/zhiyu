import { describe, expect, it } from "vitest";
import { getBrainMemoryRevisionVersion } from "@/lib/brain/memory-revision-version";
import {
  buildBrainContextPack,
  explainBrainContextPack,
  summarizeBrainContextPackForTrace,
  type BrainAccessGrant,
  type BrainMemory,
  type BrainRecallProfile,
  type BrainRequester,
} from "@/lib/brain";

const now = new Date("2026-08-10T01:00:00.000Z");

function memory(id: string, overrides: Partial<BrainMemory> = {}): BrainMemory {
  return {
    id,
    userId: "user-1",
    scope: { type: "workshop", workshopId: "trader" },
    ownerType: "work",
    ownerId: "trader-work",
    memoryType: "fact",
    subject: "General note",
    content: "General workshop memory.",
    status: "active",
    confidence: 70,
    evidenceRefs: [`event-${id}`],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

const requester: BrainRequester = {
  type: "work",
  userId: "user-1",
  id: "trader-work",
  workshopId: "trader",
};

describe("brain context pack", () => {
  it("captures the stored revision without ephemeral pending annotations", () => {
    const stored = memory("selected", { content: "Accepted basis", metadata: { source: "fixture" } });
    const annotated = { ...stored, metadata: { ...stored.metadata, pendingMemoryUpdate: { requiresOwnerDecision: true, basis: "current_stored_version" } } };
    const pack = buildBrainContextPack({ requester, taskIntent: "Accepted basis", now, memories: [annotated] });
    const expected = getBrainMemoryRevisionVersion(stored);
    expect(pack.items[0]?.revisionVersion).toBe(expected);
    expect(summarizeBrainContextPackForTrace(pack).selected[0]?.revisionVersion).toBe(expected);
    expect(annotated.metadata.pendingMemoryUpdate).toBeDefined();
    const changed = buildBrainContextPack({ requester, taskIntent: "Accepted basis", now, memories: [{ ...stored, content: "Corrected basis" }] });
    expect(changed.items[0]?.revisionVersion).not.toBe(expected);
  });
  it("warns about pending updates without recalling proposal text or denied conflicts", () => {
    const pendingMetadata = { pendingMemoryUpdate: { requiresOwnerDecision: true, basis: "current_stored_version" } };
    const pack = buildBrainContextPack({ requester, taskIntent: "report format", now,
      memories: [memory("base", { content: "Accepted format", metadata: pendingMetadata }),
        memory("proposal", { content: "Unapproved replacement", status: "candidate" }),
        memory("denied", { ownerId: "other-work", scope: { type: "work", workId: "other-work" }, metadata: pendingMetadata })] });
    expect(pack.items.map(item => item.id)).toEqual(["base"]);
    expect(pack.items[0]?.warnings).toContain("memory_update_pending");
    expect(pack.warnings).toContainEqual(expect.objectContaining({ code: "memory_update_pending", memoryIds: ["base"], requiresCurrentObservation: true }));
    expect(JSON.stringify(pack.items)).not.toContain("Unapproved replacement");
    expect(pack.omitted).toContainEqual({ id: "proposal", reason: "candidate_requires_review" });
    expect(pack.denied.map(item => item.id)).toContain("denied");
    const clean = buildBrainContextPack({ requester, taskIntent: "report format", now, memories: [memory("base")] });
    expect(clean.warnings?.some(warning => warning.code === "memory_update_pending")).toBe(false);
  });

  it("uses source observation time rather than revision time for freshness", () => {
    const pack = buildBrainContextPack({requester, taskIntent: "current account state", now,
      memories: [memory("revised", {metadata: {observationTime: "2026-01-01T00:00:00.000Z",
        revision: {createdAt: now.toISOString()}}, updatedAt: now.toISOString()})]});
    expect(pack.items[0]?.freshness).toMatchObject({basis: "observation", bucket: "historical"});
    expect(pack.items[0]?.warnings).toContain("historical_for_current_state");
    const unknown = buildBrainContextPack({requester, taskIntent: "current account state", now,
      memories: [memory("unknown", {metadata: {observationTimeUnknown: true, revision: {createdAt: now.toISOString()}}})]});
    expect(unknown.items[0]?.freshness?.bucket).toBe("unknown");
    expect(unknown.warnings).toContainEqual(expect.objectContaining({code: "observation_time_unknown", requiresCurrentObservation: true}));
  });

  it("boosts relevant recent corrections within scope without displacing boundaries", () => {
    const correction = memory("correction", {memoryType: "preference", subject: "report format", content: "report format should be detailed",
      confidence: 60, metadata: {revision: {createdAt: now.toISOString()}}});
    const pack = buildBrainContextPack({requester, taskIntent: "report format", now, maxItems: 2,
      memories: [correction, memory("boundary", {memoryType: "boundary", confidence: 10}),
        memory("generic", {memoryType: "preference", confidence: 100}),
        memory("denied", {...correction, id: "denied", ownerId: "other-work", scope: {type: "work", workId: "other-work"}}),
        memory("retired", {...correction, id: "retired", status: "superseded"}),
        memory("candidate", {...correction, id: "candidate", status: "candidate"})]});
    expect(pack.items.map(item => item.id)).toEqual(["boundary", "correction"]);
    expect(pack.items[1]?.reasons).toContain("relevant_recent_revision");
    expect(pack.items[1]?.reasons).toContain("reserved_relevant_revision");
    expect(pack.denied.map(item => item.id)).toContain("denied");
    const unrelated = buildBrainContextPack({requester, taskIntent: "garden", now, memories: [correction]});
    expect(unrelated.items[0]?.reasons).not.toContain("relevant_recent_revision");
    const later = buildBrainContextPack({requester, taskIntent: "report format", now: new Date(now.getTime() + 8 * 24 * 3_600_000), memories: [correction]});
    expect(later.items[0]?.reasons).not.toContain("relevant_recent_revision");
  });

  it("reserves only two correction slots even when unrelated plans score higher", () => {
    const corrected = (id: string) => memory(id, {memoryType: "preference", confidence: 1,
      subject: "report format", metadata: {revision: {createdAt: now.toISOString()}}});
    const pack = buildBrainContextPack({requester, taskIntent: "report format", now, maxItems: 3,
      memories: [corrected("c1"), corrected("c2"), corrected("c3"), memory("plan", {memoryType: "plan", confidence: 100})]});
    expect(pack.items.map(item => item.id)).toEqual(["c1", "c2", "plan"]);
  });
  it("prioritizes boundaries and plans for a work loop", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "pre market trading plan and risk boundary",
      now,
      maxItems: 2,
      memories: [
        memory("generic", {
          memoryType: "fact",
          subject: "Chatty note",
          content: "A low value observation.",
          confidence: 95,
        }),
        memory("plan", {
          memoryType: "plan",
          subject: "Monday trading plan",
          content: "Run pre market observation before trading.",
          confidence: 80,
        }),
        memory("boundary", {
          memoryType: "boundary",
          subject: "Risk boundary",
          content: "Never trade outside the paper account guardrails.",
          confidence: 75,
          status: "verified",
        }),
      ],
    });

    expect(pack.interfaceVersion).toBe("brain-context.v1");
    expect(pack.items.map((item) => item.id)).toEqual(["boundary", "plan"]);
    expect(pack.items[0]?.reasons).toContain("type:boundary");
    expect(pack.items[1]?.reasons).toContain("type:plan");
  });

  it("matches Chinese task intent against Chinese memory text", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent:
        "\u76d8\u524d\u5206\u6790\u6c47\u5ddd\u6280\u672f\u662f\u5426\u9700\u8981\u51cf\u4ed3",
      now,
      maxItems: 1,
      memories: [
        memory("generic", {
          memoryType: "fact",
          subject: "High confidence generic note",
          content: "General market note without the target stock.",
          confidence: 95,
        }),
        memory("huichuan", {
          memoryType: "insight",
          subject: "\u6c47\u5ddd\u6280\u672f",
          content:
            "\u6c47\u5ddd\u6280\u672f\u6536\u5230 break_warning\uff0c\u6a21\u62df\u4ed3\u4ecd\u6709\u6d6e\u76c8\uff0c\u9700\u8981\u8bc4\u4f30\u662f\u5426\u51cf\u4ed3\u3002",
          confidence: 55,
          tags: ["break_warning", "\u51cf\u4ed3"],
        }),
      ],
    });

    expect(pack.items.map((item) => item.id)).toEqual(["huichuan"]);
    expect(pack.items[0]?.reasons).not.toContain("profile:trading");
    expect(
      pack.items[0]?.reasons.some((reason) =>
        reason.startsWith("token_match:"),
      ),
    ).toBe(true);
  });

  it("keeps domain recall profiles injectable instead of hard-coding them in Brain", () => {
    const tradingProfile: BrainRecallProfile = {
      id: "trading",
      matchTerms: ["\u51cf\u4ed3", "\u6a21\u62df\u4ed3", "break_warning"],
      memoryTypeBoosts: {
        insight: 80,
        plan: 30,
        boundary: 30,
      },
    };

    const pack = buildBrainContextPack({
      requester,
      taskIntent:
        "\u76d8\u524d\u5206\u6790\u6c47\u5ddd\u6280\u672f\u662f\u5426\u9700\u8981\u51cf\u4ed3",
      now,
      maxItems: 1,
      recallProfiles: [tradingProfile],
      memories: [
        memory("generic", {
          memoryType: "fact",
          subject: "High confidence generic note",
          content: "General market note without the target stock.",
          confidence: 95,
        }),
        memory("huichuan", {
          memoryType: "insight",
          subject: "\u6c47\u5ddd\u6280\u672f",
          content:
            "\u6c47\u5ddd\u6280\u672f\u6536\u5230 break_warning\uff0c\u6a21\u62df\u4ed3\u4ecd\u6709\u6d6e\u76c8\uff0c\u9700\u8981\u8bc4\u4f30\u662f\u5426\u51cf\u4ed3\u3002",
          confidence: 55,
          tags: ["break_warning", "\u51cf\u4ed3"],
        }),
      ],
    });

    expect(pack.items.map((item) => item.id)).toEqual(["huichuan"]);
    expect(pack.items[0]?.reasons).toContain("profile:trading");
  });

  it("does not treat trading vocabulary as a global risk profile", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "evaluate stop-loss and drawdown signals",
      now,
      maxItems: 1,
      memories: [
        memory("trading-note", {
          memoryType: "boundary",
          subject: "Trading signal",
          content: "A stop-loss signal appeared after a drawdown.",
          confidence: 70,
        }),
      ],
    });

    expect(pack.items[0]?.reasons).not.toContain("profile:risk");
  });

  it("omits candidate, superseded and deleted memories from strict packs", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "daily plan",
      now,
      memories: [
        memory("active", { status: "active" }),
        memory("candidate", { status: "candidate" }),
        memory("superseded", { status: "superseded" }),
        memory("deleted", { status: "deleted" }),
      ],
    });

    expect(pack.items.map((item) => item.id)).toEqual(["active"]);
    expect(pack.omitted).toEqual([
      { id: "candidate", reason: "candidate_requires_review" },
      { id: "superseded", reason: "superseded" },
      { id: "deleted", reason: "deleted" },
    ]);
  });

  it("reports denied cross-work memories instead of silently dropping them", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "daily plan",
      now,
      memories: [
        memory("own"),
        memory("other-work", {
          scope: { type: "workshop", workshopId: "hunter" },
          ownerId: "hunter-work",
        }),
      ],
    });

    expect(pack.items.map((item) => item.id)).toEqual(["own"]);
    expect(pack.denied).toEqual([
      { id: "other-work", reason: "no_matching_grant" },
    ]);
  });

  it("includes granted cross-work reference memories", () => {
    const grants: BrainAccessGrant[] = [
      {
        id: "grant-watchlist",
        userId: "user-1",
        subjectType: "work",
        subjectId: "trader-work",
        scope: { type: "workshop", workshopId: "hunter" },
        permissions: ["reference"],
      },
    ];

    const pack = buildBrainContextPack({
      requester,
      grants,
      taskIntent: "watchlist trading plan",
      now,
      memories: [
        memory("hunter-plan", {
          scope: { type: "workshop", workshopId: "hunter" },
          ownerId: "hunter-work",
          memoryType: "plan",
          subject: "Watchlist plan",
          content: "Use only current watchlist candidates.",
        }),
      ],
    });

    expect(pack.denied).toEqual([]);
    expect(pack.items.map((item) => item.id)).toEqual(["hunter-plan"]);
  });

  it("prioritizes fresher time-varying memory and explains the freshness score", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "current watchlist and today action",
      now: new Date("2026-08-11T12:00:00.000Z"),
      maxItems: 2,
      memories: [
        memory("older", {
          subject: "Watchlist state",
          content: "Current watchlist and today action snapshot.",
          confidence: 80,
          updatedAt: "2026-08-08T12:00:00.000Z",
        }),
        memory("newer", {
          subject: "Watchlist state",
          content: "Current watchlist and today action snapshot.",
          confidence: 70,
          updatedAt: "2026-08-10T18:00:00.000Z",
        }),
      ],
    });

    expect(pack.items.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(pack.items[0]).toMatchObject({
      freshness: {
        bucket: "fresh_24h",
        updatedAt: "2026-08-10T18:00:00.000Z",
      },
    });
    expect(pack.items[0]?.reasons).toContain("freshness:fresh_24h");
  });

  it("warns when a current-state recall contains conflicting or time-versioned evidence", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "check the current watchlist state",
      now: new Date("2026-08-11T12:00:00.000Z"),
      maxItems: 2,
      memories: [
        memory("state-a", {
          subject: "Watchlist state",
          content:
            "The persisted state has a mismatch with the recorded state.",
          updatedAt: "2026-08-08T12:00:00.000Z",
        }),
        memory("state-b", {
          subject: "Watchlist state",
          content: "The current watchlist contains eleven items.",
          updatedAt: "2026-08-10T12:00:00.000Z",
        }),
      ],
    });

    expect(
      pack.items.find((item) => item.id === "state-a")?.warnings,
    ).toContain("content_reports_conflict");
    expect(pack.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "potential_state_conflict",
          memoryIds: ["state-a"],
          requiresCurrentObservation: true,
        }),
      ]),
    );
  });

  it("does not confuse stale-content vocabulary with an actual state conflict", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "check the current maintenance state",
      now: new Date("2026-08-11T12:00:00.000Z"),
      memories: [
        memory("maintenance", {
          subject: "Maintenance audit",
          content:
            "Stale-content and expired-candidate checks completed with zero issues.",
          updatedAt: "2026-08-11T10:00:00.000Z",
        }),
      ],
    });

    expect(pack.items[0]?.warnings).not.toContain("content_reports_conflict");
    expect(pack.warnings).toEqual([]);
  });

  it("deduplicates memories from the same canonical evidence group", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "review current account state",
      now,
      maxItems: 5,
      memories: [
        memory("low", {
          subject: "Account state",
          content: "Current account state from the same event.",
          confidence: 60,
          evidenceRefs: ["event-shared"],
          metadata: {
            canonicalKind: "state",
            canonicalGroupId: "evidence:state:shared",
          },
        }),
        memory("high", {
          subject: "Account state",
          content: "Current account state from the same event.",
          confidence: 90,
          evidenceRefs: ["event-shared"],
          metadata: {
            canonicalKind: "state",
            canonicalGroupId: "evidence:state:shared",
          },
        }),
      ],
    });

    expect(pack.items.map((item) => item.id)).toEqual(["high"]);
    expect(pack.selection).toMatchObject({
      selectedCount: 1,
      duplicateCanonicalGroupCount: 1,
      selectedCanonicalKinds: { state: 1 },
    });
    expect(pack.omitted).toContainEqual({
      id: "low",
      reason: "duplicate_canonical_group",
    });
  });

  it("keeps different canonical kinds from the same source event", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "review current account risk boundary",
      now,
      maxItems: 5,
      memories: [
        memory("state", {
          subject: "Account state",
          content: "Current account state from event.",
          confidence: 70,
          evidenceRefs: ["event-shared"],
          metadata: {
            canonicalKind: "state",
            canonicalGroupId: "evidence:state:shared",
          },
        }),
        memory("boundary", {
          memoryType: "boundary",
          subject: "Account boundary",
          content: "Never place real broker orders from this workshop.",
          confidence: 70,
          evidenceRefs: ["event-shared"],
          metadata: {
            canonicalKind: "boundary",
            canonicalGroupId: "evidence:boundary:shared",
          },
        }),
      ],
    });

    expect(pack.items.map((item) => item.id).sort()).toEqual([
      "boundary",
      "state",
    ]);
    expect(pack.omitted).not.toContainEqual({
      id: "state",
      reason: "duplicate_canonical_group",
    });
  });

  it("filters source facets while preserving omitted trace reasons", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "contract follow up from wechat",
      now,
      maxItems: 5,
      sourceFilters: {
        sourceKinds: ["wechat"],
        excludePrivacyClasses: ["private", "sensitive"],
        scenarioKeys: ["project:contract-alpha"],
      },
      memories: [
        memory("wechat-contract", {
          subject: "合同 Alpha",
          content: "Alice prefers structured contract proposals.",
          metadata: {
            facets: {
              sourceKind: "wechat",
              privacyClass: "normal",
              riskLevel: "low",
              scenarioKeys: ["project:contract-alpha"],
            },
          },
        }),
        memory("private-wechat", {
          subject: "Alice",
          content: "Alice shared private relationship context.",
          metadata: {
            facets: {
              sourceKind: "wechat",
              privacyClass: "private",
              riskLevel: "medium",
              scenarioKeys: ["person:alice"],
            },
          },
        }),
        memory("workshop-memory", {
          subject: "Workshop note",
          content: "A non-WeChat workshop note.",
          metadata: {
            facets: {
              sourceKind: "workshop_memory",
              privacyClass: "normal",
              riskLevel: "low",
              scenarioKeys: ["project:contract-alpha"],
            },
          },
        }),
      ],
    });

    expect(pack.items.map((item) => item.id)).toEqual(["wechat-contract"]);
    expect(pack.omitted).toEqual(
      expect.arrayContaining([
        {
          id: "private-wechat",
          reason: "source_filter:privacy_class_excluded",
        },
        {
          id: "workshop-memory",
          reason: "source_filter:source_kind",
        },
      ]),
    );
  });

  it("builds a reusable explanation summary for inspector surfaces", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "review current account risk boundary",
      now,
      maxItems: 5,
      memories: [
        memory("state", {
          subject: "Account state",
          content: "Current account state from event.",
          confidence: 70,
          evidenceRefs: ["event-state", "event-shared"],
          metadata: {
            canonicalKind: "state",
            canonicalGroupId: "evidence:state:shared",
          },
        }),
        memory("boundary", {
          memoryType: "boundary",
          subject: "Account boundary",
          content: "Never place real broker orders from this workshop.",
          confidence: 70,
          evidenceRefs: ["event-shared"],
          metadata: {
            canonicalKind: "boundary",
            canonicalGroupId: "evidence:boundary:shared",
          },
        }),
      ],
    });

    expect(explainBrainContextPack(pack)).toMatchObject({
      interfaceVersion: "brain-context-explanation.v1",
      selectedCount: 2,
      deniedCount: 0,
      omittedCount: 0,
      duplicateCanonicalGroupCount: 0,
      selectedCanonicalKinds: {
        boundary: 1,
        state: 1,
      },
      evidenceRefCount: 2,
    });
  });

  it("builds a lightweight trace summary with selected and omitted reasons", () => {
    const pack = buildBrainContextPack({
      requester,
      taskIntent: "review current account state",
      now,
      maxItems: 1,
      memories: [
        memory("selected", {
          subject: "Account state",
          content: "A".repeat(260),
          confidence: 90,
          evidenceRefs: ["event-1", "event-2"],
          metadata: {
            canonicalKind: "state",
            canonicalGroupId: "evidence:state:selected",
          },
        }),
        memory("candidate", {
          status: "candidate",
        }),
      ],
    });

    const trace = summarizeBrainContextPackForTrace(pack);

    expect(trace.interfaceVersion).toBe("brain-context-trace.v1");
    expect(trace.selected).toEqual([
      expect.objectContaining({
        id: "selected",
        canonicalKind: "state",
        canonicalGroupId: "evidence:state:selected",
        evidenceRefCount: 2,
      }),
    ]);
    expect(trace.selected[0]?.contentPreview.length).toBeLessThan(230);
    expect(trace.omitted).toContainEqual({
      id: "candidate",
      reason: "candidate_requires_review",
    });
  });
});
