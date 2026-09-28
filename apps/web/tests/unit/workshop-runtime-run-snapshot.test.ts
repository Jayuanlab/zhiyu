import { describe, expect, it } from "vitest";
import type { WorkshopEvent } from "@/lib/db/schema";
import {
  extractWorkshopRuntimeRunSnapshot,
  latestWorkshopRuntimeRunSnapshot,
} from "@/lib/workshops/runtime-run-snapshot";

function runtimeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-runtime-run-snapshot.v1",
    engine: "pi",
    adapter: "pi-agent-core",
    adapterVersion: "0.85.1",
    selectionSource: "config",
    piProtocol: "openai-responses",
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

function event(overrides: Partial<WorkshopEvent> = {}): WorkshopEvent {
  return {
    id: "event-1",
    workshopId: "work-1",
    runId: "run-1",
    loopId: null,
    loopRunId: null,
    seq: 1,
    type: "agent_configured",
    title: "runtime configured",
    body: null,
    metadata: {
      runtimeRunSnapshot: runtimeSnapshot(),
    },
    visibility: "debug",
    createdAt: new Date("2026-09-13T10:00:00.000Z"),
    ...overrides,
  } as WorkshopEvent;
}

describe("workshop runtime run snapshot recovery helpers", () => {
  it("extracts a fixed runtime snapshot from an agent_configured event", () => {
    expect(extractWorkshopRuntimeRunSnapshot(event())).toMatchObject({
      eventId: "event-1",
      createdAt: "2026-09-13T10:00:00.000Z",
      runId: "run-1",
      snapshot: {
        engine: "pi",
        adapter: "pi-agent-core",
        runtimeHash: "r".repeat(64),
        allowedToolCount: 2,
      },
    });
  });

  it("does not recover snapshots from unrelated events or invalid payloads", () => {
    expect(extractWorkshopRuntimeRunSnapshot(event({ type: "agent_text" }))).toBeNull();
    expect(
      extractWorkshopRuntimeRunSnapshot(
        event({
          metadata: {
            runtimeRunSnapshot: runtimeSnapshot({ runtimeHash: "" }),
          },
        }),
      ),
    ).toBeNull();
  });

  it("returns the latest valid runtime snapshot by event time", () => {
    const latest = latestWorkshopRuntimeRunSnapshot([
      event({ id: "older", createdAt: new Date("2026-09-13T09:00:00.000Z") }),
      event({
        id: "newer",
        createdAt: new Date("2026-09-13T11:00:00.000Z"),
        metadata: {
          runtimeRunSnapshot: runtimeSnapshot({
            runtimeHash: "n".repeat(64),
          }),
        },
      }),
      event({
        id: "invalid",
        createdAt: new Date("2026-09-13T12:00:00.000Z"),
        metadata: {
          runtimeRunSnapshot: runtimeSnapshot({
            allowedToolCount: "bad",
          }),
        },
      }),
    ]);

    expect(latest).toMatchObject({
      eventId: "newer",
      snapshot: {
        runtimeHash: "n".repeat(64),
      },
    });
  });
});
