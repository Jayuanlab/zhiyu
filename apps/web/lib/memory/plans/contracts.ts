import { createHash } from "node:crypto";
import { z } from "zod";
import type { TaskPlan } from "@openzhiyu/ai/agent/types";
import { stableJson } from "../records/observations";
export const planPayloadSchema = z.object({ id: z.string().min(1).max(200), goal: z.string().max(8192),
  steps: z.array(z.object({ id: z.string().max(200), description: z.string().max(8192),
    status: z.enum(["pending", "in_progress", "completed", "failed"]) }).strict()).max(64),
  notes: z.string().max(16384).optional(), createdAt: z.coerce.date().transform(value => value.toISOString()) }).strict();
export type PlanPayload = z.infer<typeof planPayloadSchema>;
const identity = z.string().uuid().transform(value => value.toLowerCase());
export const planVersionSchema = z.string().regex(/^mplan1:[a-f0-9]{64}$/);
export const executePlanSchema = z.object({ planId: z.string().min(1).max(200), expectedVersion: planVersionSchema,
  commandId: identity, taskId: identity.nullable().optional(), workDir: z.string().max(4096).nullable().optional() }).strict();
export const legacyRebaseSchema = z.object({ commandId: identity, expectedLegacyVersion: z.string().regex(/^legacyplan1:[a-f0-9]{64}$/),
  inputPrompt: z.string().min(1).max(262144), sourceReceiptIds: z.array(identity).max(62), confirmed: z.literal(true) }).strict();
export const revokePlanSchema = z.object({ commandId: identity, expectedVersion: planVersionSchema }).strict();
export type PlanRecord = { id: string; userId: string; planId: string; revision: number; state: "ready" | "approved" | "revoked";
  origin: "generated" | "owner_rebased_legacy"; plan: PlanPayload; promptSnapshot: string; inputObservationId: string;
  sourceReceiptIds: string[]; parentVersion: string | null; legacyVersion: string | null; taskId: string | null; workDir: string | null;
  expiresAt: string; createdAt: string; version: string };
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return Array.from(value, child => child === undefined ? null : canonical(child));
  // Match JSONB persistence: absent optional fields are omitted, while array
  // slots preserve their position as null. Private text remains byte-sensitive.
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key, canonical(child)]));
  return value;
}
export const planDigest = (value: unknown) => createHash("sha256").update(stableJson(canonical(value))).digest("hex");
export function memoryPlanVersion(record: Omit<PlanRecord, "version"> | PlanRecord) {
  const { version: _version, ...body } = record as PlanRecord;
  return `mplan1:${planDigest(body)}`;
}
export function toTaskPlan(plan: PlanPayload): TaskPlan { return { ...plan, createdAt: new Date(plan.createdAt) }; }
export function stablePlanCommand(userId: string, planId: string) {
  const h = planDigest(["memory-plan-generated.v1", userId, planId]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
