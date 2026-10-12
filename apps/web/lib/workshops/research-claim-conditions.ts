/** Local lexical checks only; no translation, entailment or scientific approval. */
type ClaimConditionInput = {
  claim: string;
  quote: string;
  kind: "method" | "experiment" | "limitation";
  /** Host-located same-paragraph text, possibly clipped to the read window. */
  context?: string;
};
const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unique = (values: string[]) => [...new Set(values)];

function hasAcronym(value: string, acronym: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${escape(acronym)}s?(?=$|[^A-Za-z0-9_-])`).test(value);
}

/** Never borrow definitions or conditions from another paragraph. */
function sameParagraph(quote: string, context: string): string {
  const candidates = context.split(/\r?\n[ \t]*\r?\n/u)
    .filter(paragraph => normalize(paragraph).includes(normalize(quote)));
  return candidates.length === 1 ? candidates[0] : quote;
}

function definitionIssues(claim: string, quote: string, paragraph: string): string[] {
  // The acronym is obtained from an explicit local definition, never a model
  // name table. This small lexical bridge distinguishes paradigm from breadth.
  const negated = (value: string, index: number) => /(?:non[\s-]*|(?:not|no)\s+(?:a\s+)?)$/i.test(value.slice(0, index));
  const definitions = [...paragraph.matchAll(/\bgenerative[\s-]+reward[\s-]+model(?:s|ing)?\s*\(([A-Z][A-Z0-9]{1,11})\)/gi)]
    .filter(match => /^[A-Z][A-Z0-9]{1,11}$/.test(match[1]) && !negated(paragraph, match.index ?? 0)).map(match => match[1]);
  const selectedDefinitions = definitions.filter(acronym => hasAcronym(quote, acronym));
  const explicitGenerative = [...quote.matchAll(/\bgenerative[\s-]+(?:reward[\s-]+model(?:s|ing)?|RMs?)\b/gi)]
    .some(match => !negated(quote, match.index ?? 0));
  if (!selectedDefinitions.length && !explicitGenerative) return [];
  const clauses = claim.split(/[，,；;。!?！？\r\n]+/u);
  if (!clauses.some(clause => /通用\s*(?:的\s*)?奖励\s*(?:模型|建模)/u.test(clause) &&
      !/生成式|\bgenerative\b/i.test(clause) && !selectedDefinitions.some(acronym => hasAcronym(clause, acronym)) &&
      // A distinct named model in a synthesis is not this local definition.
      (!scientificAnchors(clause).length || sharesAnchor(quote, clause)))) return [];
  return ["同段明确的 generative reward model(ing) 定义描述生成式范式，不能仅译作“通用奖励模型”；请保留生成式或原缩写，并将通用任务目标另行表述"];
}

function scientificAnchors(value: string): string[] {
  return unique((value.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? []).filter(token =>
    /\d/.test(token) || (token.match(/[A-Z]/g)?.length ?? 0) >= 2));
}
function sharesAnchor(source: string, claim: string): boolean {
  return scientificAnchors(source).some(anchor => new RegExp(
    `(^|[^A-Za-z0-9_-])${escape(anchor)}(?=$|[^A-Za-z0-9_-])`, "i").test(claim));
}
const sourceComparison = /\b(?:outperforms?|surpasses?|better\s+than|worse\s+than|(?:comparable|competitive)(?:\s+\w+){0,2}\s+(?:with|to)|best\s+(?:\w+\s+){0,2}(?:results?|performance))\b/i;
const claimComparison = /超越|优于|胜过|超过|不如|更差|最佳|最优|相当|可比|竞争性|媲美|\b(?:outperforms?|surpasses?|better\s+than|worse\s+than|comparable|competitive|best)\b/iu;
const sourceModelClass = /\b(?:models?|methods?|systems?|variants?|baselines?|RMs?)\b/i;
const claimModelClass = /模型|方法|系统|基线|\b(?:models?|methods?|systems?|baselines?|RMs?)\b/iu;
function adoptsComparison(claim: string, sentence: string): boolean {
  return sourceComparison.test(sentence) && claim.split(/[，,；;。!?！？\r\n]+/u).some(clause =>
    claimComparison.test(clause) && (sharesAnchor(sentence, clause) ||
      sourceModelClass.test(sentence) && claimModelClass.test(clause)));
}
function sentences(value: string): string[] {
  // A decimal or numbered model stays intact. Only visible sentence boundaries
  // bind a preceding test setting to its immediately following comparison.
  return value.split(/[!?;\r\n]+|\.(?=\s+[A-Z]|\s*$)/u).map(normalize).filter(Boolean);
}
function includesBenchmark(value: string, benchmark: string): boolean {
  // Preserve complete identities; only case and whitespace are cosmetic.
  const identity = benchmark.replace(/\s+/g, "");
  const pattern = [...identity].map(escape).join("[\\t \\r\\n]*");
  return new RegExp(`(^|[^A-Za-z0-9])${pattern}(?=$|[^A-Za-z0-9])`, "i").test(value);
}
function namedTestConditions(sentence: string): Array<{ name: string; subject: string }> {
  const found: Array<{ name: string; subject: string }> = [];
  for (const match of sentence.matchAll(/\b(?:tested|evaluated|benchmarked)\s+on\s+(?:the\s+)?([^,;.\r\n]+)/gi)) {
    const name = match[1].split(/\s+(?:with|using|under|and|where|which|for|in|at)\b/i)[0].trim();
    const subject = sentence.slice(0, match.index);
    if (/\b(?:not|never|may|might|could|would|should|will|if|unless)\b/i.test(subject)) continue;
    // Unnamed/lowercase "held-out test set" is not a named benchmark identity.
    if (/^[A-Z][A-Za-z0-9]*(?:[- ][A-Za-z0-9]+){0,4}$/.test(name) && sourceModelClass.test(subject)) found.push({ name, subject });
  }
  return found;
}
function experimentConditionIssues(claim: string, quote: string, paragraph: string): string[] {
  const local = sentences(paragraph), issues: string[] = [];
  for (const selectedSentence of sentences(quote).filter(sentence => adoptsComparison(claim, sentence))) {
    const positions = local.flatMap((sentence, index) => sentence.includes(selectedSentence) ? [index] : []);
    if (positions.length !== 1) continue; // Unknown alignment remains unverified.
    const index = positions[0];
    for (const setting of local.slice(Math.max(0, index - 1), index + 1)) {
      for (const condition of namedTestConditions(setting)) {
        // A named subject of a different experiment cannot impose its scope.
        // An unanchored "the models" may refer to the immediately adjacent
        // model comparison; broader paragraph or heading matches are not used.
        const anchors = scientificAnchors(condition.subject);
        if (anchors.length ? !sharesAnchor(condition.subject, selectedSentence) : !sourceModelClass.test(selectedSentence)) continue;
        const missing: string[] = [];
        if (!includesBenchmark(claim, condition.name)) missing.push("结论");
        if (!includesBenchmark(quote, condition.name)) missing.push("选中短摘");
        if (missing.length) issues.push(`同段该模型比较明确 tested/evaluated on ${condition.name}，${missing.join("与")}未保留该基准范围；请选取包含此条件的真实连续原文，并将结论限定为该基准下的比较`);
      }
    }
  }
  return unique(issues);
}

/** Explicit observed obligations only; unseen/unaligned conditions are not judged. */
export function researchClaimConditionIssues({ claim, quote, kind, context = "" }: ClaimConditionInput): string[] {
  const issues: string[] = [];
  for (const quoteParagraph of quote.split(/\r?\n[ \t]*\r?\n/u).filter(part => part.trim())) {
    const paragraph = sameParagraph(quoteParagraph, context);
    issues.push(...definitionIssues(claim, quoteParagraph, paragraph));
    if (kind === "experiment") issues.push(...experimentConditionIssues(claim, quoteParagraph, paragraph));
  }
  return unique(issues);
}
