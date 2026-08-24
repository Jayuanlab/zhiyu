import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchQuantWatchlistConfigMock = vi.hoisted(() => vi.fn());
const updateQuantWatchlistConfigMock = vi.hoisted(() => vi.fn());
const getWorkshopEventMock = vi.hoisted(() => vi.fn());
const listWorkshopEventsMock = vi.hoisted(() => vi.fn());
const appendWorkshopEventMock = vi.hoisted(() => vi.fn());
const resolveReviewItemMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/quant/client", () => ({
  fetchQuantWatchlistConfig: fetchQuantWatchlistConfigMock,
  updateQuantWatchlistConfig: updateQuantWatchlistConfigMock,
}));

vi.mock("@/lib/workshops/service", () => ({
  getWorkshopEvent: getWorkshopEventMock,
  listWorkshopEvents: listWorkshopEventsMock,
  appendWorkshopEvent: appendWorkshopEventMock,
}));

vi.mock("@/lib/workshops/review-items", () => ({
  resolveWorkshopReviewItemBySourceEvent: resolveReviewItemMock,
}));

import { resolveWatchlistProposal } from "@/lib/workshops/watchlist-proposals";

const now = new Date("2026-08-06T02:20:00.000Z");

function proposalEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal-1",
    workshopId: "workshop-1",
    runId: null,
    loopId: null,
    loopRunId: null,
    seq: 1,
    type: "watchlist_proposal",
    title: "自选股调整提案",
    body: "",
    visibility: "user",
    createdAt: now,
    metadata: {
      provider: "quant-paper",
      kind: "watchlist_change_proposal",
      proposalId: "wp-1",
      status: "pending_approval",
      before: ["600519.SH"],
      after: ["600519.SH", "000977.SZ"],
      add: ["000977.SZ"],
      remove: [],
      protectedRemove: [],
      reason: "候选股通过趋势和资金验证，提升为核心自选。",
      validation: { ok: true, issues: [], warnings: [] },
      ...overrides,
    },
  };
}

describe("watchlist proposals", () => {
  beforeEach(() => {
    fetchQuantWatchlistConfigMock.mockReset();
    updateQuantWatchlistConfigMock.mockReset();
    getWorkshopEventMock.mockReset();
    listWorkshopEventsMock.mockReset();
    appendWorkshopEventMock.mockReset();
    resolveReviewItemMock.mockReset();
    resolveReviewItemMock.mockResolvedValue(null);
  });

  it("promotes an added candidate item into the active watchlist", async () => {
    getWorkshopEventMock.mockResolvedValue(proposalEvent());
    listWorkshopEventsMock.mockResolvedValue([]);
    fetchQuantWatchlistConfigMock.mockResolvedValue({
      codes: ["600519.SH"],
      items: [
        {
          code: "600519.SH",
          pool: "core",
          status: "active",
          source: "owner",
        },
        {
          code: "000977.SZ",
          pool: "candidate",
          status: "active",
          source: "watchlist_hunter",
        },
      ],
    });
    updateQuantWatchlistConfigMock.mockResolvedValue({
      codes: ["600519.SH", "000977.SZ"],
      items: [],
    });
    appendWorkshopEventMock.mockResolvedValue({
      id: "resolution-1",
      type: "watchlist_proposal_applied",
      metadata: {},
    });

    await resolveWatchlistProposal({
      workshopId: "workshop-1",
      eventId: "proposal-1",
      action: "apply",
    });

    expect(updateQuantWatchlistConfigMock).toHaveBeenCalledWith(
      ["600519.SH", "000977.SZ"],
      expect.arrayContaining([
        expect.objectContaining({
          code: "000977.SZ",
          pool: "core",
          status: "active",
          source: "watchlist_hunter",
        }),
      ]),
    );
  });

  it("preserves unrelated candidate pool items when applying an active watchlist change", async () => {
    getWorkshopEventMock.mockResolvedValue(proposalEvent());
    listWorkshopEventsMock.mockResolvedValue([]);
    fetchQuantWatchlistConfigMock.mockResolvedValue({
      codes: ["600519.SH"],
      items: [
        {
          code: "600519.SH",
          pool: "core",
          status: "active",
          source: "owner",
        },
        {
          code: "000977.SZ",
          pool: "candidate",
          status: "active",
          source: "watchlist_hunter",
        },
        {
          code: "002371.SZ",
          pool: "candidate",
          status: "active",
          source: "watchlist_hunter",
          reason: "candidate supply should survive active list updates",
        },
      ],
    });
    updateQuantWatchlistConfigMock.mockResolvedValue({
      codes: ["600519.SH", "000977.SZ"],
      items: [],
    });
    appendWorkshopEventMock.mockResolvedValue({
      id: "resolution-1",
      type: "watchlist_proposal_applied",
      metadata: {},
    });

    await resolveWatchlistProposal({
      workshopId: "workshop-1",
      eventId: "proposal-1",
      action: "apply",
    });

    expect(updateQuantWatchlistConfigMock).toHaveBeenCalledWith(
      ["600519.SH", "000977.SZ"],
      expect.arrayContaining([
        expect.objectContaining({
          code: "000977.SZ",
          pool: "core",
          status: "active",
        }),
        expect.objectContaining({
          code: "002371.SZ",
          pool: "candidate",
          status: "active",
          source: "watchlist_hunter",
        }),
      ]),
    );
  });

  it("repairs an already-applied proposal when the active config is stale", async () => {
    getWorkshopEventMock.mockResolvedValue(proposalEvent());
    listWorkshopEventsMock.mockResolvedValue([
      {
        id: "resolution-1",
        type: "watchlist_proposal_applied",
        metadata: {
          proposalId: "wp-1",
          sourceProposalEventId: "proposal-1",
        },
      },
    ]);
    fetchQuantWatchlistConfigMock.mockResolvedValue({
      codes: ["600519.SH"],
      items: [
        {
          code: "600519.SH",
          pool: "core",
          status: "active",
          source: "owner",
        },
        {
          code: "000977.SZ",
          pool: "candidate",
          status: "active",
          source: "watchlist_hunter",
        },
      ],
    });
    updateQuantWatchlistConfigMock.mockResolvedValue({
      codes: ["600519.SH", "000977.SZ"],
      items: [],
    });
    appendWorkshopEventMock.mockResolvedValue({
      id: "repair-1",
      type: "watchlist_proposal_repaired",
      metadata: {},
    });

    const result = await resolveWatchlistProposal({
      workshopId: "workshop-1",
      eventId: "proposal-1",
      action: "apply",
    });

    expect(result.alreadyResolved).toBe(true);
    expect(result.repaired).toBe(true);
    expect(updateQuantWatchlistConfigMock).toHaveBeenCalledWith(
      ["600519.SH", "000977.SZ"],
      expect.arrayContaining([
        expect.objectContaining({
          code: "000977.SZ",
          pool: "core",
          status: "active",
        }),
      ]),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "watchlist_proposal_repaired",
        title: "自选股调整已补偿应用",
      }),
    );
  });
});
