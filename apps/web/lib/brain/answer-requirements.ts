export type AnswerRequirements = {
  version: "answer-requirements.v1";
  originalQuestion: string;
  requirements: string[];
  method: "explicit" | "clauses_and_domain_facets";
  unresolved: string[];
};

// Domain facets are questions, never inferred answers or gold/evaluation labels.
const facets: Array<[RegExp, string]> = [
  [/使命|职责|承担什么/u, "该对象承担的使命或职责是什么？"],
  [/目前.*状态|当前.*状态|现在.*状态|处于什么状态/u, "该对象当前的状态是什么？"],
  [/引擎/u, "该记录的引擎是什么？"], [/适配器/u, "该记录的适配器是什么？"],
  [/模型/u, "该记录使用的模型是什么？"],
  [/何时发生|发生时间/u, "该事件何时发生？"], [/何时生成|生成时间/u, "该记录何时生成？"],
  [/依据哪些记忆/u, "该记录依据哪些记忆？"], [/属于哪个范围/u, "该记录属于哪个范围？"],
  [/是否启用/u, "该对象是否启用？"], [/最近何时检查/u, "该对象最近何时检查？"],
  [/失败原因|为什么失败/u, "该次失败的原因是什么？"], [/是否恢复|恢复了吗/u, "该对象是否已经恢复？"],
];

/** Preserve unrecognized clauses; never pretend a heuristic is a complete semantic parser. */
export function buildAnswerRequirements(question: string, explicit?: string[]): AnswerRequirements {
  if (explicit) return { version: "answer-requirements.v1", originalQuestion: question,
    requirements: [...new Set(explicit.map(q => q.trim()).filter(Boolean))], method: "explicit", unresolved: [] };
  const clauses = question.split(/[?？;；\n]+/u).map(q => q.trim()).filter(Boolean);
  const requirements: string[] = [];
  const unresolved: string[] = [];
  for (const clause of clauses) {
    // Split comma-separated questions only when every fragment has a question cue.
    // Lists and comparisons stay intact, so A、B 的区别 never becomes two unrelated claims.
    const parts = clause.split(/[,，]/u).map(p => p.trim()).filter(Boolean);
    const canSplit = parts.length > 1 && parts.every(p => /什么|哪些|如何|怎样|是否|何时|多少|哪个|吗|[?？]/u.test(p));
    if (canSplit) {
      for (const part of parts) {
        const nested = buildAnswerRequirements(part);
        requirements.push(...nested.requirements);
        unresolved.push(...nested.unresolved);
      }
      continue;
    }
    const compound = /和|以及|及其|并且|同时|、|\band\b/i.test(clause);
    const recognized = facets.filter(([pattern]) => pattern.test(clause));
    // Restrict expansion to record-field questions, not architecture explanations containing these nouns.
    if (compound && recognized.length > 1 && !/原理|如何实现|怎样实现|区别|比较|为什么|设计/u.test(clause)) {
      requirements.push(...recognized.map(([, q]) => q));
      // Keep the original as an explicit unresolved obligation if it also asks unrecognized things.
      const supportedFieldList = /^(?:[^、,，和及;；?？]+的)?引擎[、,，和及\s]+适配器[、,，和及\s]+模型(?:分别)?(?:是什么|有哪些|是哪些)$/u.test(clause)
        && recognized.length === 3;
      if (!supportedFieldList) unresolved.push(clause);
    } else {
      requirements.push(clause);
      if (compound && /什么|哪些|如何|怎样|是否|何时|多少/u.test(clause)) unresolved.push(clause);
    }
  }
  return { version: "answer-requirements.v1", originalQuestion: question,
    requirements: [...new Set([...requirements, ...unresolved])], method: "clauses_and_domain_facets", unresolved: [...new Set(unresolved)] };
}
