import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import { memoryRevisionCommandReceipts } from "@/lib/db/schema.pg";
import { stableJson } from "../records/observations";
import { acquireMemoryWriteAdvisoryLock } from "../kernel/locks";
import { memoryInvalid, MemoryModuleError } from "../kernel/errors";
import { createMemoryCandidate, reviewMemory } from "./writes";
import { reviseBrainMemory, parseBrainMemoryRevisionRequest } from "./revision";
import { proposeBrainMemoryUpdate, decideBrainMemoryUpdate, parseBrainMemoryUpdateRequest } from "./proposals";
import { bindMemoryDependencies } from "./dependencies";
import { getBrainMemoryRevisionVersion } from "./version";
import type { BrainMemory, BrainMemoryType } from "../kernel/memory-types";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const REVISION_COMMAND_KINDS = ["candidate.submit", "memory.review", "memory.propose", "memory.decide", "memory.revise", "dependencies.bind"] as const;
export type RevisionCommandKind = typeof REVISION_COMMAND_KINDS[number];
type Body = Record<string, unknown>;
function obj(value: unknown): Body {
  if (!value || typeof value !== "object" || Array.isArray(value)) memoryInvalid("A command object is required");
  return value as Body;
}
function text(value: unknown, max: number, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > max) memoryInvalid(`Invalid ${name}`);
  return value.trim();
}
function id(value: unknown) { const key = text(value, 36, "record ID"); if (!uuid.test(key)) memoryInvalid("Invalid record ID"); return key.toLowerCase(); }
function fields(body: Body, allowed: string[]) {
  if (Object.keys(body).some(key => !["kind", "commandId", ...allowed].includes(key))) memoryInvalid("Unexpected memory command field");
}
function refs(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) memoryInvalid("At most 100 evidence references are required");
  return [...new Set(value.map(ref => text(ref, 2048, "evidence reference")))];
}
function expected(value: unknown) { if (typeof value !== "string" || !/^bmrv1:[a-f0-9]{64}$/.test(value)) memoryInvalid("A current memory version is required"); return value; }
export type RevisionOutcome = { kind: RevisionCommandKind; state: string; records: Array<{ id: string; revision: string; role: string }>;
  domainReceiptId?: string; dependencyReceipt?: unknown };
export type RevisionCommandResult = { status: "recorded"; replayed: boolean; outcome: RevisionOutcome;
  receipt: { id: string; commandId: string; createdAt: string }; resultSemantics: "historical_command_outcome";
  meta: { traceId: string; contractVersion: "memory-revision.v1"; implementationVersion: "memory-t3.v1"; provider: "postgres"; detail: string; warnings: string[] } };
const reference = (memory: BrainMemory, role: string) => ({ id: memory.id, revision: getBrainMemoryRevisionVersion(memory), role });
function mapError(error: unknown): never {
  if (error instanceof MemoryModuleError) throw error;
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  if (typeof value?.code === "string" && typeof value.status === "number" && value.status >= 400 && value.status < 500)
    throw new MemoryModuleError(value.code, value.status, typeof value.message === "string" ? value.message : "Memory command rejected");
  throw error;
}
/** Host-only owner entry; caller has already rejected all Work capabilities.
 * The outer ALS transaction owns nested domain savepoints and the final receipt. */
export async function submitOwnerRevisionCommand(userId: string, value: unknown): Promise<RevisionCommandResult> {
  const body = obj(value), kind = body.kind as RevisionCommandKind;
  if (!REVISION_COMMAND_KINDS.includes(kind)) throw new MemoryModuleError("unsupported_memory_command", 422, "Unsupported revision command");
  const commandId = text(body.commandId, 200, "commandId");
  const requester = { type: "chat" as const, userId, id: "memory-owner-api" };
  // Validate owner-controlled fields before replay; domain parsers validate the command-specific payload.
  let execute: () => Promise<RevisionOutcome>;
  if (kind === "candidate.submit") {
    fields(body, ["subject", "content", "memoryType", "evidenceRefs", "tags"]);
    const subject = text(body.subject, 1000, "subject"), content = text(body.content, 12000, "content"), evidenceRefs = refs(body.evidenceRefs ?? []);
    const memoryType = body.memoryType as BrainMemoryType;
    if (!["fact", "preference", "plan", "boundary", "relationship", "task", "insight", "system"].includes(memoryType)) memoryInvalid("Invalid memory type");
    const tags = body.tags === undefined ? [] : refs(body.tags);
    execute = async () => { const memory = await createMemoryCandidate({ requester, scope: { type: "global" }, ownerType: "chat", ownerId: userId, memoryType, subject, content, evidenceRefs, tags });
      const state = memory.status === "candidate" ? memory.metadata?.updateProposal ? "proposed" : "candidate" : "existing_retained";
      return { kind, state, records: [reference(memory, memory.status === "candidate" ? "candidate" : "current")] }; };
  } else if (kind === "memory.review") {
    fields(body, ["memoryId", "expectedVersion", "decision", "reason", "evidenceConfirmed"]);
    const memoryId = id(body.memoryId), expectedVersion = expected(body.expectedVersion), reason = text(body.reason, 2000, "reason");
    if (typeof body.decision !== "string" || !["confirmed", "dismissed", "rejected", "active", "weakened"].includes(body.decision)) memoryInvalid("Invalid review decision");
    if (["confirmed", "active", "weakened"].includes(String(body.decision)) && body.evidenceConfirmed !== true) memoryInvalid("Explicit source verification is required");
    const decision = body.decision as "confirmed" | "dismissed" | "rejected" | "active" | "weakened";
    execute = async () => { const memory = await reviewMemory({ requester, memoryId, expectedVersion, decision, reason, evidenceConfirmed: body.evidenceConfirmed === true });
      return { kind, state: memory.status, records: [reference(memory, "memory")] }; };
  } else if (kind === "memory.propose") {
    fields(body, ["targetMemoryId", "expectedVersion", "content", "reason", "evidenceRefs"]);
    const { kind: _kind, ...request } = body;
    const parsed = parseBrainMemoryUpdateRequest(request);
    execute = async () => { const result = await proposeBrainMemoryUpdate({ requester, request: parsed });
      return { kind, state: "proposed", records: [reference(result.base, "base"), reference(result.candidate, "candidate")], domainReceiptId: result.receipt.id }; };
  } else if (kind === "memory.decide") {
    fields(body, ["proposalId", "action", "expectedVersion", "expectedBaseVersion", "reason", "evidenceConfirmed"]);
    const proposalId = id(body.proposalId), expectedVersion = expected(body.expectedVersion), expectedBaseVersion = expected(body.expectedBaseVersion);
    const reason = text(body.reason, 2000, "reason");
    if (body.action !== "accept" && body.action !== "reject") memoryInvalid("Invalid proposal decision");
    if (body.action === "accept" && body.evidenceConfirmed !== true) memoryInvalid("Explicit source verification is required");
    const request = { commandId, action: body.action, expectedVersion, expectedBaseVersion, reason, evidenceConfirmed: body.evidenceConfirmed === true };
    execute = async () => { const result = await decideBrainMemoryUpdate({ requester, proposalId, request });
      return { kind, state: String(result.receipt.status), records: [reference(result.base, "base"), reference(result.candidate, "candidate")], domainReceiptId: result.receipt.id }; };
  } else if (kind === "memory.revise") {
    fields(body, ["memoryId", "expectedVersion", "operation", "authority", "content", "reason", "evidenceRefs", "sourceObservedAt"]);
    const memoryId = id(body.memoryId), { kind: _kind, memoryId: _memoryId, ...request } = body;
    const parsed = parseBrainMemoryRevisionRequest(request);
    execute = async () => { const result = await reviseBrainMemory({ requester, memoryId, request: parsed });
      return { kind, state: result.newMemory?.status ?? result.oldMemory.status, records: [reference(result.oldMemory, "previous"), ...(result.newMemory ? [reference(result.newMemory, "memory")] : [])], domainReceiptId: result.receipt.id }; };
  } else {
    fields(body, ["entityKind", "entityId", "action", "expectedEntityVersion", "expectedDependencyVersion", "sources", "reason", "evidenceConfirmed"]);
    const entityId = id(body.entityId), entityKind = body.entityKind;
    if (typeof entityKind !== "string" || !["wiki_note", "interaction_task", "loop"].includes(entityKind)) memoryInvalid("Invalid dependency target");
    const { kind: _kind, entityKind: _entityKind, entityId: _entityId, ...request } = body;
    execute = async () => { const result = await bindMemoryDependencies({ requester, entityKind: entityKind as "wiki_note" | "interaction_task" | "loop", entityId, request });
      return { kind, state: "bound", records: [], dependencyReceipt: result.receipt }; };
  }
  const requestHash = createHash("sha256").update(stableJson({ ...body, commandId })).digest("hex");
  const meta: RevisionCommandResult["meta"] = { traceId: randomUUID(), contractVersion: "memory-revision.v1", implementationVersion: "memory-t3.v1", provider: "postgres", detail: "owner_revision_command", warnings: [] };
  try { return await withDatabaseTransaction(async () => {
    const [principal] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("share");
    if (!principal) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity unavailable");
    await acquireMemoryWriteAdvisoryLock(db, JSON.stringify(["memory-owner-revision.v1", userId, commandId]));
    const [prior] = await db.select().from(memoryRevisionCommandReceipts).where(and(eq(memoryRevisionCommandReceipts.userId, userId), eq(memoryRevisionCommandReceipts.commandId, commandId))).limit(1);
    if (prior && prior.requestHash !== requestHash) throw new MemoryModuleError("memory_command_conflict", 409, "Command ID was reused with different input");
    if (prior) return { status: "recorded", replayed: true, outcome: prior.outcome as RevisionOutcome,
      receipt: { id: prior.id, commandId, createdAt: prior.createdAt.toISOString() }, resultSemantics: "historical_command_outcome", meta };
    const outcome = await execute();
    const [saved] = await db.insert(memoryRevisionCommandReceipts).values({ id: randomUUID(), userId, commandId, requestHash, kind, outcome,
      traceId: meta.traceId, contractVersion: meta.contractVersion, implementationVersion: meta.implementationVersion }).returning();
    if (!saved) throw new Error("Revision command receipt was not persisted");
    return { status: "recorded", replayed: false, outcome, receipt: { id: saved.id, commandId, createdAt: saved.createdAt.toISOString() }, resultSemantics: "historical_command_outcome", meta };
  }); } catch (error) { return mapError(error); }
}
export async function explainRevisionCommand(userId: string, receiptId: string) {
  const [row] = await db.select().from(memoryRevisionCommandReceipts).where(and(eq(memoryRevisionCommandReceipts.userId, userId), eq(memoryRevisionCommandReceipts.id, receiptId))).limit(1);
  return row ? { status: "ok" as const, type: "revision_command" as const, historical: true, outcome: row.outcome,
    receipt: { id: row.id, commandId: row.commandId, createdAt: row.createdAt.toISOString() },
    implementation: { traceId: row.traceId, contractVersion: row.contractVersion, implementationVersion: row.implementationVersion } } : { status: "not_found" as const };
}
