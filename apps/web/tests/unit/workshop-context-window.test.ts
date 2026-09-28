import { describe, expect, it } from "vitest";
import type { Workshop, WorkshopMemory } from "@/lib/db/schema";
import { buildWorkshopPrompt } from "@/lib/workshops/context-window";
import { buildWorkshopRunTimeContext } from "@/lib/workshops/time-context";

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "操盘交易员",
    mission: "只操作当前自选股内的模拟盘股票。",
    status: "active",
    autonomyLevel: "auto",
    boundaryPolicy: {},
    modelConfig: {
      role: "paper_trader",
      allowedTools: [
        "quantPaperGetAccount",
        "quantPaperGetWatchlist",
        "quantPaperPlaceOrder",
      ],
    },
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
    updatedAt: new Date("2026-07-28T00:00:00.000Z"),
    ...overrides,
  } as Workshop;
}

function memory(overrides: Partial<WorkshopMemory> = {}): WorkshopMemory {
  return {
    id: "memory-1",
    workshopId: "workshop-1",
    kind: "boundary",
    content: "Never place real broker orders.",
    confidence: 100,
    tags: ["risk"],
    sourceEventIds: ["event-1"],
    expiresAt: null,
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
    updatedAt: new Date("2026-07-28T00:00:00.000Z"),
    ...overrides,
  } as WorkshopMemory;
}

function promptFor(workshopInput: Workshop, memories: WorkshopMemory[] = []) {
  return buildWorkshopPrompt({
    workshop: workshopInput,
    sources: [],
    memories,
    directives: [],
    events: [],
    outbox: [],
    maxToolCalls: 20,
    runTimeContext: buildWorkshopRunTimeContext({
      now: new Date("2026-08-09T02:03:04.000Z"),
      timezone: "Asia/Shanghai",
    }),
  });
}

describe("workshop context window", () => {
  it("injects an authoritative run time before memory context", () => {
    const prompt = promptFor(workshop(), [
      memory({
        content: "今天按 2026-08-01 的计划执行。",
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ]);

    expect(prompt.indexOf("Run Time Context (authoritative):")).toBeLessThan(
      prompt.indexOf("Control Memory Context:"),
    );
    expect(prompt).toContain('"localDate": "2026-08-09"');
    expect(prompt).toContain('"localTime": "10:03:04"');
    expect(prompt).toContain(
      "Treat Run Time Context as the only authoritative source",
    );
    expect(prompt).toContain(
      "never reuse those words as the current date unless their timestamp matches this run",
    );
  });

  it("keeps paper traders out of watchlist maintenance", () => {
    const prompt = promptFor(workshop());

    expect(prompt).toContain(
      "This workshop is not responsible for maintaining the paper-trading watchlist.",
    );
    expect(prompt).toContain(
      "do not call quantMarketDiscoverCandidates or quantPaperProposeWatchlistChange",
    );
    expect(prompt).not.toContain(
      "call quantPaperProposeWatchlistChange with concrete add/remove codes",
    );
  });

  it("uses news as supporting evidence for paper-trading decisions", () => {
    const prompt = promptFor(workshop());

    expect(prompt).toContain(
      "News and filings are supporting evidence only",
    );
    expect(prompt).toContain(
      "not to trigger a trade by themselves",
    );
    expect(prompt).toContain(
      "call aStockNewsAndFilings for the relevant code",
    );
    expect(prompt).toContain('include a concise "news reference"');
  });

  it("encourages agile paper-trading rotation without leaving the watchlist boundary", () => {
    const prompt = promptFor(workshop());

    expect(prompt).toContain(
      "sell/reduce weak holdings before considering new buys",
    );
    expect(prompt).toContain("two or more weak signals");
    expect(prompt).toContain(
      "Replacement buys must stay inside the current watchlist",
    );
    expect(prompt).not.toContain("maxBuyDeviationPct=3");
    expect(prompt).not.toContain("risk_on conditions");
    expect(prompt).not.toContain("risk_off conditions");
  });

  it("injects control memory context instead of a raw recent-memory list", () => {
    const prompt = promptFor(workshop(), [memory()]);

    expect(prompt).toContain("Control Memory Context:");
    expect(prompt).toContain("Control model: engineering_cybernetics_v1");
    expect(prompt).toContain("Never place real broker orders.");
    expect(prompt).toContain("workshopSearchMemory");
    expect(prompt).toContain("workshopGetMemoryEvidence");
    expect(prompt).toContain("workshopListMemoryCandidates");
    expect(prompt).toContain("workshopReviewMemory");
    expect(prompt).toContain("Candidate memories are not part of the default");
    expect(prompt).toContain("inspect its source events");
  });

  it("allows watchlist selectors to create watchlist proposals", () => {
    const prompt = promptFor(
      workshop({
        name: "自选股猎手",
        mission: "寻找值得进入自选股观察池的股票。",
        modelConfig: {
          role: "watchlist_selector",
          primaryTools: [
            "quantMarketDiscoverCandidates",
            "quantPaperProposeWatchlistChange",
          ],
        },
      }),
    );

    expect(prompt).toContain(
      "Watchlist selection controls a three-layer universe",
    );
    expect(prompt).toContain(
      "returned candidates are persisted into the non-trading candidate pool",
    );
    expect(prompt).toContain(
      "Promote only high-conviction candidates into the active core/trading watchlist",
    );
    expect(prompt).toContain(
      "Do not remove symbols with current paper positions or open paper orders",
    );
    expect(prompt).not.toContain(
      "This workshop is not responsible for maintaining the paper-trading watchlist.",
    );
  });

  it("keeps domain instructions out of a general workshop", () => {
    const prompt = promptFor(
      workshop({
        name: "Writing assistant",
        mission: "Help draft and review long-form articles.",
        modelConfig: {
          role: "writing_assistant",
          allowedTools: ["workshopSearchMemory"],
        },
      }),
    );

    expect(prompt).toContain("Control Memory Context:");
    expect(prompt).not.toContain("paper-trading watchlist");
    expect(prompt).not.toContain("quantPaperPlaceOrder");
    expect(prompt).not.toContain("stop-loss rules");
    expect(prompt).not.toContain("risk_on conditions");
  });
});
