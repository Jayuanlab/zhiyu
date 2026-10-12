import { verifyWorkshopResearchEvidence } from "../lib/workshops/research-evidence-verification";
import type { finalizeWorkshopResearchDelivery } from "../lib/workshops/research-report-delivery";
import type { finalizeWorkshopResearchReaderDelivery } from "../lib/workshops/research-reader-delivery";

type FinalizedResearchDelivery = Awaited<ReturnType<typeof finalizeWorkshopResearchDelivery>> | Awaited<ReturnType<typeof finalizeWorkshopResearchReaderDelivery>>;
type SourceInput = Omit<Parameters<typeof verifyWorkshopResearchEvidence>[0], "report">;

/** Observation only: callers supply disk-validated, same-run source receipts.
 * A missing checkpoint is different from a present but invalid report. */
export async function observeResearchReport(input: {
  capturedOutputPresent: boolean;
  runStatus: string;
  sources: SourceInput;
  expectedCanonicalHash: unknown;
  finalize: () => Promise<FinalizedResearchDelivery>;
}) {
  const sourceCheck = verifyWorkshopResearchEvidence({ ...input.sources, report: undefined });
  const sourceProgress = {
    authority: "observer_derived" as const,
    basis: "same_run_disk_validated_source_receipts" as const,
    contractVersion: sourceCheck.contractVersion,
    coverage: sourceCheck.coverage,
    verifiedEventIds: sourceCheck.verifiedEventIds,
    warnings: sourceCheck.warnings,
  };
  if (!input.capturedOutputPresent) {
    const terminal = ["completed", "failed", "cancelled", "interrupted", "needs_review"].includes(input.runStatus);
    return {
      derivedGate: terminal ? "missing_output_checkpoint" as const : "pending_report" as const,
      derivedVerification: null,
      deliveryVerification: null,
      canonicalPresentation: null,
      deliveryHashMatches: null,
      sourceProgress,
    };
  }
  const delivery = await input.finalize();
  return {
    derivedGate: delivery.verification.status,
    derivedVerification: delivery.verification,
    deliveryVerification: delivery.audit ?? null,
    canonicalPresentation: delivery.result.structured?.presentation ?? null,
    deliveryHashMatches: (delivery.audit?.status === "verified" || delivery.audit?.status === "delivered") && delivery.audit.canonicalHash === input.expectedCanonicalHash,
    sourceProgress,
  };
}
