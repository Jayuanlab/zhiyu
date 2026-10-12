/** Private scoring context only. Never import into an answerer or retrieval corpus. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildV2WorkflowAnswerInput, V2_STORED_WORKFLOW_ADAPTER, v2Hash } from './platform-eval-v2-grading.mjs';

export const V2_WORKFLOW_REVIEW_PROTOCOL = 'workflow_answer_receipt_grounded_review.v1';
export const V2_WORKFLOW_REVIEW_FILE = 'workflow-answer-receipt-grounded-review-v2.json';

export function buildV2ReceiptGroundedWorkflowInput(testCase, record, verified) {
  const textInput = buildV2WorkflowAnswerInput(testCase, record);
  if (!textInput) return null;
  if (verified?.adapterId !== V2_STORED_WORKFLOW_ADAPTER || !['passed', 'failed', 'fixture_error'].includes(verified.status)) throw Error('Receipt-grounded review requires an independent physical verification result');
  const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const toolResults = (Array.isArray(record.events) ? record.events : []).filter(event => event.type === 'tool_result');
  const modelToolResults = toolCalls.map(call => {
    const result = toolResults.find(event => event.toolUseId === call.id);
    return { toolCallId: call.id, name: call.name, input: call.input, output: result?.output ?? null, isError: result?.isError ?? null, resultRecorded: Boolean(result) };
  });
  return { ...textInput, protocol: V2_WORKFLOW_REVIEW_PROTOCOL, recordBindingSha256: v2Hash(record),
    executionContext: { status: record.status, fixtureStatus: verified.status, source: 'independent_physical_receipt_reverification' },
    verifiedServiceEvidence: { adapterId: verified.adapterId, status: verified.status, checks: verified.serviceChecks ?? verified.checks ?? [], errors: verified.errors ?? [], receipts: verified.receipts ?? [], answerAssertionIds: verified.answerAssertionIds ?? [], fixtureAttribution: verified.fixtureAttribution ?? verified.contractMismatch ?? null, diagnostics: verified.diagnostics ?? null, verifierSourceSha256: verified.verifierSourceSha256 ?? null, baselineCountsAsModelKnowledge: false },
    modelToolResults };
}

/** @param {((input: {record: any, runFolder: string}) => any) | null} [verifyStored] */
export async function loadV2ReceiptGroundedWorkflowInputs(evaluation, verifyStored = null) {
  let verifier = verifyStored;
  const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'platform-eval-v2-workflows.mjs');
  const verifierSourceSha256 = fs.existsSync(modulePath) ? v2Hash(fs.readFileSync(modulePath, 'utf8')) : null;
  if (!verifier) {
    if (fs.existsSync(modulePath)) verifier = (await import(pathToFileURL(modulePath).href)).verifyStoredWorkflow;
  }
  const independentlyVerified = new Map();
  const inputs = [];
  for (const testCase of evaluation.cases.filter(testCase => testCase.executionTrack === 'sandbox_workflow')) {
    const record = evaluation.records.find(record => (record.artifactCaseId ?? record.id) === testCase.id);
    if (!record || !['completed', 'fixture_error'].includes(record.status)) continue;
    let verified;
    try { verified = typeof verifier === 'function' ? await verifier({ record, runFolder: evaluation.runFolder }) : null; }
    catch { verified = null; }
    if (!verified) verified = { adapterId: V2_STORED_WORKFLOW_ADAPTER, status: 'fixture_error', checks: [], errors: ['Independent physical verifier unavailable'] };
    verified = { ...verified, verifierSourceSha256 };
    independentlyVerified.set(testCase.id, verified);
    const input = buildV2ReceiptGroundedWorkflowInput(testCase, record, verified);
    if (input) inputs.push(input);
  }
  return { inputs, independentlyVerified };
}

/** Preserve all legacy bytes. Protocol errors are classified separately from model errors. */
export function legacyV2WorkflowReviewProtocolError(evaluation) {
  const file = path.join(evaluation.runFolder, 'workflow-answer-review-v2.json');
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file, 'utf8');
  const saved = JSON.parse(bytes);
  return { file: 'workflow-answer-review-v2.json', sha256: v2Hash(bytes), status: 'judge_protocol_error', retainedUnmodified: true,
    reason: 'The text-only judge lacked independently verified service evidence and actual tool results, so it could not judge action-related authored requirements.',
    batches: (saved.batches ?? []).map(batch => ({ id: batch.id, originalStatus: batch.status, inputIds: batch.inputIds, attempt: batch.attempt })), excludedFromModelOutcome: true };
}
