import { createHash } from "node:crypto";
import { canonicalCommandJson } from "@/lib/work-runtime/command-payload";
import { decodeCommandResult } from "@/lib/work-runtime/database-command";
import type { WorkCommandRecord } from "@/lib/work-runtime/command-ledger";
import type { startWorkRun } from "@/lib/work-runtime/commands";
import { buildWorkPresentation, type WorkPresentationEvent, type WorkPresentationV1 } from "@/lib/workshops/work-presentation";
import type { NativeConversationSourceMessage } from "./native-conversation";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const EVENT_LIMIT = 200;
const OUTPUT_LIMIT = 64_000;
const REPORT_LIMIT = 32_000;

export class NativeWorkshopRunError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = "NativeWorkshopRunError";
  }
}
function fail(code: string, message: string, status = 409): never { throw new NativeWorkshopRunError(code, message, status); }

export type RunWorkshopTarget = { id: string; userId: string; name: string; mission: string; status: string; modelConfig?: unknown };
export type OwnedWorkshopRun = {
  id: string; workshopId: string; status: string; outputSummary: string | null; error: string | null;
  createdAt: string | Date; updatedAt: string | Date; startedAt: string | Date | null; completedAt: string | Date | null;
};
export type WorkshopRunDependencies = {
  loadChat: (chatId: string) => Promise<{ userId: string } | undefined>;
  loadMessages: (chatId: string) => Promise<readonly NativeConversationSourceMessage[]>;
  loadTurnMessages?: (chatId: string, userMessageId: string) => Promise<readonly NativeConversationSourceMessage[]>;
  loadContext?: (ownerId: string, chatId: string) => Promise<{ workshopId: string } | null>;
  listWorkshops: (ownerId: string, limit: number) => Promise<RunWorkshopTarget[]>;
  loadWorkshopBaseline: (ownerId: string, workshopId: string) => Promise<{ workshop: RunWorkshopTarget; commandVersion: number } | null>;
  loadCommand: (ownerId: string, commandId: string) => Promise<WorkCommandRecord | null>;
  startRun: typeof startWorkRun;
  loadRun: (ownerId: string, workshopId: string, runId: string) => Promise<OwnedWorkshopRun | null>;
  loadEvents: (workshopId: string, runId: string, limit: number) => Promise<WorkPresentationEvent[]>;
  readOccupancy: (ownerId: string, workshopId: string) => Promise<{ runId: string; status: string } | null>;
  loadDelivery?: (ownerId: string, workshopId: string, runId: string) => Promise<Record<string, unknown> | null>;
};

const defaultDependencies: WorkshopRunDependencies = {
  async loadChat(chatId) { return (await import("@/lib/db/chat-queries")).getChatById({ id: chatId }); },
  async loadMessages(chatId) { return (await import("@/lib/db/chat-queries")).getMessagesByChatId({ id: chatId, limit: 1001 }); },
  async loadTurnMessages(chatId, userMessageId) {
    const { db } = await import("@/lib/db/client"); const { sql } = await import("drizzle-orm");
    return await db.execute(sql`SELECT m.id,m."chatId",m.role,m.parts FROM "Message_v2" m
      WHERE m."chatId"=${chatId}::uuid AND (m.id=${userMessageId}::uuid OR (m.role='user' AND m."createdAt">=
        (SELECT "createdAt" FROM "Message_v2" WHERE id=${userMessageId}::uuid AND "chatId"=${chatId}::uuid)))
      ORDER BY m."createdAt",m.id LIMIT 3`) as unknown as NativeConversationSourceMessage[];
  },
  async loadContext(ownerId, chatId) { return (await import("@/lib/work-runtime/chat-work-items")).readChatWorkshopContext(ownerId, chatId); },
  async listWorkshops(ownerId, limit) { return (await import("@/lib/workshops/service")).listWorkshops(ownerId, limit); },
  async loadWorkshopBaseline(ownerId, workshopId) { return (await import("@/lib/workshops/service")).getWorkshopConfigurationBaseline(ownerId, workshopId); },
  async loadCommand(ownerId, commandId) { return (await import("@/lib/work-runtime/command-ledger")).getWorkCommand(ownerId, commandId); },
  async startRun(command) { return (await import("@/lib/work-runtime/commands")).startWorkRun(command); },
  async loadRun(ownerId, workshopId, runId) {
    const { db } = await import("@/lib/db/client"); const { sql } = await import("drizzle-orm");
    const rows = await db.execute(sql`SELECT r.id,r.workshop_id AS "workshopId",r.status,r.output_summary AS "outputSummary",r.error,
      r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.started_at AS "startedAt",r.completed_at AS "completedAt"
      FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
      WHERE w.user_id=${ownerId}::uuid AND w.id=${workshopId}::uuid AND r.id=${runId}::uuid`);
    return (rows[0] as unknown as OwnedWorkshopRun | undefined) ?? null;
  },
  async loadEvents(workshopId, runId, limit) { return (await import("@/lib/workshops/service")).listWorkshopEvents(workshopId, { runId, limit, order: "latest" }); },
  async readOccupancy(ownerId, workshopId) {
    const { db } = await import("@/lib/db/client"); const { sql } = await import("drizzle-orm");
    const rows = await db.execute(sql`SELECT r.id AS "runId",r.status FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
      WHERE w.user_id=${ownerId}::uuid AND w.id=${workshopId}::uuid AND r.status IN ('queued','running','cancel_requested','needs_review')
      ORDER BY r.created_at,r.id LIMIT 1`);
    return (rows[0] as unknown as { runId: string; status: string } | undefined) ?? null;
  },
  async loadDelivery(ownerId, workshopId, runId) {
    const { db } = await import("@/lib/db/client"); const { sql } = await import("drizzle-orm");
    const rows = await db.execute(sql`SELECT d.status,d.attempts,d.last_error_code AS "errorCode",d.next_attempt_at AS "nextAttemptAt",
      d.delivered_at AS "deliveredAt" FROM workshop_chat_deliveries d JOIN workshops w ON w.id=d.workshop_id
      WHERE d.owner_id=${ownerId}::uuid AND w.user_id=${ownerId}::uuid AND w.id=${workshopId}::uuid AND d.run_id=${runId}::uuid
      ORDER BY d.created_at DESC,d.id DESC LIMIT 1`);
    return rows[0] ?? null;
  },
};

type WorkshopRunAuthorizationBase = {
  ownerId: string; chatId: string; workshopId: string; workshopName: string; requestId: string;
  expectedVersion: number; commandId: string; revalidate: () => Promise<void>;
};
export type NativeWorkshopRunAuthorization = WorkshopRunAuthorizationBase & {
  origin: "chat_command"; turnId: string; userMessageId: string; prompt: string; promptSha256: string;
};
export type OwnerClickedWorkshopRunAuthorization = WorkshopRunAuthorizationBase & { origin: "owner_button" };
export type WorkshopRunAuthorization = NativeWorkshopRunAuthorization | OwnerClickedWorkshopRunAuthorization;

function messageText(message: NativeConversationSourceMessage) {
  return (message.parts ?? []).flatMap(part => {
    if (!part || typeof part !== "object") return [];
    const value = part as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("");
}
function targetName(prompt: string): string | null {
  const text = prompt.trim().replace(/[。！!.]+$/u, "");
  if (/[?？]/u.test(text) || /^(?:不要|别|先别|如果|假如|是否|他说|她说)/u.test(text)) return null;
  const match = text.match(/^(?:请帮我|帮我|请)?(?:直接)?(?:运行|执行)(?:一下|一次|一遍)?\s*(.+?)(?:\s*(?:一下|一次|一遍))?$/u)
    ?? text.match(/^(?:please\s+)?(?:run|execute)\s+(.+?)(?:\s+once)?$/iu);
  return match?.[1]?.trim().replace(/^["“「](.*)["”」]$/u, "$1") || null;
}
function comparableName(value: string) { return value.trim().toLowerCase().replace(/(?:智能体|车间|workshop|agent)$/iu, "").trim(); }
const PRONOUNS = new Set(["这个智能体", "这个车间", "该智能体", "刚才的智能体", "刚创建的智能体", "它"]);

function stableCommand(input: { ownerId: string; chatId: string; workshopId: string; requestId: string; origin: string }) {
  return "web-chat-workshop-run-once:" + createHash("sha256").update(JSON.stringify([
    "web-chat-workshop-run-once.v1", input.ownerId, input.chatId, input.workshopId, input.origin, input.requestId,
  ])).digest("hex");
}
function commandInput(binding: WorkshopRunAuthorization, expectedVersion = binding.expectedVersion): Parameters<typeof startWorkRun>[0] {
  return { userId: binding.ownerId, workId: binding.workshopId, commandId: binding.commandId, expectedVersion,
    source: "chat_agent", reason: `Owner requested one Workshop run from chat ${binding.chatId}; request=${binding.requestId}.`,
    triggerReason: { type: "manual", source: "web_chat", chatId: binding.chatId, requestId: binding.requestId, origin: binding.origin, once: true,
      userMessageId: binding.origin === "chat_command" ? binding.userMessageId : null,
      prompt: binding.origin === "chat_command" ? binding.prompt : null,
      promptSha256: binding.origin === "chat_command" ? binding.promptSha256 : null },
  };
}
function verifyCommand(binding: WorkshopRunAuthorization, record: WorkCommandRecord) {
  try {
    const payload = decodeCommandResult(record.payload);
    if (record.commandId !== binding.commandId || record.workId !== binding.workshopId || record.type !== "startWorkRun"
      || canonicalCommandJson(payload) !== canonicalCommandJson(commandInput(binding, record.expectedVersion))) throw Error("mismatch");
  } catch { fail("workshop_run_command_conflict", "这次请求与已保存的运行命令不一致，请查看工作记录核对。"); }
}
async function ownedChat(ownerId: string, chatId: string, dependencies: WorkshopRunDependencies) {
  const chat = await dependencies.loadChat(chatId);
  if (!chat || chat.userId !== ownerId) fail("workshop_run_chat_not_owned", "无法运行：此对话不属于当前用户。");
}
function requireActive(workshop: RunWorkshopTarget) {
  if (workshop.status !== "active") fail(workshop.status === "archived" ? "workshop_run_archived" : "workshop_run_paused",
    "智能体当前已暂停或归档，不能开始新运行；请在车间核对状态。");
}
async function ownedTarget(ownerId: string, workshopId: string, dependencies: WorkshopRunDependencies) {
  const target = await dependencies.loadWorkshopBaseline(ownerId, workshopId);
  if (!target || target.workshop.id !== workshopId || target.workshop.userId !== ownerId) fail("workshop_run_not_found", "当前用户没有这个智能体。", 404);
  return target;
}
async function currentMessages(input: { ownerId: string; chatId: string; userMessageId: string; prompt: string }, dependencies: WorkshopRunDependencies) {
  await ownedChat(input.ownerId, input.chatId, dependencies);
  const messages = dependencies.loadTurnMessages ? await dependencies.loadTurnMessages(input.chatId, input.userMessageId)
    : await dependencies.loadMessages(input.chatId);
  if (messages.some(message => message.chatId !== input.chatId)) fail("workshop_run_chat_mismatch", "运行指令来源与当前对话不一致。");
  const index = messages.findIndex(message => message.id === input.userMessageId);
  if (index < 0 || messages[index].role !== "user" || messageText(messages[index]) !== input.prompt) {
    fail("workshop_run_message_mismatch", "运行指令尚未保存或内容已改变，请在当前对话重新提交。");
  }
  if ((dependencies.loadTurnMessages ? messages.some(message => message.role === "user" && message.id !== input.userMessageId)
    : messages.slice(index + 1).some(message => message.role === "user"))) fail("workshop_run_message_stale", "对话中已有更新的指令，本次运行请求已过期。");
  return messages;
}
async function resolveTarget(ownerId: string, subject: string, messages: readonly NativeConversationSourceMessage[], chatId: string, dependencies: WorkshopRunDependencies) {
  if (UUID.test(subject)) return (await ownedTarget(ownerId, subject.toLowerCase(), dependencies)).workshop;
  let name = subject;
  if (PRONOUNS.has(subject)) {
    const context = await dependencies.loadContext?.(ownerId, chatId);
    if (!context?.workshopId) fail("workshop_run_target_missing", "此对话没有已交办的智能体关联，请说明要运行哪个智能体。");
    return (await ownedTarget(ownerId, context.workshopId, dependencies)).workshop;
  }
  const candidates = await dependencies.listWorkshops(ownerId, 201);
  if (candidates.length > 200) fail("workshop_run_target_ambiguous", "智能体列表较多，请提供要运行的智能体编号。");
  const matches = candidates.filter(workshop => {
    if (workshop.userId !== ownerId) return false;
    const config = workshop.modelConfig && typeof workshop.modelConfig === "object" ? workshop.modelConfig as Record<string, unknown> : {};
    return comparableName(workshop.name) === comparableName(name) || config.manifestName === name;
  });
  if (!matches.length) fail("workshop_run_target_missing", "没有找到当前用户的这个智能体，请核对名称。");
  if (matches.length !== 1) fail("workshop_run_target_ambiguous", "有多个同名智能体，请提供要运行的智能体编号。");
  return matches[0];
}

export async function resolveNativeWorkshopRun(
  input: { ownerId: string; chatId?: string; sessionId?: string; turnId: string; userMessageId?: string; prompt: string },
  dependencies: WorkshopRunDependencies = defaultDependencies,
): Promise<NativeWorkshopRunAuthorization | undefined> {
  const subject = targetName(input.prompt);
  if (!subject) return undefined;
  if (!input.chatId || (input.sessionId && input.sessionId !== input.chatId)) fail("workshop_run_chat_mismatch", "当前对话标识不一致，无法运行。");
  if (![input.ownerId, input.chatId, input.userMessageId].every(value => typeof value === "string" && UUID.test(value))
    || !input.turnId?.trim() || input.turnId.length > 256 || input.prompt.length > 12_000) {
    fail("workshop_run_invalid_request", "运行请求缺少有效的已保存指令。", 400);
  }
  const request = { ownerId: input.ownerId, chatId: input.chatId, userMessageId: input.userMessageId!, prompt: input.prompt };
  const messages = await currentMessages(request, dependencies);
  const workshop = await resolveTarget(input.ownerId, subject, messages, input.chatId, dependencies);
  const target = await ownedTarget(input.ownerId, workshop.id, dependencies);
  const base = { ...request, origin: "chat_command" as const, turnId: input.turnId, workshopId: workshop.id,
    workshopName: target.workshop.name, requestId: input.userMessageId!, expectedVersion: target.commandVersion,
    promptSha256: createHash("sha256").update(input.prompt, "utf8").digest("hex") };
  const draft: NativeWorkshopRunAuthorization = { ...base, commandId: stableCommand(base), revalidate: async () => {} };
  const previous = await dependencies.loadCommand(draft.ownerId, draft.commandId);
  if (previous) { verifyCommand(draft, previous); draft.expectedVersion = previous.expectedVersion; }
  else requireActive(target.workshop);
  const binding: NativeWorkshopRunAuthorization = { ...draft, async revalidate() {
    const freshMessages = await currentMessages(request, dependencies);
    const freshWorkshop = await resolveTarget(request.ownerId, subject, freshMessages, request.chatId, dependencies);
    if (freshWorkshop.id !== binding.workshopId) fail("workshop_run_target_changed", "本次指令对应的智能体已改变，请重新提交。");
    const freshTarget = await ownedTarget(binding.ownerId, binding.workshopId, dependencies);
    const prior = await dependencies.loadCommand(binding.ownerId, binding.commandId);
    if (prior) { verifyCommand(binding, prior); return; }
    requireActive(freshTarget.workshop);
    if (freshTarget.commandVersion !== binding.expectedVersion) fail("workshop_run_version_changed", "智能体状态已变化，请核对后重新运行。");
  } };
  return Object.freeze(binding);
}

export async function resolveOwnerClickedWorkshopRun(
  input: { ownerId: string; chatId: string; workshopId: string; requestId: string },
  dependencies: WorkshopRunDependencies = defaultDependencies,
): Promise<OwnerClickedWorkshopRunAuthorization> {
  if (![input.ownerId, input.chatId, input.workshopId, input.requestId].every(value => typeof value === "string" && UUID.test(value))) {
    fail("workshop_run_invalid_request", "请选择当前对话中的智能体并重试。", 400);
  }
  const request = Object.freeze({ ...input });
  await ownedChat(request.ownerId, request.chatId, dependencies);
  const target = await ownedTarget(request.ownerId, request.workshopId, dependencies);
  const base = { ...request, origin: "owner_button" as const, workshopName: target.workshop.name, expectedVersion: target.commandVersion };
  const draft: OwnerClickedWorkshopRunAuthorization = { ...base, commandId: stableCommand(base), revalidate: async () => {} };
  const previous = await dependencies.loadCommand(draft.ownerId, draft.commandId);
  if (previous) { verifyCommand(draft, previous); draft.expectedVersion = previous.expectedVersion; }
  else requireActive(target.workshop);
  const binding: OwnerClickedWorkshopRunAuthorization = { ...draft, async revalidate() {
    await ownedChat(request.ownerId, request.chatId, dependencies);
    const fresh = await ownedTarget(binding.ownerId, binding.workshopId, dependencies);
    const prior = await dependencies.loadCommand(binding.ownerId, binding.commandId);
    if (prior) { verifyCommand(binding, prior); return; }
    requireActive(fresh.workshop);
    if (fresh.commandVersion !== binding.expectedVersion) fail("workshop_run_version_changed", "智能体状态已变化，请核对后重新运行。");
  } };
  return Object.freeze(binding);
}

function links(workshopId: string, runId: string) {
  const statusUrl = `/api/workshops/${encodeURIComponent(workshopId)}/runs/${encodeURIComponent(runId)}`;
  return { workshopUrl: `/workshop?workId=${encodeURIComponent(workshopId)}&tab=run&runId=${encodeURIComponent(runId)}`, statusUrl, runStatusUrl: statusUrl };
}
function boundPresentation(presentation: WorkPresentationV1 | null, truncated: string[]) {
  if (!presentation) return null;
  if (presentation.reportMarkdown && presentation.reportMarkdown.length > REPORT_LIMIT) truncated.push("presentation.reportMarkdown");
  if (presentation.artifacts.length > 20) truncated.push("presentation.artifacts");
  return { ...presentation, reportMarkdown: presentation.reportMarkdown?.slice(0, REPORT_LIMIT) ?? null,
    artifacts: presentation.artifacts.slice(0, 20), warnings: presentation.warnings.slice(0, 20).map(value => value.slice(0, 1000)),
    nextSteps: presentation.nextSteps.slice(0, 10).map(value => value.slice(0, 1000)) };
}
export async function readOwnerWorkshopRun(
  input: { ownerId: string; workshopId: string; runId: string },
  dependencies: WorkshopRunDependencies = defaultDependencies,
) {
  if (![input.ownerId, input.workshopId, input.runId].every(value => UUID.test(value))) fail("workshop_run_not_found", "没有找到这轮运行。", 404);
  const target = await ownedTarget(input.ownerId, input.workshopId, dependencies);
  const actual = await dependencies.loadRun(input.ownerId, input.workshopId, input.runId);
  if (!actual || actual.id !== input.runId || actual.workshopId !== input.workshopId) fail("workshop_run_not_found", "没有找到当前用户的这轮运行。", 404);
  const chatDelivery = await dependencies.loadDelivery?.(input.ownerId, input.workshopId, input.runId) ?? null;
  const fetched = await dependencies.loadEvents(input.workshopId, input.runId, EVENT_LIMIT + 1);
  const hasMoreEvents = fetched.length > EVENT_LIMIT;
  const events = fetched.slice(-EVENT_LIMIT).filter(event => event.visibility !== "debug" && (event.runId === input.runId || event.loopRunId === input.runId));
  const truncatedFields: string[] = [];
  if (actual.outputSummary && actual.outputSummary.length > OUTPUT_LIMIT) truncatedFields.push("run.outputSummary");
  const presentation = boundPresentation(buildWorkPresentation({ workshopId: input.workshopId, run: actual, events }), truncatedFields);
  const warnings = [ ...(hasMoreEvents ? ["本轮仅展示最近 200 条记录，较早的证据请到工作记录核对。"] : []),
    ...(truncatedFields.length ? ["本轮内容较长，当前展示有截取；完整结果请到工作记录核对。"] : []),
    ...(chatDelivery?.status === "blocked" ? ["原对话结果投递被阻止，原因：" + String(chatDelivery.errorCode) + "；业务不会因此重跑。"] : []),
    ...(chatDelivery?.status === "failed" ? ["原对话结果投递失败，正在重试通知；业务不会因此重跑。"] : []) ];
  return { ok: true as const, status: "run_observed" as const, workshopId: input.workshopId,
    workshop: { id: target.workshop.id, name: target.workshop.name, status: target.workshop.status },
    run: { id: actual.id, workshopId: actual.workshopId, status: actual.status,
      outputSummary: actual.outputSummary?.slice(0, OUTPUT_LIMIT) ?? null, error: actual.error?.slice(0, 4000) ?? null,
      createdAt: actual.createdAt, updatedAt: actual.updatedAt, startedAt: actual.startedAt, completedAt: actual.completedAt },
    presentation, chatDelivery, hasMoreEvents, truncatedFields, warnings, observedAt: new Date().toISOString(), ...links(input.workshopId, input.runId) };
}

function assertAuthorization(binding: WorkshopRunAuthorization) {
  if (![binding.ownerId, binding.chatId, binding.workshopId, binding.requestId].every(value => typeof value === "string" && UUID.test(value))
    || !["chat_command", "owner_button"].includes(binding.origin) || binding.commandId !== stableCommand(binding)
    || !Number.isSafeInteger(binding.expectedVersion) || binding.expectedVersion < 0 || binding.expectedVersion >= 2147483647
    || typeof binding.revalidate !== "function"
    || (binding.origin === "chat_command" && (binding.userMessageId !== binding.requestId || !binding.turnId?.trim()
      || createHash("sha256").update(binding.prompt, "utf8").digest("hex") !== binding.promptSha256))) {
    fail("workshop_run_invalid_binding", "运行授权已失效，请重新提交指令。");
  }
}
function acceptedRunId(binding: WorkshopRunAuthorization, record: WorkCommandRecord) {
  verifyCommand(binding, record);
  if (record.status !== "succeeded") {
    fail(record.status === "failed" ? "workshop_run_command_failed" : "workshop_run_command_pending",
      record.status === "failed" ? `上次运行请求被拒绝：${record.errorCode ?? "原因待核对"}。` : "上次请求已保存，命令结果仍待核对；请查看工作记录，勿重复新建运行。");
  }
  let result: { run?: { id?: string; workshopId?: string } };
  try { result = decodeCommandResult(record.result); } catch { fail("workshop_run_command_conflict", "已保存的运行回执无法核对。"); }
  if (!result.run?.id || !UUID.test(result.run.id) || result.run.workshopId !== binding.workshopId) fail("workshop_run_command_conflict", "已保存的运行回执与目标智能体不一致。");
  return result.run.id;
}
async function observedReceipt(binding: WorkshopRunAuthorization, runId: string, replayed: boolean, dependencies: WorkshopRunDependencies) {
  try {
    const current = await readOwnerWorkshopRun({ ownerId: binding.ownerId, workshopId: binding.workshopId, runId }, dependencies);
    return { ...current, status: "run_accepted" as const, commandId: binding.commandId, replayed };
  } catch (error) {
    return { ok: false as const, status: "run_readback_pending" as const, commandId: binding.commandId,
      workshopId: binding.workshopId, runId, replayed, retrySafe: true,
      message: "运行请求已保存，暂未完成状态回读。请核对同一轮运行，不要再次新建。",
      detail: error instanceof Error ? error.message : "运行状态回读失败。", ...links(binding.workshopId, runId) };
  }
}

/** Admission only. The managed worker owns execution, lease, cancellation and completion. */
export async function executeNativeWorkshopRun(
  input: WorkshopRunAuthorization,
  dependencies: WorkshopRunDependencies = defaultDependencies,
  signal?: AbortSignal,
) {
  const binding = Object.freeze({ ...input });
  assertAuthorization(binding); signal?.throwIfAborted();
  await binding.revalidate(); signal?.throwIfAborted();
  const previous = await dependencies.loadCommand(binding.ownerId, binding.commandId);
  if (previous) return observedReceipt(binding, acceptedRunId(binding, previous), true, dependencies);
  const busy = await dependencies.readOccupancy(binding.ownerId, binding.workshopId);
  if (busy) {
    const winner = await dependencies.loadCommand(binding.ownerId, binding.commandId);
    if (winner) return observedReceipt(binding, acceptedRunId(binding, winner), true, dependencies);
    fail("workshop_run_busy", `智能体已有一轮${busy.status === "needs_review" ? "待核对" : "未结束"}的运行，请先查看工作记录。`);
  }
  signal?.throwIfAborted();
  let result: Awaited<ReturnType<typeof startWorkRun>>;
  try { result = await dependencies.startRun(commandInput(binding)); }
  catch (error) {
    // Another retry may have won between the last read and command acceptance.
    const winner = await dependencies.loadCommand(binding.ownerId, binding.commandId);
    if (winner) return observedReceipt(binding, acceptedRunId(binding, winner), true, dependencies);
    throw error;
  }
  if (!result.run?.id || !UUID.test(result.run.id) || result.run.workshopId !== binding.workshopId || result.workshop.id !== binding.workshopId) {
    fail("workshop_run_command_conflict", "运行命令返回的目标无法核对。");
  }
  return observedReceipt(binding, result.run.id, false, dependencies);
}
export const startAuthorizedWorkshopRun = executeNativeWorkshopRun;

/** Fixed output paging: complete means the end of this exact hashed field,
 * never the end of a clipped summary or a different execution attempt. */
export async function readOwnerWorkshopRunResultPage(input: {
  ownerId: string; workshopId: string; runId: string; offset?: number; expectedHash?: string;
}, dependencies: WorkshopRunDependencies = defaultDependencies) {
  const offset = input.offset ?? 0;
  if (![input.ownerId, input.workshopId, input.runId].every(id => UUID.test(id)) || !Number.isSafeInteger(offset) || offset < 0) fail("workshop_result_invalid_page", "结果读取范围无效。", 400);
  await ownedTarget(input.ownerId, input.workshopId, dependencies);
  const run = await dependencies.loadRun(input.ownerId, input.workshopId, input.runId);
  if (!run || run.workshopId !== input.workshopId || run.id !== input.runId) fail("workshop_run_not_found", "没有找到该运行。", 404);
  if (!["completed", "failed", "cancelled", "needs_review"].includes(run.status)) return { ok: false, status: "result_pending", runId: run.id, complete: false };
  const text = run.outputSummary ?? "";
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  if ((offset > 0 && !input.expectedHash) || (input.expectedHash && input.expectedHash !== hash)) fail("workshop_result_changed", "原结果内容已变化，请从头读取并核对版本。");
  if (offset > text.length) fail("workshop_result_invalid_page", "结果读取范围超出正文。", 400);
  const end = Math.min(offset + 12_000, text.length), complete = end === text.length;
  return { ok: true, workshopId: input.workshopId, runId: input.runId, content: text.slice(offset, end), hash,
    offset, end, totalCharacters: text.length, complete, empty: !text.length, runStatus: run.status,
    nextRead: complete ? null : { tool: "observeWorkshop", workshopId: input.workshopId, runId: input.runId, view: "result", offset: end, expectedHash: hash } };
}
