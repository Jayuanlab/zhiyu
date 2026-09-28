// Evaluation-only. Never import this module into retrieval or agent prompts.
export const rubricVersion = 'question-aligned-v2';
const omitted = {
  'REAL-001': ['name'], 'REAL-002': ['name'], 'REAL-003': ['name'], 'REAL-004': ['name'],
  'REAL-009': ['capability'], 'REAL-013': ['title'], 'REAL-014': ['loop_id'],
  'REAL-015': ['name'], 'REAL-016': ['name'], 'REAL-022': ['risk_level'],
  'REAL-025': ['run_id', 'model_tier'], 'REAL-030': ['canonical_kind'],
  'REAL-038': ['source', 'content_type'], 'REAL-046': ['confidence'], 'REAL-050': ['status'],
  'REAL-039': ['conversation_name'], 'REAL-042': ['thread_id'], 'REAL-049': ['plan_date'],
};
export function answerRubric(testCase) {
  const expected = structuredClone(testCase.expected);
  for (const field of omitted[testCase.id] ?? []) delete expected.facts[field];
  if (testCase.id === 'REAL-051') delete expected.left.status;
  if (testCase.id === 'REAL-058') { delete expected.left.amount; delete expected.right.status; }
  const joinOmissions = {
    'REAL-053': { left: ['title', 'type'] },
    'REAL-054': { left: ['status'], right: ['conversation_name', 'message_time'] },
    'REAL-055': { left: ['title', 'confidence'], right: ['message_time'] },
    'REAL-056': { left: ['status'] },
    'REAL-057': { right: ['status'] },
    'REAL-059': { left: ['confidence'] },
    'REAL-060': { left: ['createdAt'], right: ['visibility'] },
  };
  for (const [side, fields] of Object.entries(joinOmissions[testCase.id] ?? {})) for (const field of fields) delete expected[side][field];
  if (testCase.id === 'REAL-059') expected.must = ['根因候选不能当作已证实根因'];
  if (['REAL-027', 'REAL-028'].includes(testCase.id)) expected.facts = { total: expected.facts.total };
  if (testCase.id === 'REAL-095') {
    expected.must = ['猎手维护自选股池，不能下单', '交易员消费正式池做模拟盘和复盘；不得直接交易池外标的，也不提交自选股调整提案，记录观察后交由猎手处理'];
    expected.basis = 'docs/reference/workshop-role-prompts-2026-09-15.md:88';
  }
  const requirements = [];
  for (const [key, value] of Object.entries(expected)) {
    if (['nullMeans', 'basis'].includes(key)) continue;
    if (key === 'must') value.forEach((v, i) => requirements.push({ id: `must.${i}`, expected: v }));
    else if (['facts', 'left', 'right'].includes(key)) {
      for (const [field, fact] of Object.entries(value)) requirements.push({ id: `${key}.${field}`, expected: fact });
    } else requirements.push({ id: key, expected: value });
  }
  return { version: rubricVersion, question: testCase.question, expected, requirements,
    policy: '仅按列出的必要要点评分，不得新增问题未问的字段。允许中文同义表达；relationship 只要求正确说明对象间关系，不要求复述外键字段名。长文本要求覆盖实质内容，不要求逐字复述或全文复制。空表需要明确当前用户该表无记录，未检索到不等于已证明表为空。null 不等于零或成功。实时结果不得冒充历史快照。' };
}
