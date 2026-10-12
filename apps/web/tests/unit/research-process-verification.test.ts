import { describe, expect, it } from "vitest";
import { verifyResearchProcess } from "@/lib/loops/research-process-verification";

const hash = "a".repeat(64);
const fields = ["researchQuestion", "researchProcess"];
const paths = ["repo/apps/web/lib/work-runtime/loop-execution.ts", "repo/apps/web/lib/loops/verifier.ts"];
const primaryUrl = "https://arxiv.org/html/2609.12345v1";
const report = () => ({
  projectAssessment: { materialChange: false, notificationIntent: "quiet" },
  researchProcess: {
    status: "sufficient",
    question: "Does the recorded-step contract cover the selected recovery boundary?",
    sourceEvidence: paths.map(path => ({ path, sha256: hash, startLine: 10, endLine: 12 })),
    externalEvidence: [{ url: primaryUrl, authority: "primary", publishedAt: "2026-09-30", supportedClaims: ["The author separates recovery from re-execution."] }],
    gaps: [] as string[],
    nextStep: "Compare the selected boundary against the isolated recovery fixture.",
  },
});
function pair(id: string, name: string, input: unknown, result: unknown = {}): Record<string, unknown>[] {
  return [
    { type: "tool_used", toolUseId: id, toolName: name, status: "running", metadata: { toolInput: input } },
    { type: "tool_result", toolUseId: id, status: "completed", metadata: result },
  ];
}
const readPair = (id: string, path: string) => pair(id, "Read", { path, offset: 10, limit: 3 }, {
  codebaseObservation: { path, sha256: hash, offset: 10, content: "10: observed code\n11: observed code\n12: observed code" },
});
const trace = () => ({ events: [
  ...pair("grep", "Grep", { query: "applyRecordedStep", pattern: "apps/web/**/*.ts" }),
  ...readPair("read-a", paths[0]), ...readPair("read-b", paths[1]),
  ...pair("search", "webSearch", { query: "agent recovery site:arxiv.org after:2026-09-25" }),
  ...pair("page", "webReadPage", { url: primaryUrl }, { toolResult: { url: primaryUrl, finalUrl: primaryUrl, success: true, contentLength: 1200 } }),
] });
const check = (value: unknown = report(), events: unknown = trace()) => verifyResearchProcess(fields, value, events);

describe("research process verification", () => {
  it("does not impose researcher rules on other Work contracts", () => {
    expect(verifyResearchProcess(["reportMarkdown"], null, null)).toEqual([]);
  });

  it("rejects old prose-only delivery when the process contract is required", () => {
    expect(check({ reportMarkdown: "All permissions are allowed and research is complete." })).not.toEqual([]);
  });

  it("accepts a sufficient process backed by paired completed calls and exact read evidence", () => {
    expect(check()).toEqual([]);
  });

  it("treats missing, null and blank publication dates as honest unknown metadata", () => {
    for (const publishedAt of [undefined, null, "", "  ", "\n\t"]) {
      const value = report();
      const evidence = { ...value.researchProcess.externalEvidence[0], publishedAt };
      expect(check({ ...value, researchProcess: { ...value.researchProcess, externalEvidence: [evidence] } })).toEqual([]);
    }
    const value = report();
    const invalid = { ...value.researchProcess.externalEvidence[0], publishedAt: 20261002 };
    expect(check({ ...value, researchProcess: { ...value.researchProcess, externalEvidence: [invalid] } }).some(issue => issue.includes("publishedAt"))).toBe(true);
  });

  it("does not infer successful tools from declarations, permissions or orphan results", () => {
    const forged = { allowedTools: ["Grep", "Read", "webSearch", "webReadPage"], events: [
      { type: "permission_decision", toolName: "Grep", status: "completed", metadata: { decision: "allow" } },
      { type: "tool_result", toolUseId: "unused", toolName: "Grep", status: "completed" },
    ] };
    expect(check(report(), forged)).toContain("Sufficient research needs a successful Grep call");
  });

  it("rejects failed paired calls even when a permission was allowed", () => {
    const failed = trace();
    failed.events[1].status = "error";
    expect(check(report(), failed)).toContain("Sufficient research needs a successful Grep call");
  });

  it("rejects structured tool failures marked completed", () => {
    const failed = trace();
    failed.events[1].metadata = { toolResult: { success: false, error: "Provider unavailable" } };
    expect(check(report(), failed)).toContain("Sufficient research needs a successful Grep call");
  });

  it("does not pair a result before its use or accept reused call IDs", () => {
    const reordered = trace();
    reordered.events.splice(0, 2, reordered.events[1], reordered.events[0]);
    expect(check(report(), reordered)).toContain("Sufficient research needs a successful Grep call");
    const reused = trace();
    reused.events.push(...pair("grep", "Grep", { query: "other" }));
    expect(check(report(), reused)).toContain("Sufficient research needs a successful Grep call");
  });

  it("accepts honest quiet evidence insufficiency with gaps and a next step", () => {
    const value = report();
    value.researchProcess = { ...value.researchProcess, status: "evidence_insufficient", sourceEvidence: [], externalEvidence: [], gaps: ["Primary source reader was unavailable."] };
    expect(check(value, { events: [] })).toEqual([]);
  });

  it("blocks unsupported material changes, notification and no-change claims in degraded research", () => {
    const value = { ...report(), outcome: "no_material_change" };
    value.researchProcess.status = "degraded";
    value.projectAssessment = { materialChange: true, notificationIntent: "notify" };
    const issues = check(value);
    expect(issues).toContain("Insufficient or degraded research must identify evidence gaps");
    expect(issues.some(issue => issue.includes("cannot claim materialChange=true"))).toBe(true);
    expect(issues.some(issue => issue.includes("must keep notificationIntent=quiet"))).toBe(true);
    expect(issues).toContain("Insufficient or degraded research cannot claim no_material_change");
  });

  it("rejects a cited path, hash or line range that was never observed", () => {
    for (const change of [{ path: "repo/apps/web/lib/loops/native-executor.ts" }, { sha256: "b".repeat(64) }, { endLine: 13 }]) {
      const value = report();
      Object.assign(value.researchProcess.sourceEvidence[0], change);
      expect(check(value).some(issue => issue.includes("must match a successful repo Read"))).toBe(true);
    }
  });

  it("does not count input copies, documents or repeated reads as two source files", () => {
    const value = report();
    const observed = trace();
    observed.events.splice(4, 2, ...readPair("read-b", paths[0]));
    value.researchProcess.sourceEvidence[1].path = paths[0];
    expect(check(value, observed)).toContain("Sufficient research needs successful repo Read observations for two different source files");
    observed.events.splice(4, 2, ...readPair("read-b", "repo/docs/architecture/plan.md"));
    expect(check(value, observed)).toContain("Sufficient research needs successful repo Read observations for two different source files");
  });

  it("can cite an actual documentation observation alongside the required implementation sources", () => {
    const documentation = "repo/docs/architecture/project-map.md";
    const value = report();
    value.researchProcess.sourceEvidence.push({ path: documentation, sha256: hash, startLine: 10, endLine: 12 });
    const observed = trace();
    observed.events.push(...readPair("docs", documentation));
    expect(check(value, observed)).toEqual([]);
  });

  it("requires a directed search and does not promote a blog's own authority claim", () => {
    const observed = trace();
    observed.events.splice(6, 2, ...pair("search", "webSearch", { query: "agent recovery" }));
    expect(check(report(), observed)).toContain("Sufficient research needs a successful directed webSearch with a domain or time window");
    const value = report();
    value.researchProcess.externalEvidence[0].url = "https://blog.csdn.net/example/article/details/123";
    observed.events.splice(8, 2, ...pair("page", "webReadPage", { url: value.researchProcess.externalEvidence[0].url }));
    expect(check(value, observed).some(issue => issue.includes("recognized primary"))).toBe(true);
  });

  it("requires actual page reading and explicit claims even for known primary hosts", () => {
    const observed = trace();
    observed.events.splice(8, 2);
    expect(check(report(), observed).some(issue => issue.includes("successful webReadPage"))).toBe(true);
    const value = report();
    value.researchProcess.externalEvidence[0].supportedClaims = [];
    expect(check(value)).toContain("Sufficient research needs a successfully read primary page with explicit supportedClaims");
  });

  it("rejects empty or unverified page bodies and redirects to secondary sources", () => {
    for (const result of [{}, { toolResult: { contentLength: 0, success: true } }, { toolResult: { contentLength: 50, success: false } }]) {
      const observed = trace();
      observed.events.splice(8, 2, ...pair("page", "webReadPage", { url: primaryUrl }, result));
      expect(check(report(), observed)).toContain("Sufficient research needs a successfully read primary page with explicit supportedClaims");
    }
    const observed = trace();
    observed.events.splice(8, 2, ...pair("page", "webReadPage", { url: primaryUrl }, { toolResult: { contentLength: 50, finalUrl: "https://blog.csdn.net/example", success: true } }));
    expect(check(report(), observed)).toContain("Sufficient research needs a successfully read primary page with explicit supportedClaims");
  });

  it("allows citing the actual primary final URL while checking redirect authority", () => {
    const finalUrl = "https://arxiv.org/html/2609.12345v2";
    const value = report();
    value.researchProcess.externalEvidence[0].url = finalUrl;
    const observed = trace();
    observed.events.splice(8, 2, ...pair("page", "webReadPage", { url: primaryUrl }, { toolResult: { url: primaryUrl, finalUrl, success: true, contentLength: 50 } }));
    expect(check(value, observed)).toEqual([]);
    const redirected = "https://blog.csdn.net/example/article/details/123";
    value.researchProcess.externalEvidence[0].url = redirected;
    observed.events.splice(8, 2, ...pair("page", "webReadPage", { url: primaryUrl }, { toolResult: { url: primaryUrl, finalUrl: redirected, success: true, contentLength: 50 } }));
    expect(check(value, observed).some(issue => issue.includes("recognized primary"))).toBe(true);
    value.researchProcess.externalEvidence[0].authority = "secondary";
    expect(check(value, observed).some(issue => issue.includes("successful webReadPage"))).toBe(false);
    expect(check(value, observed)).toContain("Sufficient research needs a successfully read primary page with explicit supportedClaims");
  });

  it("accepts bounded host-generated codebase observation receipts without retaining source text", () => {
    const observed = trace();
    observed.events[3].metadata = { toolResult: { codebaseObservation: { path: paths[0], sha256: hash, offset: 10, startLine: 10, endLine: 12, totalLines: 100, truncated: true } } };
    expect(check(report(), observed)).toEqual([]);
  });

  it("can read untruncated trace detail JSON without metadata and normalizes Windows repo separators", () => {
    const observed = trace();
    observed.events[2] = { ...observed.events[2], metadata: {}, detail: JSON.stringify({ path: paths[0].replaceAll("/", "\\") }) };
    observed.events[3] = { ...observed.events[3], metadata: {}, detail: JSON.stringify({ path: paths[0], sha256: hash, startLine: 10, endLine: 12 }) };
    expect(check(report(), observed)).toEqual([]);
  });

  it("allows an evidence-backed correction notification while keeping research insufficiency explicit", () => {
    const value = report();
    value.researchProcess = { ...value.researchProcess, status: "evidence_insufficient", sourceEvidence: [value.researchProcess.sourceEvidence[0]], externalEvidence: [], gaps: ["External research has not completed."] };
    const correction = { ...value, projectAssessment: { materialChange: true, notificationIntent: "notify", notificationReason: "verified_correction" } };
    expect(check(correction, { events: readPair("correction", paths[0]) })).toEqual([]);
    expect(check(correction, { events: [] }).some(issue => issue.includes("must keep notificationIntent=quiet"))).toBe(true);
    const noChange = { ...correction, outcome: "no_material_change" };
    expect(check(noChange, { events: readPair("correction", paths[0]) })).toContain("Insufficient or degraded research cannot claim no_material_change");
  });

  it("allows a real failed-tool notification but rejects unpaired errors and permission denials", () => {
    const value = report();
    value.researchProcess = { ...value.researchProcess, status: "degraded", sourceEvidence: [], externalEvidence: [], gaps: ["External page reading failed."] };
    const degraded = { ...value, projectAssessment: { materialChange: true, notificationIntent: "notify", notificationReason: "tool_failure" } };
    for (const status of ["error", "failed"]) {
      const failed = pair("page", "webReadPage", { url: primaryUrl });
      failed[1].status = status;
      expect(check(degraded, { events: failed })).toEqual([]);
    }
    const reportedFailure = pair("search", "webSearch", { query: "recovery site:arxiv.org" }, { toolResult: { success: false } });
    expect(check(degraded, { events: reportedFailure })).toEqual([]);
    for (const events of [
      [{ type: "tool_result", toolUseId: "absent", status: "error" }],
      [{ type: "permission_decision", toolName: "webReadPage", status: "error", metadata: { decision: "deny" } }],
      pair("search", "webSearch", { query: "recovery site:arxiv.org" }),
    ]) expect(check(degraded, { events }).some(issue => issue.includes("must keep notificationIntent=quiet"))).toBe(true);
  });

  it("allows a decision request with a real source or external observation and a non-empty question", () => {
    const value = report();
    value.researchProcess = { ...value.researchProcess, status: "evidence_insufficient", sourceEvidence: [value.researchProcess.sourceEvidence[0]], externalEvidence: [], gaps: ["Only one relevant implementation boundary has been checked."] };
    const decision = { ...value, projectAssessment: { materialChange: true, notificationIntent: "notify", notificationReason: "decision_required", decisionNeeded: "Should the next run prioritize recovery or evaluation?" } };
    expect(check(decision, { events: readPair("decision", paths[0]) })).toEqual([]);
    const externalDecision = { ...decision, researchProcess: { ...decision.researchProcess, sourceEvidence: [], externalEvidence: report().researchProcess.externalEvidence } };
    expect(check(externalDecision, { events: pair("page", "webReadPage", { url: primaryUrl }, { toolResult: { success: true, contentLength: 30 } }) })).toEqual([]);
    for (const decisionNeeded of ["", "  ", false, [], {}]) {
      expect(check({ ...decision, projectAssessment: { ...decision.projectAssessment, decisionNeeded } }, { events: readPair("decision", paths[0]) }).some(issue => issue.includes("must keep notificationIntent=quiet"))).toBe(true);
    }
    expect(check(decision, { events: [] }).some(issue => issue.includes("must keep notificationIntent=quiet"))).toBe(true);
  });

  it("does not turn a reason string or a success label into tool evidence", () => {
    const observed = trace();
    observed.events[1].status = "success";
    expect(check(report(), observed)).toContain("Sufficient research needs a successful Grep call");
    const value = report();
    value.researchProcess = { ...value.researchProcess, status: "degraded", sourceEvidence: [], externalEvidence: [], gaps: ["No tools produced observations."] };
    for (const notificationReason of [undefined, "verified_correction", "tool_failure", "decision_required", "self_scored_high"]) {
      const request = { ...value, projectAssessment: { materialChange: true, notificationIntent: "notify", notificationReason, decisionNeeded: "Question without evidence" } };
      expect(check(request, { events: [] }).some(issue => issue.includes("must keep notificationIntent=quiet"))).toBe(true);
    }
  });

  it("joins consecutive successful Read windows only for the same path and hash", () => {
    const value = report();
    value.researchProcess.sourceEvidence[0] = { path: paths[0], sha256: hash, startLine: 1, endLine: 749 };
    const ranges = [[1, 100], [100, 299], [300, 549], [550, 749]];
    const windows = ranges.flatMap(([startLine, endLine], index) => pair(`window-${index}`, "Read", { path: paths[0], offset: startLine }, {
      toolResult: { codebaseObservation: { path: paths[0], sha256: hash, startLine, endLine } },
    }));
    const observed = trace();
    observed.events.splice(2, 2, ...windows);
    expect(check(value, observed)).toEqual([]);
    const hole = { events: [...observed.events] };
    hole.events[7] = { ...hole.events[7], metadata: { toolResult: { codebaseObservation: { path: paths[0], sha256: hash, startLine: 301, endLine: 549 } } } };
    expect(check(value, hole).some(issue => issue.includes("must match a successful repo Read"))).toBe(true);
    const changed = { events: [...observed.events] };
    changed.events[7] = { ...changed.events[7], metadata: { toolResult: { codebaseObservation: { path: paths[0], sha256: "b".repeat(64), startLine: 300, endLine: 549 } } } };
    expect(check(value, changed).some(issue => issue.includes("must match a successful repo Read"))).toBe(true);
  });

  it("accepts publisher package pages and maintainer raw files, not generic publisher home pages", () => {
    for (const url of ["https://pypi.org/project/langgraph/", "https://pypi.org/project/langgraph/1.2.3/", "https://raw.githubusercontent.com/langchain-ai/langgraph/main/README.md"]) {
      const value = report();
      value.researchProcess.externalEvidence[0].url = url;
      const observed = trace();
      observed.events.splice(8, 2, ...pair("page", "webReadPage", { url }, { toolResult: { finalUrl: url, contentLength: 100 } }));
      expect(check(value, observed)).toEqual([]);
    }
    for (const url of ["https://pypi.org/", "https://pypi.org/project/", "https://raw.githubusercontent.com/langchain-ai/langgraph/main"]) {
      const value = report();
      value.researchProcess.externalEvidence[0].url = url;
      const observed = trace();
      observed.events.splice(8, 2, ...pair("page", "webReadPage", { url }, { toolResult: { finalUrl: url, contentLength: 100 } }));
      expect(check(value, observed).some(issue => issue.includes("recognized primary"))).toBe(true);
    }
  });

  it("keeps unverified primary pages as honest insufficient evidence with an explicit redirect gap", () => {
    const observed = trace();
    observed.events.splice(8, 2, ...pair("page", "webReadPage", { url: primaryUrl }, {
      toolResult: { finalUrl: primaryUrl, finalUrlVerified: false, contentLength: 100, ok: true },
    }));
    expect(check(report(), observed)).toContain("Sufficient research needs a successfully read primary page with explicit supportedClaims");
    const value = report();
    value.researchProcess.status = "evidence_insufficient";
    value.researchProcess.gaps = ["The reader has not independently verified the redirect destination."];
    expect(check(value, observed)).toEqual([]);
    value.researchProcess.gaps = ["重定向后的最终域名尚未核验。"];
    expect(check(value, observed)).toEqual([]);
    value.researchProcess.gaps = ["External coverage was limited."];
    expect(check(value, observed).some(issue => issue.includes("redirect verification gap"))).toBe(true);
    value.researchProcess.gaps = ["Redirect destination was verified."];
    expect(check(value, observed).some(issue => issue.includes("redirect verification gap"))).toBe(true);
    value.researchProcess.gaps = ["Redirect destination was not verified."];
    value.researchProcess.externalEvidence[0].url = "https://anthropic.com/research/unverified-final";
    observed.events.splice(8, 2, ...pair("page", "webReadPage", { url: primaryUrl }, { toolResult: { finalUrl: value.researchProcess.externalEvidence[0].url, finalUrlVerified: false, contentLength: 100 } }));
    expect(check(value, observed).some(issue => issue.includes("recognized primary"))).toBe(true);
  });
});
