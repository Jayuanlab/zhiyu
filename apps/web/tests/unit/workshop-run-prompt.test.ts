import { describe, expect, it } from "vitest";
import type { Workshop, Loop } from "@/lib/db/schema";
import { composeWorkshopRunPrompt, resolveWorkshopRunSkillSelections, WORKSHOP_BASE_SYSTEM_PROMPT } from "@/lib/workshops/run-prompt";
import { buildWorkshopPrompt } from "@/lib/workshops/context-window";
import { prepareLoopContextWindow, prepareLoopWorkshopContext } from "@/lib/loops/context-window";
import { buildNativeLoopPrompt } from "@/lib/loops/native-executor";
import { parseLoopSpec } from "@/lib/loops/spec";
import { sha256Hex } from "@/lib/ai/runtime/run-snapshot";

function workshop(config: Record<string, unknown> = {}): Workshop {
  return {
    id: "hunter", name: "自选股猎手", mission: "负责候选研究和池子维护，不下单。",
    userId: "owner", createdAt: new Date("2026-09-15"), updatedAt: new Date("2026-09-15"),
    status: "active", autonomyLevel: "auto", boundaryPolicy: {},
    modelConfig: { role: "watchlist_selector", workVersion: 3, ...config },
  } as Workshop;
}

describe("per-run workshop prompt assembly", () => {
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
});
