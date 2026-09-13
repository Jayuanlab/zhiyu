import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workshop, WorkshopHeartbeat } from "@/lib/db/schema";

const now = new Date("2026-07-04T00:00:00.000Z");

const heartbeatByWorkshopId = vi.hoisted(
  () => new Map<string, WorkshopHeartbeat>(),
);
const workshops = vi.hoisted(() => [] as Workshop[]);
const events = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const startWorkshopRunMock = vi.hoisted(() => vi.fn());
const claimWorkshopHeartbeatMock = vi.hoisted(() => vi.fn());
const admission=vi.hoisted(()=>vi.fn());
const projection=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/work-runtime/heartbeat-admission',()=>({admitWorkshopHeartbeat:admission}));
vi.mock('@/lib/work-runtime/heartbeat-projection',()=>({projectWorkshopHeartbeat:projection}));

vi.mock("@/lib/workshops/service", () => ({
  appendWorkshopEvent: vi.fn(async (input: Record<string, unknown>) => {
    events.push(input);
    return {
      id: `event-${events.length}`,
      seq: events.length,
      createdAt: now,
      ...input,
    };
  }),
  getWorkshopHeartbeat: vi.fn(async (workshopId: string) => {
    return heartbeatByWorkshopId.get(workshopId) ?? null;
  }),
  claimWorkshopHeartbeat: claimWorkshopHeartbeatMock,
  listWorkshopHeartbeatCandidates: vi.fn(async () => {
    return workshops.map((workshop) => ({
      workshop,
      heartbeat: heartbeatByWorkshopId.get(workshop.id) ?? null,
    }));
  }),
  upsertWorkshopHeartbeat: vi.fn(
    async (workshopId: string, input: Partial<WorkshopHeartbeat>) => {
      const existing = heartbeatByWorkshopId.get(workshopId) ?? heartbeat(workshopId);
      const updated = {
        ...existing,
        ...input,
        heartbeatPolicy:
          input.heartbeatPolicy === undefined
            ? existing.heartbeatPolicy
            : input.heartbeatPolicy,
        updatedAt: now,
      } as WorkshopHeartbeat;
      heartbeatByWorkshopId.set(workshopId, updated);
      return updated;
    },
  ),
}));

vi.mock("@/lib/workshops/runtime", () => ({
  startWorkshopRun: startWorkshopRunMock,
}));

import { computeSuggestedWakeupAt, normalizeWorkshopHeartbeatPolicy } from "@/lib/workshops/heartbeat";
import {
  listDueWorkshopHeartbeats,
  runDueWorkshopHeartbeats,
} from "@/lib/workshops/heartbeat-scheduler";

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "Workshop",
    mission: "Watch the market",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: {},
    modelConfig: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workshop;
}

function heartbeat(
  workshopId = "workshop-1",
  overrides: Partial<WorkshopHeartbeat> = {},
): WorkshopHeartbeat {
  return {
    workshopId,
    enabled: true,
    mode: "suggested",
    nextWakeupAt: null,
    lastWakeupAt: null,
    lastHeartbeatAt: null,
    schedulerStatus: "idle",
    schedulerError: null,
    consecutiveFailures: 0,
    leaseUntil: null,
    heartbeatPolicy: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WorkshopHeartbeat;
}

describe("workshop heartbeat", () => {
  beforeEach(() => {
    heartbeatByWorkshopId.clear();
    workshops.length = 0;
    events.length = 0;
    admission.mockReset();projection.mockReset();admission.mockResolvedValue({state:'accepted',replayed:false});
    startWorkshopRunMock.mockReset();
    claimWorkshopHeartbeatMock.mockReset();
    claimWorkshopHeartbeatMock.mockImplementation(
      async (input: {
        workshopId: string;
        scheduledAt: Date;
        now: Date;
        leaseUntil: Date;
        schedulerError?: string | null;
      }) => {
        const existing = heartbeatByWorkshopId.get(input.workshopId);
        if (!existing?.enabled) return null;
        if (existing.nextWakeupAt?.getTime() !== input.scheduledAt.getTime()) {
          return null;
        }
        if (existing.leaseUntil && existing.leaseUntil > input.now) return null;
        const claimed = heartbeat(input.workshopId, {
          ...existing,
          nextWakeupAt: null,
          lastWakeupAt: input.scheduledAt,
          lastHeartbeatAt: input.now,
          schedulerStatus: "running",
          schedulerError: input.schedulerError ?? null,
          leaseUntil: input.leaseUntil,
        });
        heartbeatByWorkshopId.set(input.workshopId, claimed);
        return claimed;
      },
    );
  });

  it("clamps suggested wakeup intervals", () => {
    const scheduled = computeSuggestedWakeupAt({
      policy: normalizeWorkshopHeartbeatPolicy({}),
      suggestion: {
        reason: "Check the next market open",
        delayMinutes: 1,
      },
      now,
    });

    expect(scheduled?.wakeupAt.toISOString()).toBe(
      "2026-07-04T00:15:00.000Z",
    );
  });

  it("observes due heartbeats without writes and queues without executing", async () => {
    const item = workshop();
    workshops.push(item);
    heartbeatByWorkshopId.set(
      item.id,
      heartbeat(item.id, {
        nextWakeupAt: new Date("2026-07-04T00:00:00.000Z"),
      }),
    );
    startWorkshopRunMock.mockResolvedValue({
      id: "run-1",
      workshopId: item.id,
    });

    const due = await listDueWorkshopHeartbeats({
      userId: item.userId,
      now: new Date("2026-07-04T00:01:00.000Z"),
    });
    expect(due).toHaveLength(1);
    expect(admission).not.toHaveBeenCalled();expect(events).toEqual([]);

    const result = await runDueWorkshopHeartbeats({
      userId: item.userId,
      now: new Date("2026-07-04T00:01:00.000Z"),
      awaitCompletion: true,
    });

    expect(result).toEqual({ launched: 0, queued:1, skipped: 0,errors:[] });
    expect(admission).toHaveBeenCalledWith({userId:item.userId,workId:item.id,scheduledAt:now.toISOString(),signal:undefined});
    expect(projection).toHaveBeenCalledWith({userId:item.userId,workId:item.id,signal:undefined});
    expect(startWorkshopRunMock).not.toHaveBeenCalled();
    expect(claimWorkshopHeartbeatMock).not.toHaveBeenCalled();
  });

  it("does not count a replayed admission as a new queued run", async () => {
    const item = workshop();
    workshops.push(item);
    heartbeatByWorkshopId.set(
      item.id,
      heartbeat(item.id, {
        nextWakeupAt: new Date("2026-07-04T00:00:00.000Z"),
      }),
    );
    admission.mockResolvedValueOnce({state:'accepted',replayed:true});

    const result = await runDueWorkshopHeartbeats({
      userId: item.userId,
      now: new Date("2026-07-04T00:01:00.000Z"),
      awaitCompletion: true,
    });

    expect(result).toEqual({ launched: 0, queued:0, skipped: 1,errors:[] });
    expect(startWorkshopRunMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
