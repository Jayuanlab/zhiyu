export type ContextBudgetSectionInput = {
  name: string;
  value: unknown;
  maxChars?: number | null;
};

export type ContextBudgetSectionReport = {
  name: string;
  chars: number;
  estimatedTokens: number;
  maxChars: number | null;
  overBudget: boolean;
};

export type ContextBudgetReport = {
  kind: "context_budget_report";
  profile: string;
  model: string | null;
  promptChars: number;
  estimatedPromptTokens: number;
  estimatedTokenRatio: number;
  estimatedInputCostUsd: number | null;
  inputPriceUsdPerMillionTokens: number | null;
  toolCount: number;
  maxToolCalls: number | null;
  toolProfile: string | null;
  modelTier: string | null;
  modelSource: string | null;
  sections: ContextBudgetSectionReport[];
  largestSections: ContextBudgetSectionReport[];
  createdAt: string;
};

const DEFAULT_CHARS_PER_TOKEN = 4;

function stableJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

export function estimateTokenCount(chars: number) {
  return Math.ceil(Math.max(0, chars) / DEFAULT_CHARS_PER_TOKEN);
}

export function buildContextBudgetReport(input: {
  profile?: string | null;
  model?: string | null;
  prompt: string;
  maxToolCalls?: number | null;
  allowedTools?: string[] | null;
  toolProfile?: string | null;
  modelTier?: string | null;
  modelSource?: string | null;
  inputPriceUsdPerMillionTokens?: number | null;
  sections: ContextBudgetSectionInput[];
}): ContextBudgetReport {
  const sections = input.sections.map((section) => {
    const chars = stableJson(section.value).length;
    const maxChars = section.maxChars ?? null;
    return {
      name: section.name,
      chars,
      estimatedTokens: estimateTokenCount(chars),
      maxChars,
      overBudget: maxChars !== null && chars > maxChars,
    };
  });
  const promptChars = input.prompt.length;
  const estimatedPromptTokens = estimateTokenCount(promptChars);
  const inputPriceUsdPerMillionTokens =
    typeof input.inputPriceUsdPerMillionTokens === "number" &&
    Number.isFinite(input.inputPriceUsdPerMillionTokens) &&
    input.inputPriceUsdPerMillionTokens >= 0
      ? input.inputPriceUsdPerMillionTokens
      : null;
  const estimatedInputCostUsd =
    inputPriceUsdPerMillionTokens === null
      ? null
      : (estimatedPromptTokens / 1_000_000) *
        inputPriceUsdPerMillionTokens;

  return {
    kind: "context_budget_report",
    profile: input.profile ?? "normal",
    model: input.model ?? null,
    promptChars,
    estimatedPromptTokens,
    estimatedTokenRatio: DEFAULT_CHARS_PER_TOKEN,
    estimatedInputCostUsd,
    inputPriceUsdPerMillionTokens,
    toolCount: input.allowedTools?.length ?? 0,
    maxToolCalls: input.maxToolCalls ?? null,
    toolProfile: input.toolProfile ?? null,
    modelTier: input.modelTier ?? null,
    modelSource: input.modelSource ?? null,
    sections,
    largestSections: [...sections]
      .sort((left, right) => right.chars - left.chars)
      .slice(0, 5),
    createdAt: new Date().toISOString(),
  };
}
