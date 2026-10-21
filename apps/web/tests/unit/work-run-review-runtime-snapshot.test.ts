import { describe, expect, it, vi } from "vitest";
import {
  compareWorkRunRuntimeSnapshotSummaries,
  extractWorkRunRuntimeSnapshotSummary,
  persistWorkRunRuntimeSnapshot,
  parseWorkRunReviewRuntimeSnapshot,
  readWorkRunRuntimeSnapshotSummary,
  summarizeWorkRunReviewRuntimeSnapshot,
} from "@/lib/work-runtime/runtime-snapshot";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-runtime-run-snapshot.v1" as const,
    engine: "pi" as const,
    adapter: "pi-agent-core",
    adapterVersion: "0.85.1",
    selectionSource: "config" as const,
    piProtocol: "openai-responses" as const,
    model: "fixture-model",
    modelTier: "standard",
    modelSource: "user",
    promptHash: "p".repeat(64),
    allowedToolsHash: "t".repeat(64),
    policyHash: "c".repeat(64),
    runtimeHash: "r".repeat(64),
    allowedToolCount: 2,
    ...overrides,
  };
}

describe("work run review runtime snapshot parser", () => {
  it("parses a complete persisted agent_configured snapshot reference", () => {
    expect(
      parseWorkRunReviewRuntimeSnapshot({
        eventId: "event-1",
        createdAt: "2026-09-14T01:00:00.000Z",
        runId: "run-1",
        loopId: null,
        loopRunId: null,
        snapshot: snapshot(),
      }),
    ).toMatchObject({
      eventId: "event-1",
      createdAt: "2026-09-14T01:00:00.000Z",
      runId: "run-1",
      snapshot: {
        engine: "pi",
        adapter: "pi-agent-core",
        runtimeHash: "r".repeat(64),
      },
    });
  });

  it("rejects missing identity fields or invalid snapshots", () => {
    expect(parseWorkRunReviewRuntimeSnapshot(null)).toBeNull();
    expect(
      parseWorkRunReviewRuntimeSnapshot({
        eventId: "event-1",
        createdAt: "2026-09-14T01:00:00.000Z",
        snapshot: snapshot({ runtimeHash: "" }),
      }),
    ).toBeNull();
    expect(
      parseWorkRunReviewRuntimeSnapshot({
        createdAt: "2026-09-14T01:00:00.000Z",
        snapshot: snapshot(),
      }),
    ).toBeNull();
  });

  it("summarizes the snapshot identity for review audit metadata", () => {
    const parsed = parseWorkRunReviewRuntimeSnapshot({
      eventId: "event-1",
      createdAt: "2026-09-14T01:00:00.000Z",
      runId: "run-1",
      loopId: "loop-1",
      loopRunId: "loop-run-1",
      snapshot: snapshot(),
    });

    expect(summarizeWorkRunReviewRuntimeSnapshot(parsed)).toEqual({
      eventId: "event-1",
      createdAt: "2026-09-14T01:00:00.000Z",
      runId: "run-1",
      loopId: "loop-1",
      loopRunId: "loop-run-1",
      engine: "pi",
      adapter: "pi-agent-core",
      model: "fixture-model",
      modelTier: "standard",
      runtimeHash: "r".repeat(64),
      policyHash: "c".repeat(64),
      allowedToolCount: 2,
    });
    expect(JSON.stringify(summarizeWorkRunReviewRuntimeSnapshot(parsed))).not.toContain(
      "promptHash",
    );
  });

  it("extracts audit summaries from completion, lease and review receipts", () => {
    const summary = summarizeWorkRunReviewRuntimeSnapshot(
      parseWorkRunReviewRuntimeSnapshot({
        eventId: "event-1",
        createdAt: "2026-09-14T01:00:00.000Z",
        runId: "run-1",
        snapshot: snapshot(),
      }),
    );

    expect(
      extractWorkRunRuntimeSnapshotSummary({
        request: {
          metadata: {
            runtimeSnapshot: summary,
          },
        },
      }),
    ).toEqual(summary);
    expect(
      extractWorkRunRuntimeSnapshotSummary({
        result: {
          runtimeSnapshot: summary,
        },
      }),
    ).toEqual(summary);
    expect(
      extractWorkRunRuntimeSnapshotSummary({
        resolution: {
          priorCompletion: {
            request: {
              metadata: {
                runtimeSnapshot: summary,
              },
            },
          },
        },
      }),
    ).toEqual(summary);
    expect(extractWorkRunRuntimeSnapshotSummary({ runtimeSnapshot: { model: "bad" } })).toBeNull();
  });

  it("compares receipt runtime identity against the current configured snapshot", () => {
    const current = summarizeWorkRunReviewRuntimeSnapshot(
      parseWorkRunReviewRuntimeSnapshot({
        eventId: "event-1",
        createdAt: "2026-09-14T01:00:00.000Z",
        runId: "run-1",
        snapshot: snapshot(),
      }),
    );
    const same = summarizeWorkRunReviewRuntimeSnapshot(
      parseWorkRunReviewRuntimeSnapshot({
        eventId: "event-2",
        createdAt: "2026-09-14T01:01:00.000Z",
        runId: "run-1",
        snapshot: snapshot(),
      }),
    );
    const changedPolicy = summarizeWorkRunReviewRuntimeSnapshot(
      parseWorkRunReviewRuntimeSnapshot({
        eventId: "event-3",
        createdAt: "2026-09-14T01:02:00.000Z",
        runId: "run-1",
        snapshot: snapshot({ policyHash: "d".repeat(64) }),
      }),
    );
    const changedRuntime = summarizeWorkRunReviewRuntimeSnapshot(
      parseWorkRunReviewRuntimeSnapshot({
        eventId: "event-4",
        createdAt: "2026-09-14T01:03:00.000Z",
        runId: "run-1",
        snapshot: snapshot({ runtimeHash: "s".repeat(64) }),
      }),
    );

    expect(compareWorkRunRuntimeSnapshotSummaries(current, null)).toBeNull();
    expect(compareWorkRunRuntimeSnapshotSummaries(current, same)).toEqual({
      matches: true,
      reason: null,
    });
    expect(compareWorkRunRuntimeSnapshotSummaries(current, changedRuntime)).toEqual({
      matches: false,
      reason: "runtime_hash_mismatch",
    });
    expect(compareWorkRunRuntimeSnapshotSummaries(current, changedPolicy)).toEqual({
      matches: false,
      reason: "policy_hash_mismatch",
    });
  });

  it("reads structured runtime snapshot projections before falling back to events", async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([{ table_name: "workshop_runtime_snapshots" }])
        .mockResolvedValueOnce([
          {
            runtime_snapshot: {
              eventId: "event-structured",
              createdAt: "2026-09-14T01:00:00.000Z",
              runId: "run-1",
              loopId: null,
              loopRunId: null,
              snapshot: snapshot({ runtimeHash: "s".repeat(64) }),
            },
          },
        ]),
    };

    await expect(
      readWorkRunRuntimeSnapshotSummary(db as any, {
        workId: "work-1",
        runId: "run-1",
      }),
    ).resolves.toMatchObject({
      eventId: "event-structured",
      runtimeHash: "s".repeat(64),
    });
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("falls back to agent_configured events when the projection table is unavailable", async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([{ table_name: null }])
        .mockResolvedValueOnce([
          {
            runtime_snapshot: {
              eventId: "event-fallback",
              createdAt: "2026-09-14T01:00:00.000Z",
              runId: "run-1",
              loopId: null,
              loopRunId: null,
              snapshot: snapshot({ runtimeHash: "f".repeat(64) }),
            },
          },
        ]),
    };

    await expect(
      readWorkRunRuntimeSnapshotSummary(db as any, {
        workId: "work-1",
        runId: "run-1",
      }),
    ).resolves.toMatchObject({
      eventId: "event-fallback",
      runtimeHash: "f".repeat(64),
    });
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("persists runtime snapshots into the structured projection table", async () => {
    const db = { execute: vi.fn(async () => [{ id: "snapshot-row" }]) };

    await persistWorkRunRuntimeSnapshot(db as any, {
      workshopId: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000002",
      eventId: "00000000-0000-4000-8000-000000000003",
      snapshot: snapshot(),
    });

    expect(db.execute).toHaveBeenCalledOnce();
  });
});
