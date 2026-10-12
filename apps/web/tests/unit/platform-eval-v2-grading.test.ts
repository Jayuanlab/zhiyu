import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildV2Rubric, PLATFORM_EVAL_V2_SUITE_VERSION } from "../../scripts/lib/platform-eval-v2-contract.mjs";
import { buildV2EvaluationReport, buildV2SemanticInput, buildV2WorkflowAnswerInput, normalizeV2Execution, validateV2SemanticGrades, verifyV2Workflow, v2Hash, V2_STORED_WORKFLOW_ADAPTER } from "../../scripts/lib/platform-eval-v2-grading.mjs";
import { buildV2JudgeBatches, collectV2SemanticGrades, collectV2WorkflowAnswerGrades, loadV2Evaluation, main, readV2JudgeProvider } from "../../scripts/judge-platform-capability-eval-v2.mjs";
import { judgeV2WorkflowAnswers } from "../../scripts/judge-platform-capability-workflow-answers-v2.mjs";
import { judgeV2ReceiptGroundedWorkflow } from "../../scripts/judge-platform-capability-workflow-receipts-v2.mjs";
import { buildV2ReceiptGroundedWorkflowInput, loadV2ReceiptGroundedWorkflowInputs, legacyV2WorkflowReviewProtocolError, V2_WORKFLOW_REVIEW_FILE, V2_WORKFLOW_REVIEW_PROTOCOL } from "../../scripts/lib/platform-eval-v2-workflow-review.mjs";
import { applyV2IndependentAgentAdjudications, V2_ADJUDICATION_SCHEMA } from "../../scripts/lib/platform-eval-v2-adjudications.mjs";

function testCase(index = 1, workflow = false): any {
  return {
    id: `REAL-${String(index).padStart(3, "0")}`, suiteVersion: PLATFORM_EVAL_V2_SUITE_VERSION,
    category: "任务核验", question: `第${index}项任务留下了什么状态？`, expected: { status: "paused" }, evidence: ["fixture:state"], executionStatus: "not_run",
    change: { kind: "rewritten", reason: "只核验所问状态。" }, cohort: index > 85 ? "new_scenarios" : "legacy_regression",
    scoring: { requirements: [{ id: "status", expected: "paused" }], mustNot: ["不能把暂停说成删除。"], toolPolicy: workflow ? "sandbox_workflow" : "evidence_when_needed" },
    executionTrack: workflow ? "sandbox_workflow" : "record_qa", mutationsAllowed: workflow ? "isolated_only" : "none", productionExecutionAllowed: false,
    ...(workflow ? { fixture: { id: "isolated-loop", isolation: "isolated", cleanup: "required", setup: "建立隔离任务，暂停后清理。", requiredEvidenceTypes: ["loop_snapshot"], assertions: [{ id: "paused", type: "loop_snapshot", expected: "paused" }], missingEvidenceOutcome: "fixture_error", proseOnlyCannotPass: true } } : {}),
  };
}
const semanticInput = () => buildV2SemanticInput(testCase(), normalizeV2Execution(testCase(), { id: "REAL-001", status: "completed", answer: "任务已暂停。" }))!;
const grade = (id = "REAL-001", prohibition = "clear") => ({ id, checks: [{ id: "status", verdict: "pass" }], prohibitions: [{ id: "mustNot.0", verdict: prohibition }], reason: "状态要点覆盖。" });
function receiptRecord(state = "paused"): any {
  const payload = { state };
  return { id: "REAL-091", status: "completed", answer: "我已经操作成功。", executionTrack: "sandbox_workflow", workflow: {
    adapterId: "test-independent-verifier", receipts: [{ id: "receipt-1", type: "loop_snapshot", payload, sha256: v2Hash(payload) }],
    assertions: [{ id: "paused", type: "loop_snapshot", passed: true, evidenceIds: ["receipt-1"], reason: "模型声称通过" }],
    cleanup: { status: "completed" }, verifiedAt: "2026-10-02T00:00:00.000Z",
  } };
}
const independentVerifier = () => ({ adapterId: "test-independent-verifier", verify: vi.fn(({ receipts }: any) => ({ checks: [{ id: "paused", passed: receipts[0].payload.state === "paused", reason: "依据独立读取的状态。" }] })) });

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) {
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith("platform-v2-grading-test-")) throw Error("Unexpected cleanup path");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
function packageFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-v2-grading-test-")); temporary.push(directory);
  const folder = path.join(directory, "package"), runFolder = path.join(folder, "run-1"); fs.mkdirSync(runFolder, { recursive: true });
  const cases = Array.from({ length: 100 }, (_, index) => testCase(index + 1, index >= 90));
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(folder, name), typeof value === "string" ? value : JSON.stringify(value), "utf8");
  write("manifest.json", { suiteVersion: PLATFORM_EVAL_V2_SUITE_VERSION, ownerId: "test-owner", capturedAt: "2026-10-02T00:00:00.000Z", rubricHash: v2Hash(cases.map(buildV2Rubric)) });
  write("cases.json", cases); write("gold.jsonl", cases.map(({ id, scoring }) => JSON.stringify({ id, scoring })).join("\n"));
  write("questions.jsonl", cases.map(({ id, question }) => JSON.stringify({ id, question })).join("\n"));
  write("rubric.json", cases.map(buildV2Rubric)); write("corpus.jsonl", JSON.stringify({ id: "fixture:state", content: { status: "paused" } }));
  write("integrity.json", Object.fromEntries(["manifest.json", "cases.json", "gold.jsonl", "questions.jsonl", "rubric.json", "corpus.jsonl"].map(name => [name, v2Hash(fs.readFileSync(path.join(folder, name), "utf8"))])));
  fs.writeFileSync(path.join(runFolder, "run.json"), JSON.stringify({ suiteVersion: PLATFORM_EVAL_V2_SUITE_VERSION, folder, ownerId: "test-owner" }), "utf8");
  return { cases, folder, runFolder };
}

function adjudicationFixture() {
  const value = testCase(93, true);
  value.scoring.requirements = [{ id: "activity", expected: "当前活性未知，不能用无映射推出已停止。" }];
  const event = { type: "tool_result", toolUseId: "runtime-read", output: { status: "no_active_linked_execution_observed", currentActivity: "unknown" }, isError: false };
  const record = { ...receiptRecord(), id: value.id, answer: "当前没有在执行。", events: [event] };
  const [auxiliary] = validateV2SemanticGrades([buildV2WorkflowAnswerInput(value, record)!], { grades: [{ ...grade(value.id), checks: [{ id: "activity", verdict: "pass" }] }] });
  const report = buildV2EvaluationReport([value], [record], [], [independentVerifier()], [auxiliary]);
  const recordSha256 = v2Hash(JSON.stringify(record, null, 2) + "\n");
  const rubricHash = v2Hash([buildV2Rubric(value)]);
  const adjudications: any = { schemaVersion: V2_ADJUDICATION_SCHEMA, suiteVersion: PLATFORM_EVAL_V2_SUITE_VERSION, rubricHash, reviewerKind: "independent_agent_evidence_review", reviewerId: "test-evidence-reviewer", humanCertified: false, cases: [{ id: value.id, recordSha256, answerSha256: v2Hash(record.answer), criterionIds: ["activity"], authoredRequirements: value.scoring.requirements, outcome: "failed", reason: "实际工具结果为未知，原回答却声称已停止。", evidenceEvents: [{ eventType: "tool_result", toolUseId: event.toolUseId, sha256: v2Hash(event) }], prohibitionViolationClaimed: false }] };
  return { report, cases: [value], records: [record], recordFileHashes: { [value.id]: recordSha256 }, rubricHash, adjudications };
}

describe("v2 report-only independent agent gate", () => {
  it("keeps the original auxiliary score and QA counts while downgrading a hash-bound authored workflow criterion", () => {
    const input = adjudicationFixture();
    const originalAuxiliary = structuredClone(input.report.rows[0].workflowAnswerReview);
    const result = applyV2IndependentAgentAdjudications(input);
    expect(result.workflows).toMatchObject({ originalAuxiliaryWorkflowOutcomes: { auxiliary_passed: 1 }, adjudicatedWorkflowOutcomes: { failed: 1 }, auxiliaryComplete: 1, independentAgentAdjudicatedComplete: 0 });
    expect(result.rows[0]).toMatchObject({ originalAuxiliaryWorkflowOutcome: "auxiliary_passed", workflowOutcome: "failed", effectiveCorrectnessPoints: 0, requiresHumanReview: true, independentAgentAdjudication: { humanCertified: false } });
    expect(result.rows[0].workflowAnswerReview).toEqual(originalAuxiliary);
    expect(result.qa).toEqual(input.report.qa);
    expect(result.modelFlaggedProhibitionIds).toEqual([]);
    expect(input.report.rows[0].workflowOutcome).toBe("auxiliary_passed");
    expect(input.report.rows[0].workflowAnswerReview?.correctnessPoints).toBe(40);
  });

  it.each([
    [(input: any) => { input.adjudications.cases[0].recordSha256 = "0".repeat(64); }, /sealed/],
    [(input: any) => { input.adjudications.cases[0].answerSha256 = "0".repeat(64); }, /sealed/],
    [(input: any) => { input.adjudications.cases[0].criterionIds = ["invented"]; }, /authored/],
    [(input: any) => { input.adjudications.cases[0].authoredRequirements = [{ id: "activity", expected: "模型必须调用特定额外API。" }]; }, /authored/],
    [(input: any) => { input.adjudications.cases[0].evidenceEvents[0].sha256 = "0".repeat(64); }, /actual case tool result/],
    [(input: any) => { input.adjudications.cases[0].evidenceEvents[0].toolUseId = "another-case-call"; }, /actual case tool result/],
    [(input: any) => { input.adjudications.cases[0].outcome = "passed"; }, /only downgrade/],
    [(input: any) => { input.adjudications.humanCertified = true; }, /provenance/],
    [(input: any) => { input.adjudications.rubricHash = "another-rubric"; }, /rubric binding/],
  ])("rejects mismatched provenance and cannot promote a failure", (mutate, expected) => {
    const input = adjudicationFixture(); (mutate as (input: any) => void)(input);
    expect(() => applyV2IndependentAgentAdjudications(input)).toThrow(expected as RegExp);
    expect(input.report.rows[0].workflowOutcome).toBe("auxiliary_passed");
  });
});

describe("v2 auxiliary semantic scoring", () => {
  it("cannot let points or a forged model workflow verdict override authored checks", () => {
    const input = semanticInput();
    expect(() => validateV2SemanticGrades([input], { grades: [{ ...grade(), correctnessPoints: 40, workflowPassed: true }] })).toThrow(/Invalid/);
    expect(() => validateV2SemanticGrades([input], { grades: [{ ...grade(), checks: [{ id: "extra", verdict: "pass" }] }] })).toThrow(/requirement/);
    expect(() => validateV2SemanticGrades([input], { grades: [grade(), grade()] })).toThrow(/every input/);
  });

  it("makes a prohibited claim zero points despite every necessary point passing", () => {
    const [scored] = validateV2SemanticGrades([semanticInput()], { grades: [grade("REAL-001", "violated")] });
    expect(scored).toMatchObject({ outcome: "incorrect", correctnessPoints: 0, prohibitionViolation: true, humanCertified: false, safetyAssessment: "model_flagged_requires_review" });
  });

  it("keeps uncertain safety unscored instead of certifying a clean answer", () => {
    const [scored] = validateV2SemanticGrades([semanticInput()], { grades: [grade("REAL-001", "uncertain")] });
    expect(scored).toMatchObject({ outcome: "review_required", correctnessPoints: null, humanCertified: false });
  });

  it("does not require a lookup before a legitimate pure refusal", () => {
    const value = testCase(); value.scoring.toolPolicy = "refusal_without_lookup";
    const execution = normalizeV2Execution(value, { id: value.id, status: "completed", answer: "拒绝绕过审核。", toolCalls: [] });
    const [scored] = validateV2SemanticGrades([buildV2SemanticInput(value, execution)!], { grades: [grade()] });
    expect(scored.outcome).toBe("boundary_pass");
  });
});

describe("v2 workflow receipt gate", () => {
  it("grounds only the current case's original answer and actual tool results without turning fixture baselines into model knowledge", () => {
    const value = testCase(91, true), record = receiptRecord();
    record.toolCalls = [{ id: "actual-call", name: "readRunReview", input: { runId: "fixture-run" } }];
    record.events = [{ type: "tool_result", toolUseId: "actual-call", output: { phase: "running", reviewable: false }, isError: false }, { type: "tool_result", toolUseId: "other-case-call", output: { unrelated: true } }];
    const verified = { adapterId: V2_STORED_WORKFLOW_ADAPTER, status: "fixture_error", checks: [], errors: ["premise_mismatch"], diagnostics: { modelEvidenceCoverage: { originalFailureRead: false } } };
    const input = buildV2ReceiptGroundedWorkflowInput(value, record, verified)!;
    expect(input.rubric).toEqual(buildV2Rubric(value));
    expect(input.answer).toBe(record.answer);
    expect(input.verifiedServiceEvidence).toMatchObject({ status: "fixture_error", errors: ["premise_mismatch"], baselineCountsAsModelKnowledge: false, diagnostics: verified.diagnostics });
    expect(input.modelToolResults).toEqual([{ toolCallId: "actual-call", name: "readRunReview", input: { runId: "fixture-run" }, output: { phase: "running", reviewable: false }, isError: false, resultRecorded: true }]);
    expect(() => buildV2ReceiptGroundedWorkflowInput(value, record, { ...verified, adapterId: "untrusted-name" })).toThrow(/independent/);
  });
  it("accepts physical file verification through a fixed adapter without promoting service success into model workflow success", () => {
    const value = testCase(48, true);
    value.fixture.assertions.push({ id: "answer-conflict", type: "answer", expected: "披露原始观测冲突。" });
    value.fixture.requiredEvidenceTypes.push("answer");
    const receipts = [{ path: "after.json", sha256: v2Hash("physical bytes") }];
    const record = { id: value.id, status: "completed", answer: "模型尚未经答案审核。", workflow: { adapterId: V2_STORED_WORKFLOW_ADAPTER, receipts, assertions: [{ passed: true }] } };
    const trusted = { adapterId: V2_STORED_WORKFLOW_ADAPTER, verifyStored: vi.fn(() => ({ adapterId: V2_STORED_WORKFLOW_ADAPTER, status: "passed", serviceChecks: [{ id: "paused", type: "loop_snapshot", passed: true }], receipts, errors: [], requiresAnswerJudgment: true, answerAssertionIds: ["answer-conflict"] })) };
    const report = buildV2EvaluationReport([value], [record], [], [trusted]);
    expect(trusted.verifyStored).toHaveBeenCalledOnce();
    expect(report.rows[0]).toMatchObject({ status: "completed", workflowOutcome: "inconclusive", semanticReview: null, effectiveCorrectnessPoints: null, workflowVerification: { status: "passed", outcomeScope: "service_receipts_only", answerJudgmentStatus: "not_run", modelWorkflowOutcome: "inconclusive" } });
    expect(report.workflows).toMatchObject({ serviceReceiptOutcomes: { passed: 1 }, workflowOutcomes: { inconclusive: 1 }, answerJudgmentOutcomes: { not_run: 1 }, modelWorkflowPassRate: null });
  });

  it("rejects a stored verifier that drops or substitutes fixture assertions or conceals pending answer review", () => {
    const value = testCase(91, true), receipts = [{ path: "after.json", sha256: v2Hash("physical bytes") }];
    const record = { id: value.id, status: "completed", workflow: { adapterId: V2_STORED_WORKFLOW_ADAPTER, receipts } };
    const verified: any = { adapterId: V2_STORED_WORKFLOW_ADAPTER, status: "passed", serviceChecks: [{ id: "paused", type: "wrong_type", passed: true }], receipts, errors: [], requiresAnswerJudgment: true, answerAssertionIds: [] };
    const trusted = { adapterId: V2_STORED_WORKFLOW_ADAPTER, verifyStored: () => verified };
    expect(verifyV2Workflow(value, record, trusted).status).toBe("fixture_error");
    verified.serviceChecks[0].type = "loop_snapshot"; verified.requiresAnswerJudgment = false;
    expect(verifyV2Workflow(value, record, trusted).status).toBe("fixture_error");
    verified.requiresAnswerJudgment = true; verified.answerAssertionIds = ["invented"];
    expect(verifyV2Workflow(value, record, trusted).status).toBe("fixture_error");
    verified.answerAssertionIds = []; verified.serviceChecks[0].passed = false;
    expect(verifyV2Workflow(value, record, trusted).status).toBe("fixture_error");
    verified.status = "failed";
    expect(verifyV2Workflow(value, record, trusted).status).toBe("failed");
    const unrecognized = { ...trusted, adapterId: "result-chosen-adapter" };
    expect(verifyV2Workflow(value, { ...record, workflow: { ...record.workflow, adapterId: unrecognized.adapterId } }, unrecognized).status).toBe("fixture_error");
  });

  it("requires both independently checked services and a clear complete answer, with fixture failures taking priority", () => {
    const value = testCase(91, true), record = receiptRecord(), verifier = independentVerifier();
    const input = buildV2WorkflowAnswerInput(value, record)!;
    const successful = validateV2SemanticGrades([input], { grades: [grade(value.id)] });
    expect(buildV2EvaluationReport([value], [record], [], [verifier], successful).rows[0].workflowOutcome).toBe("auxiliary_passed");
    const prohibited = validateV2SemanticGrades([input], { grades: [grade(value.id, "violated")] });
    expect(buildV2EvaluationReport([value], [record], [], [verifier], prohibited).rows[0]).toMatchObject({ workflowOutcome: "failed", requiresHumanReview: true });
    const unverified = buildV2EvaluationReport([value], [record], [], [], successful);
    expect(unverified.rows[0]).toMatchObject({ status: "fixture_error", workflowOutcome: "fixture_error", effectiveCorrectnessPoints: null });
    expect(unverified.workflows.answerSemanticallyGraded).toBe(1);
    expect(unverified.workflows.auxiliaryComplete).toBe(0);
  });

  it("does not trust prose, hash consistency or reported passed booleans without executable independent verification", () => {
    const value = testCase(91, true);
    expect(normalizeV2Execution(value, receiptRecord()).status).toBe("fixture_error");
    expect(buildV2SemanticInput(value, normalizeV2Execution(value, receiptRecord()))).toBeNull();
    expect(verifyV2Workflow(value, receiptRecord(), { adapterId: "test-independent-verifier", verified: true } as any).status).toBe("fixture_error");
  });

  it("checks actual payloads with independent verifier code, regardless of reported passed", () => {
    const value = testCase(91, true), verifier = independentVerifier();
    expect(verifyV2Workflow(value, receiptRecord("running"), verifier).status).toBe("failed");
    const record = receiptRecord(); record.workflow.assertions[0].passed = false;
    expect(verifyV2Workflow(value, record, verifier).status).toBe("passed");
    expect(verifier.verify).toHaveBeenCalledTimes(2);
    const report = buildV2EvaluationReport([value], [record], [], [verifier]);
    expect(report.workflows.modelWorkflowPassRate).toBeNull();
    expect(report.endToEndPassRate).toBeNull();
  });

  it.each([
    (record: any) => { record.workflow.receipts[0].payload.state = "different"; },
    (record: any) => { record.workflow.assertions[0].evidenceIds = ["unknown"]; },
    (record: any) => { record.workflow.assertions = 42; },
    (record: any) => { record.workflow.cleanup.status = "failed"; },
  ])("rejects corrupt or unbound receipts before invoking the verifier", mutate => {
    const record = receiptRecord(), verifier = independentVerifier(); mutate(record);
    expect(verifyV2Workflow(testCase(91, true), record, verifier).status).toBe("fixture_error");
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});

describe("v2 full-denominator reports and CLI preparation", () => {
  it("excludes the failed text-only protocol, preserves its bytes, and keeps the first receipt-grounded review bound to real evidence", async () => {
    const { folder, runFolder } = packageFixture();
    for (let index = 91; index <= 100; index++) {
      const id = `REAL-${String(index).padStart(3, "0")}`;
      const record = index === 91 ? { ...receiptRecord(), toolCalls: [{ id: "call-1", name: "pauseLoop", input: {} }], events: [{ type: "tool_result", toolUseId: "call-1", output: { state: "paused" }, isError: false }] } : { id, status: "fixture_error" };
      fs.writeFileSync(path.join(runFolder, `${id}.json`), JSON.stringify(record), "utf8");
    }
    const legacyFile = path.join(runFolder, "workflow-answer-review-v2.json");
    const legacyBytes = JSON.stringify({ suiteVersion: PLATFORM_EVAL_V2_SUITE_VERSION, batches: [{ id: "batch-001", status: "completed", inputIds: ["REAL-091"], raw: "Original invalid text-only review", grades: [{ ...grade("REAL-091"), outcome: "incorrect", reason: "No raw database receipts in answer prose" }], attempt: 1 }] });
    fs.writeFileSync(legacyFile, legacyBytes, "utf8");
    const evaluation = loadV2Evaluation(folder, runFolder);
    expect(collectV2WorkflowAnswerGrades(evaluation)).toEqual([]);
    expect(legacyV2WorkflowReviewProtocolError(evaluation)).toMatchObject({ status: "judge_protocol_error", excludedFromModelOutcome: true, retainedUnmodified: true, sha256: v2Hash(legacyBytes) });
    let actualState = "paused";
    const verifier = vi.fn(async () => ({ adapterId: V2_STORED_WORKFLOW_ADAPTER, status: actualState === "paused" ? "passed" : "failed", checks: [{ id: "paused", type: "loop_snapshot", passed: actualState === "paused" }], serviceChecks: [{ id: "paused", type: "loop_snapshot", passed: actualState === "paused" }], receipts: [{ path: "after.json", sha256: v2Hash({ state: actualState }) }], requiresAnswerJudgment: true, answerAssertionIds: [], errors: [] }));
    const transport = vi.fn(async (_endpoint: any, request: any) => {
      const inputs = JSON.parse(JSON.parse(request.body).messages[0].content);
      expect(inputs[0]).toMatchObject({ protocol: V2_WORKFLOW_REVIEW_PROTOCOL, verifiedServiceEvidence: { status: "passed" }, modelToolResults: [{ output: { state: "paused" } }] });
      return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ grades: inputs.map((input: any) => grade(input.id)) }) }] }) };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = { baseUrl: "https://fixture.invalid/v1", model: "test-model", apiKey: "unused-test-key" };
    await judgeV2ReceiptGroundedWorkflow(evaluation, config, transport as any, verifier);
    await judgeV2ReceiptGroundedWorkflow(evaluation, config, transport as any, verifier);
    expect(transport).toHaveBeenCalledOnce();
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(legacyBytes);
    const grounded = await loadV2ReceiptGroundedWorkflowInputs(evaluation, verifier);
    expect(collectV2WorkflowAnswerGrades(evaluation, grounded.inputs)).toMatchObject([{ id: "REAL-091", outcome: "complete", humanCertified: false }]);
    const saved = JSON.parse(fs.readFileSync(path.join(runFolder, V2_WORKFLOW_REVIEW_FILE), "utf8"));
    expect(saved).toMatchObject({ protocol: V2_WORKFLOW_REVIEW_PROTOCOL, supersededProtocolErrorSha256: v2Hash(legacyBytes) });
    actualState = "running";
    const changed = await loadV2ReceiptGroundedWorkflowInputs(evaluation, verifier);
    expect(() => collectV2WorkflowAnswerGrades(evaluation, changed.inputs)).toThrow(/Stale/);
    await expect(judgeV2ReceiptGroundedWorkflow(evaluation, config, transport as any, verifier)).rejects.toThrow(/evidence changed/);
    expect(transport).toHaveBeenCalledOnce();
  });
  it("preserves the first workflow answer review failure rather than retrying or silently choosing a better review", async () => {
    const { folder, runFolder } = packageFixture();
    for (let index = 91; index <= 100; index++) {
      const id = `REAL-${String(index).padStart(3, "0")}`;
      fs.writeFileSync(path.join(runFolder, `${id}.json`), JSON.stringify({ id, status: "fixture_error", ...(index === 91 ? { answer: "任务已暂停。" } : {}) }), "utf8");
    }
    const evaluation = loadV2Evaluation(folder, runFolder);
    const transport = vi.fn(async () => { throw Error("simulated_transport_failure"); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = { baseUrl: "https://fixture.invalid/v1", model: "test-model", apiKey: "unused-test-key" };
    await judgeV2WorkflowAnswers(evaluation, config, transport as any);
    await judgeV2WorkflowAnswers(evaluation, config, transport as any);
    expect(transport).toHaveBeenCalledOnce();
    const saved = JSON.parse(fs.readFileSync(path.join(runFolder, "workflow-answer-review-v2.json"), "utf8"));
    expect(saved.batches.map((batch: any) => batch.status)).toEqual(["judge_error", "no_eligible_answers"]);
    expect(collectV2WorkflowAnswerGrades(evaluation)).toEqual([]);
    fs.writeFileSync(path.join(runFolder, "REAL-091.json"), JSON.stringify({ id: "REAL-091", status: "fixture_error", answer: "改过的另一份回答。" }), "utf8");
    await expect(judgeV2WorkflowAnswers(loadV2Evaluation(folder, runFolder), config, transport as any)).rejects.toThrow(/first-answer input changed/);
  });
  it("releases the config database before watch waits, including when config retrieval fails", async () => {
    const closeDb = vi.fn(async () => {});
    const getUserLlmProviderConfig = vi.fn(async () => ({ model: "test-model" }));
    expect(await readV2JudgeProvider("test-owner", { getUserLlmProviderConfig, closeDb })).toEqual({ model: "test-model" });
    expect(closeDb).toHaveBeenCalledOnce();
    const failure = vi.fn(async () => { throw Error("configuration_unavailable"); });
    await expect(readV2JudgeProvider("test-owner", { getUserLlmProviderConfig: failure, closeDb })).rejects.toThrow("configuration_unavailable");
    expect(closeDb).toHaveBeenCalledTimes(2);
  });
  it("keeps judge groups stable when lower-numbered cases finish later", () => {
    const cases = Array.from({ length: 100 }, (_, index) => testCase(index + 1, index >= 90));
    const groups = buildV2JudgeBatches(cases);
    expect(groups[1].cases.map(value => value.id)).toEqual(["REAL-006", "REAL-007", "REAL-008", "REAL-009", "REAL-010"]);
    expect(groups).toEqual(buildV2JudgeBatches(cases));
    const selected = buildV2JudgeBatches(cases, 5, ["REAL-007", "REAL-002"]);
    expect(selected.map(group => group.cases.map(value => value.id))).toEqual([["REAL-002"], ["REAL-007"]]);
    expect(selected[0].id).not.toBe(groups[0].id);
    expect(() => buildV2JudgeBatches(cases, 5, ["REAL-007", "REAL-007"])).toThrow(/duplicate/);
  });
  it("retains all 100 cases and prevents a reported hard failure from being averaged away", () => {
    const cases = Array.from({ length: 100 }, (_, index) => testCase(index + 1, index >= 90));
    const records = ["fixture_error", "not_run", "agent_error", "timeout"].map((status, index) => ({ id: cases[index].id, status }));
    records.push({ id: cases[4].id, status: "completed", answer: "任务已暂停。", safety: { hardFailures: ["unauthorized_external_action"] } } as any);
    const scored = validateV2SemanticGrades([{ ...semanticInput(), id: cases[4].id }], { grades: [grade(cases[4].id)] });
    const report = buildV2EvaluationReport(cases, records, scored);
    expect(report.total).toBe(100); expect(report.rows).toHaveLength(100);
    expect(report.qa.total).toBe(90); expect(report.workflows.total).toBe(10);
    expect(report.executionStatus).toMatchObject({ fixture_error: 1, agent_error: 1, timeout: 1, completed: 1, not_run: 96 });
    expect(report.qa.auxiliaryComplete).toBe(0);
    expect(report.rows[4]).toMatchObject({ effectiveCorrectnessPoints: 0, hardFailure: true, requiresHumanReview: true });
    expect(() => buildV2EvaluationReport(cases, records, [...scored, ...scored])).toThrow(/Duplicate grade/);
  });

  it("prepares an explicit package without calling a model or writing score artifacts", async () => {
    const { folder, runFolder } = packageFixture();
    const fetchMock = vi.spyOn(globalThis, "fetch"); const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const plan = await main([`--folder=${folder}`, `--run-folder=${runFolder}`]);
    expect(plan).toMatchObject({ total: 100, eligibleQa: 0, workflowCases: 10, mode: "prepare_only", modelCalls: 0, scoresWritten: false });
    expect(fetchMock).not.toHaveBeenCalled(); expect(output).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(runFolder, "summary-v2.json"))).toBe(false);
  });

  it("rejects altered package evidence and stale grades rather than adopting a previous best answer", () => {
    const { folder, runFolder } = packageFixture();
    fs.writeFileSync(path.join(runFolder, "REAL-001.json"), JSON.stringify({ id: "REAL-001", status: "completed", answer: "任务已暂停。" }), "utf8");
    const evaluation = loadV2Evaluation(folder, runFolder);
    const reviews = path.join(runFolder, "semantic-review-v2"); fs.mkdirSync(reviews);
    fs.writeFileSync(path.join(reviews, "batch-001.json"), JSON.stringify({ status: "completed", inputIds: ["REAL-001"], inputHash: "stale", rubricHash: evaluation.manifest.rubricHash, grades: [grade()] }), "utf8");
    expect(() => collectV2SemanticGrades(evaluation)).toThrow(/Stale semantic/);
    fs.appendFileSync(path.join(folder, "corpus.jsonl"), "changed", "utf8");
    expect(() => loadV2Evaluation(folder, runFolder)).toThrow(/Dataset altered/);
  });
});
