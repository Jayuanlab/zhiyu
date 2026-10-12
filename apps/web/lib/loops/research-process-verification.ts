import { z } from "zod";

const text = z.string().trim().min(1);
const sourceEvidence = z.object({
  path: text,
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  startLine: z.number().int().positive().safe(),
  endLine: z.number().int().positive().safe(),
}).refine(value => value.endLine >= value.startLine, "endLine must follow startLine");
const researchProcess = z.object({
  status: z.enum(["sufficient", "evidence_insufficient", "degraded"]),
  question: text,
  sourceEvidence: z.array(sourceEvidence),
  externalEvidence: z.array(z.object({
    url: z.url().refine(value => /^https?:\/\//i.test(value), "Expected an HTTP(S) evidence URL"),
    authority: z.enum(["primary", "secondary"]),
    publishedAt: z.preprocess(value => value === null || (typeof value === "string" && !value.trim())
      ? undefined : value, text.optional()),
    supportedClaims: z.array(text),
  })),
  gaps: z.array(text),
  nextStep: text,
});

type RecordValue = Record<string, unknown>;
type SuccessfulCall = { name: string; input: RecordValue; result: RecordValue };
type ObservedCall = SuccessfulCall & { failed: boolean };
type ReadObservation = { path: string; sha256: string; startLine: number; endLine: number };

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
}

function parsedRecord(value: unknown): RecordValue {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}

function leafToolName(value: unknown): string {
  return typeof value === "string" ? (value.split("__").pop() ?? "").toLowerCase() : "";
}

function payloads(event: RecordValue): RecordValue[] {
  const metadata = record(event.metadata);
  const values = [event, metadata, record(event.details), record(metadata.details),
    parsedRecord(metadata.toolResult), parsedRecord(event.detail)];
  for (const value of [...values]) {
    if (Array.isArray(value.content)) {
      for (const item of value.content) values.push(parsedRecord(record(item).text));
    }
  }
  return values;
}

function failedResult(event: RecordValue): boolean {
  return payloads(event).some(value => value.isError === true || value.success === false ||
    value.ok === false || ["error", "failed", "failure"].includes(String(value.status).toLowerCase()));
}

/** Permission decisions and orphaned results are deliberately not observations. */
function observedCalls(trace: unknown): ObservedCall[] {
  const events = record(trace).events;
  if (!Array.isArray(events)) return [];
  const pending = new Map<string, RecordValue>();
  const duplicates = new Set<string>();
  const completed: Array<ObservedCall & { id: string }> = [];
  for (const raw of events) {
    const event = record(raw);
    const id = typeof event.toolUseId === "string" ? event.toolUseId : "";
    if (!id) continue;
    if (event.type === "tool_used") {
      if (pending.has(id) || completed.some(call => call.id === id)) duplicates.add(id);
      pending.set(id, event);
    } else if (event.type === "tool_result") {
      const used = pending.get(id);
      pending.delete(id);
      if (!used || !["completed", "error", "failed"].includes(String(event.status)) || used.status === "error") continue;
      const name = leafToolName(used.toolName);
      if (event.toolName && leafToolName(event.toolName) !== name) continue;
      const metadata = record(used.metadata);
      completed.push({ id, name, input: parsedRecord(metadata.toolInput ?? used.input ?? used.detail), result: event, failed: failedResult(event) });
    }
  }
  return completed.filter(call => !duplicates.has(call.id));
}

function repoPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.replaceAll("\\", "/");
  if (!path.startsWith("repo/") || path.split("/").some(part => !part || part === "." || part === "..")) return null;
  return path;
}

function isSourcePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cc|cpp|h|hpp|cs|rb|php|swift|kt|kts|scala|sql|sh|ps1)$/i.test(path);
}

function readObservation(call: SuccessfulCall): ReadObservation | null {
  if (call.name !== "read") return null;
  const requestedPath = repoPath(call.input.path);
  if (!requestedPath) return null;
  const values = payloads(call.result);
  for (const value of [...values]) values.push(record(value.codebaseObservation));
  for (const value of values) {
    const path = repoPath(value.path);
    if (path !== requestedPath || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256)) continue;
    const numberedLines = typeof value.content === "string"
      ? [...value.content.matchAll(/(?:^|\n)(\d+):/g)].map(match => Number(match[1])) : [];
    const startLine = value.startLine ?? value.offset ?? numberedLines[0];
    const endLine = value.endLine ?? numberedLines.at(-1);
    if (typeof startLine !== "number" || typeof endLine !== "number" || !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) continue;
    return { path, sha256: value.sha256.toLowerCase(), startLine, endLine };
  }
  return null;
}

function coversSourceRange(reads: ReadObservation[], evidence: z.infer<typeof sourceEvidence>): boolean {
  const path = repoPath(evidence.path);
  if (!path) return false;
  const windows = reads.filter(read => read.path === path && read.sha256 === evidence.sha256.toLowerCase())
    .sort((left, right) => left.startLine - right.startLine);
  let coveredThrough = evidence.startLine - 1;
  for (const window of windows) {
    if (window.endLine <= coveredThrough) continue;
    if (window.startLine > coveredThrough + 1) return false;
    coveredThrough = window.endLine;
    if (coveredThrough >= evidence.endLine) return true;
  }
  return false;
}

function canonicalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch { return null; }
}

// Conservative recognized publisher/author hosts. A report's own authority label is not enough.
const primaryHosts = ["arxiv.org", "openreview.net", "aclanthology.org", "proceedings.mlr.press",
  "neurips.cc", "aaai.org", "dl.acm.org", "ieeexplore.ieee.org", "openai.com", "anthropic.com",
  "deepmind.google", "research.google", "microsoft.com", "modelcontextprotocol.io",
  "langchain.com", "langchain-ai.github.io", "llamaindex.ai", "huggingface.co"];

function isPrimaryUrl(value: unknown): boolean {
  const canonical = canonicalUrl(value);
  if (!canonical) return false;
  const url = new URL(canonical);
  if (url.hostname === "github.com") return /^\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname) && !/^\/(search|topics|collections)\//.test(url.pathname);
  if (url.hostname === "pypi.org") return /^\/project\/[^/]+(?:\/[^/]+)?\/?$/.test(url.pathname);
  if (url.hostname === "raw.githubusercontent.com") return /^\/[^/]+\/[^/]+\/[^/]+\/.+/.test(url.pathname);
  return primaryHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

function directedSearch(input: RecordValue): boolean {
  const query = typeof input.query === "string" ? input.query : "";
  const domains = input.domains ?? input.domain;
  return /\bsite:\s*[\w.-]+/i.test(query) || /\b(?:after|before):\d{4}/i.test(query) ||
    /\b(?:last|past)\s+\d*\s*(?:days?|weeks?|months?)\b/i.test(query) || /(?:最近|近|过去)\s*\d+\s*(?:天|日|周|个月)/.test(query) ||
    (typeof domains === "string" && Boolean(domains.trim())) || (Array.isArray(domains) && domains.some(value => typeof value === "string" && value.trim())) ||
    (typeof input.recency === "number" && input.recency > 0) || typeof input.dateFrom === "string" || typeof input.date_from === "string";
}

function successfulPage(call: SuccessfulCall): boolean {
  return call.name === "webreadpage" && payloads(call.result).some(value =>
    typeof value.contentLength === "number" && Number.isSafeInteger(value.contentLength) && value.contentLength > 0);
}

function primaryPage(call: SuccessfulCall): boolean {
  if (!successfulPage(call)) return false;
  if (payloads(call.result).some(value => value.finalUrlVerified === false)) return false;
  const redirected = payloads(call.result).find(value => typeof value.finalUrl === "string");
  return isPrimaryUrl(redirected?.finalUrl ?? call.input.url);
}

function unverifiedRequestedPrimary(call: SuccessfulCall, url: string): boolean {
  return successfulPage(call) && canonicalUrl(call.input.url) === canonicalUrl(url) && isPrimaryUrl(call.input.url) &&
    payloads(call.result).some(value => value.finalUrlVerified === false);
}

function pageMatches(call: SuccessfulCall, url: string): boolean {
  const expected = canonicalUrl(url);
  return canonicalUrl(call.input.url) === expected || payloads(call.result).some(value =>
    typeof value.finalUrl === "string" && canonicalUrl(value.finalUrl) === expected);
}

function hasNoChangeClaim(value: unknown): boolean {
  if (typeof value === "string") return value.trim().toLowerCase() === "no_material_change";
  if (Array.isArray(value)) return value.some(hasNoChangeClaim);
  return Object.values(record(value)).some(hasNoChangeClaim);
}

function hasDecisionText(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasDecisionText);
  return Object.values(record(value)).some(hasDecisionText);
}

/** Enforces observable research coverage and honest degradation, not the truth of model conclusions. */
export function verifyResearchProcess(requiredFields: string[], report: unknown, trace: unknown): string[] {
  if (!requiredFields.some(field => field.toLowerCase() === "researchprocess")) return [];
  const raw = record(report);
  const parsed = researchProcess.safeParse(raw.researchProcess);
  if (!parsed.success) return parsed.error.issues.map(issue => `researchProcess.${issue.path.join(".")}: ${issue.message}`);
  const process = parsed.data;
  const issues: string[] = [];
  const observed = observedCalls(trace);
  const calls = observed.filter(call => !call.failed);
  const reads = calls.map(readObservation).filter((value): value is ReadObservation => Boolean(value));
  let matchedSourceCount = 0;
  let matchedCodeSourceCount = 0;
  for (const evidence of process.sourceEvidence) {
    const path = repoPath(evidence.path);
    if (!coversSourceRange(reads, evidence)) {
      issues.push(`Source evidence ${evidence.path}:${evidence.startLine}-${evidence.endLine} must match a successful repo Read, SHA256 and observed line range`);
    } else {
      matchedSourceCount += 1;
      if (path && isSourcePath(path)) matchedCodeSourceCount += 1;
    }
  }
  const pageCalls = calls.filter(successfulPage);
  let matchedExternalCount = 0;
  for (const evidence of process.externalEvidence) {
    const pageMatched = pageCalls.some(call => pageMatches(call, evidence.url));
    if (!pageMatched) {
      issues.push(`External evidence ${evidence.url} must match a successful webReadPage`);
    }
    const canCiteUnverified = process.status !== "sufficient" && pageCalls.some(call => unverifiedRequestedPrimary(call, evidence.url));
    const authorityMatched = evidence.authority !== "primary" || canCiteUnverified ||
      pageCalls.some(call => pageMatches(call, evidence.url) && primaryPage(call));
    if (evidence.authority === "primary" && !authorityMatched) issues.push(`Primary evidence ${evidence.url} must match a recognized primary publisher or author host; sufficient research also requires an independently verified redirect destination`);
    const redirectGapDeclared = process.gaps.some(gap => /redirect|重定向/i.test(gap) &&
      /unverified|unknown|not\b.{0,60}\b(?:verified|confirmed|checked|resolved)|unable|cannot|could not|unavailable|未|无法|不确定|未知/i.test(gap));
    if (evidence.authority === "primary" && canCiteUnverified && !redirectGapDeclared) {
      issues.push(`Unverified final URL for primary evidence ${evidence.url} must be disclosed as a redirect verification gap`);
    }
    if (pageMatched && authorityMatched && evidence.supportedClaims.length && (!canCiteUnverified || redirectGapDeclared)) matchedExternalCount += 1;
  }
  if (process.status !== "sufficient") {
    if (!process.gaps.length) issues.push("Insufficient or degraded research must identify evidence gaps");
    const assessment = record(raw.projectAssessment);
    const reason = assessment.notificationReason;
    const notificationAllowed = (reason === "verified_correction" && matchedSourceCount > 0) ||
      (reason === "tool_failure" && observed.some(call => call.failed)) ||
      (reason === "decision_required" && hasDecisionText(assessment.decisionNeeded) && matchedCodeSourceCount + matchedExternalCount > 0);
    if (!notificationAllowed && (raw.materialChange === true || assessment.materialChange === true)) {
      issues.push("Insufficient or degraded research cannot claim materialChange=true without a verified correction, tool failure or evidenced decision request");
    }
    if (!notificationAllowed && (raw.notificationIntent === "notify" || assessment.notificationIntent === "notify")) {
      issues.push("Insufficient or degraded research must keep notificationIntent=quiet without a verified notificationReason");
    }
    if (hasNoChangeClaim(raw)) issues.push("Insufficient or degraded research cannot claim no_material_change");
    return issues;
  }
  if (!calls.some(call => call.name === "grep")) issues.push("Sufficient research needs a successful Grep call");
  if (new Set(reads.filter(read => isSourcePath(read.path)).map(read => read.path)).size < 2) issues.push("Sufficient research needs successful repo Read observations for two different source files");
  if (new Set(process.sourceEvidence.map(evidence => repoPath(evidence.path)).filter(path => path && isSourcePath(path))).size < 2) issues.push("Sufficient research must cite two different repo source files");
  if (!calls.some(call => call.name === "websearch" && directedSearch(call.input))) issues.push("Sufficient research needs a successful directed webSearch with a domain or time window");
  if (!process.externalEvidence.some(evidence => evidence.authority === "primary" && evidence.supportedClaims.length &&
    pageCalls.some(call => primaryPage(call) && pageMatches(call, evidence.url)))) {
    issues.push("Sufficient research needs a successfully read primary page with explicit supportedClaims");
  }
  return issues;
}
