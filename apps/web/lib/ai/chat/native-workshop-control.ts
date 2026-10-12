import { createHash } from "node:crypto";
import { NativeWorkshopRunError, type RunWorkshopTarget } from "./native-workshop-run";
import type { ChatWorkshopContext } from "@/lib/work-runtime/chat-work-items";
import type { ChatTaskCommand } from "@/lib/work-runtime/chat-task-command";
import type { WorkCommandRecord } from "@/lib/work-runtime/command-ledger";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export type ChatControlAction = "assign" | "ask" | "continue" | "pause" | "cancel" | "stop";
export type NativeWorkshopControlBinding = {
  ownerId: string; chatId: string; turnId: string; userMessageId: string; prompt: string; action: ChatControlAction;
  workshopId: string; workshopName: string; commandId: string; expectedVersion: number;
  context: ChatWorkshopContext | null; revalidate: () => Promise<void>;
};
export type WorkshopControlDependencies = {
  verifyTurn: (input: { ownerId: string; chatId: string; userMessageId: string; prompt: string }) => Promise<void>;
  findNamedTargets: (ownerId: string, prompt: string) => Promise<RunWorkshopTarget[]>;
  loadContext: (ownerId: string, chatId: string) => Promise<ChatWorkshopContext | null>;
  baseline: (ownerId: string, workId: string) => Promise<{ workshop: RunWorkshopTarget; commandVersion: number } | null>;
  loadCommand: (ownerId: string, commandId: string) => Promise<WorkCommandRecord | null>;
  assign: (input: ChatTaskCommand) => Promise<unknown>;
  pause: (input: Record<string, unknown>) => Promise<unknown>;
  cancel: (input: Record<string, unknown>) => Promise<unknown>;
};

const defaults: WorkshopControlDependencies = {
  async verifyTurn(input) {
    const { db } = await import("@/lib/db/client");
    await (await import("@/lib/work-runtime/chat-work-items")).requirePersistedChatTurn(db, input);
  },
  async findNamedTargets(ownerId, prompt) {
    const { db } = await import("@/lib/db/client"); const { sql } = await import("drizzle-orm");
    const rows = await db.execute(sql`SELECT id,user_id AS "userId",name,mission,status FROM workshops
      WHERE user_id=${ownerId}::uuid AND (position(name in ${prompt})=1 OR position(id::text in ${prompt})=1
        OR (NULLIF(model_config->>'manifestName','') IS NOT NULL AND position(model_config->>'manifestName' in ${prompt})=1)) LIMIT 3`);
    return rows as unknown as RunWorkshopTarget[];
  },
  async loadContext(ownerId, chatId) { return (await import("@/lib/work-runtime/chat-work-items")).readChatWorkshopContext(ownerId, chatId); },
  async baseline(ownerId, workId) { return (await import("@/lib/workshops/service")).getWorkshopConfigurationBaseline(ownerId, workId); },
  async loadCommand(ownerId, commandId) { return (await import("@/lib/work-runtime/command-ledger")).getWorkCommand(ownerId, commandId); },
  async assign(input) { return (await import("@/lib/work-runtime/chat-task-command")).assignChatWorkshopTask(input); },
  async pause(input) { return (await import("@/lib/work-runtime/commands")).updateWork(input as any); },
  async cancel(input) { return (await import("@/lib/work-runtime/cancel-run")).cancelWorkRun(input as any); },
};

/** Conservative owner intent admission. Retrieved text and model arguments
 * never enter this parser; it only sees the current persisted user message. */
export function parseWorkshopControlAction(prompt: string): ChatControlAction | null {
  const text = prompt.trim().replace(/[。！!.]+$/u, "").replace(/^(?:(?:请帮我|帮我|请|现在|直接)\s*){0,3}/u, "");
  if (!text || /[?？]/u.test(text) || /^(?:不要|别|先别|如果|假如|是否|他说|她说|这段|以下|解释|为什么|怎么|查看|看看|[“"「])/u.test(text)) return null;
  const body = text.replace(/^(?:请帮我|帮我|请|现在|直接)\s*/u, "").replace(/^只(?=暂停|停止|取消|终止)/u, "");
  if (/^(?:暂停|停止|停下|停掉|取消|终止)/u.test(body)) {
    // Merely asking for future plans or current progress does not authorize
    // stopping that scope. Only direct control clauses contribute a scope.
    const clauses = body.split(/[，,；;。]/u).map(clause => clause.trim());
    const controlScope = clauses.filter((clause, index) => index === 0
      || /^(?:(?:并|再|同时|也|然后|顺便)\s*)?(?:暂停|停止|停下|停掉|取消|终止)/u.test(clause)
      || /^(?:当前|这轮|本轮|后续|以后|新任务)[^，,；;。]{0,24}(?:都停|也停|暂停|停止|取消|终止)/u.test(clause)).join("，");
    const future = /(?:后续|以后|接新任务|新任务)/u.test(controlScope);
    const current = /(?:当前|现在这轮|这轮|本轮)/u.test(controlScope);
    const keepCurrent = /(?:当前|这轮|本轮)[^，,；;。]{0,24}(?:继续|做完)|(?:不要|别|不)[^，,；;。]{0,12}(?:停止|取消|终止|暂停)[^，,；;。]{0,12}(?:当前|这轮|本轮)/u.test(body);
    const keepFuture = /(?:后续|以后|新任务)[^，,；;。]{0,24}(?:照常|继续|不变)|(?:保留|维持)[^，,；;。]{0,12}(?:后续|以后|新任务)|(?:后续|以后|新任务)[^，,；;。]{0,12}(?:不要|别|不)(?:再)?(?:暂停|停止|取消|终止)|(?:不要|别|不)(?:再)?(?:暂停|停止|取消|终止)[^，,；;。]{0,12}(?:后续|以后|新任务)/u.test(body);
    if (keepFuture) return current && !keepCurrent ? "cancel" : null;
    if (keepCurrent) return future ? "pause" : null;
    if (future && current) return "stop";
    if (future) return "pause";
    if (/(?:全部|都停|整个车间)/u.test(controlScope)) return "stop";
    if (/^(?:取消|终止)/u.test(body)) return "cancel";
    return current ? "cancel" : "pause";
  }
  if (/^(?:继续|补充|返工|重做|重新做)/u.test(body)) return "continue";
  if (/^(?:问一下|问问|询问|让.*(?:解释|回答))/u.test(body)) return "ask";
  if (/^(?:让|交给|交办|安排|委托|运行|执行)/u.test(body)) return "assign";
  return null;
}

export function workshopCommandSubject(prompt: string) {
  return prompt.trim().replace(/^(?:(?:请帮我|帮我|请|现在|直接)\s*){0,3}/u, "")
    .replace(/^只(?=暂停|停止|取消|终止)/u, "")
    .replace(/^(?:问一下|问问|询问|让|交给|交办|安排|委托|运行|执行|继续|补充|返工|重做|重新做|暂停|停止|停下|停掉|取消|终止)(?:一下|一次|一遍)?\s*/u, "");
}

function failure(code: string, message: string): never { throw new NativeWorkshopRunError(code, message); }
export function workshopControlCommandId(input: { ownerId: string; chatId: string; userMessageId: string; action: string }) {
  return "chat-workshop-control:" + createHash("sha256").update(JSON.stringify(["v1", input.ownerId, input.chatId, input.userMessageId, input.action])).digest("hex");
}

export async function resolveNativeWorkshopControl(input: {
  ownerId: string; chatId?: string; sessionId?: string; turnId: string; userMessageId?: string; prompt: string;
}, deps: WorkshopControlDependencies = defaults): Promise<NativeWorkshopControlBinding | undefined> {
  let action = parseWorkshopControlAction(input.prompt);
  if (!input.chatId || !input.userMessageId || ![input.ownerId, input.chatId, input.userMessageId].every(id => UUID.test(id))
    || (input.sessionId && input.sessionId !== input.chatId) || !input.turnId || input.prompt.length > 12_000) {
    if (action) failure("workshop_control_invalid_turn", "缺少当前对话已保存的主人指令，无法执行车间操作。");
    return undefined;
  }
  const context = await deps.loadContext(input.ownerId, input.chatId);
  // A direct answer to a Workshop's saved clarification resumes that item.
  if (!action && context?.itemStatus === "needs_input" && !/[?？]/u.test(input.prompt)
    && /^(?:只看|只研究|范围是|时间是|时间为|研究范围|我选|选择|答案是|按.{1,30}(?:范围|时间|标准)|[ABCＡＢＣ](?:[。.!！]|$))/iu.test(input.prompt.trim())) action = "continue";
  if (!action) return undefined;
  const request = { ownerId: input.ownerId, chatId: input.chatId, userMessageId: input.userMessageId, prompt: input.prompt };
  await deps.verifyTurn(request);
  const subject = workshopCommandSubject(input.prompt);
  const pronounTarget = /^(?:它|这个智能体|这个车间|该智能体|刚才的智能体)/u.test(subject);
  const named = pronounTarget ? [] : await deps.findNamedTargets(input.ownerId, subject);
  if (named.length > 1) failure("workshop_control_ambiguous", "指令涉及多个或同名智能体，请用名称和编号明确要操作的一个车间。");
  const commandId = workshopControlCommandId({ ...request, action });
  const previous = await deps.loadCommand(input.ownerId, commandId);
  const scopeOnly = /^(?:当前|这轮|本轮|后续|以后|全部|都|整个车间)/u.test(subject) || !subject;
  const canUseFocus = action === "continue" || pronounTarget || (["pause", "cancel", "stop"].includes(action) && scopeOnly);
  const workId = previous?.workId ?? named[0]?.id ?? (canUseFocus ? context?.workshopId : undefined);
  if (!workId) return undefined; // An unrelated ordinary command is still chat.
  if (named[0] && action === "continue" && context?.workshopId !== workId) failure("workshop_control_item_missing", "这条对话没有该车间的原事项关联，请先明确交办任务。");
  const target = await deps.baseline(input.ownerId, workId);
  if (!target || target.workshop.userId !== input.ownerId) failure("workshop_control_not_owned", "没有找到当前用户的这个车间。");
  // This adapter pauses the entire Work. A named Loop or a partial scope must
  // never be widened to the Work's admission barrier. Remove the exact Work
  // name first so a Work whose own name contains a cadence remains addressable.
  const scopeText = input.prompt.replace(target.workshop.name, "");
  if (["pause", "stop"].includes(action) && /(?:每周|每日|每天|定时|排期|循环任务|Loop|其他任务.*(?:照常|继续))/iu.test(scopeText)) {
    failure("workshop_control_scope_not_implemented", "当前对话入口仅支持暂停整个车间的后续接单，尚未接通单个持续任务或排期的暂停；没有修改车间状态。");
  }
  if (!previous && action === "continue" && (!context?.workItemId || !context.itemRevision || !["needs_input", "awaiting_acceptance", "failed", "cancelled"].includes(context.itemStatus ?? ""))) {
    failure("workshop_control_not_continuable", "原事项仍在运行、待核对或缺少关联。请先查看原运行；不会重复新建任务。");
  }
  if (!previous && ["assign", "ask", "continue"].includes(action) && target.workshop.status !== "active") failure("workshop_control_paused", "该车间已暂停或归档，请先在车间核对恢复范围。");
  const binding: NativeWorkshopControlBinding = { ...request, turnId: input.turnId, action, workshopId: workId,
    workshopName: target.workshop.name, commandId, expectedVersion: previous?.expectedVersion ?? target.commandVersion, context,
    async revalidate() {
      await deps.verifyTurn(request);
      const fresh = await deps.baseline(input.ownerId, workId);
      if (!fresh || fresh.workshop.userId !== input.ownerId) failure("workshop_control_not_owned", "车间归属已改变。");
      const prior = await deps.loadCommand(input.ownerId, commandId);
      if (prior) return;
      if (fresh.commandVersion !== binding.expectedVersion) failure("workshop_control_version_changed", "车间版本已变化，请核对当前状态后重试。");
      if (["assign", "ask", "continue"].includes(binding.action) && fresh.workshop.status !== "active") failure("workshop_control_paused", "车间当前已暂停。");
      if (!named.length || binding.action === "continue") {
        const latest = await deps.loadContext(input.ownerId, request.chatId);
        if (latest?.workshopId !== workId || latest.workItemId !== context?.workItemId || latest.itemRevision !== context?.itemRevision) {
          failure("workshop_control_context_changed", "对话的工作关联已变化，请明确当前要处理的事项。");
        }
      }
    } };
  return Object.freeze(binding);
}

export async function executeNativeWorkshopControl(binding: NativeWorkshopControlBinding, deps: WorkshopControlDependencies = defaults, signal?: AbortSignal) {
  if (binding.commandId !== workshopControlCommandId(binding) || !UUID.test(binding.workshopId) || typeof binding.revalidate !== "function") {
    failure("workshop_control_invalid_binding", "车间控制授权无效。");
  }
  signal?.throwIfAborted(); await binding.revalidate(); signal?.throwIfAborted();
  const previous = await deps.loadCommand(binding.ownerId, binding.commandId);
  if (previous) {
    const { decodeCommandResult } = await import("@/lib/work-runtime/database-command");
    const payload = decodeCommandResult<Record<string, unknown>>(previous.payload);
    if (previous.workId !== binding.workshopId || payload.userId !== binding.ownerId || payload.workId !== binding.workshopId
      || (previous.type === "assignChatWorkshopTask" && (payload.prompt !== binding.prompt || payload.chatId !== binding.chatId || payload.userMessageId !== binding.userMessageId))) {
      failure("workshop_control_receipt_conflict", "原控制命令与本次指令不一致，请核对回执。");
    }
    if (previous.status !== "succeeded") return { ok: false, status: "command_" + previous.status, commandId: binding.commandId,
      errorCode: previous.errorCode, message: "原命令尚未成功；请核对原回执，不会盲目新建运行。" };
    return { ok: true, replayed: true, status: "command_succeeded", readback: "immutable_command_receipt", nextRead: "observeWorkshop", action: binding.action, commandId: binding.commandId,
      workshopId: binding.workshopId, workshopUrl: `/workshop?workId=${binding.workshopId}`, result: decodeCommandResult(previous.result) };
  }
  const meta = { userId: binding.ownerId, workId: binding.workshopId, commandId: binding.commandId,
    expectedVersion: binding.expectedVersion, source: "chat_agent" as const, reason: `Persisted owner command ${binding.userMessageId} in chat ${binding.chatId}` };
  let result: unknown;
  try {
  if (binding.action === "pause") {
    await deps.pause({ ...meta, patch: { status: "paused" } });
    result = { status: "future_paused", queuedPolicy: "kept_paused", currentRunCancelled: false };
  } else if (binding.action === "cancel" || binding.action === "stop") {
    if (!binding.context?.runId || binding.context.workshopId !== binding.workshopId) failure("workshop_control_run_missing", "没有关联到该车间的具体运行，请先定位要取消的那一轮。");
    result = await deps.cancel({ ...meta, source: "owner", runId: binding.context.runId, pauseFuture: binding.action === "stop" });
  } else {
    const continuing = binding.action === "continue";
    const intentText = continuing ? `${binding.context!.intentText}\n\n主人本次补充（只用于原事项）：\n${binding.prompt}` : binding.prompt;
    if (intentText.length > 24_000) failure("workshop_control_input_too_long", "原事项和补充超过完整输入上限，请先整理要求；不会静默截断主任务。");
    result = await deps.assign({ ...meta, chatId: binding.chatId, userMessageId: binding.userMessageId, prompt: binding.prompt,
      intentText, mode: binding.action === "ask" || (continuing && binding.context?.itemMode === "conversation") ? "ask" : "task",
      ...(continuing && binding.context?.itemMode === "conversation" && binding.context.runId ? { parentRunId: binding.context.runId } : {}),
      ...(continuing ? { workItemId: binding.context!.workItemId!, expectedItemRevision: binding.context!.itemRevision!, continuationFromRunId: binding.context!.runId! } : {}) });
  }
  } catch (error) {
    const { WorkCommandConflict } = await import("@/lib/work-runtime/command-ledger");
    if (!(error instanceof WorkCommandConflict)) throw error;
    return { ok: false, status: "command_rejected", action: binding.action, commandId: binding.commandId,
      workshopId: binding.workshopId, errorCode: error.code, workshopUrl: `/workshop?workId=${binding.workshopId}`,
      message: error.code === "input_not_available" ? "附件尚未完成向车间的持久输入交接，本次未启动。请先在车间提供完整资料，或只交办明确的文字任务。"
        : error.code === "target_busy" ? "该车间有未结束或待核对的运行，或已经暂停；本次没有另建运行。请查看原记录。"
        : "本次控制命令未成功，原因：" + error.code + "。请核对原命令，不会盲目重跑。" };
  }
  return { ok: true, action: binding.action, commandId: binding.commandId, workshopId: binding.workshopId,
    workshopName: binding.workshopName, workshopUrl: `/workshop?workId=${binding.workshopId}`, result };
}
