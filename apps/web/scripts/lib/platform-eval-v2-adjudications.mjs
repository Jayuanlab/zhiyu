/** Report-only agent review gate. It never edits an answer or an auxiliary grade. */
import { v2Hash } from './platform-eval-v2-grading.mjs';
import { PLATFORM_EVAL_V2_SUITE_VERSION } from './platform-eval-v2-contract.mjs';

export const V2_ADJUDICATION_SCHEMA = 'platform-independent-agent-adjudications.v1';
const counts = rows => rows.reduce((result, row) => { result[row.workflowOutcome] = (result[row.workflowOutcome] ?? 0) + 1; return result; }, {});

export function applyV2IndependentAgentAdjudications({ report, cases, records, recordFileHashes, adjudications, rubricHash }) {
  const output = structuredClone(report);
  const original = { ...report.workflows.workflowOutcomes };
  output.workflows.originalAuxiliaryWorkflowOutcomes = original;
  output.workflows.adjudicatedWorkflowOutcomes = { ...original };
  output.workflows.independentAgentAdjudicatedComplete = report.workflows.auxiliaryComplete;
  output.independentAgentAdjudications = { applied: false, humanCertified: false, cases: [] };
  if (!adjudications) return output;
  if (adjudications.schemaVersion !== V2_ADJUDICATION_SCHEMA || adjudications.suiteVersion !== PLATFORM_EVAL_V2_SUITE_VERSION || adjudications.rubricHash !== rubricHash || adjudications.reviewerKind !== 'independent_agent_evidence_review' || typeof adjudications.reviewerId !== 'string' || !adjudications.reviewerId.trim() || adjudications.humanCertified !== false || !Array.isArray(adjudications.cases)) throw Error('Invalid independent agent adjudication provenance or rubric binding');
  const seen = new Set();
  for (const entry of adjudications.cases) {
    const testCase = cases.find(testCase => testCase.id === entry?.id);
    const record = records.find(record => (record.artifactCaseId ?? record.id) === entry?.id);
    const row = output.rows.find(row => row.id === entry?.id);
    if (!testCase || testCase.executionTrack !== 'sandbox_workflow' || !record || !row || seen.has(entry.id) || entry.outcome !== 'failed' || row.workflowOutcome !== 'auxiliary_passed' || typeof entry.reason !== 'string' || !entry.reason.trim() || entry.prohibitionViolationClaimed !== false) throw Error('Agent adjudication can only downgrade a previously auxiliary-passed workflow against an explicit criterion');
    seen.add(entry.id);
    if (!/^[a-f0-9]{64}$/u.test(entry.recordSha256 ?? '') || !/^[a-f0-9]{64}$/u.test(entry.answerSha256 ?? '') || entry.recordSha256 !== recordFileHashes?.[entry.id] || entry.answerSha256 !== v2Hash(record.answer)) throw Error('Independent adjudication does not match the sealed original record or answer hash');
    if (!Array.isArray(entry.criterionIds) || !entry.criterionIds.length || new Set(entry.criterionIds).size !== entry.criterionIds.length || !Array.isArray(entry.authoredRequirements) || entry.authoredRequirements.length !== entry.criterionIds.length) throw Error('Independent adjudication lacks unique authored criteria');
    const expected = entry.criterionIds.map(id => testCase.scoring.requirements.find(requirement => requirement.id === id));
    if (expected.some(requirement => !requirement) || new Set(entry.authoredRequirements.map(requirement => requirement?.id)).size !== expected.length || expected.some(requirement => !entry.authoredRequirements.some(actual => actual?.id === requirement.id && v2Hash(actual.expected) === v2Hash(requirement.expected)))) throw Error('Independent adjudication changed or invented an authored requirement');
    if (!Array.isArray(entry.evidenceEvents) || !entry.evidenceEvents.length || new Set(entry.evidenceEvents.map(event => event?.sha256)).size !== entry.evidenceEvents.length || entry.evidenceEvents.some(evidence => evidence?.eventType !== 'tool_result' || !Array.isArray(record.events) || !record.events.some(event => event.type === evidence.eventType && (!evidence.toolUseId || event.toolUseId === evidence.toolUseId) && v2Hash(event) === evidence.sha256))) throw Error('Independent adjudication evidence hash does not match an actual case tool result');
    row.originalAuxiliaryWorkflowOutcome = row.workflowOutcome;
    row.workflowOutcome = 'failed';
    row.workflowVerification = row.workflowVerification ? { ...row.workflowVerification, originalAuxiliaryModelWorkflowOutcome: row.workflowVerification.modelWorkflowOutcome, modelWorkflowOutcome: 'failed' } : null;
    row.effectiveCorrectnessPoints = 0;
    row.requiresHumanReview = true;
    row.independentAgentAdjudication = { ...entry, reviewerKind: adjudications.reviewerKind, reviewerId: adjudications.reviewerId, humanCertified: false };
  }
  const workflows = output.rows.filter(row => row.executionTrack === 'sandbox_workflow');
  output.workflows.adjudicatedWorkflowOutcomes = counts(workflows);
  output.workflows.workflowOutcomes = { ...output.workflows.adjudicatedWorkflowOutcomes };
  output.workflows.independentAgentAdjudicatedComplete = workflows.filter(row => row.workflowOutcome === 'auxiliary_passed').length;
  output.independentAgentAdjudications = { schemaVersion: adjudications.schemaVersion, reviewerKind: adjudications.reviewerKind, reviewerId: adjudications.reviewerId, applied: true, humanCertified: false, cases: structuredClone(adjudications.cases) };
  output.independentEvidenceFailureIds = adjudications.cases.map(entry => entry.id);
  output.humanReviewRequiredIds = output.rows.filter(row => row.requiresHumanReview).map(row => row.id);
  return output;
}
