import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkingMemoryPanel } from "@/app/(chat)/workshop/working-memory-panel";
import type { WorkshopEvent } from "@/lib/workshops/run-history-types";
import { buildWorkingMemoryView } from "@/lib/workshops/working-memory-view";

function event(type = "working_memory_updated", metadata: Record<string, unknown> = {}, seq = 2): WorkshopEvent {
  return {
    id: `memory-${seq}`, workshopId: "work", runId: "run", seq, type,
    title: "工作记忆整理", body: null, createdAt: "2026-10-10T01:02:03.000Z",
    metadata: {
      schemaVersion: "host-working-memory.v1", receiptAuthority: "runtime",
      mode: "apply", commandId: `command-${seq}`, previousVersion: 0, version: 1,
      pruneToolCallIds: ["read-1"], restoredToolCallIds: [],
      state: {
        facts: [{ text: "已读取第一篇论文，内容解释仍需核对。", evidenceIds: ["read-1"] }],
        hypotheses: [{ text: "压缩可能减少重复读取。", evidenceIds: [] }],
        openQuestions: ["压缩后是否丢失失败证据？"],
        nextAction: { text: "核对实验条件。", evidenceIds: ["read-1"] },
      },
      ...metadata,
    },
  };
}

function markup(events: WorkshopEvent[]) {
  return renderToStaticMarkup(createElement(WorkingMemoryPanel, { events }));
}

function visible(events: WorkshopEvent[]) {
  return markup(events).replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
}

describe("desktop working memory observation", () => {
  it("does not add a panel or an inferred memory state to runs without memory actions", () => {
    expect(buildWorkingMemoryView([event("run_started")])).toBeNull();
    expect(markup([event("run_started")])).toBe("");
  });

  it.each([
    { schemaVersion: undefined },
    { schemaVersion: "host-working-memory.v2" },
    { schemaVersion: false },
    { receiptAuthority: undefined },
    { receiptAuthority: "agent" },
    { receiptAuthority: "unknown" },
  ])("leaves receipts with unsupported schema or authority in ordinary events: %j", metadata => {
    const candidate = event("working_memory_updated", metadata);
    const events = [event("run_started"), candidate];
    const original = structuredClone(events);
    expect(buildWorkingMemoryView(events)).toBeNull();
    expect(markup(events)).toBe("");
    expect(events).toEqual(original);
    expect(events[1]).toBe(candidate);
  });

  it("does not let an unsupported newer receipt replace the last supported host record", () => {
    const current = event();
    const unsupported = event("working_memory_restored", { schemaVersion: "host-working-memory.v2", version: 2 }, 3);
    const untrusted = event("working_memory_projected", { receiptAuthority: "agent", version: 3 }, 4);
    const events = [current, unsupported, untrusted];
    const original = structuredClone(events);
    const view = buildWorkingMemoryView(events)!;
    expect(view.records.map(record => record.id)).toEqual([current.id]);
    expect(view.checkpoint?.id).toBe(current.id);
    expect(view.projection).toBeNull();
    expect(events).toEqual(original);
  });

  it("separates agent estimates, hypotheses, gaps and tool receipt references", () => {
    const output = markup([event()]);
    expect(output).toContain('aria-label="本轮工作记忆"');
    expect(output).toContain("事实摘要（智能体整理，需核对来源）");
    expect(output).toContain("待验证的假设");
    expect(output).toContain("未独立验证");
    expect(output).toContain("尚未解决的问题");
    expect(output).toContain("工具回执引用：read-1");
    expect(output).toContain("累计移出本轮上下文的工具回执：read-1");
    expect(output).toContain("版本 1");
    expect(output).not.toContain("已验证事实");
    expect(output).not.toContain("sourceEventId");
    expect(output).toMatch(/<details\b[^>]*><summary\b/);
    expect(output).not.toMatch(/<details\b[^>]*\bopen(?:=|\s|>)/);
    expect(output).toContain("09:02:03");
  });

  it("exposes a shadow candidate without suggesting that context was pruned", () => {
    const output = markup([event("working_memory_updated", { mode: "shadow" })]);
    expect(output).toContain("候选已记录");
    expect(output).toContain("仅记录候选");
    expect(output).toContain("本轮上下文未裁剪");
    expect(output).toContain("候选移出的工具回执（本轮未生效）：read-1");
    expect(output).not.toContain("本轮上下文已整理");
  });

  it("keeps the last accepted summary after rejection and displays the rejection reason", () => {
    const events = [event(), event("working_memory_rejected", {
      reason: "unknown_evidence_id", version: 1,
      state: { facts: [{ text: "拒绝的候选不应覆盖现有摘要。", evidenceIds: ["unknown"] }] },
    }, 3)];
    const view = buildWorkingMemoryView(events)!;
    expect(view.latest.statusLabel).toBe("整理未应用");
    expect(view.checkpoint?.id).toBe("memory-2");
    const output = visible(events);
    expect(output).toContain("unknown_evidence_id");
    expect(output).toContain("已读取第一篇论文");
    expect(output).not.toContain("拒绝的候选不应覆盖现有摘要");
  });

  it("does not continue presenting an old summary as current after an in-run restore", () => {
    const events = [event(), event("working_memory_restored", {
      version: 2, pruneToolCallIds: [], restoredToolCallIds: ["read-1"],
      state: { facts: [], hypotheses: [], openQuestions: [], nextAction: null },
    }, 3)];
    expect(buildWorkingMemoryView(events)?.checkpoint?.type).toBe("working_memory_restored");
    const output = visible(events);
    expect(output).toContain("本轮整理状态已清空");
    expect(output).not.toContain("已读取第一篇论文");
    expect(markup(events)).toContain("恢复的工具回执：read-1");
    expect(output).not.toContain("下轮已恢复");
  });

  it("distinguishes a saved edit from a prepared model request and exposes measured character counts", () => {
    const saved = event();
    expect(visible([saved])).toContain("整理已保存，待模型调用采用");
    expect(visible([saved])).toContain("不能据此认定已发往模型");
    const prepared = event("working_memory_projected", {
      originalChars: 25000, projectedChars: 14000,
      originalMessageCount: 13, projectedMessageCount: 11,
      state: undefined,
    }, 3);
    const view = buildWorkingMemoryView([saved, prepared])!;
    expect(view.checkpoint?.id).toBe(saved.id);
    expect(view.projection?.id).toBe(prepared.id);
    const output = visible([saved, prepared]);
    expect(output).toContain("模型请求上下文已准备");
    expect(output).toContain("25,000 → 14,000 字符");
    expect(output).toContain("13 → 11 条消息");
    expect(output).toContain("不表示模型已理解摘要或完成任务");
  });

  it("shows when the latest saved edit has no matching request preparation yet", () => {
    const prepared = event("working_memory_projected", {
      originalChars: 5000, projectedChars: 4000, version: 1,
    }, 3);
    const updated = event("working_memory_updated", { version: 2 }, 4);
    expect(visible([prepared, updated])).toContain("与最近保存的摘要版本不同");
    expect(buildWorkingMemoryView([prepared, updated])?.checkpoint?.version).toBe("2");
  });

  it("explains a host rejection in readable language while retaining its diagnostic code", () => {
    const output = markup([event("working_memory_rejected", { code: "unsafe_prune" })]);
    expect(output).toContain("受到保护或不属于可移出的完整读取记录");
    expect(output).toContain("诊断代码：unsafe_prune");
    expect(output).not.toContain("本轮上下文已整理");
  });

  it("leaves storage failure and truncated metadata visible without claiming an accepted state", () => {
    const events = [event(), event("working_memory_updated", {
      __truncated: true, persistenceError: "event_store_unavailable", state: {}, version: 2,
    }, 3)];
    const view = buildWorkingMemoryView(events)!;
    expect(view.checkpoint?.version).toBe("1");
    const output = visible(events);
    expect(output).toContain('role="alert"');
    expect(output).toContain("event_store_unavailable");
    expect(output).toContain("整理记录已截断");
    expect(output).toContain("已读取第一篇论文");
    expect(view.latest.statusLabel).toBe("保存结果异常");
  });

  it("handles malformed payloads as missing observations and escapes model content", () => {
    const events = [event("working_memory_updated", {
      mode: "surprise", version: false,
      state: { facts: [{ text: "<script>unsafe</script>", evidenceIds: ["<tool>", {}, 123] }, null],
        hypotheses: "not-an-array", openQuestions: [false, "缺口"], nextAction: false },
    })];
    const output = markup(events);
    expect(output).toContain("未知模式（surprise）");
    expect(output).toContain("版本未记录");
    expect(output).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(output).not.toContain("<script>");
    expect(output).toContain("&lt;tool&gt;");
    expect(output).not.toContain("[object Object]");
    expect(output).toContain("缺口");
    expect(output).not.toContain("本轮上下文已整理");
  });

  it("uses run sequence for the latest edit without mutating the supplied event list", () => {
    const latest = event("working_memory_updated", { version: 2 }, 10);
    latest.createdAt = "2026-10-10T00:00:00.000Z";
    const events = [event(), latest];
    expect(buildWorkingMemoryView(events)?.latest.version).toBe("2");
    expect(events.map((entry) => entry.seq)).toEqual([2, 10]);
  });
});
