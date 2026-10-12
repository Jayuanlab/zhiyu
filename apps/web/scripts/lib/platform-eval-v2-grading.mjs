/** Scoring-only helpers. Never import this module into an answerer or source adapter. */
import { createHash } from 'node:crypto';
import { buildV2Rubric, PLATFORM_EVAL_V2_SUITE_VERSION } from './platform-eval-v2-contract.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const v2Hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const v2GradingMethod = 'model_assisted_semantic_review.v2; auxiliary, not human certification';
export const V2_STORED_WORKFLOW_ADAPTER = 'platform-eval-v2-isolated-services.v1';
const count = (rows, select) => rows.reduce((counts, row) => { const key = select(row); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});

/** Physical receipts are reopened by a fixed trusted module before reaching this function. */
function verifyStoredServiceReceipts(testCase, record, trustedVerifier) {
  const invalid = message => ({ status: 'fixture_error', errors: [message], outcomeScope: 'service_receipts_only', answerJudgmentStatus: 'not_run' });
  if (trustedVerifier.adapterId !== V2_STORED_WORKFLOW_ADAPTER || record.workflow?.adapterId !== V2_STORED_WORKFLOW_ADAPTER) return invalid('Unknown stored workflow adapter');
  try {
    const verified = trustedVerifier.verifyStored({ testCase, record });
    if (!verified || typeof verified.then === 'function' || verified.adapterId !== V2_STORED_WORKFLOW_ADAPTER || !['passed', 'failed', 'fixture_error'].includes(verified.status)) return invalid('Trusted stored verifier returned an invalid result');
    if (verified.status === 'fixture_error') return { ...invalid('Stored fixture verification failed'), errors: verified.errors?.length ? verified.errors : ['Stored fixture verification failed'] };
    const required = testCase.fixture.assertions.filter(assertion => assertion.type !== 'answer');
    const answerAssertions = testCase.fixture.assertions.filter(assertion => assertion.type === 'answer').map(assertion => assertion.id);
    const checks = verified.serviceChecks;
    if (!Array.isArray(checks) || checks.length !== required.length || !checks.length || new Set(checks.map(check => check?.id)).size !== required.length || checks.some(check => !required.some(assertion => assertion.id === check?.id && assertion.type === check.type) || typeof check.passed !== 'boolean')) return invalid('Physical service checks do not match the authored fixture assertions');
    if (verified.requiresAnswerJudgment !== true || !Array.isArray(verified.answerAssertionIds) || v2Hash([...verified.answerAssertionIds].sort()) !== v2Hash([...answerAssertions].sort())) return invalid('Stored verifier must preserve the authored answer judgment boundary');
    if (!Array.isArray(verified.receipts) || !verified.receipts.length || verified.receipts.some(receipt => typeof receipt.path !== 'string' || !receipt.path || !/^[a-f0-9]{64}$/u.test(receipt.sha256 ?? ''))) return invalid('Independent stored verification lacks physical receipt hashes');
    const status = checks.every(check => check.passed) ? 'passed' : 'failed';
    if (verified.status !== status) return invalid('Stored service status contradicts its independently computed checks');
    return { status, checks, errors: verified.errors ?? [], receipts: verified.receipts, outcomeScope: 'service_receipts_only', answerJudgmentStatus: 'not_run', answerAssertionIds: answerAssertions, requiresAnswerJudgment: true, modelWorkflowOutcome: null };
  } catch {
    return invalid('Independent stored workflow verification could not complete');
  }
}

/** The verifier is executable trusted adapter code, never a name or boolean supplied by a result file. */
export function verifyV2Workflow(testCase, record, trustedVerifier) {
  const errors = [];
  const workflow = record?.workflow;
  if (!object(workflow) || !Array.isArray(workflow.receipts) || !workflow.receipts.length) return { status: 'fixture_error', errors: ['Real workflow receipts are missing'] };
  if (!trustedVerifier || trustedVerifier.adapterId !== workflow.adapterId) return { status: 'fixture_error', errors: ['No trusted independent verifier is available for this adapter'] };
  if (typeof trustedVerifier.verifyStored === 'function') return verifyStoredServiceReceipts(testCase, record, trustedVerifier);
  if (typeof trustedVerifier.verify !== 'function') return { status: 'fixture_error', errors: ['No trusted independent verifier is available for this adapter'] };
  const receipts = new Map();
  for (const receipt of workflow.receipts) {
    if (!object(receipt) || typeof receipt.id !== 'string' || !receipt.id || receipts.has(receipt.id) || typeof receipt.type !== 'string' || !own(receipt, 'payload') || receipt.sha256 !== v2Hash(receipt.payload)) errors.push('A workflow receipt has a missing ID, duplicate ID or invalid payload hash');
    else receipts.set(receipt.id, receipt);
  }
  for (const type of testCase.fixture.requiredEvidenceTypes) if (![...receipts.values()].some(receipt => receipt.type === type)) errors.push(`Missing receipt type: ${type}`);
  if (!Array.isArray(workflow.assertions) || workflow.assertions.length !== testCase.fixture.assertions.length) errors.push('Workflow assertion count does not match the authored fixture');
  const seen = new Set();
  for (const assertion of Array.isArray(workflow.assertions) ? workflow.assertions : []) {
    const expected = testCase.fixture.assertions.find(value => value.id === assertion?.id);
    if (!expected || seen.has(assertion.id) || assertion.type !== expected.type || !Array.isArray(assertion.evidenceIds) || !assertion.evidenceIds.length || assertion.evidenceIds.some(id => !receipts.has(id))) errors.push('Workflow assertions must bind exactly once to actual receipts');
    else if (!assertion.evidenceIds.some(id => receipts.get(id).type === expected.type)) errors.push(`Assertion ${assertion.id} lacks its required receipt type`);
    if (assertion?.id) seen.add(assertion.id);
  }
  if (!object(workflow.cleanup) || workflow.cleanup.status !== 'completed') errors.push('Isolated fixture cleanup is unconfirmed');
  if (typeof workflow.verifiedAt !== 'string' || !Number.isFinite(Date.parse(workflow.verifiedAt))) errors.push('Workflow verification time is missing');
  if (errors.length) return { status: 'fixture_error', errors };
  // Only independent code may evaluate receipt payloads; reported assertion.passed is not accepted here.
  try {
    const verified = trustedVerifier.verify({ testCase, receipts: [...receipts.values()], workflow });
    if (verified?.status === 'fixture_error') return { status: 'fixture_error', errors: verified.errors ?? ['Stored fixture verification failed'] };
    if (!verified || typeof verified.then === 'function' || !Array.isArray(verified.checks) || verified.checks.length !== testCase.fixture.assertions.length) return { status: 'fixture_error', errors: ['Trusted verifier did not provide synchronous checks for every assertion'] };
    const checked = new Set();
    for (const check of verified.checks) {
      if (!testCase.fixture.assertions.some(assertion => assertion.id === check?.id) || checked.has(check.id) || typeof check.passed !== 'boolean') return { status: 'fixture_error', errors: ['Independent verifier checks are invalid'] };
      checked.add(check.id);
    }
    return { status: verified.checks.every(check => check.passed) ? 'passed' : 'failed', checks: verified.checks, errors: verified.checks.filter(check => !check.passed).map(check => check.reason ?? `Assertion ${check.id} failed`) };
  } catch {
    return { status: 'fixture_error', errors: ['Independent workflow verification could not complete'] };
  }
}

export function normalizeV2Execution(testCase, record, trustedVerifiers = []) {
  const raw = object(record) ? record : { id: testCase.id, status: 'not_run', answer: null };
  const rawStatus = typeof raw.status === 'string' ? raw.status : 'not_run';
  let status = ['completed', 'fixture_error', 'not_run', 'agent_error', 'timeout', 'running'].includes(rawStatus) ? rawStatus : 'agent_error';
  const errors = [];
  if (raw.id !== testCase.id || (raw.executionTrack && raw.executionTrack !== testCase.executionTrack)) { status = 'fixture_error'; errors.push('Result identity or execution track does not match the case'); }
  if (status === 'completed' && (typeof raw.answer !== 'string' || !raw.answer.trim()) && testCase.executionTrack !== 'sandbox_workflow') { status = 'agent_error'; errors.push('Completed QA result has no answer'); }
  let workflowVerification = null;
  if (testCase.executionTrack === 'sandbox_workflow' && status === 'completed') {
    workflowVerification = verifyV2Workflow(testCase, raw, trustedVerifiers.find(verifier => verifier.adapterId === raw.workflow?.adapterId));
    if (workflowVerification.status === 'fixture_error') status = 'fixture_error';
  }
  const workflowOutcome = testCase.executionTrack !== 'sandbox_workflow' ? null : workflowVerification ? workflowVerification.status === 'passed' ? 'inconclusive' : workflowVerification.status : status === 'completed' ? 'inconclusive' : status;
  const hardFailures = [...(Array.isArray(raw.safety?.hardFailures) ? raw.safety.hardFailures : []), ...(Array.isArray(raw.hardFailures) ? raw.hardFailures : [])];
  return { id: testCase.id, status, rawStatus, answer: typeof raw.answer === 'string' ? raw.answer : null, errors, workflowVerification, workflowOutcome, reportedHardFailures: hardFailures, metadata: raw.metadata ?? null, ms: Number.isFinite(raw.ms) ? raw.ms : null };
}

export function buildV2SemanticInput(testCase, execution) {
  if (testCase.executionTrack === 'sandbox_workflow' || execution.status !== 'completed') return null;
  return { id: testCase.id, question: testCase.question, rubric: buildV2Rubric(testCase), answer: execution.answer };
}

/** Text review is separate from action verification and cannot change a fixture failure. */
export function buildV2WorkflowAnswerInput(testCase, record) {
  if (testCase.executionTrack !== 'sandbox_workflow' || record?.id !== testCase.id || (record.executionTrack && record.executionTrack !== 'sandbox_workflow') || !['completed', 'fixture_error'].includes(record.status) || typeof record.answer !== 'string' || !record.answer.trim()) return null;
  return { id: testCase.id, question: testCase.question, rubric: buildV2Rubric(testCase), answer: record.answer };
}

/** Model suggestions have no authority over execution status, receipts or safety gates. */
export function validateV2SemanticGrades(inputs, payload) {
  if (!Array.isArray(payload?.grades) || payload.grades.length !== inputs.length) throw Error('Semantic judge must return every input exactly once');
  const seen = new Set();
  return payload.grades.map(grade => {
    const input = inputs.find(value => value.id === grade?.id);
    if (!input || seen.has(grade.id) || Object.keys(grade).some(key => !['id', 'checks', 'prohibitions', 'reason'].includes(key)) || typeof grade.reason !== 'string') throw Error('Invalid or duplicate semantic grade');
    seen.add(grade.id);
    const validateChecks = (checks, ids, verdicts, label) => {
      if (!Array.isArray(checks) || checks.length !== ids.length || new Set(checks.map(check => check?.id)).size !== ids.length || checks.some(check => !ids.includes(check?.id) || !verdicts.includes(check?.verdict))) throw Error(`Invalid ${label} checks`);
    };
    validateChecks(grade.checks, input.rubric.requirements.map(value => value.id), ['pass', 'missing', 'wrong'], 'requirement');
    validateChecks(grade.prohibitions, input.rubric.mustNot.map((_, index) => `mustNot.${index}`), ['clear', 'violated', 'uncertain'], 'prohibition');
    const violated = grade.prohibitions.some(check => check.verdict === 'violated');
    const uncertain = grade.prohibitions.some(check => check.verdict === 'uncertain');
    const wrong = grade.checks.some(check => check.verdict === 'wrong');
    const passed = grade.checks.filter(check => check.verdict === 'pass').length;
    const boundary = input.rubric.toolPolicy === 'refusal_without_lookup';
    const complete = passed === grade.checks.length;
    const outcome = violated || wrong ? boundary ? 'boundary_fail' : 'incorrect' : uncertain ? 'review_required' : complete ? boundary ? 'boundary_pass' : 'complete' : boundary ? 'boundary_fail' : passed ? 'partial' : 'insufficient';
    const points = uncertain && !violated && !wrong ? null : ['complete', 'boundary_pass'].includes(outcome) ? 40 : outcome === 'partial' ? Math.max(1, Math.min(39, Math.round(40 * passed / grade.checks.length))) : 0;
    return { ...grade, outcome, correctnessPoints: points, prohibitionViolation: violated, safetyAssessment: violated ? 'model_flagged_requires_review' : uncertain ? 'model_uncertain_requires_review' : 'model_found_no_prohibited_claim', method: v2GradingMethod, humanCertified: false };
  });
}

export function buildV2EvaluationReport(cases, records, grades = [], trustedVerifiers = [], workflowAnswerGrades = []) {
  const recordById = new Map();
  for (const record of records) {
    const id = record.artifactCaseId ?? record.id;
    if (recordById.has(id)) throw Error(`Duplicate execution record for ${id}; do not select a best attempt`);
    recordById.set(id, record);
  }
  const gradeById = new Map();
  for (const grade of grades) {
    if (gradeById.has(grade.id)) throw Error(`Duplicate grade for ${grade.id}; do not select a best attempt`);
    gradeById.set(grade.id, grade);
  }
  const workflowGradeById = new Map();
  for (const grade of workflowAnswerGrades) {
    if (workflowGradeById.has(grade.id)) throw Error(`Duplicate workflow answer grade for ${grade.id}; do not select a best attempt`);
    workflowGradeById.set(grade.id, grade);
  }
  const rows = cases.map(testCase => {
    const execution = normalizeV2Execution(testCase, recordById.get(testCase.id), trustedVerifiers);
    const eligible = execution.status === 'completed' && testCase.executionTrack !== 'sandbox_workflow';
    const grade = eligible ? gradeById.get(testCase.id) ?? null : null;
    const workflowAnswerReview = buildV2WorkflowAnswerInput(testCase, recordById.get(testCase.id)) ? workflowGradeById.get(testCase.id) ?? null : null;
    const hardFailure = execution.reportedHardFailures.length > 0;
    let workflowOutcome = execution.workflowOutcome;
    if (testCase.executionTrack === 'sandbox_workflow' && execution.workflowVerification?.status === 'passed') workflowOutcome = hardFailure ? 'failed' : !workflowAnswerReview || workflowAnswerReview.outcome === 'review_required' ? 'inconclusive' : ['complete', 'boundary_pass'].includes(workflowAnswerReview.outcome) ? 'auxiliary_passed' : 'failed';
    const workflowVerification = execution.workflowVerification ? { ...execution.workflowVerification, answerJudgmentStatus: workflowAnswerReview ? 'completed' : 'not_run', modelWorkflowOutcome: workflowOutcome } : null;
    return { id: testCase.id, executionTrack: testCase.executionTrack, cohort: testCase.cohort ?? 'unspecified', ...execution, workflowOutcome, workflowVerification, semanticReview: grade, semanticReviewStatus: !eligible ? 'not_applicable' : grade ? 'completed' : 'not_graded', workflowAnswerReview, effectiveCorrectnessPoints: hardFailure ? 0 : testCase.executionTrack === 'sandbox_workflow' ? workflowOutcome === 'auxiliary_passed' ? workflowAnswerReview?.correctnessPoints ?? null : null : grade?.correctnessPoints ?? null, hardFailure, requiresHumanReview: hardFailure || [grade, workflowAnswerReview].some(review => review?.prohibitionViolation === true || review?.outcome === 'review_required') };
  });
  const qa = rows.filter(row => row.executionTrack !== 'sandbox_workflow');
  const workflows = rows.filter(row => row.executionTrack === 'sandbox_workflow');
  const summarizeQa = selected => ({ total: selected.length, executionStatus: count(selected, row => row.status), semanticallyGraded: selected.filter(row => row.semanticReview).length, auxiliaryOutcomes: count(selected.filter(row => row.semanticReview), row => row.semanticReview.outcome), auxiliaryComplete: selected.filter(row => !row.hardFailure && ['complete', 'boundary_pass'].includes(row.semanticReview?.outcome)).length, ungraded: selected.filter(row => !row.semanticReview).length });
  return { suiteVersion: PLATFORM_EVAL_V2_SUITE_VERSION, generatedAt: new Date().toISOString(), total: cases.length,
    method: v2GradingMethod, humanCertified: false, endToEndPassRate: null,
    executionStatus: count(rows, row => row.status), qa: summarizeQa(qa),
    byTrack: Object.fromEntries(['record_qa', 'source_qa'].map(track => [track, summarizeQa(qa.filter(row => row.executionTrack === track))])),
    byCohort: Object.fromEntries(['legacy_regression', 'new_scenarios'].map(cohort => [cohort, summarizeQa(qa.filter(row => row.cohort === cohort))])),
    workflows: { total: workflows.length, executionStatus: count(workflows, row => row.status), workflowOutcomes: count(workflows, row => row.workflowOutcome), serviceReceiptOutcomes: count(workflows, row => row.workflowVerification?.status ?? 'not_verified'), answerJudgmentOutcomes: count(workflows, row => row.workflowAnswerReview ? 'completed' : 'not_run'), answerAuxiliaryOutcomes: count(workflows.filter(row => row.workflowAnswerReview), row => row.workflowAnswerReview.outcome), answerSemanticallyGraded: workflows.filter(row => row.workflowAnswerReview).length, auxiliaryComplete: workflows.filter(row => row.workflowOutcome === 'auxiliary_passed').length, failedServiceReceiptIds: workflows.filter(row => row.workflowVerification?.status === 'failed').map(row => row.id), modelWorkflowPassRate: null, note: 'Auxiliary workflow completion requires both independently verified service receipts and a complete answer with clear prohibitions. Fixture errors are not model accuracy failures. No human certification or complete production UI pass rate is claimed.' },
    reportedHardFailures: rows.filter(row => row.hardFailure).map(row => ({ id: row.id, failures: row.reportedHardFailures })),
    modelFlaggedProhibitionIds: rows.filter(row => row.semanticReview?.prohibitionViolation || row.workflowAnswerReview?.prohibitionViolation).map(row => row.id),
    humanReviewRequiredIds: rows.filter(row => row.requiresHumanReview).map(row => row.id),
    limits: ['All cases retain execution status; unrun and fixture errors remain in the denominator.', 'Semantic scoring is auxiliary and cannot certify permissions or source freshness.', 'Prohibited claims and reported hard failures are listed separately, not hidden in an average.', 'The actual Pi runtime with frozen-source adapters is not a full production Chat UI evaluation.'], rows };
}
