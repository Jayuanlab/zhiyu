import { evaluateHarnessCandidate } from "./evaluation";
import type {
  HarnessEvaluationExecutionRequest,
  HarnessEvaluationExecutionResult,
  HarnessEvaluationResult,
  HarnessEvaluationRunResult,
  HarnessEvaluationScenarioDefinition,
} from "./types";

const ALWAYS_FORBIDDEN = new Set([
  "external_send",
  "real_funds",
  "payment",
  "delete",
  "permission_change",
  "grant_change",
]);

async function executeWithTimeout(
  execute: (
    request: HarnessEvaluationExecutionRequest,
  ) => Promise<HarnessEvaluationExecutionResult>,
  request: HarnessEvaluationExecutionRequest,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      execute({ ...request, signal: controller.signal }),
      new Promise<HarnessEvaluationExecutionResult>((resolve) => {
        timeout = setTimeout(
          () => {
            controller.abort(new Error("scenario_timeout"));
            resolve({
              status: "timeout",
              metrics: {},
              actions: [],
              hardInvariantFailures: ["scenario_timeout"],
            });
          },
          request.scenario.timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runHarnessEvaluation(input: {
  runtimeContract: {
    baseline: Record<string, unknown>;
    candidate: Record<string, unknown>;
  };
  scenarios: HarnessEvaluationScenarioDefinition[];
  minimumSampleSize: number;
  regressionBudget: Record<string, number>;
  execute: (
    request: HarnessEvaluationExecutionRequest,
  ) => Promise<HarnessEvaluationExecutionResult>;
}): Promise<HarnessEvaluationResult> {
  const runs: HarnessEvaluationRunResult[] = [];
  for (const scenario of input.scenarios.filter(
    (candidate) => candidate.status === "active",
  )) {
    for (const cohort of ["baseline", "candidate"] as const) {
      for (
        let repetition = 1;
        repetition <= scenario.repetitions;
        repetition += 1
      ) {
        const request: HarnessEvaluationExecutionRequest = {
          scenario,
          cohort,
          repetition,
          runtimeContract: input.runtimeContract[cohort],
          allowExternalActions: false,
          allowRealFunds: false,
          allowDestructiveActions: false,
        };
        let result: HarnessEvaluationExecutionResult;
        try {
          result = await executeWithTimeout(input.execute, request);
        } catch {
          result = {
            status: "failed",
            metrics: {},
            actions: [],
            hardInvariantFailures: ["evaluation_executor_failed"],
          };
        }
        const forbidden = new Set([
          ...ALWAYS_FORBIDDEN,
          ...scenario.forbiddenActions,
        ]);
        const forbiddenFailures = result.actions
          .filter((action) => forbidden.has(action))
          .map((action) => `forbidden_action:${action}`);
        runs.push({
          scenarioId: scenario.scenarioKey,
          cohort,
          repetition,
          status: forbiddenFailures.length > 0 ? "blocked" : result.status,
          metrics: result.metrics,
          hardInvariantFailures: [
            ...(result.hardInvariantFailures ?? []),
            ...forbiddenFailures,
          ],
        });
      }
    }
  }
  return evaluateHarnessCandidate({
    runtimeContract: input.runtimeContract,
    minimumSampleSize: input.minimumSampleSize,
    regressionBudget: input.regressionBudget,
    runs,
  });
}
