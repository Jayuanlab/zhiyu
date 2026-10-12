/** Evaluation-only contract. Validation never grants permission to execute a case. */
export const PLATFORM_EVAL_V2_SUITE_VERSION = 'platform-capability-100.v2';

const tracks = new Set(['record_qa', 'source_qa', 'sandbox_workflow']);
const toolPolicies = new Set(['evidence_when_needed', 'refusal_without_lookup', 'sandbox_workflow']);
const changeKinds = new Set(['retained', 'rewritten', 'replaced']);
const inputFields = new Set(['id', 'question', 'asOf', 'requester', 'queryVariants']);
const requesterFields = new Set(['type', 'userId', 'accessMode']);
const forbiddenInputFields = new Set([
  'expected', 'evidence', 'scoring', 'change', 'gold', 'evalrequirements', 'sourcerefs',
  'requirements', 'mustnot', 'requiredtools', 'toolpolicy', 'fixture', 'fixtureid',
  'executiontrack', 'mutationsallowed', 'productionexecutionallowed',
  'requiredevidencetypes', 'assertions', 'fixtureevidencerequirements', 'deterministicassertions',
  'missingevidenceoutcome', 'proseonlycannotpass', 'workflowoutcomerequiresreceipts',
]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const canonicalQuestion = value => value.normalize('NFKC').replace(/\s+/gu, '').replace(/[?？。.!！]+$/u, '');
const result = errors => ({ valid: errors.length === 0, errors });

function inspectJson(value, location, errors, ancestors = new Set(), input = false) {
  if (typeof value === 'string') {
    if (/\uFFFD|\?{3,}|[\uD800-\uDFFF]/u.test(value)) errors.push(`${location}: corrupted Unicode text`);
    return;
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || ancestors.has(value)) {
    errors.push(`${location}: must be finite, acyclic JSON data`);
    return;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    errors.push(`${location}: must be a plain JSON object`);
    return;
  }
  ancestors.add(value);
  for (const [key, child] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
    if (input && forbiddenInputFields.has(String(key).toLowerCase())) errors.push(`${location}.${key}: evaluation labels or execution metadata must not enter questions`);
    inspectJson(child, `${location}.${key}`, errors, ancestors, input);
  }
  ancestors.delete(value);
}

function inspectScoring(scoring, location, errors) {
  if (!object(scoring)) {
    errors.push(`${location}: explicit scoring is required; legacy ID rules cannot supply it`);
    return;
  }
  for (const key of Object.keys(scoring)) {
    if (!['requirements', 'mustNot', 'toolPolicy'].includes(key)) errors.push(`${location}.${key}: unsupported scoring field; do not force a lookup tool`);
  }
  if (!Array.isArray(scoring.requirements) || !scoring.requirements.length) {
    errors.push(`${location}.requirements: at least one explicit requirement is required`);
  } else {
    const seen = new Set();
    for (const [index, requirement] of scoring.requirements.entries()) {
      const where = `${location}.requirements[${index}]`;
      if (!object(requirement)) { errors.push(`${where}: must be an object`); continue; }
      if (Object.keys(requirement).some(key => !['id', 'expected'].includes(key))) errors.push(`${where}: only id and expected are allowed`);
      if (!text(requirement.id)) errors.push(`${where}.id: must be nonempty`);
      else if (seen.has(requirement.id.trim())) errors.push(`${where}.id: duplicate requirement ${requirement.id.trim()}`);
      else seen.add(requirement.id.trim());
      // null, false, zero and empty collections are meaningful observed states.
      if (!own(requirement, 'expected') || requirement.expected === undefined || (typeof requirement.expected === 'string' && !text(requirement.expected))) {
        errors.push(`${where}.expected: an explicit nonblank expected value is required`);
      }
    }
  }
  if (!Array.isArray(scoring.mustNot) || !scoring.mustNot.length || scoring.mustNot.some(value => !text(value))) {
    errors.push(`${location}.mustNot: at least one nonblank prohibited claim is required`);
  }
  if (!toolPolicies.has(scoring.toolPolicy)) errors.push(`${location}.toolPolicy: unsupported tool policy`);
}

function inspectWorkflow(testCase, location, errors) {
  if (testCase.executionTrack !== 'sandbox_workflow' || testCase.scoring?.toolPolicy !== 'sandbox_workflow') errors.push(`${location}: sandbox track and tool policy must agree`);
  const fixture = testCase.fixture;
  if (!object(fixture) || !text(fixture.id) || fixture.isolation !== 'isolated' || fixture.cleanup !== 'required' || !text(fixture.setup)) {
    errors.push(`${location}.fixture: id, isolation=isolated, cleanup=required and setup instructions are required`);
  }
  if (object(fixture)) {
    const types = fixture.requiredEvidenceTypes;
    const validTypes = Array.isArray(types) && types.length > 0 && types.every(value => text(value) && value === value.trim());
    if (!validTypes || new Set(types).size !== types.length) errors.push(`${location}.fixture.requiredEvidenceTypes: unique, nonblank receipt types are required`);
    const declaredTypes = new Set(validTypes ? types : []);
    if (validTypes && types.every(type => ['answer', 'prose', 'model_output', 'narrative'].includes(type.toLowerCase()))) errors.push(`${location}.fixture.requiredEvidenceTypes: prose alone is not execution evidence`);
    const coveredTypes = new Set();
    const assertionIds = new Set();
    if (!Array.isArray(fixture.assertions) || !fixture.assertions.length) {
      errors.push(`${location}.fixture.assertions: deterministic receipt assertions are required`);
    } else for (const [index, assertion] of fixture.assertions.entries()) {
      const where = `${location}.fixture.assertions[${index}]`;
      if (!object(assertion)) { errors.push(`${where}: must be an assertion object`); continue; }
      if (!text(assertion.id)) errors.push(`${where}.id: must be nonempty`);
      else if (assertionIds.has(assertion.id.trim())) errors.push(`${where}.id: duplicate assertion ${assertion.id.trim()}`);
      else assertionIds.add(assertion.id.trim());
      if (!declaredTypes.has(assertion.type)) errors.push(`${where}.type: must be a requiredEvidenceTypes member`);
      else coveredTypes.add(assertion.type);
      const expected = assertion.expected;
      if (!own(assertion, 'expected') || expected === undefined || expected === null ||
        (typeof expected === 'string' && !text(expected)) ||
        (Array.isArray(expected) && !expected.length) ||
        (object(expected) && !Object.keys(expected).length)) errors.push(`${where}.expected: a nonempty receipt assertion is required`);
    }
    for (const type of declaredTypes) if (!coveredTypes.has(type)) errors.push(`${location}.fixture.assertions: missing assertion for ${type}`);
    if (fixture.missingEvidenceOutcome !== 'fixture_error') errors.push(`${location}.fixture.missingEvidenceOutcome: missing receipts must be fixture_error`);
    if (fixture.proseOnlyCannotPass !== true) errors.push(`${location}.fixture.proseOnlyCannotPass: must explicitly forbid prose-only success`);
    if ((own(fixture, 'productionExecutionAllowed') && fixture.productionExecutionAllowed !== false) || ['production', 'live'].includes(fixture.environment)) errors.push(`${location}.fixture: a production target or permission is forbidden`);
  }
  if (testCase.mutationsAllowed !== 'isolated_only') errors.push(`${location}.mutationsAllowed: workflows must be isolated_only`);
  if (testCase.productionExecutionAllowed !== false) errors.push(`${location}.productionExecutionAllowed: workflows must explicitly deny production execution`);
}

function inspectCase(testCase, index, errors) {
  const location = `cases[${index}]`;
  if (!object(testCase)) { errors.push(`${location}: must be an object`); return; }
  inspectJson(testCase, location, errors);
  if (testCase.suiteVersion !== PLATFORM_EVAL_V2_SUITE_VERSION) errors.push(`${location}.suiteVersion: must be ${PLATFORM_EVAL_V2_SUITE_VERSION}`);
  if (!/^REAL-(?:0[0-9]{2}|100)$/.test(testCase.id ?? '') || testCase.id === 'REAL-000') errors.push(`${location}.id: must be REAL-001 through REAL-100`);
  if (!text(testCase.category)) errors.push(`${location}.category: must be nonempty`);
  if (!text(testCase.question) || !/[^\x00-\x7F]/u.test(testCase.question)) errors.push(`${location}.question: a nonblank Unicode question is required`);
  if (!own(testCase, 'expected')) errors.push(`${location}.expected: compatibility gold is required`);
  if (!Array.isArray(testCase.evidence) || !testCase.evidence.length || testCase.evidence.some(value => !text(value))) errors.push(`${location}.evidence: nonblank evidence references are required`);
  if (testCase.executionStatus !== 'not_run') errors.push(`${location}.executionStatus: a catalog is not_run, not an execution receipt`);
  if (!object(testCase.change) || !changeKinds.has(testCase.change.kind) || !text(testCase.change.reason)) errors.push(`${location}.change: change kind and a nonblank reason are required`);
  if (!tracks.has(testCase.executionTrack)) errors.push(`${location}.executionTrack: unsupported track`);
  inspectScoring(testCase.scoring, `${location}.scoring`, errors);
  if (own(testCase, 'requiredTools') || own(testCase, 'evalRequirements')) errors.push(`${location}: legacy requiredTools/evalRequirements must not force tool use`);
  if (own(testCase, 'productionExecutionAllowed') && testCase.productionExecutionAllowed !== false) errors.push(`${location}.productionExecutionAllowed: production execution is forbidden`);

  const workflow = testCase.executionTrack === 'sandbox_workflow';
  if (workflow) {
    inspectWorkflow(testCase, location, errors);
  } else {
    if (testCase.scoring?.toolPolicy === 'sandbox_workflow') errors.push(`${location}.executionTrack: sandbox policy cannot run in a QA track`);
    if (own(testCase, 'mutationsAllowed') && testCase.mutationsAllowed !== 'none') errors.push(`${location}.mutationsAllowed: QA tracks cannot authorize mutations`);
  }
  if (own(testCase, 'sourceRefs')) {
    if (!Array.isArray(testCase.sourceRefs) || !testCase.sourceRefs.length) errors.push(`${location}.sourceRefs: if supplied, at least one reference is required`);
    else for (const [i, ref] of testCase.sourceRefs.entries()) {
      if (!object(ref) || !text(ref.path) || !text(ref.anchor)) errors.push(`${location}.sourceRefs[${i}]: path and anchor are required`);
      else if (/^(?:[A-Za-z]:|[\\/])/.test(ref.path) || ref.path.split(/[\\/]/u).includes('..')) errors.push(`${location}.sourceRefs[${i}].path: must stay repository-relative`);
    }
  }
}

/** Validate the complete authored catalog, not model judgments or execution results. */
export function validateV2Catalog(cases) {
  const errors = [];
  if (!Array.isArray(cases)) return result(['cases: must be an array']);
  if (cases.length !== 100) errors.push(`cases: expected 100 cases, received ${cases.length}`);
  const seenIds = new Set();
  const seenQuestions = new Set();
  for (const [index, testCase] of cases.entries()) {
    inspectCase(testCase, index, errors);
    if (!object(testCase)) continue;
    if (seenIds.has(testCase.id)) errors.push(`cases[${index}].id: duplicate case ${testCase.id}`);
    seenIds.add(testCase.id);
    if (text(testCase.question)) {
      const question = canonicalQuestion(testCase.question);
      if (seenQuestions.has(question)) errors.push(`cases[${index}].question: duplicate question`);
      seenQuestions.add(question);
    }
  }
  for (let index = 1; index <= 100; index++) {
    const id = `REAL-${String(index).padStart(3, '0')}`;
    if (!seenIds.has(id)) errors.push(`cases: missing ${id}`);
  }
  return result(errors);
}

/** Strict allowlist for questions.jsonl; no fixture, policy or answer-bearing metadata. */
export function validateV2QuestionInputs(questions) {
  const errors = [];
  if (!Array.isArray(questions)) return result(['questions: must be an array']);
  if (!questions.length) errors.push('questions: must not be empty');
  const seen = new Set();
  for (const [index, question] of questions.entries()) {
    const location = `questions[${index}]`;
    if (!object(question)) { errors.push(`${location}: must be an object`); continue; }
    inspectJson(question, location, errors, new Set(), true);
    for (const key of Object.keys(question)) if (!inputFields.has(key)) errors.push(`${location}.${key}: not an allowed question input field`);
    if (!/^REAL-(?:0[0-9]{2}|100)$/.test(question.id ?? '') || question.id === 'REAL-000') errors.push(`${location}.id: must be REAL-001 through REAL-100`);
    if (seen.has(question.id)) errors.push(`${location}.id: duplicate question input`);
    seen.add(question.id);
    if (!text(question.question) || !/[^\x00-\x7F]/u.test(question.question)) errors.push(`${location}.question: a nonblank Unicode question is required`);
    if (own(question, 'asOf') && (!text(question.asOf) || !/^\d{4}-\d{2}-\d{2}T/.test(question.asOf) || !Number.isFinite(Date.parse(question.asOf)))) errors.push(`${location}.asOf: must be an ISO timestamp`);
    if (own(question, 'requester')) {
      if (!object(question.requester) || Object.keys(question.requester).some(key => !requesterFields.has(key)) || Object.values(question.requester).some(value => !text(value))) errors.push(`${location}.requester: only nonblank type, userId and accessMode are allowed`);
    }
    if (own(question, 'queryVariants')) {
      const variants = question.queryVariants;
      const validArray = Array.isArray(variants) && variants.length > 0 && variants.every(text);
      const validObject = object(variants) && Object.keys(variants).length > 0 && Object.entries(variants).every(([key, value]) => ['exact', 'natural'].includes(key) && text(value));
      if (!validArray && !validObject) errors.push(`${location}.queryVariants: must be text variants, or exact/natural text only`);
    }
  }
  return result(errors);
}

/** No legacy imports, ID patches or expected-field inference: authored scoring is the sole rubric. */
export function buildV2Rubric(testCase) {
  if (!object(testCase) || testCase.suiteVersion !== PLATFORM_EVAL_V2_SUITE_VERSION) throw new Error('buildV2Rubric requires platform-capability-100.v2; legacy catalogs cannot be mixed');
  const errors = [];
  inspectScoring(testCase.scoring, 'scoring', errors);
  inspectJson(testCase.scoring, 'scoring', errors);
  const workflow = testCase.executionTrack === 'sandbox_workflow' || testCase.scoring?.toolPolicy === 'sandbox_workflow';
  if (workflow) {
    inspectWorkflow(testCase, 'case', errors);
    inspectJson(testCase.fixture, 'fixture', errors);
  }
  if (!text(testCase.question)) errors.push('question: must be nonempty');
  if (errors.length) throw new Error(`Invalid v2 rubric: ${errors.join('; ')}`);
  const requirements = structuredClone(testCase.scoring.requirements);
  return {
    version: PLATFORM_EVAL_V2_SUITE_VERSION,
    suiteVersion: PLATFORM_EVAL_V2_SUITE_VERSION,
    question: testCase.question,
    expected: Object.fromEntries(requirements.map(requirement => [requirement.id, requirement.expected])),
    requirements,
    mustNot: [...testCase.scoring.mustNot],
    toolPolicy: testCase.scoring.toolPolicy,
    ...(workflow ? {
      fixtureEvidenceRequirements: [...testCase.fixture.requiredEvidenceTypes],
      deterministicAssertions: structuredClone(testCase.fixture.assertions),
      workflowOutcomeRequiresReceipts: true,
      workflowMissingEvidenceOutcome: 'fixture_error',
      workflowProseOnlyCannotPass: true,
    } : {}),
    policy: '只按本题明确列出的 requirements 和 mustNot 评分，允许同义表达，不增加未问字段。证据型题按回答所需核查来源，不强制某个工具；纯拒绝题无需查询；工作流题只允许隔离夹具中的动作。工作流必须由真实适配器核验 requiredEvidenceTypes 和 deterministicAssertions，缺少必要回执标 fixture_error，纯文字或模型自评分不得产生 passed；本评分表不执行断言，也不签发回执。不得把计划、提案、模型判断或未执行结果说成已经成功执行。',
  };
}
