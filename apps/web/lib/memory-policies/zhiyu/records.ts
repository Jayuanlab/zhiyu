import type {
  PolicyInput,
  BusinessPolicy,
  PolicyClass,
} from "../../../../../packages/memory/src/policy";
import { analyzeOperationalContent } from "./operational-content";
import { ZHIYU_MEMORY_RULES } from "./rules";
export function inferZhiyuRecordClass(memory: PolicyInput): {
  recordClass: Exclude<PolicyClass, "unclassified">;
  reason: string;
} {
  if (
    memory.recordType === "boundary" ||
    memory.attributes?.canonicalKind === "boundary"
  )
    return { recordClass: "long_term", reason: "protected_boundary" };
  const facets = memory.attributes?.facets as
    | Record<string, unknown>
    | undefined;
  const promotion = memory.attributes?.workingMemoryPromotion as
    | Record<string, unknown>
    | undefined;
  if (
    /^Memory continuity acceptance [a-f0-9]{8} \/ acceptance\.policy$/.test(
      memory.subject,
    ) &&
    memory.content.startsWith("memory-continuity-acceptance;") &&
    facets?.notebookKey === "acceptance.policy" &&
    typeof promotion?.commandId === "string" &&
    promotion.commandId.startsWith("memory-continuity:")
  )
    return {
      recordClass: "acceptance_record",
      reason: "scoped_continuity_acceptance_fixture",
    };
  if (
    memory.originType === "work" &&
    ["work", "workshop"].includes(memory.scopeType) &&
    ["insight", "fact"].includes(memory.recordType)
  ) {
    const tags = new Set(memory.tags ?? []),
      head = memory.content.slice(0, 180);
    const authoredCheckpoint =
      tags.has("checkpoint") &&
      (tags.has("research-state") ||
        tags.has("daily-audit") ||
        tags.has("threshold-review") ||
        tags.has("recall-quality"));
    const datedCheckpoint =
      /^(?:\d{4}-\d{2}(?:-\d{2})?[^\n]{0,45}(?:研究检查点|质量审计检查点)|每日 Harness 质量审计检查点 \d{4}-|(?:Baseline checkpoint|Checkpoint|Threshold review checkpoint) \d{4}-)/i.test(
        head,
      );
    const datedAudit =
      /^\d{4}-\d{2}-\d{2}\s/.test(head) &&
      ((tags.has("daily-audit") && /每日 Harness 质量审计/.test(head)) ||
        (tags.has("threshold-review") && /阈值复核/.test(head)));
    const datedProposalReceipt =
      tags.has("recall-quality") &&
      tags.has("change-proposal") &&
      /^Change proposal \d{4}-\d{2}-\d{2}/.test(head);
    if (
      authoredCheckpoint ||
      datedCheckpoint ||
      datedAudit ||
      datedProposalReceipt
    )
      return {
        recordClass: "run_record",
        reason: "authored_operational_checkpoint",
      };
  }
  const operational = analyzeOperationalContent(memory);
  return operational
    ? { recordClass: "run_record", reason: operational.reason }
    : { recordClass: "long_term", reason: "no_operational_source_proof" };
}
export const zhiyuMemoryPolicy: BusinessPolicy = Object.freeze({
  id: "zhiyu.memory.records",
  version: "2.0.0",
  decide(input: PolicyInput) {
    const inferred = inferZhiyuRecordClass(input);
    return {
      ...inferred,
      runWindowMs: analyzeOperationalContent(input)
        ? ZHIYU_MEMORY_RULES.operationalWindowMs
        : ZHIYU_MEMORY_RULES.checkpointWindowMs,
      reviewDefaultDays: ZHIYU_MEMORY_RULES.lessonDefaultDays,
      reviewMaxDays: ZHIYU_MEMORY_RULES.lessonMaxDays,
      reviewRequired: true,
    };
  },
});
