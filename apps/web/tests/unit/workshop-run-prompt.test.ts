import { describe, expect, it, vi } from "vitest";
import type { Workshop, Loop } from "@/lib/db/schema";
import { composeWorkshopRunPrompt, resolveWorkshopRunSkillSelections, WORKSHOP_BASE_SYSTEM_PROMPT } from "@/lib/workshops/run-prompt";
import { buildWorkshopPrompt } from "@/lib/workshops/context-window";
import { prepareLoopContextWindow, prepareLoopWorkshopContext } from "@/lib/loops/context-window";
import { buildNativeLoopPrompt } from "@/lib/loops/native-executor";
import { parseLoopSpec } from "@/lib/loops/spec";
import { sha256Hex } from "@/lib/ai/runtime/run-snapshot";
import { formatWorkshopResearchContract } from "@/lib/workshops/research-evidence-verification";

function workshop(config: Record<string, unknown> = {}): Workshop {
  return {
    id: "hunter", name: "自选股猎手", mission: "负责候选研究和池子维护，不下单。",
    userId: "owner", createdAt: new Date("2026-09-15"), updatedAt: new Date("2026-09-15"),
    status: "active", autonomyLevel: "auto", boundaryPolicy: {},
    modelConfig: { role: "watchlist_selector", workVersion: 3, ...config },
  } as Workshop;
}

describe("per-run workshop prompt assembly", () => {
  const primaryReadingContract = {
    version: "primary-reading/v1",
    taskKeywords: ["deepseek"],
    requiredPrimarySources: [
      { id: "deepseek-math", label: "DeepSeekMath", urls: ["https://arxiv.org/html/2402.03300"] },
      { id: "deepseek-r1", label: "DeepSeek-R1", urls: ["https://arxiv.org/html/2501.12948"] },
      { id: "deepseek-grm", label: "GRM/SPCT", urls: ["https://arxiv.org/html/2504.02495"] },
    ],
    minQualityScore: 60,
  };
  const researchFields = ["reportMarkdown", "researchProcess", "projectAssessment", "checkpoint", "warnings"];
  function nativePrompt(role: string, reportStyle?: string) {
    const spec = parseLoopSpec({ goal: "研究一份外部材料对项目恢复机制的真实价值", trigger: { type: "manual" }, verification: { requiredFields: researchFields } });
    return buildNativeLoopPrompt({
      loop: { id: "research", name: "项目技术研究", goal: spec.goal, triggerConfig: {} } as Loop,
      loopSpec: spec, contextWindow: prepareLoopContextWindow({ state: null, loopSpec: spec }),
      workshopContext: null, workshopRole: role, reportStyle, separateSystemPrompt: true,
      sessionDir: "D:/test", language: "en", maxToolCalls: 20,
    });
  }

  it("uses free Chinese project-value reporting only for the explicitly configured research role", () => {
    const prompt = nativePrompt("agent_frontier_researcher", "freeform_project_value");
    expect(prompt).toContain("Output language: Simplified Chinese");
    expect(prompt).toContain("不固定标题、章节、字数或结论数量");
    expect(prompt).toContain("知遇当前实现是否已有等价能力");
    expect(prompt).toContain("反例和不成立的情形");
    expect(prompt).toContain("不展示工具流水账或验收对勾");
    expect(prompt).toContain("reportMarkdown、researchProcess、projectAssessment、checkpoint、warnings");
    expect(prompt).toContain("JSON 外可以有正文，但不要求重复同一文章");
    expect(prompt).not.toContain("Start the Markdown report with one # heading");
    expect(prompt).not.toContain("当前结论, 关键依据, 指标/规则验证");
    expect(prompt).not.toContain('"finalMarkdownReport": "the same complete Markdown');
  });

  it("keeps the legacy native prompt unchanged for other roles and unconfigured researchers", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-02T06:00:00Z"));
      expect(nativePrompt("paper_trader", "freeform_project_value")).toBe(nativePrompt("paper_trader"));
      for (const style of [undefined, "other_style"]) {
        const prompt = nativePrompt("agent_frontier_researcher", style);
        expect(prompt).toContain("Start the Markdown report with one # heading");
        expect(prompt).toContain('"finalMarkdownReport": "the same complete Markdown');
        expect(prompt).toContain("Output language: English");
      }
    } finally { vi.useRealTimers(); }
  });

  it("removes duplicate report requirements from the free research system prompt without changing default base hashes", () => {
    const configured = workshop({ role: "agent_frontier_researcher", researchReportStyle: "freeform_project_value" });
    const free = composeWorkshopRunPrompt({ workshop: configured, prompt: "本轮研究" });
    expect(free.systemPrompt).toContain("无须重复同一文章");
    expect(free.systemPrompt).toContain("顶层保留本轮 requiredFields 验收字段，可附简短 summary");
    expect(free.systemPrompt).not.toContain("presentation 含 title、summary、reportMarkdown");
    expect(free.systemPrompt).toContain("系统回执决定运行状态");
    expect(free.systemPrompt).toContain("denied 优先于 allowed");
    expect(free.manifest.baseHash).not.toBe(sha256Hex(WORKSHOP_BASE_SYSTEM_PROMPT));
    const other = composeWorkshopRunPrompt({ workshop: workshop({ researchReportStyle: "freeform_project_value" }), prompt: "本轮工作" });
    const unconfigured = composeWorkshopRunPrompt({ workshop: workshop({ role: "agent_frontier_researcher" }), prompt: "本轮研究" });
    for (const result of [other, unconfigured]) {
      expect(result.systemPrompt).toContain(WORKSHOP_BASE_SYSTEM_PROMPT);
      expect(result.manifest.baseHash).toBe(sha256Hex(WORKSHOP_BASE_SYSTEM_PROMPT));
    }
  });

  it("keeps full role rules out of compacted observations and preserves the Loop task contract", () => {
    const work = workshop({ primarySkills: ["research"], loopSkillMap: { "收盘": "research" } });
    work.mission += "完整职责说明。".repeat(500) + "末尾职责不得截断。";
    const spec = parseLoopSpec({
      goal: "检查本次候选",
      trigger: { type: "manual" },
      context: { sources: [], instructions: "仅此 Loop：写入前检查池子。" },
      actions: { allowed: ["quantPaperGetWatchlist"], denied: ["quantPaperPlaceOrder"] },
      verification: { requiredFields: ["summary"], successCriteria: ["有本轮证据"] },
    });
    const context = prepareLoopWorkshopContext({ workshop: work, sources: [], memories: [], directives: [], events: [] });
    expect(context.workshop.mission).not.toContain("末尾职责不得截断。");
    const task = buildNativeLoopPrompt({
      loop: { id: "loop", name: "收盘", goal: spec.goal, triggerConfig: {} } as Loop,
      loopSpec: spec, contextWindow: prepareLoopContextWindow({ state: null, loopSpec: spec }),
      workshopContext: context, workshopRole: "watchlist_selector", separateSystemPrompt: true,
      sessionDir: "D:/test", language: "zh", maxToolCalls: 10,
    });
    const result = composeWorkshopRunPrompt({ workshop: work, prompt: task, loop: { id: "loop", name: "收盘" },
      skills: [{ name: "research", required: true, status: "loaded", content: "仅本次研究方法。" }] });
    expect(result.systemPrompt).toContain(work.mission);
    expect(result.systemPrompt.split(work.mission)).toHaveLength(2);
    expect(result.prompt).not.toContain("完整职责说明。");
    expect(result.prompt).toContain("仅此 Loop：写入前检查池子。");
    expect(result.systemPrompt).not.toContain("写入前检查池子");
    expect(result.prompt).toContain("<structured-output>");
    expect(result.prompt).toContain('"finalMarkdownReport"');
    expect(result.prompt).not.toContain("Paper-trading simulator rules");
    expect(result.prompt).not.toContain("Target 1-3");
    expect(result.prompt).not.toContain("8%-15%");
    expect(result.prompt).not.toContain("call the Skill tool");
    expect(result.prompt).not.toContain("active memory by default");
    expect(result.systemPrompt).toContain("仅本次研究方法。");
    expect(result.manifest).toMatchObject({ role: "watchlist_selector", workVersion: 3, systemPromptHash: sha256Hex(result.systemPrompt) });
  });

  it("shares a domain-neutral base while each role and task remains independent", () => {
    const hunter = composeWorkshopRunPrompt({ workshop: workshop(), prompt: "观察候选" });
    const writer = composeWorkshopRunPrompt({ workshop: { ...workshop({ role: "writing_assistant" }), mission: "编辑并核验文稿。" }, prompt: "检查文章" });
    expect(hunter.manifest.baseHash).toBe(writer.manifest.baseHash);
    expect(hunter.manifest.systemPromptHash).not.toBe(writer.manifest.systemPromptHash);
    expect(writer.systemPrompt).not.toContain("池子");
    expect(WORKSHOP_BASE_SYSTEM_PROMPT).not.toMatch(/quantPaper|8%-15%|池子|仓位/);
    expect(hunter.prompt).toBe("观察候选");
  });

  it("carries a Work's presentation design into both execution paths", () => {
    const work = workshop({ manifestSpec: { presentation: {
      purpose: "让主人核对本轮成果",
      requiredSections: ["conclusion", "evidence"],
      expectedArtifacts: ["Markdown 报告"],
    } } });
    const pi = composeWorkshopRunPrompt({ workshop: work, prompt: "完成本轮工作" });
    const claude = buildWorkshopPrompt({ workshop: work, sources: [], memories: [], directives: [], events: [], outbox: [], maxToolCalls: 10 });
    for (const prompt of [pi.systemPrompt, claude]) {
      expect(prompt).toContain("让主人核对本轮成果");
      expect(prompt).toContain("Markdown 报告");
      expect(prompt).toContain("预期不代表已交付");
    }
    expect(pi.systemPrompt).toContain("presentation");
  });

  it("selects only the current Loop's mapped method; direct runs list optional primary skills", () => {
    const work = workshop({ primarySkills: ["research", "audit"], loopSkillMap: { "收盘": "research", "自查": "audit", "其他": "unrelated" } });
    expect(resolveWorkshopRunSkillSelections(work, "收盘")).toEqual([{ name: "research", required: true }]);
    expect(resolveWorkshopRunSkillSelections(work)).toEqual([{ name: "research", required: false }, { name: "audit", required: false }]);
    const result = composeWorkshopRunPrompt({ workshop: work, prompt: "直接运行", skills: [{ name: "research", required: false, status: "available", description: "研究方法" }] });
    expect(result.systemPrompt).toContain("正文尚未加载");
    expect(result.systemPrompt).toContain("不可用，不能声称已遵循其方法");
    expect(result.systemPrompt).not.toContain("unrelated");
  });

  it("blocks missing mandatory skill and oversized full instructions before a model call", () => {
    expect(() => composeWorkshopRunPrompt({ workshop: workshop({ loopSkillMap: { run: "missing" } }), loop: { id: "l", name: "run" }, prompt: "task" })).toThrow("Required workshop skill unavailable: missing");
    expect(() => composeWorkshopRunPrompt({ workshop: { ...workshop(), mission: "x".repeat(48_000) }, prompt: "task" })).toThrow("required instructions were not truncated");
  });

  it("direct execution loads role once and never infers trading behavior from read tools", () => {
    const work = workshop({ primaryTools: ["quantPaperGetAccount", "quantPaperGetWatchlist"] });
    const task = buildWorkshopPrompt({ workshop: work, sources: [], memories: [], directives: [], events: [], outbox: [], maxToolCalls: 10, separateSystemPrompt: true });
    const result = composeWorkshopRunPrompt({ workshop: work, prompt: task });
    expect(task).not.toContain(work.mission);
    expect(result.systemPrompt).toContain(work.mission);
    expect(task).not.toContain("quantPaperPlaceOrder");
    expect(task).not.toContain("paper-trading rotation");
    expect(task).not.toContain("write memoryCandidates or call workshopWriteMemory");
    expect(task).toContain("compact strict JSON summary");
    expect(task).toContain('"nextWakeupSuggestion"');
    const legacyTask = buildWorkshopPrompt({ workshop: work, sources: [], memories: [], directives: [], events: [], outbox: [], maxToolCalls: 10 });
    expect(legacyTask).not.toContain("paper-trading rotation");
  });

  it("loads the configured primary reading contract and records its actual prompt identity", () => {
    const work = workshop({ researchEvidenceContract: primaryReadingContract });
    const ownerTask = "让强化学习前沿学习者，重点看deepseek关于这方面的工作";
    const result = composeWorkshopRunPrompt({ workshop: work, prompt: "本轮完整任务上下文", researchTask: ownerTask });
    const contract = formatWorkshopResearchContract(work.modelConfig, ownerTask)!;
    expect(result.systemPrompt).toContain(contract);
    expect(result.systemPrompt).toContain("researchEvidence");
    expect(result.systemPrompt).toContain("evidenceEventIds");
    expect(result.systemPrompt).toContain("DeepSeekMath");
    expect(result.systemPrompt).toContain("DeepSeek-R1");
    expect(result.systemPrompt).toContain("GRM/SPCT");
    expect(result.manifest).toMatchObject({ researchContractActive: true,
      researchContractVersion: "primary-reading/v1", researchContractHash: sha256Hex(contract) });
    expect(result.prompt).toBe("本轮完整任务上下文");
    expect(result.systemPrompt).toContain("denied 优先于 allowed");
    expect(result.systemPrompt).not.toContain("Sufficient research needs a successful Grep");
  });

  it("uses the admitted task instead of a historical topic when activating reading requirements", () => {
    const work = workshop({ researchEvidenceContract: primaryReadingContract });
    const result = composeWorkshopRunPrompt({ workshop: work,
      prompt: "历史报告讨论了 DeepSeek，现在的任务是确认任务状态。", researchTask: "确认任务状态" });
    expect(result.systemPrompt).not.toContain("researchEvidence");
    expect(result.manifest).toMatchObject({ researchContractActive: false,
      researchContractVersion: null, researchContractHash: null });
    const fallback = composeWorkshopRunPrompt({ workshop: work, prompt: "核对 DEEPSEEK 原文" });
    expect(fallback.manifest.researchContractActive).toBe(true);
  });

  it("rejects invalid configured reading requirements before assembling an execution prompt", () => {
    const work = workshop({ researchEvidenceContract: { ...primaryReadingContract,
      requiredPrimarySources: [{ id: "broken", label: "Broken", urls: ["file:///private.txt"] }] } });
    expect(() => composeWorkshopRunPrompt({ workshop: work, prompt: "DeepSeek 研究" }))
      .toThrow("Invalid workshop research evidence contract");
  });
});
