import type { WorkshopEvent } from "@/lib/workshops/run-history-types";

export const promotionWorkId = "11111111-1111-4111-a111-111111111111";
export const promotionRunId = "22222222-2222-4222-a222-222222222222";
export const promotionUserId = "33333333-3333-4333-a333-333333333333";
export const promotionSourceId = "44444444-4444-4444-a444-444444444444";
export const promotionLoopId = "88888888-8888-4888-a888-888888888888";
export function loopPromotionEvents(): WorkshopEvent[] {
  return promotionEvents().map(event => ({ ...event, loopId: promotionLoopId, loopRunId: promotionRunId,
    runId: "99999999-9999-4999-a999-999999999999" }));
}
export function promotionEvents(): WorkshopEvent[] {
  const base = { workshopId: promotionWorkId, runId: promotionRunId, title: "记忆来源", body: null, createdAt: "2026-10-13T00:00:00.000Z" };
  const policyIdentity = { version: "memact-automem.v1", hash: "c".repeat(64) };
  const entry = { toolCallId: "read-1", toolName: "webReadPage", contentHash: "b".repeat(64), referenceEligible: true,
    projectionEligible: false, sourceIdentityStatus: "reported", projectionBlockedReasons: ["source_warning"],
    sourceIdentity: { sourceEventId: promotionSourceId, evidenceId: "saved-page", contentHash: "a".repeat(64), offset: 0, contentLength: 1000, totalChars: 2000 },
    sourceCautions: { warningCodes: ["extraction_not_independently_verified"], warningTexts: ["科学结论仍需核对。"] },
  };
  return [
    { ...base, id: promotionSourceId, seq: 1, type: "source_checked", metadata: { receiptAuthority: "runtime", ok: true, toolName: "webReadPage",
      toolUseId: "read-1", evidenceId: "saved-page", contentHash: "a".repeat(64), offset: 0, contentLength: 1000, totalChars: 2000,
      provider: "fixture", finalUrlVerified: false, warnings: ["extraction_not_independently_verified"] } },
    { ...base, id: "55555555-5555-4555-a555-555555555555", seq: 2, type: "working_memory_updated", metadata: {
      schemaVersion: "host-working-memory.v1", receiptAuthority: "runtime", status: "ready_for_projection", mode: "apply", version: 1,
      policyIdentity, state: { facts: [{ key: "paper:method", text: "来源只覆盖第一段，结论仍需核验。", evidenceIds: ["read-1"] }], hypotheses: [], openQuestions: [], nextAction: { text: "", evidenceIds: [] } },
      evidenceCatalog: [structuredClone(entry)] } },
    { ...base, id: "66666666-6666-4666-a666-666666666666", seq: 3, type: "working_memory_projected", metadata: {
      schemaVersion: "host-working-memory.v1", receiptAuthority: "runtime", status: "provider_request_prepared", mode: "apply", version: 1,
      policyIdentity, evidenceCatalog: [structuredClone(entry)], originalChars: 1500, projectedChars: 1500 } },
  ];
}
