import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import type { Workshop } from "@/lib/db/schema";
import { getWorkshop, appendWorkshopEvent } from "./service";
import { buildReviewAssistantItem, sortReviewAssistantItems, type ReviewAssistantResponse, type ReviewAssistantItem, type ReviewAssistantSourceItem, type ReviewAssistantSourceEvent } from "./review-assistant";
import { evaluateReviewAssistantWithJev, REVIEW_ASSISTANT_AI_LIMIT, REVIEW_ASSISTANT_JEV_MODEL, REVIEW_ASSISTANT_JEV_SCHEMA, REVIEW_ASSISTANT_THRESHOLDS, type ReviewAssistantModelInput, type ReviewAssistantModelResult } from "./review-assistant-model";
import { loadReviewWorkObservations, type ReviewWorkObservations } from "./review-assistant-observations";

export const REVIEW_ASSISTANT_ITEM_LIMIT = 200;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class ReviewAssistantError extends Error {
  constructor(public code: "invalid_request" | "not_found" | "source_changed", public status: number) { super(code); }
}
type Source = { item: ReviewAssistantSourceItem; event: ReviewAssistantSourceEvent | null };
export type ReviewAssistantSnapshot = { workshop: Workshop; sources: Source[]; total: number; pendingUpdatedAt: string;
  workObservations?: ReviewWorkObservations | null; observationWarning?: string | null };
type Cached = { generatedAt: string; result: ReviewAssistantModelResult };
type Dependencies = {
  snapshot: (userId: string, workId: string) => Promise<ReviewAssistantSnapshot>;
  cached: (userId: string, workId: string, fingerprint: string) => Promise<Cached | null>;
  evaluate: (inputs: ReviewAssistantModelInput[]) => Promise<ReviewAssistantModelResult>;
  save: (userId: string, workId: string, fingerprint: string, saved: Cached) => Promise<void>;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return record(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function date(value: unknown) { const parsed = new Date(String(value ?? "")); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : ""; }
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

export function reviewAssistantFingerprint(snapshot: ReviewAssistantSnapshot) {
  return createHash("sha256").update(JSON.stringify(stable({ schema: REVIEW_ASSISTANT_JEV_SCHEMA,
    workId: snapshot.workshop.id, owner: snapshot.workshop.userId, name: snapshot.workshop.name,
    mission: snapshot.workshop.mission, total: snapshot.total, pendingUpdatedAt: snapshot.pendingUpdatedAt,
    sources: [...snapshot.sources].sort((a, b) => a.item.id.localeCompare(b.item.id)),
    workObservations: snapshot.workObservations ?? null, observationWarning: snapshot.observationWarning ?? null,
  }))).digest("hex");
}

/** Authorization precedes all review/event reads; source joins stay in this Work. */
export async function loadReviewAssistantSnapshot(userId: string, workId: string): Promise<ReviewAssistantSnapshot> {
  if (!uuid.test(workId) || !uuid.test(userId)) throw new ReviewAssistantError("invalid_request", 400);
  const workshop = await getWorkshop(userId, workId);
  if (!workshop) throw new ReviewAssistantError("not_found", 404);
  const rows = await db.execute(sql`
    SELECT i.*, count(*) OVER()::int AS total, max(i.updated_at) OVER() AS pending_updated_at,
      e.id AS source_id, e.title AS source_title, e.type AS source_type, e.body AS source_body,
      e.metadata AS source_metadata, e.created_at AS source_created_at
    FROM workshop_review_items i
    LEFT JOIN workshop_events e ON e.id=i.source_event_id AND e.workshop_id=i.workshop_id
    WHERE i.workshop_id=${workId}::uuid AND i.status='pending'
    ORDER BY (COALESCE(i.risk_level='high',false) OR i.kind IN ('permission_boundary','agent_change_proposal','watchlist_proposal','insight_change_proposal','loop_change_proposal','memory_recall_change_plan','memory_recall_governance_proposal')) DESC,
      i.updated_at DESC, i.id
    LIMIT ${REVIEW_ASSISTANT_ITEM_LIMIT}
  `) as Array<Record<string, any>>;
  let workObservations: ReviewWorkObservations | null = null;
  let observationWarning: string | null = null;
  if (rows.some(row => row.kind === "memory_recall_quality")) {
    try { workObservations = await loadReviewWorkObservations(workId); }
    catch { observationWarning = "本次未能读取当前车间的记忆使用记录，已保留历史待办说明；当前任务是否受影响仍待核实。"; }
  }
  return { workshop, workObservations, observationWarning, total: Number(rows[0]?.total ?? 0), pendingUpdatedAt: date(rows[0]?.pending_updated_at),
    sources: rows.map(row => ({ item: {
      id: row.id, kind: row.kind, title: row.title, summary: row.summary, riskLevel: row.risk_level,
      sourceEventId: row.source_event_id, metadata: record(row.metadata), updatedAt: date(row.updated_at), createdAt: date(row.created_at),
    }, event: row.source_id ? {
      id: row.source_id, title: row.source_title, type: row.source_type, body: row.source_body,
      metadata: record(row.source_metadata), createdAt: date(row.source_created_at),
    } : null })),
  };
}

export function reviewAssistantBaseline(snapshot: ReviewAssistantSnapshot): ReviewAssistantResponse {
  const items = snapshot.sources.map(source => {
    const item = buildReviewAssistantItem(source.item, source.event);
    if (item.kind !== "memory_recall_quality") return item;
    const sample = snapshot.workObservations;
    if (sample?.sampleCount) {
      const count = (value: number | null) => value === null ? "未能读取" : `${value} 次`;
      item.knownFacts = [...(item.knownFacts ?? []), `本车间近 ${sample.windowDays} 天抽样 ${sample.sampleCount} 条记忆使用记录：告警 ${count(sample.warningCount)}，所选记忆未附来源链接 ${count(sample.noEvidenceSelectedCount)}，重复候选被过滤 ${count(sample.duplicateOmittedCount)}。这是本车间的抽样结果，不代表全部运行。`];
    } else if (sample) {
      item.knownFacts = [...(item.knownFacts ?? []), `本车间近 ${sample.windowDays} 天没有读到可统计的记忆使用记录，无法核实当前影响。`];
    }
    if (snapshot.observationWarning) item.missingInfo.push("当前车间的使用记录本次读取失败，需要恢复读取后核对影响。");
    return item;
  });
  return {
    version: 1, workId: snapshot.workshop.id, generatedAt: new Date().toISOString(), fingerprint: reviewAssistantFingerprint(snapshot),
    mode: "rules", model: null, warning: snapshot.observationWarning ?? null, cached: false,
    coverage: { scope: "pending_review_items", total: snapshot.total, included: snapshot.sources.length,
      analyzed: 0, limit: REVIEW_ASSISTANT_AI_LIMIT, hasMore: snapshot.total > snapshot.sources.length,
      note: `这里整理统一待办中的待确认事项；不包含独立的视频审核、发信批准、持续任务待批或运行结果核实队列。最多显示 ${REVIEW_ASSISTANT_ITEM_LIMIT} 项，JEV 每次判断前 ${REVIEW_ASSISTANT_AI_LIMIT} 项的摘要，其余保留基础说明。`,
    },
    items: sortReviewAssistantItems(items),
  };
}

export function reviewAssistantModelInputs(snapshot: ReviewAssistantSnapshot, baseline: ReviewAssistantResponse): ReviewAssistantModelInput[] {
  return baseline.items.slice(0, REVIEW_ASSISTANT_AI_LIMIT).map(item => {
    const source = snapshot.sources.find(source => source.item.id === item.id)!;
    const metadata = { ...record(source.item.metadata), ...record(source.event?.metadata) };
    // Prioritize observed facts before narrative; preserve valid JSON and disclose omitted fields.
    // Suggested actions remain source proposals, never completed actions or model instructions.
    let truncated = false;
    const bounded = (value: unknown, depth = 0): unknown => {
      if (typeof value === "string") { if (value.length > 220) truncated = true; return value.slice(0, 220); }
      if (Array.isArray(value)) { if (value.length > 3) truncated = true; return value.slice(0, 3).map(v => bounded(v, depth + 1)); }
      if (value && typeof value === "object") {
        if (depth > 3) { truncated = true; return "本次未纳入更深层明细"; }
        const entries = Object.entries(value); if (entries.length > 10) truncated = true;
        return Object.fromEntries(entries.slice(0, 10).map(([key, v]) => [key, bounded(v, depth + 1)]));
      }
      return value;
    };
    const sample = item.kind === "memory_recall_quality" ? snapshot.workObservations : null;
    const candidates = {
      workshop: { name: snapshot.workshop.name, mission: snapshot.workshop.mission }, kind: item.kind,
      issueKind: metadata.issueKind, issueCount: metadata.issueCount, source: metadata.source,
      observationScope: metadata.observationScope ?? (metadata.source === "memory_recall_quality_report"
        ? { kind: "user_memory_recall_sample", includesOtherWorkshops: true, legacyScopeInferredFromProducer: true } : undefined),
      period: { since: metadata.periodSince, until: metadata.generatedAt, days: metadata.periodDays },
      currentWorkSample: sample ? { windowDays: sample.windowDays, sampleCount: sample.sampleCount,
        firstEventAt: sample.firstEventAt, lastEventAt: sample.lastEventAt, warningCount: sample.warningCount,
        noEvidenceSelectedCount: sample.noEvidenceSelectedCount, duplicateOmittedCount: sample.duplicateOmittedCount,
        scope: "current_work_only_sample_not_all_runs" } : undefined,
      observationWarning: snapshot.observationWarning ?? undefined,
      metricMeaning: metadata.issueKind === "duplicate_canonical_groups" ? "统计已经被过滤的重复候选，不代表重复内容已被选入上下文"
        : metadata.issueKind === "no_evidence_selected" ? "统计所选记忆未附来源链接的次数，不等于不同记忆条数，也不代表整轮资料都没有证据" : undefined,
      riskLevel: item.riskLevel, automaticPolicyChange: metadata.automaticPolicyChange,
      evidenceHints: metadata.evidenceHints, blockedActions: metadata.blockedActions,
      feedbackTraceDiagnostics: metadata.feedbackTraceDiagnostics,
      recommendedActions: metadata.recommendedActions,
      changedFields: metadata.changedFields, problems: metadata.problems, reason: metadata.reason,
      nextAction: metadata.nextAction, blockedReason: metadata.blockedReason, destructive: metadata.destructive,
      proposedYamlPatch: metadata.proposedYamlPatch ? "存在配置修改建议，具体值未纳入本次摘要" : undefined,
      title: source.item.title, summary: source.item.summary,
      sourceEvent: source.event ? { type: source.event.type, title: source.event.title, body: source.event.body, createdAt: source.event.createdAt } : null,
    };
    const facts: Record<string, unknown> = {};
    const omitted: string[] = [];
    for (const [key, value] of Object.entries(candidates)) {
      if (value === undefined) continue;
      const compact = bounded(value);
      if (JSON.stringify({ ...facts, [key]: compact }).length <= 2600) facts[key] = compact;
      else { truncated = true; omitted.push(key); }
    }
    if (omitted.length) facts.omittedFields = omitted.join(", ").slice(0, 160);
    return { id: item.id, facts: JSON.stringify(facts), truncated };
  });
}

const probability = z.number().min(0).max(1);
const resultSchema = z.object({
  status: z.enum(["ok", "degraded"]), model: z.literal(REVIEW_ASSISTANT_JEV_MODEL), schemaVersion: z.literal(REVIEW_ASSISTANT_JEV_SCHEMA),
  thresholds: z.object({ select: z.literal(REVIEW_ASSISTANT_THRESHOLDS.select), exclude: z.literal(REVIEW_ASSISTANT_THRESHOLDS.exclude) }).strict(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), elapsedMs: z.number().finite().nonnegative(), detail: z.string().max(80).optional(),
  items: z.array(z.object({ id: z.string().uuid(), truncated: z.boolean(), probabilities: z.object({
    currentImpact: probability, concreteBenefit: probability, sufficientEvidence: probability, significantSideEffects: probability,
  }).strict() }).strict()).max(REVIEW_ASSISTANT_AI_LIMIT),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict().optional(),
}).strict();

function validResult(result: unknown, expectedIds: string[]): ReviewAssistantModelResult | null {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.status === "degraded") return value.items.length === 0 ? value : null;
  const ids = value.items.map(item => item.id);
  if (ids.length !== expectedIds.length || new Set(ids).size !== ids.length || ids.some(id => !expectedIds.includes(id))) return null;
  return value;
}

export function applyReviewAssistantJudgments(baseline: ReviewAssistantResponse, result: ReviewAssistantModelResult, generatedAt: string, cached = false): ReviewAssistantResponse {
  if (result.status !== "ok") return { ...baseline, generatedAt, cached, warning: [baseline.warning, reviewAssistantWarning(result.detail)].filter(Boolean).join(" ") };
  const items = baseline.items.map(item => {
    const judgment = result.items.find(row => row.id === item.id);
    if (!judgment) return item;
    const p = judgment.probabilities;
    const threshold = result.thresholds;
    const uncertain = (value: number) => value > threshold.exclude && value < threshold.select;
    const evidenceIncomplete = judgment.truncated || item.missingInfo.length > 0 || p.sufficientEvidence < threshold.select;
    const fixedFirst = item.priority === "first";
    const sideEffects = p.significantSideEffects >= threshold.select;
    const currentImpact = p.currentImpact >= threshold.select;
    const useful = currentImpact || p.concreteBenefit >= threshold.select;
    const canWait = item.category === "optional" && !fixedFirst && !judgment.truncated && p.currentImpact <= threshold.exclude && p.significantSideEffects <= threshold.exclude;
    const checks = item.verificationQuestions;
    const missingInfo = [...new Set([
      ...item.missingInfo,
      ...(p.sufficientEvidence < threshold.select && checks ? [checks.evidence] : []),
      ...(uncertain(p.currentImpact) && checks ? [checks.impact] : []),
      ...(uncertain(p.concreteBenefit) && checks ? [checks.benefit] : []),
      ...(uncertain(p.significantSideEffects) && checks ? [checks.sideEffects] : []),
      ...(judgment.truncated ? ["这次摘要未包含全部明细，做具体修改前需要核对完整记录。"] : []),
    ])];
    let suggestion: ReviewAssistantItem["suggestion"];
    let reason: string;
    if (canWait) {
      suggestion = "defer";
      reason = item.kind === "memory_recall_quality"
        ? "现有材料尚未显示这些记忆信号正在阻塞当前工作。这是可选的维护事项，可先保留记录，由记忆维护环节核实后再决定是否改动。"
        : `现有材料尚未显示“${item.title}”正在影响当前工作，也没有明确的重要副作用，可以稍后处理。具体改动前仍需核对下面的问题。`;
    } else if (evidenceIncomplete) {
      suggestion = "need_evidence";
      reason = `关于“${item.title}”，${judgment.truncated ? "本次只分析了部分明细" : "已有说明还不足以决定具体改动"}。先由提出事项的一方核对下面的问题，再形成可供你审核的方案。`;
    } else if (fixedFirst || sideEffects || currentImpact) {
      suggestion = "review";
      reason = sideEffects ? "这项安排可能产生重要副作用，建议优先查看具体改动、影响范围和恢复方式。"
        : currentImpact ? "现有说明表明它与当前工作结果有关，值得优先查看；改进收益尚未明确也不妨碍先了解问题。"
          : "这项安排需要你决定，现有说明可以开始审阅。请核对具体变更后再处理。";
    } else if (useful && p.significantSideEffects <= threshold.exclude) {
      suggestion = "review";
      reason = `“${item.title}”的资料中有明确改进目标，你可以按关注点查看具体方案。`;
    } else {
      suggestion = "need_evidence";
      reason = uncertain(p.significantSideEffects) ? "改动范围或副作用还不能确定，先把受影响对象和恢复方式核对清楚。"
        : uncertain(p.currentImpact) ? "还不能确定这件事影响哪项工作，建议先定位受影响的任务和运行记录。"
          : "进一步改动能带来的具体改善还不明确，建议先拿出修改前后的对照再决定。";
    }
    return { ...item, suggestion, reason, aiAssisted: true,
      priority: fixedFirst || sideEffects || currentImpact ? "first" as const : suggestion === "defer" ? "later" as const : "normal" as const,
      prioritySource: fixedFirst ? "rules" as const : "ai" as const,
      missingInfo,
    };
  });
  return { ...baseline, generatedAt, cached, mode: "ai", model: result.model,
    items: sortReviewAssistantItems(items), coverage: { ...baseline.coverage, analyzed: result.items.length },
    warning: [baseline.warning, result.items.some(item => item.truncated) ? "部分事项的明细未全部纳入本次判断，具体改动前请核对完整记录。" : null].filter(Boolean).join(" ") || null,
  };
}

function reviewAssistantWarning(detail?: string) {
  if (detail === "missing_api_key") return "JEV 尚未配置 TYPESAFE_API_KEY，当前显示基础整理；没有执行 AI 判断。";
  if (detail === "timeout") return "JEV 判断超时，当前保留基础整理，可以稍后重试。";
  if (detail === "invalid_response") return "JEV 返回内容未通过完整性校验，当前保留基础整理。";
  return "JEV 暂时无法完成判断，当前保留基础整理，可以稍后重试。";
}

async function cachedResult(userId: string, workId: string, fingerprint: string): Promise<Cached | null> {
  const rows = await db.execute(sql`SELECT metadata, created_at FROM workshop_events
    WHERE workshop_id=${workId}::uuid AND type='review_assistant_completed'
      AND metadata->>'fingerprint'=${fingerprint} AND metadata->>'actorId'=${userId}
      AND metadata->>'receiptAuthority'='runtime' AND metadata->>'source'='review_assistant'
    ORDER BY seq DESC LIMIT 1`) as Array<{ metadata: unknown; created_at: unknown }>;
  const metadata = record(rows[0]?.metadata);
  return rows[0] ? { generatedAt: date(metadata.generatedAt ?? rows[0].created_at), result: metadata.result as ReviewAssistantModelResult } : null;
}

async function saveResult(userId: string, workId: string, fingerprint: string, saved: Cached) {
  await appendWorkshopEvent({ workshopId: workId, type: "review_assistant_completed", visibility: "debug",
    title: saved.result.status === "ok" ? "JEV 助审建议已生成" : "JEV 助审已降级为基础整理",
    body: `本次仅整理待办并给出查看建议，未改变任何审核或执行状态。`,
    metadata: { source: "review_assistant", receiptAuthority: "runtime", actorId: userId,
      fingerprint, generatedAt: saved.generatedAt, schemaVersion: saved.result.schemaVersion, model: saved.result.model,
      result: saved.result, appliesAutomatically: false },
  });
}

/** Per-process single flight plus durable, source-fingerprinted results. No approval command is reachable. */
export function createReviewAssistantService(dependencies: Dependencies) {
  const inFlight = new Map<string, Promise<ReviewAssistantResponse>>();
  async function readSaved(userId: string, baseline: ReviewAssistantResponse) {
    const saved = await dependencies.cached(userId, baseline.workId, baseline.fingerprint);
    if (!saved) return null;
    const result = validResult(saved.result, baseline.items.slice(0, REVIEW_ASSISTANT_AI_LIMIT).map(item => item.id));
    if (!result || !Number.isFinite(Date.parse(saved.generatedAt))) return null;
    if (result.status === "degraded" && Date.now() - Date.parse(saved.generatedAt) > 30_000) return null;
    return applyReviewAssistantJudgments(baseline, result, saved.generatedAt, true);
  }
  return {
    async get(input: { userId: string; workId: string }) {
      const snapshot = await dependencies.snapshot(input.userId, input.workId);
      const baseline = reviewAssistantBaseline(snapshot);
      return await readSaved(input.userId, baseline) ?? baseline;
    },
    async generate(input: { userId: string; workId: string; fingerprint: unknown }) {
      if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new ReviewAssistantError("invalid_request", 400);
      const snapshot = await dependencies.snapshot(input.userId, input.workId);
      const baseline = reviewAssistantBaseline(snapshot);
      if (input.fingerprint !== baseline.fingerprint) throw new ReviewAssistantError("source_changed", 409);
      if (!baseline.items.length) return baseline;
      const saved = await readSaved(input.userId, baseline);
      if (saved) return saved;
      const key = `${input.userId}:${input.workId}:${input.fingerprint}`;
      const running = inFlight.get(key);
      if (running) return running;
      const work = (async () => {
        const inputs = reviewAssistantModelInputs(snapshot, baseline);
        let result: ReviewAssistantModelResult;
        try { result = await dependencies.evaluate(inputs); }
        catch { result = { status: "degraded", model: REVIEW_ASSISTANT_JEV_MODEL, schemaVersion: REVIEW_ASSISTANT_JEV_SCHEMA,
          thresholds: { ...REVIEW_ASSISTANT_THRESHOLDS }, inputHash: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
          elapsedMs: 0, detail: "transport_error", items: [] }; }
        if (!validResult(result, inputs.map(item => item.id))) result = {
          status: "degraded", model: REVIEW_ASSISTANT_JEV_MODEL, schemaVersion: REVIEW_ASSISTANT_JEV_SCHEMA,
          thresholds: { ...REVIEW_ASSISTANT_THRESHOLDS }, inputHash: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
          elapsedMs: 0, detail: "invalid_response", items: [],
        };
        const generatedAt = new Date().toISOString();
        // A result always refers to its observed source; stale analysis is never returned as current.
        await dependencies.save(input.userId, input.workId, baseline.fingerprint, { result, generatedAt });
        const current = await dependencies.snapshot(input.userId, input.workId);
        if (reviewAssistantFingerprint(current) !== baseline.fingerprint) throw new ReviewAssistantError("source_changed", 409);
        return applyReviewAssistantJudgments(baseline, result, generatedAt);
      })();
      inFlight.set(key, work);
      try { return await work; } finally { inFlight.delete(key); }
    },
  };
}

const service = createReviewAssistantService({ snapshot: loadReviewAssistantSnapshot, cached: cachedResult,
  evaluate: evaluateReviewAssistantWithJev, save: saveResult });
export const getReviewAssistant = service.get;
export const generateReviewAssistant = service.generate;
export async function getSavedReviewAssistantResult(userId: string, workId: string, fingerprint: string) {
  const snapshot = await loadReviewAssistantSnapshot(userId, workId);
  const baseline = reviewAssistantBaseline(snapshot);
  if (baseline.fingerprint !== fingerprint) throw new ReviewAssistantError("source_changed", 409);
  const saved = await cachedResult(userId, workId, fingerprint);
  const result = saved && validResult(saved.result, baseline.items.slice(0, REVIEW_ASSISTANT_AI_LIMIT).map(item => item.id));
  return result?.status === "ok" ? result : null;
}
