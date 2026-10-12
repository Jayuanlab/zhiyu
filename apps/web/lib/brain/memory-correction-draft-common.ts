import { createHash } from "node:crypto";
import type { BrainMemoryStatus } from "./types";

export const BRAIN_MEMORY_CORRECTION_DRAFT_SOURCE = "brain-memory-correction-draft.v1";
export const BRAIN_MEMORY_CORRECTION_DRAFT_TYPE = "memory_correction_draft";
export const BRAIN_MEMORY_CORRECTION_INTENT_TYPE = "owner_memory_correction_intent";
export const BRAIN_MEMORY_CORRECTION_RULE_VERSION = "brain-memory-correction-rules.v1";
export type BrainMemoryCorrectionOperation = "correct" | "supplement" | "state_change" | "deactivate";
export type BrainMemoryCorrectionDraftRequest = { commandId: string; expectedVersion: string; intent: string };
export type BrainMemoryCorrectionInterpretation = {
  outcome: "ready" | "needs_clarification";
  operation: BrainMemoryCorrectionOperation | null;
  content: string | null;
  reason: string | null;
  authority: null;
  sourceObservedAt: null;
  quote: { start: number; end: number; text: string } | null;
  questions: string[];
  provider: "deterministic_rules";
  detail: string;
  warnings: string[];
};
export type BrainMemoryCorrectionDraft = BrainMemoryCorrectionInterpretation & {
  id: string; commandId: string; memoryId: string; expectedVersion: string; intent: string;
  evidenceRefs: string[]; createdAt: string;
};
export type BrainMemoryCorrectionDraftReceipt = {
  id: string; commandId: string; memoryId: string; expectedVersion: string; draftId: string;
  observationId: string; draftVersion: string; createdAt: string; effective: false;
};
export type BrainMemoryCorrectionDraftResult = {
  draft: BrainMemoryCorrectionDraft;
  receipt: BrainMemoryCorrectionDraftReceipt;
  current: { memoryId: string; version: string; status: BrainMemoryStatus; expiresAt: string | null; versionMatches: boolean; canSeed: boolean };
  replayed: boolean;
};
export class BrainMemoryCorrectionDraftError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export function correctionFail(code: string, status: number, message: string): never { throw new BrainMemoryCorrectionDraftError(code, status, message); }
export const CORRECTION_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const CORRECTION_MEMORY_VERSION = /^bmrv1:[a-f0-9]{64}$/;
export function correctionObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
export function correctionDigest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
export function correctionTextHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function brainMemoryCorrectionRecordId(userId: string, commandId: string, purpose: "draft" | "observation" | "receipt"): string {
  const hash = correctionDigest([BRAIN_MEMORY_CORRECTION_DRAFT_SOURCE, userId, commandId, purpose]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function getBrainMemoryCorrectionDraftVersion(draft: BrainMemoryCorrectionDraft): string { return `bmcd1:${correctionDigest(draft)}`; }
export function parseBrainMemoryCorrectionDraftRequest(value: unknown): BrainMemoryCorrectionDraftRequest {
  const body = correctionObject(value);
  if (Object.keys(body).some(key => !["commandId", "expectedVersion", "intent"].includes(key)) ||
      typeof body.commandId !== "string" || !body.commandId.trim() || body.commandId.length > 200 ||
      typeof body.expectedVersion !== "string" || !CORRECTION_MEMORY_VERSION.test(body.expectedVersion) ||
      typeof body.intent !== "string" || !body.intent.trim() || body.intent.length > 4000 || body.intent.includes("\0"))
    correctionFail("invalid_correction_draft", 400, "A commandId, current memory version and 1 to 4000 characters of intent are required");
  // Preserve the original intent byte-for-byte; only the command identifier is normalized.
  return { commandId: body.commandId.trim(), expectedVersion: body.expectedVersion, intent: body.intent };
}
export function correctionNow(value?: Date): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) correctionFail("invalid_correction_draft", 400, "Invalid submission time");
  return now;
}

/** A deliberately small command grammar, not semantic understanding or a fact checker. */
export function parseBrainMemoryCorrectionIntent(memoryContent: string, intent: string): BrainMemoryCorrectionInterpretation {
  const text = intent.trim();
  const start = intent.indexOf(text);
  const quote = text ? { start, end: start + text.length, text } : null;
  const base = { authority: null, sourceObservedAt: null, quote, provider: "deterministic_rules" as const,
    warnings: ["owner_review_required", "proves_owner_expression_only", "semantic_quality_not_evaluated"] };
  const clarify = (detail: string, question: string): BrainMemoryCorrectionInterpretation => ({ ...base, outcome: "needs_clarification", operation: null, content: null, reason: null, detail, questions: [question] });
  if (!text || text.length > 4000 || intent.includes("\0")) return clarify("invalid_intent", "请提供需要改动的完整正文或明确停用请求。");
  // Quoted examples, hypothetical requests and questions never become ready commands.
  if (/["'`“”‘’「」『』?？]/u.test(text) || /假设|如果|可能|也许|据说|听说|例如|举例|是否|是不是|能不能|要不要|引用/u.test(text))
    return clarify("ambiguous_or_quoted_intent", "请确认这是你现在对本条记忆的明确更正，而不是引用、假设或问题。");
  if (/^(?:请)?停用这条记忆[。.!！]?$/u.test(text)) return { ...base, outcome: "ready", operation: "deactivate", content: null,
    reason: "主人明确请求停用本条记忆，仍需人工核对并提交。", detail: "explicit_deactivate", questions: [] };
  const rules: Array<{ operation: BrainMemoryCorrectionOperation; pattern: RegExp; detail: string; reason: string }> = [
    { operation: "correct", pattern: /^(?:请)?(?:把这条记忆)?完整改为[：:]\s*([\s\S]+)$/u, detail: "explicit_complete_correct", reason: "主人明确提供纠正后的完整正文，仍需人工核对来源。" },
    { operation: "supplement", pattern: /^(?:请)?(?:把这条记忆)?完整补充为[：:]\s*([\s\S]+)$/u, detail: "explicit_complete_supplement", reason: "主人明确提供补充后的完整正文，仍需人工核对原意和来源。" },
    { operation: "state_change", pattern: /^(?:请)?状态变化后的完整内容[：:]\s*([\s\S]+)$/u, detail: "explicit_complete_state_change", reason: "主人明确提供状态变化后的完整正文，事实发生时间仍需人工确认。" },
  ];
  for (const rule of rules) {
    const match = text.match(rule.pattern);
    if (!match || !match[1].trim()) continue;
    const content = match[1].trim();
    if (content === memoryContent.trim()) return clarify("unchanged_content", "提供的完整正文与当前正文相同；请核对是否需要改动。");
    const contentStart = start + text.length - match[1].length + match[1].length - match[1].trimStart().length;
    return { ...base, quote: { start: contentStart, end: contentStart + content.length, text: content },
      outcome: "ready", operation: rule.operation, content, reason: rule.reason, detail: rule.detail, questions: [] };
  }
  return clarify("explicit_full_content_required", "请使用“完整改为：…”、“完整补充为：…”、“状态变化后的完整内容：…”或“停用这条记忆”，并核对完整新正文。");
}
