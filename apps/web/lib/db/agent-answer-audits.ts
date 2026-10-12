import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { isTauriMode } from "@/lib/env/constants";
import { db, withDatabaseTransaction } from "./client";
import { agentAnswerAudits, chat, message, workshops } from "./schema";
import type { AgentAnswerAuditRow } from "./schema.pg";
import { inspectAnswerBodyMirror } from "@/lib/ai/runtime/answer-body-mirror";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const TERMINAL_TYPES = new Set(["turn_completed", "turn_failed", "turn_aborted"]);
const MAX_EVENT_BYTES = 1024 * 1024;

export class AgentAnswerAuditError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = "AgentAnswerAuditError";
  }
}

function requireUuid(value: string, name: string) {
  if (typeof value !== "string" || !UUID.test(value)) throw new AgentAnswerAuditError("invalid_audit_request", 400, `Invalid ${name}`);
}
function requireText(value: string, name: string, limit = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new AgentAnswerAuditError("invalid_audit_request", 400, `Invalid ${name}`);
}

/** Sort object keys and use JSON's treatment of optional undefined properties. */
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== "object" || !value) throw new AgentAnswerAuditError("invalid_audit_payload", 400, "Audit payload must be JSON");
  if (ancestors.has(value)) throw new AgentAnswerAuditError("invalid_audit_payload", 400, "Cyclic audit payload");
  ancestors.add(value);
  let encoded: string;
  if (Array.isArray(value)) encoded = `[${value.map((item) => canonical(item === undefined ? null : item, ancestors)).join(",")}]`;
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new AgentAnswerAuditError("invalid_audit_payload", 400, "Audit payload must be a plain object");
    encoded = `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], ancestors)}`).join(",")}}`;
  }
  ancestors.delete(value);
  return encoded;
}

export function hashAgentAnswerPayload(payload: unknown): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

function normalizePayload(payload: Record<string, unknown>) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new AgentAnswerAuditError("invalid_audit_payload", 400, "Expected an audit object");
  const encoded = canonical(payload);
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_BYTES) throw new AgentAnswerAuditError("audit_payload_too_large", 413, "Audit event exceeds its storage limit");
  return { payload: JSON.parse(encoded) as Record<string, unknown>, payloadHash: createHash("sha256").update(encoded).digest("hex") };
}

function requirePostgres() {
  if (isTauriMode() || !agentAnswerAudits) throw new AgentAnswerAuditError("audit_not_available", 503, "Answer audits require PostgreSQL");
}

/** Caller must already be in the short database-only transaction. */
export async function lockAnswerPersistenceKey(key: string) {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export interface ReserveAgentAnswerTurnInput {
  ownerId: string;
  chatId: string;
  clientRequestId: string;
  userMessageId: string;
  assistantMessageId: string;
  requestPayloadHash: string;
  schemaVersion: string;
  ruleVersion: string;
  runtimeHash: string;
  workId?: string | null;
  payload?: Record<string, unknown>;
}

export type AgentAnswerTurnStatus = "running" | "completed" | "failed" | "aborted";
export interface AgentAnswerAuditSummary {
  turnId: string;
  chatId: string;
  assistantMessageId: string;
  status: AgentAnswerTurnStatus;
  mode?: "off" | "shadow" | "enforce_critical" | "enforce_supported";
  evidence?: Record<string, unknown>;
  finalText?: string;
  runtimeTerminal?: Record<string, unknown>;
  progress?: {
    schemaVersion: "platform-answer-progress.v1";
    phase: "reading" | "read_closed";
    totalRequirements: number;
    resolvedRequirements: number;
    lastEventAt: string;
    requirements: Array<{ requirementId: string; label: string; state: string; reason?: string }>;
  };
}

const RESOLUTION_STATES = ["supported", "not_recorded", "unknown", "denied"] as const;
const PLATFORM_KINDS = ["run_outcome", "message_identity", "chat_identity", "stored_status_distribution"];
// Only published source identifiers and finite scopes cross the audit boundary.
const PUBLIC_SOURCES = new Set(["workshopRuns", "loopRuns", "loops", "message", "chat", "brainMemories", "interactionTasks", "interactionMemories", "memoryGraphRelations",
  "brain_memories.status", "interaction_processing_jobs.status", "interaction_events.processed_status", "paper_orders.status", "workshop_outbox.status", "workshop_heartbeats.scheduler_status", "loops.status", "workshops.status"]);
const PUBLIC_SCOPES = new Set(["owner_exact_record", "owner_stored_status", "known_message_text", "exact_context"]);
function publicText(value: unknown, limit: number) {
  return typeof value === "string" && value.length <= limit ? value : undefined;
}
function publicTime(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function publicResolution(value: unknown) {
  const r = object(value), requirementId = publicText(r?.requirementId, 160);
  if (!r || !requirementId || !RESOLUTION_STATES.includes(r.state as typeof RESOLUTION_STATES[number])) return undefined;
  return {
    requirementId, state: r.state as typeof RESOLUTION_STATES[number],
    evidenceIds: Array.isArray(r.evidenceIds) ? r.evidenceIds.filter((id): id is string => typeof id === "string" && id.length <= 240).slice(0, 64) : [],
    reason: publicText(r.reason, 2000) ?? "", presentationIncluded: r.presentationIncluded === true,
  };
}
function publicCoverage(value: unknown, resolutions: Array<NonNullable<ReturnType<typeof publicResolution>>>) {
  const source = object(value);
  const expected = { supported: 0, notRecorded: 0, unknown: 0, denied: 0, total: resolutions.length };
  for (const resolution of resolutions) {
    const key = resolution.state === "not_recorded" ? "notRecorded" : resolution.state;
    expected[key]++;
  }
  if (!source || Object.entries(expected).some(([key, count]) => source[key] !== count)) return undefined;
  return expected;
}

function publicFinalEvidence(payload: Record<string, unknown>, turnId: string) {
  const outcomes = ["supported_fields", "partial", "unknown", "execution_failed", "unchecked"];
  const platform = payload.schemaVersion === "platform-answer-decision.v1";
  if ((!platform && payload.schemaVersion !== "answer-decision.v1") || !outcomes.includes(String(payload.outcome))) return undefined;
  const displayText = typeof payload.displayText === "string" ? payload.displayText : typeof payload.renderedText === "string" ? payload.renderedText : typeof payload.answer === "string" ? payload.answer : undefined;
  if (displayText === undefined || displayText.length > 64000) return undefined;
  const rawResolutions = Array.isArray(payload.resolutions) ? payload.resolutions : [];
  const resolutions = rawResolutions.slice(0, 64).map(publicResolution).filter((r): r is NonNullable<typeof r> => !!r);
  const evidenceCoverage = platform ? publicCoverage(payload.evidenceCoverage, resolutions) : undefined;
  if (platform && (!PLATFORM_KINDS.includes(String(payload.contractKind)) || !["off", "shadow", "enforce_supported"].includes(String(payload.mode))
    || typeof payload.questionComplete !== "boolean" || !evidenceCoverage || rawResolutions.length !== resolutions.length
    || new Set(resolutions.map(r => r.requirementId)).size !== resolutions.length)) return undefined;
  const evidenceRefs = Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs.map((value) => {
    const r = object(value), evidenceId = publicText(r?.evidenceId, 240);
    if (!r || !evidenceId) return null;
    return { evidenceId, observedAt: publicTime(r.observedAt), status: publicText(r.status, 80) ?? "unknown",
      ...(platform && PUBLIC_SOURCES.has(String(r.source)) ? { source: r.source } : {}),
      ...(platform && PUBLIC_SCOPES.has(String(r.scope)) ? { scope: r.scope } : {}) };
  }).filter(Boolean).slice(0, 64) : [];
  return { schemaVersion: platform ? "platform-answer-summary.v1" : "answer-evidence-summary.v1", turnId, ruleVersion: publicText(payload.ruleVersion, 160) ?? "unknown", outcome: payload.outcome, displayText, resolutions, evidenceRefs, auditPersisted: true,
    ...(platform ? { kind: "platform", mode: payload.mode, contractKind: payload.contractKind, questionComplete: payload.questionComplete, evidenceCoverage } : {}),
    ...(typeof payload.auditIncomplete === "boolean" ? { auditIncomplete: payload.auditIncomplete } : {}) };
}

function publicProgress(events: AgentAnswerAuditRow[]): AgentAnswerAuditSummary["progress"] {
  const requirements = new Map<string, { requirementId: string; label: string; state: string; reason?: string }>();
  let phase: "reading" | "read_closed" = "reading", lastEventAt: string | undefined;
  for (const event of events) {
    if (event.payload.schemaVersion !== "platform-answer-progress.v1") continue;
    if (event.eventType === "requirements_planned" && Array.isArray(event.payload.requirements) && event.payload.requirements.length <= 64) {
      const planned = event.payload.requirements.map(object);
      if (planned.some(r => !publicText(r?.id, 160) || !publicText(r?.label, 160))) continue;
      requirements.clear();
      for (const r of planned) requirements.set(r!.id as string, { requirementId: r!.id as string, label: r!.label as string, state: "pending" });
      phase = "reading";
    } else if (event.eventType === "requirement_resolved") {
      const resolution = publicResolution(event.payload.resolution);
      const planned = resolution && requirements.get(resolution.requirementId);
      if (!resolution || !planned) continue;
      requirements.set(resolution.requirementId, { requirementId: planned.requirementId, label: planned.label, state: resolution.state, reason: resolution.reason });
    } else if (event.eventType === "read_phase_closed" && requirements.size > 0) phase = "read_closed";
    else continue;
    if (event.createdAt instanceof Date && Number.isFinite(event.createdAt.getTime())) lastEventAt = event.createdAt.toISOString();
  }
  if (!lastEventAt || !requirements.size) return undefined;
  return { schemaVersion: "platform-answer-progress.v1", phase, totalRequirements: requirements.size,
    resolvedRequirements: [...requirements.values()].filter(r => r.state !== "pending").length,
    lastEventAt, requirements: [...requirements.values()] };
}

function publicRuntimeTerminal(payload: Record<string, unknown>) {
  const source = (payload.terminal ?? payload.runtimeTerminal) as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object" || !["completed", "failed", "aborted", "unknown"].includes(String(source.status))) return undefined;
  const projected: Record<string, unknown> = { status: source.status };
  if (typeof source.schemaVersion === "string") projected.schemaVersion = source.schemaVersion;
  if (["completed", "failed", "unknown", "not_run"].includes(String(source.cleanupStatus))) projected.cleanupStatus = source.cleanupStatus;
  if (["runtime", "answer_delivery"].includes(String(source.completionScope))) projected.completionScope = source.completionScope;
  if (["completed", "failed", "aborted", "unknown"].includes(String(source.runtimeStatus))) projected.runtimeStatus = source.runtimeStatus;
  if (typeof source.error === "string") projected.error = source.error.slice(0, 2000);
  return projected;
}

/** Pure, conservative public projection; it never promotes an unknown event version. */
export function buildAgentAnswerAuditSummary(events: AgentAnswerAuditRow[]): AgentAnswerAuditSummary | null {
  const initial = events.find((event) => event.eventType === "turn_started");
  if (!initial) return null;
  const terminal = events.find((event) => TERMINAL_TYPES.has(event.eventType));
  const status: AgentAnswerTurnStatus = !terminal ? "running" : terminal.eventType === "turn_completed" ? "completed" : terminal.eventType === "turn_aborted" ? "aborted" : "failed";
  const final = [...events].reverse().find((event) => event.eventType === "final_evidence");
  const evidence = terminal && final ? publicFinalEvidence(final.payload, initial.turnId) : undefined;
  const mode = initial.payload.platformAnswerMode ?? initial.payload.answerEvidenceMode;
  const runtimeTerminal = terminal ? publicRuntimeTerminal(terminal.payload) : undefined;
  const progress = publicProgress(events);
  return {
    turnId: initial.turnId, chatId: initial.chatId, assistantMessageId: initial.assistantMessageId, status,
    ...(mode === "off" || mode === "shadow" || mode === "enforce_critical" || mode === "enforce_supported" ? { mode } : {}),
    ...(evidence ? { evidence, finalText: evidence.displayText } : {}),
    ...(runtimeTerminal ? { runtimeTerminal } : {}),
    ...(progress ? { progress } : {}),
  };
}

async function ownedInitial(ownerId: string, turnId: string): Promise<AgentAnswerAuditRow | undefined> {
  const [initial] = await db.select().from(agentAnswerAudits).where(and(eq(agentAnswerAudits.ownerId, ownerId), eq(agentAnswerAudits.turnId, turnId), eq(agentAnswerAudits.eventType, "turn_started"))).limit(1);
  if (!initial) return undefined;
  const [ownedChat] = await db.select({ id: chat.id }).from(chat).where(and(eq(chat.id, initial.chatId), eq(chat.userId, ownerId))).limit(1);
  return ownedChat ? initial as AgentAnswerAuditRow : undefined;
}

export async function listAgentAnswerAuditEvents({ ownerId, turnId }: { ownerId: string; turnId: string }): Promise<AgentAnswerAuditRow[]> {
  requirePostgres(); requireUuid(ownerId, "ownerId"); requireUuid(turnId, "turnId");
  if (!await ownedInitial(ownerId, turnId)) return [];
  return db.select().from(agentAnswerAudits).where(and(eq(agentAnswerAudits.ownerId, ownerId), eq(agentAnswerAudits.turnId, turnId))).orderBy(asc(agentAnswerAudits.seq));
}

export async function getAgentAnswerAuditSummary(input: { ownerId: string; turnId: string }) {
  return buildAgentAnswerAuditSummary(await listAgentAnswerAuditEvents(input));
}

/** Only used after the owner-scoped audit lookup; rechecks current chat ownership. */
export async function getAgentAnswerBodyMirror(input: { ownerId: string; summary: AgentAnswerAuditSummary }) {
  const { summary } = input;
  const observation = { ...summary, observedAt: new Date().toISOString() };
  if (summary.status === "running" || typeof summary.finalText !== "string") return inspectAnswerBodyMirror(observation);
  try {
    requirePostgres(); requireUuid(input.ownerId, "ownerId");
    requireUuid(summary.chatId, "chatId"); requireUuid(summary.assistantMessageId, "assistantMessageId");
    const [stored] = await db.select({ id: message.id, chatId: message.chatId, role: message.role, parts: message.parts })
      .from(message).innerJoin(chat, eq(chat.id, message.chatId))
      .where(and(eq(chat.userId, input.ownerId), eq(chat.id, summary.chatId), eq(message.chatId, summary.chatId),
        eq(message.id, summary.assistantMessageId), eq(message.role, "assistant"))).limit(1);
    return inspectAnswerBodyMirror({ ...observation, stored });
  } catch {
    return inspectAnswerBodyMirror({ ...observation, unavailable: true });
  }
}

export async function reserveAgentAnswerTurn(input: ReserveAgentAnswerTurnInput) {
  requirePostgres();
  for (const name of ["ownerId", "chatId", "userMessageId", "assistantMessageId"] as const) requireUuid(input[name], name);
  requireText(input.clientRequestId, "clientRequestId");
  for (const name of ["schemaVersion", "ruleVersion", "runtimeHash"] as const) requireText(input[name], name);
  if (!HASH.test(input.requestPayloadHash)) throw new AgentAnswerAuditError("invalid_audit_request", 400, "Invalid requestPayloadHash");
  if (input.userMessageId === input.assistantMessageId) throw new AgentAnswerAuditError("message_role_conflict", 409, "User and assistant IDs must differ");
  if (input.workId) requireUuid(input.workId, "workId");
  return withDatabaseTransaction(async () => {
    await lockAnswerPersistenceKey(`answer-request:${input.ownerId}:${input.clientRequestId}`);
    await lockAnswerPersistenceKey(`chat-save:${input.chatId}`);
    for (const id of [input.userMessageId, input.assistantMessageId].sort()) await lockAnswerPersistenceKey(`message-save:${id}`);
    const [ownedChat] = await db.select().from(chat).where(eq(chat.id, input.chatId)).limit(1);
    if (!ownedChat || ownedChat.userId !== input.ownerId) throw new AgentAnswerAuditError("chat_not_owned", 403, "Chat is not owned by this user");
    const [userMessage] = await db.select().from(message).where(eq(message.id, input.userMessageId)).limit(1);
    if (!userMessage || userMessage.chatId !== input.chatId || userMessage.role !== "user") throw new AgentAnswerAuditError("user_message_not_owned", 403, "Saved user message is required in this chat");
    if (input.workId) {
      const [work] = await db.select({ id: workshops.id }).from(workshops).where(and(eq(workshops.id, input.workId), eq(workshops.userId, input.ownerId))).limit(1);
      if (!work) throw new AgentAnswerAuditError("work_not_owned", 403, "Work is not owned by this user");
    }
    const [existing] = await db.select().from(agentAnswerAudits).where(and(eq(agentAnswerAudits.ownerId, input.ownerId), eq(agentAnswerAudits.requestKey, input.clientRequestId), eq(agentAnswerAudits.eventType, "turn_started"))).limit(1);
    if (existing) {
      if (existing.requestPayloadHash !== input.requestPayloadHash || existing.chatId !== input.chatId || existing.assistantMessageId !== input.assistantMessageId || existing.payload.userMessageId !== input.userMessageId || (existing.workId ?? null) !== (input.workId ?? null)) throw new AgentAnswerAuditError("answer_request_conflict", 409, "Request ID is already bound to a different payload");
      const summary = (await getAgentAnswerAuditSummary({ ownerId: input.ownerId, turnId: existing.turnId }))!;
      return { created: false, ...summary, summary };
    }
    const [assistant] = await db.select().from(message).where(eq(message.id, input.assistantMessageId)).limit(1);
    if (assistant && (assistant.chatId !== input.chatId || assistant.role !== "assistant")) throw new AgentAnswerAuditError("assistant_message_conflict", 409, "Assistant ID belongs to a different message");
    const [bound] = await db.select({ id: agentAnswerAudits.id }).from(agentAnswerAudits).where(and(eq(agentAnswerAudits.assistantMessageId, input.assistantMessageId), eq(agentAnswerAudits.eventType, "turn_started"))).limit(1);
    if (bound || (assistant && ((Array.isArray(assistant.parts) && assistant.parts.length > 0) || (Array.isArray(assistant.attachments) && assistant.attachments.length > 0)))) throw new AgentAnswerAuditError("assistant_message_conflict", 409, "Assistant ID is already in use");
    const turnId = randomUUID();
    const placeholderParts = [{ type: "data-answerEvidence", data: { turnId } }];
    if (!assistant) await db.insert(message).values({ id: input.assistantMessageId, chatId: input.chatId, role: "assistant", parts: placeholderParts, attachments: [], createdAt: new Date() });
    else await db.update(message).set({ parts: placeholderParts }).where(and(eq(message.id, input.assistantMessageId), eq(message.chatId, input.chatId), eq(message.role, "assistant")));
    const normalized = normalizePayload({ ...(input.payload ?? {}), userMessageId: input.userMessageId });
    await db.insert(agentAnswerAudits).values({ ownerId: input.ownerId, turnId, chatId: input.chatId, assistantMessageId: input.assistantMessageId, workId: input.workId ?? null, eventKey: "turn_started", eventType: "turn_started", requestKey: input.clientRequestId, requestPayloadHash: input.requestPayloadHash, schemaVersion: input.schemaVersion, ruleVersion: input.ruleVersion, runtimeHash: input.runtimeHash, ...normalized });
    return { created: true, turnId, chatId: input.chatId, assistantMessageId: input.assistantMessageId, status: "running" as const };
  });
}

export async function appendAgentAnswerAuditEvent(input: { ownerId: string; turnId: string; eventKey: string; eventType: string; payload: Record<string, unknown> }) {
  requirePostgres(); requireUuid(input.ownerId, "ownerId"); requireUuid(input.turnId, "turnId");
  requireText(input.eventKey, "eventKey", 300); requireText(input.eventType, "eventType", 100);
  if (input.eventType === "turn_started") throw new AgentAnswerAuditError("reserved_audit_event", 400, "Use reserveAgentAnswerTurn for turn_started");
  const normalized = normalizePayload(input.payload);
  return withDatabaseTransaction(async () => {
    await lockAnswerPersistenceKey(`answer-turn:${input.ownerId}:${input.turnId}`);
    const initial = await ownedInitial(input.ownerId, input.turnId);
    if (!initial) throw new AgentAnswerAuditError("answer_turn_not_found", 404, "Answer turn not found");
    const events: AgentAnswerAuditRow[] = await db.select().from(agentAnswerAudits).where(and(eq(agentAnswerAudits.ownerId, input.ownerId), eq(agentAnswerAudits.turnId, input.turnId))).orderBy(asc(agentAnswerAudits.seq));
    const existing = events.find((event) => event.eventKey === input.eventKey);
    if (existing) {
      if (existing.eventType !== input.eventType || existing.payloadHash !== normalized.payloadHash) throw new AgentAnswerAuditError("audit_event_conflict", 409, "Audit event key is already bound to different content");
      return { created: false, event: existing };
    }
    if (events.some((event) => TERMINAL_TYPES.has(event.eventType))) throw new AgentAnswerAuditError("answer_turn_sealed", 409, "Answer turn already has a terminal event");
    const [event] = await db.insert(agentAnswerAudits).values({ ownerId: initial.ownerId, turnId: initial.turnId, chatId: initial.chatId, assistantMessageId: initial.assistantMessageId, workId: initial.workId, schemaVersion: initial.schemaVersion, ruleVersion: initial.ruleVersion, runtimeHash: initial.runtimeHash, eventKey: input.eventKey, eventType: input.eventType, ...normalized }).returning();
    return { created: true, event: event as AgentAnswerAuditRow };
  });
}
