import type { BrainRecallFeedbackOutcome } from "@/lib/brain/recall-quality";
import type {
  BuildRunEvidenceBundleInput,
  HarnessComponentType,
  RunEvidenceBundle,
  RunEvidenceDiagnosis,
  RunFailureClass,
} from "./types";

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

export function buildRunEvidenceBundle(
  input: BuildRunEvidenceBundleInput,
): RunEvidenceBundle {
  const warnings = [...input.observations.providerWarnings];
  if (input.observations.freshness === "stale") {
    warnings.push("Observation data is stale.");
  }
  if (input.observations.freshness === "unknown") {
    warnings.push("Observation freshness is unknown.");
  }
  if (
    input.evidenceRefs.some((reference) => reference.integrity === "missing")
  ) {
    warnings.push("One or more evidence references are missing.");
  }
  if (
    input.evidenceRefs.some((reference) => reference.integrity === "unverified")
  ) {
    warnings.push("One or more evidence references are unverified.");
  }

  const hasRun = Boolean(input.workRunId || input.loopRunId);
  const hasMissingEvidence = input.evidenceRefs.some(
    (reference) => reference.integrity !== "verified",
  );
  const completeness =
    !hasRun || !input.harnessSnapshotId
      ? "insufficient"
      : input.captureStatus !== "finalized" || hasMissingEvidence
        ? "partial"
        : "complete";

  return {
    interfaceVersion: "run-evidence.v1",
    ...input,
    observations: {
      ...input.observations,
      sourceEventIds: unique(input.observations.sourceEventIds),
      providerWarnings: unique(input.observations.providerWarnings),
    },
    actions: {
      ...input.actions,
      toolNames: unique(input.actions.toolNames),
    },
    evidenceRefs: [...input.evidenceRefs],
    completeness,
    warnings: unique(warnings),
  };
}

function targetTypes(failures: RunFailureClass[]): HarnessComponentType[] {
  const targets: HarnessComponentType[] = [];
  for (const failure of failures) {
    if (
      failure === "data_missing" ||
      failure === "data_stale" ||
      failure === "external_dependency_failure"
    ) {
      targets.push("tool_contract", "context_policy");
    }
    if (
      failure === "access_denied_expected" ||
      failure === "access_grant_gap_confirmed" ||
      failure === "boundary_policy_defect" ||
      failure === "boundary_blocked_expected"
    ) {
      targets.push("middleware_policy");
    }
    if (
      failure === "memory_missing" ||
      failure === "memory_irrelevant" ||
      failure === "memory_stale"
    ) {
      targets.push("memory_profile");
    }
    if (failure === "verification_failure" || failure === "artifact_missing") {
      targets.push("verifier", "loop_spec");
    }
    if (failure === "tool_runtime_failure" || failure === "tool_retry_loop") {
      targets.push("tool_implementation", "loop_spec");
    }
  }
  return unique(targets);
}

export function diagnoseRunEvidence(input: {
  bundle: RunEvidenceBundle;
  recallFeedback?: BrainRecallFeedbackOutcome[];
  ownerConfirmedCrossScopeNeed?: boolean;
}): RunEvidenceDiagnosis {
  const failures: RunFailureClass[] = [];
  const symptoms: string[] = [];
  const feedback = new Set(input.recallFeedback ?? []);

  if (input.bundle.observations.freshness === "stale") {
    failures.push("data_stale");
    symptoms.push("The run used stale observation data.");
  }
  if (input.bundle.observations.sourceEventIds.length === 0) {
    failures.push("data_missing");
    symptoms.push("No source observation event was recorded.");
  }
  if (input.bundle.actions.deniedCount > 0) {
    if (
      feedback.has("missing") &&
      input.ownerConfirmedCrossScopeNeed === true
    ) {
      failures.push("access_grant_gap_confirmed");
      symptoms.push(
        "Missing recall feedback and owner confirmation support a narrow access gap.",
      );
    } else {
      failures.push("access_denied_expected");
      symptoms.push(
        "Access filtering ran; denied counts alone do not prove a missing grant.",
      );
    }
  }
  if (
    feedback.has("missing") ||
    feedback.has("too_narrow") ||
    feedback.has("missed_boundary")
  ) {
    failures.push("memory_missing");
  }
  if (
    feedback.has("irrelevant") ||
    feedback.has("too_broad") ||
    feedback.has("wrong_scope")
  ) {
    failures.push("memory_irrelevant");
  }
  if (feedback.has("stale") || feedback.has("stale_state")) {
    failures.push("memory_stale");
  }
  if (
    input.bundle.outcome.verifierPassed === false ||
    input.bundle.outcome.requiredFieldsMissing.length > 0
  ) {
    failures.push("verification_failure");
    symptoms.push("The run did not satisfy its verifier contract.");
  }
  if (input.bundle.outcome.requiredFieldsMissing.length > 0) {
    failures.push("artifact_missing");
  }
  if (input.bundle.outcome.errorClass === "tool_runtime_failure") {
    failures.push("tool_runtime_failure");
  }
  if (input.bundle.runtime.attemptCount > 2) {
    failures.push("tool_retry_loop");
  }
  if (input.bundle.completeness !== "complete") {
    failures.push("insufficient_evidence");
    symptoms.push(
      "The evidence bundle is not complete enough for a firm root cause.",
    );
  }

  const uniqueFailures = unique(failures);
  return {
    interfaceVersion: "run-diagnosis.v1",
    evidenceBundleId: input.bundle.id,
    status:
      input.bundle.completeness === "complete" ? "completed" : "inconclusive",
    failureClasses: uniqueFailures,
    symptoms: unique(symptoms),
    rootCauseCandidates: uniqueFailures.map(
      (failure) => `Candidate cause: ${failure}`,
    ),
    targetComponentTypes: targetTypes(uniqueFailures),
    confidence: input.bundle.completeness === "complete" ? 80 : 30,
    evidenceRefs: input.bundle.evidenceRefs,
  };
}
