import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHostWorkingMemory } from "@openzhiyu/ai/agent/runtime/host-working-memory";
import { loopPromotionEvents, promotionEvents, promotionLoopId, promotionRunId } from "../fixtures/working-memory-promotion";
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
  it("shows host report progress origin directly on the card without presenting it as a model LOG call", () => {
    const saved = event("working_memory_updated", {operation:"update",phase:"LOG",status:"ready_for_projection",
      commitOrigin:"validated_report_checkpoint",pruneToolCallIds:[],
      state:{facts:[],hypotheses:[],openQuestions:["下一轮核对实际来源。"],nextAction:{text:"",evidenceIds:[]}}});
    const original=structuredClone(saved),output=visible([saved]);
    expect(output).toContain("宿主已保存报告待办，供后续运行接续");
    expect(output).toContain("宿主提交报告待办（非模型工具调用）");
    expect(output).not.toContain("整理已保存，待模型调用采用");
    expect(saved).toEqual(original);
    for(const patch of [{receiptAuthority:"agent"},{persistenceError:"storage failed"},{__truncated:true}]) {
      expect(visible([{...saved,metadata:{...saved.metadata,...patch}}])).not.toContain("宿主已保存报告待办");
    }
    expect(visible([event()])).not.toContain("宿主提交报告待办");
  });
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
    expect(output).toContain("累计选择投影的工具正文（待模型调用采用）：read-1");
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
    expect(output).toContain("受到保护或不属于当前获准投影的读取来源");
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

  it("shows an observed but blocked catalog without counting an update or token saving", () => {
    const events = [event("working_memory_projected", {
      version: 0, pruneToolCallIds: [], state: undefined,
      originalChars: 24000, projectedChars: 24000,
      policyIdentity: { version: "memact-automem.v1", hash: "policy-a" }, phase: "PLAN",
      catalogSummary: {
        evidenceCount: 2, referenceEligibleCount: 2, projectionCandidateCount: 0,
        blockedCount: 2, blockedReasons: [{ code: "degraded_source", count: 2 }], truncated: false,
      },
      evidenceCatalog: [{
        toolCallId: "read-1", toolName: "webReadPage", provider: "direct-fallback", detail: "provider_failed",
        referenceEligible: true, projectionEligible: false, contentHash: "source-a",
        projectionBlockedReasons: ["degraded_source"], sourceIdentity: { finalUrlVerified: false, offset: 0 },
        sourceCautions: { warningCodes: ["partial_source"], warningTexts: ["原数据源不可用，正文不完整。"] },
      }],
    })];
    const original = structuredClone(events);
    const view = buildWorkingMemoryView(events)!;
    expect(view.counts).toEqual({ updated: 0, projected: 1, reduced: 0, restored: 0, rejected: 0 });
    const output = visible(events);
    expect(output).toContain("当前记录尚无已保存的整理更新");
    expect(output).toContain("已有来源，但此时没有可移出的正文");
    expect(output).toContain("可引用 2 条 · 可投影正文 0 条");
    expect(output).toContain("本次请求字符量未减少");
    expect(output).toContain("无法证明 token 成本变化");
    expect(markup(events)).toContain("原数据源不可用，正文不完整。");
    expect(markup(events)).toContain("direct-fallback");
    expect(markup(events)).toContain("最终地址已核验：否");
    expect(markup(events)).toContain("片段起点：0");
    expect(output).toContain("memact-automem.v1 · hash policy-a");
    expect(output).toContain("PLAN · 读取当前状态");
    expect(events).toEqual(original);
  });

  it("keeps a malformed catalog count unknown and preserves readable stable note keys", () => {
    const candidate = event("working_memory_updated", {
      phase: "LOG", policyIdentity: { version: "memact-automem.v1", hash: "policy-b" },
      readCount: 2, logCount: 1, planCount: 2,
      catalogSummary: { evidenceCount: false, referenceEligibleCount: -1, projectionCandidateCount: "0", blockedCount: 0, truncated: true },
      evidenceCatalog: [null, { toolCallId: false }],
      state: { facts: [{ key: "paper:method", text: "方法仍需独立核对。", evidenceIds: ["read-1"] }] },
    });
    const output = visible([candidate]);
    expect(output).toContain("观测 未记录 条 · 可引用 未记录 条 · 可投影正文 未记录 条");
    expect(output).not.toContain("目录为空不表示整理已成功");
    expect(output).toContain("来源详情达到展示上限");
    expect(output).toContain("LOG · 整理本轮观测");
    expect(output).toContain("读取 2 次 · LOG 1 次 · PLAN 2 次");
    expect(output).toContain("笔记键：paper:method");
  });

  it("reports actual SDK token fields and unknown receipts separately from character changes", () => {
    const events = [event(), event("working_memory_projected", {
      originalChars: 5000, projectedChars: 4200, state: undefined,
    }, 3), event("working_memory_usage", {
      status: "provider_result_received", invocation: 1, model: "model-a", provider: "provider-a", usageStatus: "reported",
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1100,
      state: undefined,
    }, 4), event("working_memory_usage", {
      status: "provider_result_received", invocation: 2, usageStatus: "not_reported",
      inputTokens: null, outputTokens: 50, totalTokens: null,
      state: undefined,
    }, 5)];
    const view = buildWorkingMemoryView(events)!;
    expect(view.checkpoint?.id).toBe("memory-2");
    expect(view.counts.reduced).toBe(1);
    expect(view.usage.records).toBe(2);
    expect(view.usage.inputTokens).toEqual({ known: 1000, missing: 1 });
    expect(view.usage.outputTokens).toEqual({ known: 150, missing: 0 });
    expect(view.usage.totalTokens).toEqual({ known: 1100, missing: 1 });
    const output = visible(events);
    expect(output).toContain("输入 1,000（另 1 次未记录）");
    expect(output).toContain("输出 150");
    expect(output).toContain("总 token 1,100（另 1 次未记录）");
    expect(output).toContain("缓存读取 0（另 1 次未记录）");
    expect(output).not.toContain("总 token 1,150");
  });

  it("does not count failed persistence or shadow request reductions as applied context savings", () => {
    const events = [event("working_memory_updated", { persistenceError: "failed" }),
      event("working_memory_projected", { mode: "shadow", originalChars: 5000, projectedChars: 4000, state: undefined }, 3),
      event("working_memory_restored", { persistenceError: "failed", state: undefined }, 4),
      event("working_memory_usage", { status: "provider_result_received", inputTokens: false, totalTokens: -1, state: undefined }, 5)];
    const view = buildWorkingMemoryView(events)!;
    expect(view.counts.updated).toBe(0);
    expect(view.counts.restored).toBe(0);
    expect(view.counts.reduced).toBe(0);
    expect(view.usage.inputTokens).toEqual({ known: null, missing: 1 });
    expect(visible(events)).toContain("输入 未记录");
  });

  it("projects actual host catalog, LOG/PLAN, projection, usage and restore receipts into the desktop view", async () => {
    const events: WorkshopEvent[] = [];
    const record = (type: string, metadata: object) => {
      const receipt = event(type, {}, events.length + 1);
      receipt.metadata = { ...metadata, receiptAuthority: "runtime" };
      events.push(receipt);
    };
    const gate = createHostWorkingMemory({ signal: new AbortController().signal, options: {
      mode: "apply", readonlyToolNames: ["read"], policyIdentity: { version: "memact-automem.v1", hash: "e".repeat(64) },
      onAudit: metadata => record(metadata.operation === "restore" ? "working_memory_restored" : "working_memory_updated", metadata),
      onProjection: metadata => record("working_memory_projected", metadata),
      onUsage: metadata => record("working_memory_usage", metadata),
    } });
    const assistant = fauxAssistantMessage({ ...fauxToolCall("read", {}), id: "read-1" }, { stopReason: "toolUse" });
    assistant.content.unshift({ type: "thinking", thinking: "Original reasoning remains in the protocol." });
    const context: Context = { messages: [assistant, {
      role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, timestamp: 1,
      content: [{ type: "text", text: "Original source content. ".repeat(300) }],
      details: { result: { sourceEventId: "event-source-1", provider: "fixture", offset: 0, nextOffset: 7000 } },
    }] };
    const original = structuredClone(context);
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage("ready"), fauxAssistantMessage("ready")]);
    const dispatch = () => gate.wrapStream((...args) => faux.streamSimple(...args))(faux.getModel(), context);
    await dispatch();
    expect(await gate.manage({ operation: "read" })).toMatchObject({ ok: true });
    expect(await gate.manage({ operation: "update", commandId: "log-1", expectedVersion: 0, phase: "LOG",
      state: { facts: [{ key: "source:first", text: "The source requires independent review.", evidenceIds: ["read-1"] }],
        hypotheses: [], openQuestions: [], nextAction: { text: "Review the source.", evidenceIds: ["read-1"] } },
      pruneToolCallIds: ["read-1"],
    })).toMatchObject({ ok: true });
    await dispatch();
    await gate.recordUsage({ usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100 } },
      { model: "faux-model", provider: "faux-provider", elapsedMs: 12 });
    const view = buildWorkingMemoryView(events)!;
    expect(view.catalog?.catalog).toMatchObject({ evidenceCount: 1, referenceEligibleCount: 1, projectionCandidateCount: 1, blockedCount: 0 });
    expect(view.protocol).toMatchObject({ phase: "LOG", readCount: 1, logCount: 1, planCount: 1 });
    expect(view.counts).toMatchObject({ updated: 1, projected: 2, reduced: 1, restored: 0 });
    expect(view.usage.totalTokens).toEqual({ known: 1100, missing: 0 });
    expect(markup(events)).toContain("原始事件：event-source-1");
    expect(visible(events)).toContain("笔记键：source:first");
    expect(context).toEqual(original);
    expect(await gate.manage({ operation: "restore", commandId: "restore-1", expectedVersion: 1 })).toMatchObject({ ok: true });
    expect(buildWorkingMemoryView(events)?.counts.restored).toBe(1);
    expect(visible(events)).toContain("本轮整理状态已清空");
    expect(visible(events)).not.toContain("The source requires independent review.");
    expect(context).toEqual(original);
  });

  it("shows owner candidate submission only on current notes, explains terminal waits and missing durable sources", () => {
    const events = promotionEvents();
    const runIdentity = { runKind: "workshop" as const, runId: promotionRunId };
    const onPromote = async () => ({ candidateId: "candidate", status: "candidate" });
    expect(markup(events)).not.toContain("送交长期记忆审核");
    const ready = renderToStaticMarkup(createElement(WorkingMemoryPanel, { events, onPromote, runStatus: "completed", runIdentity }));
    expect(ready).toContain("送交长期记忆审核");
    expect(ready).not.toContain('disabled=""');
    expect(ready).toContain("长期记忆仍须主人核验");
    const running = renderToStaticMarkup(createElement(WorkingMemoryPanel, { events, onPromote, runStatus: "running", runIdentity }));
    expect(running).toContain('disabled=""');
    expect(running).toContain("这轮运行尚未结束");
    const unconsumed = renderToStaticMarkup(createElement(WorkingMemoryPanel, { events: events.slice(0, 2), onPromote, runStatus: "completed", runIdentity }));
    expect(unconsumed).toContain('disabled=""');
    expect(unconsumed).toContain("这版笔记尚无后续模型请求准备回执");
    delete ((events[1].metadata.evidenceCatalog as Record<string, any>[])[0].sourceIdentity).sourceEventId;
    const local = renderToStaticMarkup(createElement(WorkingMemoryPanel, { events, onPromote, runStatus: "completed", runIdentity }));
    expect(local).toContain('disabled=""');
    expect(local).toContain("本地读取不能直接晋升");
  });
  it("enables finalized Loop notes by their Loop identity and rejects a colliding native identity", () => {
    const events = loopPromotionEvents();
    const onPromote = async () => ({ candidateId: "candidate", status: "candidate" });
    const runIdentity = { runKind: "loop" as const, runId: promotionRunId, loopId: promotionLoopId };
    const ready = renderToStaticMarkup(createElement(WorkingMemoryPanel, { events, onPromote, runStatus: "success", runIdentity }));
    expect(ready).toContain("送交长期记忆审核");
    expect(ready).not.toContain('disabled=""');
    const pending = renderToStaticMarkup(createElement(WorkingMemoryPanel, { events, onPromote, runStatus: "needs_review", runIdentity }));
    expect(pending).toContain('disabled=""');
    const wrong = renderToStaticMarkup(createElement(WorkingMemoryPanel, { events, onPromote, runStatus: "completed",
      runIdentity: { runKind: "workshop", runId: events[1].runId! } }));
    expect(wrong).toContain('disabled=""');
    expect(wrong).toContain("运行类型或持续任务身份无法核对");
  });
  it("explains inherited and skipped history without presenting it as verified or a restored conversation", () => {
    const inherited = event("working_memory_continuity_loaded", { schemaVersion: "working-memory-continuity.v1", receiptAuthority: "runtime",
      status: "inherited", reason: "inherited_with_corrections", warnings: [], checkpoint: {
        sourceRunId: promotionRunId, checkpointEventId: "checkpoint-1", loopId: promotionLoopId, expiresAt: "2026-10-23T00:00:00.000Z",
        chain: { assertionsSuppressed: true }, history: { facts: [], hypotheses: [], openQuestions: ["What still needs verification?"] },
      } });
    const shown = markup([inherited]);
    expect(shown).toContain("已为本轮输入准备历史工作状态");
    expect(shown).toContain("未解决问题 1 项");
    expect(shown).toContain("历史内容仍须核实");
    expect(shown).toContain("不会恢复原会话或回放旧工具");
    expect(shown).toContain("旧事实、假设和行动建议未带入本轮");
    expect(shown).not.toContain("送交长期记忆审核");
    const skipped = event("working_memory_continuity_loaded", { schemaVersion: "working-memory-continuity.v1", receiptAuthority: "runtime",
      status: "skipped", reason: "checkpoint_expired", warnings: [], checkpoint: null });
    expect(markup([skipped])).toContain("历史工作状态已过期，需要重新观察");
    expect(markup([skipped])).toContain("未接续不表示从未保存历史");
  });
});
