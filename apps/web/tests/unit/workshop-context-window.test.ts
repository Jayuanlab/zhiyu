import { describe, expect, it } from "vitest";
import type { Workshop, WorkshopDirective, WorkshopMemory } from "@/lib/db/schema";
import { buildWorkshopPrompt } from "@/lib/workshops/context-window";
import { buildWorkshopRunTimeContext } from "@/lib/workshops/time-context";
import { composeWorkshopRunPrompt } from "@/lib/workshops/run-prompt";
import { formatWorkshopResearchContract } from "@/lib/workshops/research-evidence-verification";

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

function directive(overrides: Partial<WorkshopDirective> = {}): WorkshopDirective {
  return {
    id: "primary-directive",
    workshopId: "workshop-1",
    runId: null,
    content: "Complete this exact item.",
    priority: 0,
    scope: "current_run",
    status: "active",
    createdAt: new Date("2026-10-09T00:00:00.000Z"),
    ...overrides,
  } as WorkshopDirective;
}

function requiredPrompt(overrides: Partial<Parameters<typeof buildWorkshopPrompt>[0]> = {}) {
  return buildWorkshopPrompt({
    workshop: workshop({ modelConfig: { role: "writing_assistant", contextProfile: "full" } }),
    sources: [],
    memories: [],
    directives: [directive()],
    primaryDirectiveId: "primary-directive",
    events: [],
    outbox: [],
    maxToolCalls: 20,
    runTimeContext: buildWorkshopRunTimeContext({ now: new Date("2026-10-09T00:00:00.000Z") }),
    ...overrides,
  });
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
  const primaryReadingContract = {
    version: "primary-reading/v1",
    taskKeywords: ["deepseek"],
    requiredPrimarySources: [
      { id: "deepseek-r1", label: "DeepSeek-R1", urls: ["https://arxiv.org/html/2501.12948"] },
    ],
    minQualityScore: 60,
  };
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

  it("uses a single complete authored report for the configured freeform researcher", () => {
    const prompt = promptFor(workshop({
      name: "知遇技术研究院",
      mission: "研究外部技术对当前项目的实际价值。",
      modelConfig: {
        role: "agent_frontier_researcher",
        researchReportStyle: "freeform_project_value",
      },
    }));

    expect(prompt).toContain("本轮自由研究汇报合同：");
    expect(prompt).toContain("不固定标题、章节、字数或结论数量");
    expect(prompt).toContain("与当前已核源码的匹配");
    expect(prompt).toContain("可证伪的最小验证");
    expect(prompt).toContain("顶层 reportMarkdown 保存完整正文");
    expect(prompt).toContain("summary 是可选的简短摘要");
    expect(prompt).toContain("引用真实来源、事件 ID 和工具回执");
    expect(prompt).toContain("权限拒绝、工具失败、资料不足、预算限制和降级必须如实暴露");
    expect(prompt).toContain("汇报风格不改变当前权限、外发审核和通知边界");
    expect(prompt).toContain('"reportMarkdown": "自由组织的完整中文技术研究正文"');
    expect(prompt).not.toContain('"presentation":');
    expect(prompt).not.toContain("Follow the same presentation shape for every Work role.");
    expect(prompt).not.toContain("At the end, return a compact strict JSON summary");
  });

  it("keeps the existing contract unless both research role and style match", () => {
    const standardWorkshop = workshop({ modelConfig: { role: "writing_assistant" } });
    const standard = promptFor(standardWorkshop);
    const otherRole = promptFor({
      ...standardWorkshop,
      modelConfig: { role: "writing_assistant", researchReportStyle: "freeform_project_value" },
    });
    const researchWorkshop = workshop({ modelConfig: { role: "agent_frontier_researcher" } });
    const research = promptFor(researchWorkshop);
    const unknownStyle = promptFor({
      ...researchWorkshop,
      modelConfig: { role: "agent_frontier_researcher", researchReportStyle: "another_style" },
    });

    expect(otherRole).toBe(standard);
    expect(unknownStyle).toBe(research);
    for (const prompt of [standard, research]) {
      expect(prompt).toContain("Follow the same presentation shape for every Work role.");
      expect(prompt).toContain("At the end, return a compact strict JSON summary");
      expect(prompt).toContain('"presentation": {');
      expect(prompt).not.toContain("本轮自由研究汇报合同：");
    }
  });

  it("preserves the complete freeform contract when the context is truncated", () => {
    const prompt = promptFor(workshop({
      mission: "long context ".repeat(5_000),
      modelConfig: {
        role: "agent_frontier_researcher",
        researchReportStyle: "freeform_project_value",
        contextProfile: "cheap",
      },
    }));

    expect(prompt).toContain("[Context truncated to fit workshop run budget.]");
    expect(prompt).toContain("本轮自由研究汇报合同：");
    expect(prompt).toContain("引用真实来源、事件 ID 和工具回执");
    expect(prompt).toContain("顶层 reportMarkdown 保存完整正文");
    expect(prompt).toContain('"reportMarkdown": "自由组织的完整中文技术研究正文"');
    expect(prompt).not.toContain('"presentation":');
  });

  it("preserves the exact primary input beyond the auxiliary list limit and during compression", () => {
    const tail = "PRIMARY_TAIL_ACCEPTANCE_CONDITION  ";
    const content = "  " + "x".repeat(24_000 - tail.length - 2) + tail;
    const primary = directive({ content });
    const auxiliary = Array.from({ length: 60 }, (_, index) => directive({
      id: `auxiliary-${index}`,
      content: `auxiliary-${index} ` + "optional detail ".repeat(100) + "AUXILIARY_TAIL",
    }));
    const prompt = requiredPrompt({
      workshop: workshop({ mission: "optional context ".repeat(5_000),
        modelConfig: { role: "writing_assistant", contextProfile: "full" } }),
      directives: [...auxiliary, primary],
    });

    expect(prompt).toContain(`Primary user directive (id=${primary.id}`);
    expect(prompt).toContain(content);
    expect(prompt.split(content)).toHaveLength(2);
    expect(prompt).toContain("PRIMARY_TAIL_ACCEPTANCE_CONDITION");
    expect(prompt).toContain("[Context truncated to fit workshop run budget.]");
    expect(prompt).toContain('"nextWakeupSuggestion":');
    expect(prompt).not.toContain("AUXILIARY_TAIL");
    expect(prompt.length).toBeLessThanOrEqual(40_000);
  });

  it("does not guess the primary input from the first directive", () => {
    expect(() => requiredPrompt({ primaryDirectiveId: "missing" })).toThrow("primary_directive_unavailable");
    expect(() => requiredPrompt({ directives: [directive(), directive({ content: "Different content." })] }))
      .toThrow("primary_directive_ambiguous");
    expect(() => requiredPrompt({ directives: [directive({ content: "  " })] }))
      .toThrow("primary_directive_unavailable");
  });

  it("rejects oversized required input instead of shortening its tail", () => {
    expect(() => requiredPrompt({ directives: [directive({ content: "x".repeat(24_001) })] }))
      .toThrow("primary_directive_input_too_large");
    expect(() => requiredPrompt({
      workshop: workshop({ modelConfig: { role: "writing_assistant", contextProfile: "normal" } }),
      directives: [directive({ content: "x".repeat(24_000) })],
    })).toThrow("required_input_budget_exceeded");
  });

  it("reserves appended server context and keeps the full pinned result as a separate input", () => {
    const content = "previous result ".repeat(900) + "CONTINUATION_TAIL";
    const prompt = requiredPrompt({
      continuationContext: { sourceRunId: "prior-run", resultHash: "pinned-hash", content },
      promptReserveChars: 4_000,
    });
    expect(prompt).toContain(JSON.stringify(content));
    expect(prompt).toContain('"sourceRunId":"prior-run"');
    expect(prompt).toContain('"resultHash":"pinned-hash"');
    expect(prompt.length).toBeLessThanOrEqual(36_000);

    expect(() => requiredPrompt({
      directives: [directive({ content: "x".repeat(24_000) })],
      promptReserveChars: 20_000,
    })).toThrow("required_input_budget_exceeded");
    expect(() => requiredPrompt({ promptReserveChars: -1 })).toThrow("required_input_budget_exceeded");
  });

  it("refuses a 40k profile when two admitted 24k inputs cannot fit together", () => {
    expect(() => requiredPrompt({
      directives: [directive({ content: "x".repeat(24_000) })],
      continuationContext: { sourceRunId: "prior-run", resultHash: "pinned-hash", content: "y".repeat(24_000) },
    })).toThrow("required_input_budget_exceeded");
  });

  it("keeps the primary tail in the executor's final Pi prompt assembly with a reserved system budget", () => {
    const work = workshop({ modelConfig: { role: "writing_assistant", contextProfile: "full" } });
    const tail = "EXECUTOR_PRIMARY_TAIL";
    const content = "x".repeat(24_000 - tail.length) + tail;
    const system = composeWorkshopRunPrompt({ workshop: work, prompt: "", allowedTools: [] });
    const taskPrompt = requiredPrompt({
      workshop: work,
      directives: [directive({ content }), ...Array.from({ length: 60 }, (_, index) => directive({
        id: `auxiliary-${index}`, content: "optional context ".repeat(100),
      }))],
      separateSystemPrompt: true,
      promptReserveChars: system.systemPrompt.length + 2,
    });
    const executorPrompt = composeWorkshopRunPrompt({ workshop: work, prompt: taskPrompt, allowedTools: [] });

    expect(executorPrompt.prompt).toContain(content);
    expect(executorPrompt.prompt).toContain(tail);
    expect(executorPrompt.manifest.taskPromptChars).toBe(taskPrompt.length);
    expect(`${executorPrompt.systemPrompt}\n\n${executorPrompt.prompt}`.length).toBeLessThanOrEqual(40_000);
  });

  it("preserves primary reading requirements while truncating optional legacy context", () => {
    const work = workshop({ mission: "optional context ".repeat(5_000), modelConfig: {
      role: "reinforcement_learning_researcher", contextProfile: "full", researchEvidenceContract: primaryReadingContract,
    } });
    const task = "核对 DeepSeek 强化学习方法、实验和局限";
    const prompt = requiredPrompt({ workshop: work, directives: [directive({ content: task })] });
    const contract = formatWorkshopResearchContract(work.modelConfig, task)!;
    expect(prompt).toContain("[Context truncated to fit workshop run budget.]");
    expect(prompt).toContain(task);
    expect(prompt).toContain(contract);
    expect(prompt).toContain("researchEvidence");
    expect(prompt).toContain("evidenceEventIds");
    expect(prompt.length).toBeLessThanOrEqual(40_000);
  });

  it("activates legacy reading requirements only from the exact primary directive", () => {
    const work = workshop({ modelConfig: { role: "reinforcement_learning_researcher", contextProfile: "full",
      researchEvidenceContract: primaryReadingContract } });
    const prompt = requiredPrompt({ workshop: work, directives: [
      directive({ content: "查看本次任务状态" }),
      directive({ id: "historical-directive", content: "历史任务研究 DeepSeek" }),
    ] });
    expect(prompt).not.toContain("researchEvidence");
    const piTask = requiredPrompt({ workshop: work, directives: [directive({ content: "研究 DeepSeek" })],
      separateSystemPrompt: true });
    expect(piTask).not.toContain("researchEvidence");
  });

  it("blocks invalid legacy reading contracts without falling back to ordinary completion", () => {
    const work = workshop({ modelConfig: { role: "reinforcement_learning_researcher", contextProfile: "full",
      researchEvidenceContract: { ...primaryReadingContract, version: "unsupported/v9" } } });
    expect(() => requiredPrompt({ workshop: work, directives: [directive({ content: "研究 DeepSeek" })] }))
      .toThrow("Invalid workshop research evidence contract");
  });

  it("uses the exact admitted conversation task for legacy research requirements", () => {
    const work = workshop({ modelConfig: { role: "reinforcement_learning_researcher", contextProfile: "full",
      researchEvidenceContract: primaryReadingContract } });
    const task = "研究 DeepSeek 的强化学习工作";
    const prompt = requiredPrompt({ workshop: work, directives: [], primaryDirectiveId: undefined, researchTask: task });
    expect(prompt).toContain(formatWorkshopResearchContract(work.modelConfig, task)!);
    const unrelated = requiredPrompt({ workshop: work, researchTask: "查看任务状态",
      directives: [directive({ content: "历史任务研究 DeepSeek" })] });
    expect(unrelated).not.toContain("researchEvidence");
  });
});
