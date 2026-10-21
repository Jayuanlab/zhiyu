import { createHash } from "node:crypto";
import { memoryRecallOmitReason } from "../records/lifecycle";
import type { BrainMemory, BrainRequester } from "../kernel/memory-types";

export const MEMORY_DEPENDENCY_SOURCE = "brain-memory-dependencies.v1";
export const MEMORY_DEPENDENCY_REGISTRY_TYPE = "memory_dependency_registry";
export const MEMORY_DEPENDENCY_CHANGE_TYPE = "memory_dependency_change";
export type MemoryDependencyEntityKind = "wiki_note" | "interaction_task" | "loop";
export type MemoryDependencyAssessment = "unknown" | "current" | "stale" | "denied";
export type MemoryDependencySource = { memoryId: string; expectedVersion: string };
export class MemoryDependencyError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export function dependencyFail(code: string, status: number, message: string): never {
  throw new MemoryDependencyError(code, status, message);
}
export function dependencyObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}
export function memoryDependencyDigest(value: unknown) { return createHash("sha256").update(stableJson(value)).digest("hex"); }
/** Real persisted content/definition projection, never a caller supplied revision counter. */
export function getMemoryDependencyEntityVersion(projection: unknown) { return `bmde1:${memoryDependencyDigest(projection)}`; }
export function getMemoryDependencyRegistryVersion(snapshot: { id: string; content: unknown } | null) {
  return snapshot ? `bmdd1:${memoryDependencyDigest({ id: snapshot.id, content: snapshot.content })}` : "bmdd1:initial";
}
export function memoryDependencyRecordId(userId: string, commandId: string, purpose: string) {
  const h = memoryDependencyDigest([MEMORY_DEPENDENCY_SOURCE, userId.toLowerCase(), commandId, purpose]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseMemoryDependencyEntity(kind: unknown, id: unknown) {
  if (!["wiki_note", "interaction_task", "loop"].includes(String(kind)) || typeof id !== "string" || !UUID.test(id))
    dependencyFail("invalid_dependency", 400, "Invalid dependency target");
  return { entityKind: kind as MemoryDependencyEntityKind, entityId: id.toLowerCase() };
}
export function parseMemoryDependencySources(value: unknown): MemoryDependencySource[] {
  if (!Array.isArray(value) || !value.length || value.length > 20)
    dependencyFail("invalid_dependency", 400, "Register 1 to 20 exact memory versions");
  const sources = value.map(v => {
    const source = dependencyObject(v);
    if (Object.keys(source).some(k => !["memoryId", "expectedVersion"].includes(k)) || typeof source.memoryId !== "string" || !UUID.test(source.memoryId) || typeof source.expectedVersion !== "string" || !/^bmrv1:[a-f0-9]{64}$/.test(source.expectedVersion))
      dependencyFail("invalid_dependency", 400, "Every source requires a memoryId and bmrv1 expectedVersion");
    return { memoryId: source.memoryId.toLowerCase(), expectedVersion: source.expectedVersion };
  });
  if (new Set(sources.map(s => s.memoryId)).size !== sources.length)
    dependencyFail("invalid_dependency", 400, "Duplicate memory dependencies are not allowed");
  return sources.sort((a, b) => a.memoryId.localeCompare(b.memoryId));
}
export function dependencyText(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    dependencyFail("invalid_dependency", 400, `${field} requires 1 to ${max} characters`);
  return value.trim();
}
export function dependencyNow(value?: Date) {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) dependencyFail("invalid_dependency", 400, "Invalid submission time");
  return now;
}
export function isDependencyHuman(requester: BrainRequester) { return requester.type === "chat" && requester.id !== "brain-mcp"; }
export function memoryIsDependencyCurrent(memory: BrainMemory, now: Date) {
  if (memoryRecallOmitReason(memory)) return false;
  return ["active", "verified"].includes(memory.status) && (!memory.expiresAt || Number.isFinite(Date.parse(memory.expiresAt)) && Date.parse(memory.expiresAt) > now.getTime()) && dependencyObject(memory.metadata?.updateProposal).status !== "pending";
}
/** Denial wins; recorded coverage does not assert completeness. */
export function deriveMemoryDependencyAssessment(input: { recorded: boolean; entityCurrent: boolean; sourceAssessments: MemoryDependencyAssessment[] }): MemoryDependencyAssessment {
  if (input.sourceAssessments.includes("denied")) return "denied";
  if (!input.recorded) return "unknown";
  return input.entityCurrent && input.sourceAssessments.length > 0 && input.sourceAssessments.every(s => s === "current") ? "current" : "stale";
}
