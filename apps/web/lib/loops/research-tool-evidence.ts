type Value = Record<string, unknown>;
function record(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
}
function parse(value: unknown): Value {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}
function select(value: Value, keys: string[]): Value {
  const selected: Value = {};
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string") selected[key] = item.slice(0, 2048);
    else if (typeof item === "boolean" || typeof item === "number" || item === null) selected[key] = item;
    else if (Array.isArray(item)) selected[key] = item.filter(v => typeof v === "string").slice(0, 8).map(v => v.slice(0, 256));
  }
  return selected;
}
const inputs: Record<string, string[]> = {
  read: ["path", "offset", "limit"],
  grep: ["query", "pattern", "offset", "limit"],
  glob: ["pattern", "offset", "limit"],
  websearch: ["query", "domains", "domain", "recency", "dateFrom", "date_from", "limit"],
  webreadpage: ["url", "maxChars", "offset", "evidenceId", "figureId", "preferReader"],
};
function name(toolName: string): string { return (toolName.split("__").pop() ?? "").toLowerCase(); }

/** Bounded host receipts, never the page/code body or the model's evidence assertions. */
export function researchToolInput(toolName: string, input: unknown): Value | undefined {
  const keys = inputs[name(toolName)];
  return keys ? select(record(input), keys) : undefined;
}
export function researchToolResult(toolName: string, output: unknown): Value | undefined {
  const tool = name(toolName);
  if (!inputs[tool]) return undefined;
  const payload = parse(output);
  const result = select(payload, ["success", "ok", "isError", "status", "error", "warning", "warnings", "fallbackErrors"]);
  if (tool === "read" || tool === "grep" || tool === "glob") {
    const observation = record(payload.codebaseObservation ?? payload);
    result.codebaseObservation = select(observation, ["path", "sha256", "observedAt", "offset", "startLine", "endLine", "totalLines", "truncated", "nextOffset", "skippedFiles", "root", "query", "warnings"]);
    if (Array.isArray(observation.matches)) result.matchCount = observation.matches.length;
    if (Array.isArray(observation.paths)) result.pathCount = observation.paths.length;
  } else if (tool === "webreadpage") {
    Object.assign(result, select(payload, ["url", "finalUrl", "finalUrlVerified", "method", "qualityScore", "evidenceId", "contentHash", "truncated", "nextOffset"]));
    result.contentLength = typeof payload.content === "string" ? payload.content.length : 0;
  } else {
    Object.assign(result, select(payload, ["query", "source", "provider"]));
    result.resultCount = Array.isArray(payload.results) ? payload.results.length : 0;
  }
  return result;
}
